/* ============================================================
   服务端自测：mock 模式全链路 API 测试（npm run test）
   覆盖：health / 校验 / 限流 / 去重换一批 / 400-413-429-502 / 404
   ============================================================ */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3210; // 自测专用端口，避免与开发端口冲突
const BASE = `http://127.0.0.1:${PORT}`;

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

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function main() {
  console.log('[server-self-test] 启动 mock 服务…');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      MOCK_MODE: '1',
      MOCK_DELAY_MS: '50',
      // 前面的功能用例共 8 个合法请求；设为 8 可让它们全部通过，随后限流循环触发 429
      RATE_LIMIT_PER_MIN: '8',
      DEEPSEEK_API_KEY: '', // mock 模式不需要 key
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  // 等待服务就绪
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
    console.error('[server-self-test] 服务未能启动，日志：\n' + serverLog);
    try { child.kill(); } catch { /* ignore */ }
    process.exit(1);
  }

  try {
    // 1. health
    const health = await (await fetch(BASE + '/api/health')).json();
    check('GET /api/health 返回 {ok,mock,maxInputLength}',
      health && health.ok === true && health.mock === true && typeof health.maxInputLength === 'number',
      JSON.stringify(health));

    // 2. 正常生成
    const okRes = await postJson(BASE + '/api/generate', {
      input: '同事把锅甩给我，领导却让我背，该怎么回应不伤和气？', tone: 'warm', length: 'medium', avoid: [],
    });
    check('POST /api/generate 200 且返回 main+alternatives+notes',
      okRes.status === 200 && okRes.data && okRes.data.main && okRes.data.main.text
        && Array.isArray(okRes.data.alternatives) && okRes.data.alternatives.length === 2
        && ('notes' in okRes.data),
      okRes.status + ' ' + JSON.stringify(okRes.data).slice(0, 200));
    const textsA = [okRes.data.main.text].concat(okRes.data.alternatives.map((a) => a.text));
    check('返回 3 条非空文本', textsA.length === 3 && textsA.every((t) => typeof t === 'string' && t.length > 0));

    // 3. 换一批不重复（avoid 传上批）
    const regenRes = await postJson(BASE + '/api/generate', {
      input: '同事把锅甩给我，领导却让我背，该怎么回应不伤和气？', tone: 'warm', length: 'medium', avoid: textsA,
    });
    const textsB = regenRes.status === 200 && regenRes.data
      ? [regenRes.data.main.text].concat(regenRes.data.alternatives.map((a) => a.text))
      : [];
    check('换一批（avoid=上批）返回 200 且与上批无相同文本',
      regenRes.status === 200 && textsB.length === 3 && textsB.every((t) => textsA.indexOf(t) === -1),
      regenRes.status + ' ' + JSON.stringify(textsB));

    // 3. 非法 tone/length（放在限流触发前执行）
    const badTone = await postJson(BASE + '/api/generate', {
      input: '测试', tone: 'angry', length: 'medium', avoid: [],
    });
    check('非法 tone → 400 INVALID_INPUT', badTone.status === 400 && badTone.data.error.code === 'INVALID_INPUT',
      badTone.status + ' ' + JSON.stringify(badTone.data));

    // 4. 输入校验：空输入
    const emptyRes = await postJson(BASE + '/api/generate', { input: '   ', tone: 'warm', length: 'medium', avoid: [] });
    check('空输入 → 400 INVALID_INPUT', emptyRes.status === 400 && emptyRes.data.error.code === 'INVALID_INPUT',
      emptyRes.status + ' ' + JSON.stringify(emptyRes.data));

    // 5. 超长输入（mock 默认 2000，发 2001 字）
    const longRes = await postJson(BASE + '/api/generate', {
      input: '长'.repeat(2001), tone: 'warm', length: 'medium', avoid: [],
    });
    check('超长输入 → 400 INVALID_INPUT', longRes.status === 400 && longRes.data.error.code === 'INVALID_INPUT',
      longRes.status + ' ' + JSON.stringify(longRes.data && longRes.data.error));

    // 6. 纯表情 / 纯符号输入不报错
    const emojiRes = await postJson(BASE + '/api/generate', {
      input: '😂😂😂🙃🙃🙃', tone: 'warm', length: 'medium', avoid: [],
    });
    check('纯表情输入 → 200 正常生成', emojiRes.status === 200 && emojiRes.data.main && emojiRes.data.main.text,
      emojiRes.status + ' ' + JSON.stringify(emojiRes.data).slice(0, 120));
    const symRes = await postJson(BASE + '/api/generate', {
      input: ')))))((((*****', tone: 'warm', length: 'medium', avoid: [],
    });
    check('纯符号输入 → 200 正常生成', symRes.status === 200 && symRes.data.main && symRes.data.main.text,
      symRes.status + ' ' + JSON.stringify(symRes.data).slice(0, 120));

    // 6b. 超长无空格单行 1000 字（在 2000 上限内）→ 正常生成（验收 3）
    const lineRes = await postJson(BASE + '/api/generate', {
      input: '长'.repeat(1000), tone: 'warm', length: 'short', avoid: [],
    });
    check('1000 字无空格单行输入 → 200 正常生成', lineRes.status === 200 && lineRes.data.main && lineRes.data.main.text,
      lineRes.status + ' ' + JSON.stringify(lineRes.data).slice(0, 120));

    // 7. 非法 JSON 请求体 → 400（在 express.json 解析层被拒，先于限流）
    const raw = await fetch(BASE + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken json',
    });
    check('非法 JSON 请求体 → 400', raw.status === 400, String(raw.status));

    // 8. 超限流（此前已有 7 个合法请求，第 8 个起应 429）
    let rateRes = null;
    for (let i = 0; i < 12; i += 1) {
      const r = await postJson(BASE + '/api/generate', {
        input: '限流测试', tone: 'warm', length: 'short', avoid: [],
      });
      if (r.status === 429) { rateRes = r; break; }
    }
    check('限流生效 → 429 RATE_LIMITED + retryAfterSec',
      rateRes !== null && rateRes.data.error.code === 'RATE_LIMITED' && rateRes.data.error.retryAfterSec > 0,
      rateRes ? rateRes.status + ' ' + JSON.stringify(rateRes.data.error) : '未触发 429');

    // 10. 未知 API 路由 → 404 JSON
    const notFound = await fetch(BASE + '/api/nope');
    const nfBody = await notFound.json().catch(() => null);
    check('未知 /api 路由 → 404 JSON', notFound.status === 404 && nfBody && nfBody.error, String(notFound.status));

    // 11. 页面 404 → HTML 404 页
    const page404 = await fetch(BASE + '/no-such-page.html');
    const page404Text = await page404.text();
    check('未知页面 → 404 且返回 404 页面内容',
      page404.status === 404 && page404Text.indexOf('404') !== -1, String(page404.status));

    // 12. 静态首页可访问且无密钥痕迹（验收 10 的检索证据）
    const home = await fetch(BASE + '/');
    const homeText = await home.text();
    check('首页 200 可访问', home.status === 200, String(home.status));
    check('首页 HTML 不含 DEEPSEEK_API_KEY 字样', homeText.indexOf('DEEPSEEK_API_KEY') === -1);
    const cssRes = await fetch(BASE + '/style.css');
    const jsRes = await fetch(BASE + '/app.js');
    const cssText = await cssRes.text();
    const jsText = await jsRes.text();
    check('前端产物（html/css/js）均不含密钥字样',
      [homeText, cssText, jsText].every((t) => t.indexOf('DEEPSEEK_API_KEY') === -1 && t.indexOf('sk-') === -1));

    // 13. 上游不可达（验收 4 服务端部分）：非 mock 实例，base URL 指向无服务端口
    console.log('[server-self-test] 启动第二个实例（无效上游地址）…');
    const child2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: '3212',
        MOCK_MODE: '0',
        DEEPSEEK_API_KEY: 'sk-fake-self-test',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
        MODEL_TIMEOUT_MS: '3000',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child2.stderr.on('data', () => { /* 忽略 */ });
    let ready2 = false;
    for (let i = 0; i < 50 && !ready2; i += 1) {
      try {
        const res = await fetch('http://127.0.0.1:3212/api/health');
        if (res.ok) ready2 = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!ready2) {
      check('第二实例启动', false, '3212 端口未就绪');
    } else {
      const upRes = await postJson('http://127.0.0.1:3212/api/generate', {
        input: '上游异常测试', tone: 'warm', length: 'short', avoid: [],
      });
      check('上游不可达 → 502 UPSTREAM_ERROR 且 retryable=true',
        upRes.status === 502 && upRes.data.error.code === 'UPSTREAM_ERROR' && upRes.data.error.retryable === true,
        upRes.status + ' ' + JSON.stringify(upRes.data));
    }
    try { child2.kill(); } catch { /* ignore */ }
  } catch (err) {
    failed += 1;
    console.error('  ✗ 自测过程异常：' + (err && err.stack ? err.stack : err));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }

  console.log(`\n[server-self-test] 通过 ${passed} / ${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
