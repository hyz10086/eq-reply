/* ============================================================
   高情商回复生成器 —— 前端逻辑（原生 JS，无依赖）
   要点：防重复提交 / 30s 超时兜底 / 错误分类渲染 / 剪贴板三级降级 /
        visualViewport 键盘适配 / selftest 自测模式（供无头浏览器回归）
   ============================================================ */
(function () {
  'use strict';

  // ---------------- DOM 引用 ----------------
  const $ = (id) => document.getElementById(id);
  const inputEl = $('user-input');
  const charCountEl = $('char-count');
  const charWarningEl = $('char-warning');
  const inputHintEl = $('input-hint');
  const generateBtn = $('generate-btn');
  const btnLabel = $('btn-label');
  const btnSpinner = $('btn-spinner');
  const errorBox = $('error-box');
  const errorText = $('error-text');
  const retryBtn = $('retry-btn');
  const loadingBox = $('loading-box');
  const resultsEl = $('results');
  const resultsList = $('results-list');
  const resultsNotes = $('results-notes');
  const regenerateBtn = $('regenerate-btn');
  const manualCopyBox = $('manual-copy');
  const manualCopyText = $('manual-copy-text');

  // ---------------- 状态 ----------------
  const MAX_LENGTH_DEFAULT = 2000; // 服务端下发前的前端默认值
  const FRONTEND_TIMEOUT_MS = 30000; // 前端兜底超时（服务端 25s 内先超时）

  const state = {
    tone: 'warm',
    length: 'medium',
    maxLength: MAX_LENGTH_DEFAULT,
    generating: false,
    lastResult: null, // { texts: string[], request: {...} } 换一批去重用
    lastRequest: null, // 重试按钮复用
    seq: 0, // 请求序号，防止竞态回写
  };

  const countChars = (s) => Array.from(s).length;

  // ---------------- 配置同步（输入上限来自服务端，避免两端不一致） ----------------
  async function loadConfig() {
    try {
      const res = await fetch('/api/health', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.maxInputLength === 'number' && data.maxInputLength > 0) {
          state.maxLength = data.maxInputLength;
        }
        updateCharCount();
      }
    } catch {
      /* 加载失败保持默认上限，不阻塞主流程 */
    }
  }

  // ---------------- 输入区 ----------------
  function updateCharCount() {
    const n = countChars(inputEl.value);
    charCountEl.textContent = n + ' / ' + state.maxLength;
    charWarningEl.hidden = n <= state.maxLength;
    updateGenerateBtnState();
  }

  function updateGenerateBtnState() {
    const empty = inputEl.value.trim().length === 0;
    const over = countChars(inputEl.value) > state.maxLength;
    generateBtn.disabled = empty || over || state.generating;
  }

  inputEl.addEventListener('input', updateCharCount);

  let hintTimer = null;
  function showInlineHint(msg) {
    inputHintEl.textContent = msg;
    inputHintEl.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { inputHintEl.hidden = true; }, 2600);
  }

  // 语气 / 长度分段按钮（点击切换 aria-pressed，核心交互不依赖 hover）
  function bindSegmented(selector, attr, key) {
    document.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.generating) return;
        state[key] = btn.dataset[attr];
        document.querySelectorAll(selector).forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset[attr] === state[key]));
        });
      });
    });
  }
  bindSegmented('.seg-btn[data-tone]', 'tone', 'tone');
  bindSegmented('.seg-btn[data-len]', 'len', 'length');

  // ---------------- 生成主流程 ----------------
  generateBtn.addEventListener('click', () => { void startGenerate({ regenerate: false }); });
  retryBtn.addEventListener('click', () => { void startGenerate({ regenerate: false, isRetry: true }); });
  regenerateBtn.addEventListener('click', () => { void startGenerate({ regenerate: true }); });

  async function startGenerate(opts) {
    if (state.generating) return; // 防重复提交：loading 期间一律忽略

    const input = inputEl.value.trim();
    const n = countChars(inputEl.value);
    if (!input) {
      showInlineHint('请先输入对方的话或描述一下场景。');
      return;
    }
    if (n > state.maxLength) {
      showInlineHint('输入超过 ' + state.maxLength + ' 字上限，请删减后再生成。');
      return;
    }

    const request = {
      input,
      tone: state.tone,
      length: state.length,
      avoid: opts.regenerate && state.lastResult ? state.lastResult.texts : [],
    };
    state.lastRequest = request;
    const mySeq = ++state.seq;

    setGenerating(true, opts.regenerate);
    hideError();
    hideManualCopy();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FRONTEND_TIMEOUT_MS);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (mySeq !== state.seq) return; // 已有更新的请求，丢弃本次结果

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!data) {
        showError('UPSTREAM_ERROR', '服务返回了无法识别的数据，请重试。', true);
        return;
      }
      if (!res.ok || data.error) {
        const err = data.error || { code: 'UPSTREAM_ERROR', message: '服务暂时不可用，请稍后再试。' };
        showError(err.code, err.message, err.retryable !== false, err.retryAfterSec || 0);
        return;
      }
      renderResult(data, request);
    } catch (err) {
      if (mySeq !== state.seq) return;
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (aborted) {
        showError('MODEL_TIMEOUT', '生成超时了，请点击重试。', true);
      } else if (!navigator.onLine) {
        showError('OFFLINE', '网络不可用，请检查网络连接后重试。', true);
      } else {
        showError('UPSTREAM_ERROR', '网络异常，请重试。', true);
      }
    } finally {
      clearTimeout(timer);
      if (mySeq === state.seq) setGenerating(false);
    }
  }

  function setGenerating(on, keepResults) {
    state.generating = on;
    if (on) {
      btnSpinner.hidden = false;
      btnLabel.textContent = '生成中…';
      generateBtn.disabled = true;
      regenerateBtn.disabled = true;
      if (!keepResults && resultsEl.hidden) loadingBox.hidden = false; // 首次生成显示骨架
    } else {
      btnSpinner.hidden = true;
      btnLabel.textContent = '生成回复';
      regenerateBtn.disabled = false;
      loadingBox.hidden = true;
      updateGenerateBtnState();
    }
  }

  // ---------------- 结果渲染 ----------------
  function renderResult(data, request) {
    const main = data.main || {};
    const alts = Array.isArray(data.alternatives) ? data.alternatives.slice(0, 2) : [];
    state.lastResult = {
      texts: [main.text].concat(alts.map((a) => a.text)).filter(Boolean),
      request,
    };

    resultsList.innerHTML = '';
    resultsList.appendChild(buildCard(main, '主推', true));
    alts.forEach((a, i) => resultsList.appendChild(buildCard(a, '备选 ' + (i + 1), false)));

    resultsNotes.hidden = !data.notes;
    resultsNotes.textContent = data.notes || '';

    loadingBox.hidden = true;
    resultsEl.hidden = false;

    // 生成完成后结果区自动滚入可见位置（验收 6）
    requestAnimationFrame(() => {
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function buildCard(item, badge, isMain) {
    const card = document.createElement('article');
    card.className = 'reply-card' + (isMain ? ' main-card' : '');

    const badgeEl = document.createElement('div');
    badgeEl.className = 'reply-badge';
    badgeEl.textContent = badge;

    const textEl = document.createElement('p');
    textEl.className = 'reply-text';
    textEl.textContent = item.text || '';

    const actions = document.createElement('div');
    actions.className = 'reply-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '复制';
    const statusEl = document.createElement('span');
    statusEl.className = 'copy-status';
    statusEl.setAttribute('role', 'status');
    copyBtn.addEventListener('click', () => { void copyReply(item.text || '', copyBtn, statusEl); });
    actions.append(copyBtn, statusEl);

    const why = document.createElement('details');
    why.className = 'reply-why';
    const summary = document.createElement('summary');
    summary.textContent = '为什么这么说';
    const reasonEl = document.createElement('p');
    reasonEl.textContent = item.reason || '';
    why.append(summary, reasonEl);

    card.append(badgeEl, textEl, actions, why);

    if (item.risk) {
      const riskEl = document.createElement('p');
      riskEl.className = 'reply-risk';
      riskEl.textContent = '⚠ ' + item.risk;
      card.appendChild(riskEl);
    }
    return card;
  }

  // ---------------- 复制（clipboard API → execCommand → 手动降级） ----------------
  async function copyReply(text, btn, statusEl) {
    if (!text) return;
    let ok = false;
    // 一级：Clipboard API（仅安全上下文可用；加超时防止个别浏览器挂起不返回）
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await Promise.race([
          navigator.clipboard.writeText(text),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('clipboard-timeout')), 1500);
          }),
        ]);
        ok = true;
      } catch {
        ok = false; // 权限被拒或超时 → 走下一级
      }
    }
    // 二级：隐藏 textarea + execCommand（HTTP 非安全上下文的主要通道）
    if (!ok) ok = legacyCopy(text);

    if (ok) {
      statusEl.textContent = '✓ 已复制';
      statusEl.classList.add('ok');
      btn.textContent = '已复制';
      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.classList.remove('ok');
        btn.textContent = '复制';
      }, 2000);
    } else {
      // 三级：展开可长按选中的文本块，提示手动复制
      showManualCopy(text);
    }
  }

  function legacyCopy(text) {
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      return document.execCommand('copy') === true;
    } catch {
      return false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  }

  function showManualCopy(text) {
    manualCopyText.textContent = text;
    manualCopyBox.hidden = false;
    manualCopyBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideManualCopy() {
    manualCopyBox.hidden = true;
  }

  // ---------------- 错误提示 ----------------
  const ERROR_TEXT = {
    RATE_LIMITED: '请求太频繁了，请稍后再试。',
    MODEL_TIMEOUT: '生成超时了，请重试。',
    MODEL_ERROR: '生成服务出现异常，请稍后再试。',
    PARSE_ERROR: '生成结果解析失败，请重试。',
    UPSTREAM_ERROR: '服务暂时不可用，请稍后再试。',
    INVALID_INPUT: '输入内容不符合要求。',
    OFFLINE: '网络不可用，请检查网络后重试。',
  };

  function showError(code, message, retryable, retryAfterSec) {
    let text = message || ERROR_TEXT[code] || '出错了，请稍后再试。';
    if (code === 'RATE_LIMITED' && retryAfterSec > 0) {
      text += '（约 ' + retryAfterSec + ' 秒后可再试）';
    }
    errorText.textContent = text;
    retryBtn.hidden = retryable === false;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideError() {
    errorBox.hidden = true;
  }

  // ---------------- 网络状态 ----------------
  window.addEventListener('offline', () => {
    if (state.generating) showError('OFFLINE', '网络已断开，请恢复网络后重试。', true);
  });
  window.addEventListener('online', () => {
    if (!errorBox.hidden && errorText.textContent.indexOf('网络') !== -1) hideError();
  });

  // ---------------- 软键盘适配（验收 8：键盘弹起时输入框与生成按钮可见可点） ----------------
  function nudgeGenerateBtn() {
    requestAnimationFrame(() => {
      generateBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  let lastVvHeight = 0;
  function handleViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    if (Math.abs(vv.height - lastVvHeight) > 10) {
      lastVvHeight = vv.height;
      if (document.activeElement === inputEl) nudgeGenerateBtn();
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleViewport);
    window.visualViewport.addEventListener('scroll', handleViewport);
  }
  inputEl.addEventListener('focus', () => {
    // 等软键盘弹出动画进行后再调整，确保按钮完整可见
    setTimeout(nudgeGenerateBtn, 250);
  });

  // ============================================================
  // selftest 自测模式（供无头浏览器回归验证，?selftest=1 全流程 / ?selftest=layout 仅布局）
  // 结果写入 body[data-selftest]（JSON），由 dump-dom 抓取
  // ============================================================
  function runSelfTest(mode) {
    const out = { checks: [], flow: { steps: [] }, ok: true };
    const check = (name, pass, detail) => {
      out.checks.push({ name, pass: !!pass, detail: detail || '' });
      if (!pass) out.ok = false;
    };

    // ---- 同步布局检查 ----
    const meta = document.querySelector('meta[name="viewport"]');
    check('viewport meta 存在且含 width=device-width 与 initial-scale=1',
      !!meta && /width=device-width/.test(meta.content || '') && /initial-scale=1/.test(meta.content || ''),
      meta && meta.content);
    check('未锁定缩放（无 maximum-scale=1）',
      !(meta && /maximum-scale\s*=\s*1\b/.test(meta.content || '')),
      meta && meta.content);
    const de = document.documentElement;
    check('无横向滚动（scrollWidth ≤ innerWidth）',
      de.scrollWidth <= window.innerWidth + 1,
      'scrollWidth=' + de.scrollWidth + ' innerWidth=' + window.innerWidth);
    const bodyFont = parseFloat(getComputedStyle(document.body).fontSize);
    check('正文字号 ≥16px', bodyFont >= 16, 'body fontSize=' + bodyFont + 'px');
    const taFont = parseFloat(getComputedStyle(inputEl).fontSize);
    check('输入框字号 ≥16px（防 iOS 自动放大）', taFont >= 16, 'textarea fontSize=' + taFont + 'px');
    const badBtns = [];
    document.querySelectorAll('button').forEach((b) => {
      // 跳过当前不可见的按钮（hidden 或 display:none 时尺寸为 0，无意义）
      if (b.hidden || b.offsetParent === null) return;
      const r = b.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) {
        badBtns.push((b.id || b.className) + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    });
    check('所有可见按钮命中区 ≥44×44px', badBtns.length === 0, badBtns.join(', '));
    check('全局 touch-action: manipulation',
      getComputedStyle(document.body).touchAction === 'manipulation',
      getComputedStyle(document.body).touchAction);

    // 深色模式断言：仅在 prefers-color-scheme: dark 生效时检查（浅色环境自动跳过）
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    if (darkMq.matches) {
      const bg = getComputedStyle(document.body).backgroundColor;
      check('深色模式生效（body 背景为深色变量值）', bg === 'rgb(16, 23, 21)', 'backgroundColor=' + bg);
    }

    // ---- 输入区动态检查（layout / flow 公共；验收 3 与边界情况表）----
    check('初始空输入时生成按钮禁用', generateBtn.disabled);
    inputEl.value = '你好，对方说这个项目出了问题。';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    check('输入文字后生成按钮启用', !generateBtn.disabled);
    const long1k = '长'.repeat(1000); // 无空格连续 1000 字单行
    inputEl.value = long1k;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    check('1000 字无空格单行输入不产生横向滚动',
      document.documentElement.scrollWidth <= window.innerWidth + 1,
      'scrollWidth=' + document.documentElement.scrollWidth);
    check('字数统计实时显示 1000', charCountEl.textContent.indexOf('1000') !== -1, charCountEl.textContent);
    inputEl.value = '超'.repeat(state.maxLength + 1);
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    check('超限输入禁用生成按钮', generateBtn.disabled);
    check('超限输入显示超限警告', !charWarningEl.hidden);
    inputEl.value = '你好，测试。';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.focus(); // 触发键盘适配路径（nudgeGenerateBtn）

    // focus 250ms 后 nudge 执行；600ms 后断言生成按钮在视口内，再进入模式分支
    setTimeout(() => {
      const r = generateBtn.getBoundingClientRect();
      check('输入框聚焦后生成按钮位于视口内（键盘适配）',
        r.top >= -1 && r.bottom <= window.innerHeight + 1,
        'top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom) + ' vh=' + window.innerHeight);
      if (mode === 'layout') {
        document.body.setAttribute('data-selftest', JSON.stringify(out));
        return;
      }
      runFlowTest(out, check);
    }, 600);
  }

  function runFlowTest(out, check) {
    const flow = out.flow;
    flow.steps.push('start');

    // 包装 fetch 统计 /api/generate 调用次数（验收 5：10 连点只发 1 次请求）
    const origFetch = window.fetch;
    let generateCalls = 0;
    window.fetch = function wrappedFetch(...args) {
      const url = String(args[0] && typeof args[0] === 'object' && args[0].url ? args[0].url : args[0]);
      if (url.indexOf('/api/generate') !== -1) generateCalls += 1;
      return origFetch.apply(this, args);
    };

    inputEl.value = '同事把锅甩给我，领导却让我背，该怎么回应不伤和气？';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    flow.steps.push('filled-input');

    // 连续快速点击 10 次
    for (let i = 0; i < 10; i += 1) generateBtn.click();
    flow.steps.push('clicked-10-times');

    let scrollChecked = false;
    const t0 = Date.now();
    (function pollFlow() {
      const elapsed = Date.now() - t0;
      flow.steps.push('poll:' + elapsed + 'ms shown=' + !resultsEl.hidden + ' calls=' + generateCalls);
      // 生成中滚动检查（验收 6）：页面高度超过视口时滚动应生效
      if (state.generating && !scrollChecked) {
        scrollChecked = true;
        if (document.documentElement.scrollHeight > window.innerHeight) {
          window.scrollTo(0, document.documentElement.scrollHeight);
          setTimeout(() => {
            check('生成中页面可滚动不卡死（scrollY>0）', window.scrollY > 0, 'scrollY=' + window.scrollY);
          }, 300);
        } else {
          check('生成中页面可滚动不卡死', true, '页面高度未超过视口，无滚动空间');
        }
      }
      if (!resultsEl.hidden) {
        const texts = Array.from(resultsList.querySelectorAll('.reply-text')).map((e) => e.textContent.trim());
        check('流程：输入 → 生成 → 输出 3 条回复', texts.length >= 3 && texts.every((t) => t.length > 0),
          'count=' + texts.length + ' texts=' + JSON.stringify(texts));
        check('验收5：10 次连点只产生 1 次生成请求', generateCalls === 1, 'generateCalls=' + generateCalls);

        // 结果区按钮显示后的命中区复查（copy-btn / regenerate-btn 均需 ≥44×44）
        const badVisible = [];
        document.querySelectorAll('button').forEach((b) => {
          if (b.hidden || b.offsetParent === null) return;
          const r = b.getBoundingClientRect();
          if (r.width < 44 || r.height < 44) {
            badVisible.push((b.id || b.className) + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
          }
        });
        check('流程：结果区可见按钮命中区 ≥44×44', badVisible.length === 0, badVisible.join(', '));

        // 验收 6 后半：生成完成后结果区自动滚入可见位置
        setTimeout(() => {
          const rr = resultsEl.getBoundingClientRect();
          check('生成完成后结果区滚入可见位置', rr.top <= window.innerHeight + 1 && rr.bottom >= 0,
            'top=' + Math.round(rr.top) + ' bottom=' + Math.round(rr.bottom) + ' vh=' + window.innerHeight);
        }, 400);

        // 换一批：验证与上一批不重复
        const before = texts.join('|');
        regenerateBtn.click();
        flow.steps.push('clicked-regenerate');
        const t1 = Date.now();
        (function pollRegen() {
          flow.steps.push('regen-poll:' + (Date.now() - t1) + 'ms');
          if (!state.generating) {
            const after = Array.from(resultsList.querySelectorAll('.reply-text')).map((e) => e.textContent.trim());
            const distinct = after.every((t) => before.indexOf(t) === -1);
            check('流程：换一批结果与上一批不重复', distinct, 'before=' + JSON.stringify(texts) + ' after=' + JSON.stringify(after));
            finishFlow();
          } else if (Date.now() - t1 > 12000) {
            check('流程：换一批完成', false, 'timeout');
            finishFlow();
          } else {
            setTimeout(pollRegen, 200);
          }
        })();
      } else if (elapsed > 12000) {
        check('流程：生成完成', false, 'timeout');
        finishFlow();
      } else {
        setTimeout(pollFlow, 200);
      }
    })();

    function finishFlow() {
      // 降级机制检查（验收 7）：execCommand 复制函数可执行、手动复制区可显示
      let legacyRet = null;
      try { legacyRet = legacyCopy('手动复制自测文本'); } catch (err) { legacyRet = 'throw: ' + err.message; }
      check('execCommand 降级复制函数可执行不抛错', typeof legacyRet === 'boolean', String(legacyRet));
      showManualCopy('手动复制自测文本');
      check('手动复制降级区可显示且文本正确',
        !manualCopyBox.hidden && manualCopyText.textContent === '手动复制自测文本');
      hideManualCopy();

      // 复制按钮反馈或手动降级（二者任一即为通过）；轮询等待剪贴板三级降级完成
      const copyBtn = resultsList.querySelector('.copy-btn');
      if (copyBtn) {
        copyBtn.click();
        const t2 = Date.now();
        (function pollCopy() {
          const status = resultsList.querySelector('.copy-status');
          const manualShown = !manualCopyBox.hidden;
          if ((status && status.textContent.indexOf('已复制') !== -1) || manualShown) {
            check('流程：复制给出明确反馈或降级方案', true,
              'status="' + (status && status.textContent) + '" manual=' + manualShown);
            out.flow.done = true;
            document.body.setAttribute('data-selftest', JSON.stringify(out));
          } else if (Date.now() - t2 > 5000) {
            check('流程：复制给出明确反馈或降级方案', false,
              'timeout status="' + (status && status.textContent) + '" manual=' + manualShown);
            out.flow.done = true;
            document.body.setAttribute('data-selftest', JSON.stringify(out));
          } else {
            setTimeout(pollCopy, 150);
          }
        })();
      } else {
        check('流程：复制按钮存在', false, 'no copy button');
        out.flow.done = true;
        document.body.setAttribute('data-selftest', JSON.stringify(out));
      }
    }
  }

  // ============================================================
  // selftest:error 模式（?selftest=error）——伪造 /api/generate 响应，
  // 验证错误分类渲染、重试按钮显隐、限流秒数、网络异常与恢复后可用（验收 4）
  // ============================================================
  function runErrorTest() {
    const out = { checks: [], steps: [], ok: true };
    const check = (name, pass, detail) => {
      out.checks.push({ name, pass: !!pass, detail: detail || '' });
      if (!pass) out.ok = false;
    };
    const done = () => {
      out.done = true;
      document.body.setAttribute('data-selftest', JSON.stringify(out));
    };

    const origFetch = window.fetch;
    let fakeMode = 'timeout';
    window.fetch = function fakeFetch(...args) {
      const url = String(args[0] && typeof args[0] === 'object' && args[0].url ? args[0].url : args[0]);
      if (url.indexOf('/api/generate') === -1) return origFetch.apply(this, args);
      if (fakeMode === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      const bodies = {
        timeout: { code: 'MODEL_TIMEOUT', message: '生成超时了，请重试。', retryable: true, retryAfterSec: 0 },
        modelerror: { code: 'MODEL_ERROR', message: '生成服务出现异常，请稍后再试。', retryable: false, retryAfterSec: 0 },
        ratelimited: { code: 'RATE_LIMITED', message: '请求太频繁了，请稍后再试。', retryable: true, retryAfterSec: 42 },
      };
      const status = fakeMode === 'ratelimited' ? 429 : 502;
      return Promise.resolve({ ok: false, status, json: async () => ({ error: bodies[fakeMode] }) });
    };

    function poll(expectText, timeoutMs, onMatch, onTimeout) {
      const t = Date.now();
      (function tick() {
        if (!errorBox.hidden && errorText.textContent.indexOf(expectText) !== -1) {
          onMatch();
        } else if (Date.now() - t > timeoutMs) {
          onTimeout();
        } else {
          setTimeout(tick, 150);
        }
      })();
    }

    inputEl.value = '老板让我背锅，怎么回应？';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    // 1) 超时错误 → 明确提示 + 重试按钮可见
    fakeMode = 'timeout';
    generateBtn.click();
    out.steps.push('send-timeout');
    poll('超时', 5000, () => {
      check('MODEL_TIMEOUT 显示明确错误提示', true, errorText.textContent);
      check('可重试错误显示重试按钮', !retryBtn.hidden);
      out.steps.push('timeout-shown');

      // 2) 不可重试错误 → 提示 + 重试按钮隐藏
      fakeMode = 'modelerror';
      retryBtn.click();
      poll('异常', 5000, () => {
        check('MODEL_ERROR 显示分类提示', true, errorText.textContent);
        check('不可重试错误隐藏重试按钮', retryBtn.hidden);
        out.steps.push('modelerror-shown');

        // 3) 限流错误 → 提示含等待秒数
        fakeMode = 'ratelimited';
        generateBtn.click();
        poll('42', 5000, () => {
          check('RATE_LIMITED 提示包含等待秒数', true, errorText.textContent);
          out.steps.push('ratelimited-shown');

          // 4) 网络异常（fetch reject）→ 明确提示，不白屏不无限转圈
          fakeMode = 'network';
          generateBtn.click();
          poll('网络', 5000, () => {
            check('网络异常显示明确提示', true, errorText.textContent);
            out.steps.push('network-shown');

            // 5) 恢复真实请求 → 重试成功，页面仍可用
            window.fetch = origFetch;
            fakeMode = '';
            generateBtn.click();
            const t5 = Date.now();
            (function pollOk() {
              if (!resultsEl.hidden) {
                check('错误恢复后重试成功，页面仍可用', true);
                out.steps.push('recovered');
                done();
              } else if (Date.now() - t5 > 8000) {
                check('错误恢复后重试成功，页面仍可用', false, 'timeout');
                done();
              } else {
                setTimeout(pollOk, 200);
              }
            })();
          }, () => { check('网络异常显示明确提示', false, errorText.textContent); done(); });
        }, () => { check('RATE_LIMITED 提示包含等待秒数', false, errorText.textContent); done(); });
      }, () => { check('MODEL_ERROR 显示分类提示', false, errorText.textContent); done(); });
    }, () => { check('MODEL_TIMEOUT 显示明确错误提示', false, errorText.textContent); done(); });
  }

  const params = new URLSearchParams(location.search);
  if (params.has('selftest')) {
    const p = params.get('selftest');
    const mode = p === 'layout' ? 'layout' : (p === 'error' ? 'error' : 'flow');
    // 等首屏渲染稳定后开始
    setTimeout(() => (mode === 'error' ? runErrorTest() : runSelfTest(mode)), 300);
  }

  // ---------------- 初始化 ----------------
  updateCharCount();
  void loadConfig();
})();
