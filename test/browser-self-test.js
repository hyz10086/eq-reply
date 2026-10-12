/* ============================================================
   无头浏览器自测（npm run test:browser）
   用 Edge headless --dump-dom 打开 ?selftest=layout / ?selftest=1，
   解析页面写入的 body[data-selftest] JSON 并逐项报告。
   覆盖验收 1/2/3/5/6/7 的自动化部分 + 320/375/390/414/768 宽度布局。
   ============================================================ */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;

const SIZES = [320, 375, 390, 414, 768];

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
  }
}

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function runHeadless(edgePath, url, windowSize, virtualBudgetMs, extraArgs) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--user-data-dir=' + path.join(process.env.TEMP || ROOT, 'eq-reply-edge-profile-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
      '--window-size=' + windowSize,
      '--virtual-time-budget=' + virtualBudgetMs,
    ].concat(extraArgs || [], [
      '--dump-dom',
      url,
    ]);
    const child = spawn(edgePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const killTimer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, virtualBudgetMs + 15000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, out, err });
    });
  });
}

function extractSelfTest(dom) {
  const m = dom.match(/<body[^>]*data-selftest="([^"]*)"/) || dom.match(/<body[^>]*data-selftest='([^']*)'/);
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
}

async function main() {
  console.log('[browser-self-test] 查找 Edge…');
  const edgePath = findEdge();
  if (!edgePath) {
    console.error('[browser-self-test] 未找到 Edge 可执行文件，无法运行无头浏览器自测。');
    console.error('  请安装 Microsoft Edge 后重试，或按自测清单手动验证。');
    process.exit(2);
  }
  console.log('[browser-self-test] 使用 ' + edgePath);

  console.log('[browser-self-test] 启动 mock 服务…');
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      MOCK_MODE: '1',
      MOCK_DELAY_MS: '800', // 留出生成中窗口，供滚动检查（验收 6）
      DEEPSEEK_API_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i += 1) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!ready) {
    console.error('[browser-self-test] 服务启动失败');
    try { server.kill(); } catch { /* ignore */ }
    process.exit(1);
  }

  try {
    // ---- 布局检查：多宽度 ----
    for (const w of SIZES) {
      const r = await runHeadless(edgePath, BASE + '/?selftest=layout', w + ',800', 5000);
      const t = extractSelfTest(r.out);
      console.log(`\n[layout ${w}px]`);
      if (!t) {
        check('布局自测完成（' + w + 'px）', false, '未取到 data-selftest，Edge 输出长度 ' + r.out.length);
        continue;
      }
      for (const c of t.checks) {
        check(w + 'px · ' + c.name, c.pass, c.detail);
      }
    }

    // ---- 深色模式布局检查：320px（--force-dark-mode 激活 prefers-color-scheme: dark） ----
    console.log('\n[layout dark 320px]');
    const d = await runHeadless(edgePath, BASE + '/?selftest=layout', '320,800', 6000, ['--force-dark-mode']);
    const dt = extractSelfTest(d.out);
    if (!dt) {
      check('深色模式布局自测完成', false, '未取到 data-selftest，输出长度 ' + d.out.length);
    } else {
      for (const c of dt.checks) {
        check('深色 · ' + c.name, c.pass, c.detail);
      }
    }

    // ---- 全流程检查：320px ----
    console.log('\n[flow 320px]');
    const f = await runHeadless(edgePath, BASE + '/?selftest=1', '320,800', 25000);
    const ft = extractSelfTest(f.out);
    if (!ft) {
      check('全流程自测完成', false, '未取到 data-selftest（超时或流程失败），输出长度 ' + f.out.length);
    } else {
      for (const c of ft.checks) {
        check('流程 · ' + c.name, c.pass, c.detail);
      }
      if (ft.flow && ft.flow.steps) {
        console.log('  流程步骤: ' + ft.flow.steps.join(' → '));
      }
    }

    // ---- 错误路径检查：320px（伪造模型错误响应，验证分类提示/重试/恢复） ----
    console.log('\n[error 320px]');
    const e = await runHeadless(edgePath, BASE + '/?selftest=error', '320,800', 20000);
    const et = extractSelfTest(e.out);
    if (!et) {
      check('错误路径自测完成', false, '未取到 data-selftest，输出长度 ' + e.out.length);
    } else {
      for (const c of et.checks) {
        check('错误 · ' + c.name, c.pass, c.detail);
      }
      if (et.steps) console.log('  错误步骤: ' + et.steps.join(' → '));
    }
  } finally {
    try { server.kill(); } catch { /* ignore */ }
  }

  console.log(`\n[browser-self-test] 通过 ${passed} / ${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
