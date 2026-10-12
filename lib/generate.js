'use strict';

const config = require('./config');
const { buildSystemPrompt, buildUserMessage } = require('./prompt');
const { anySimilar } = require('./dedupe');

/** 业务错误：分类码 + 用户可读中文提示 + 是否可重试。 */
class GenerateError extends Error {
  /**
   * @param {string} code 分类码（见 server.js 错误码表）
   * @param {string} message 用户可读提示
   * @param {boolean} retryable 是否建议用户重试
   * @param {number} retryAfterSec 建议等待秒数（0 表示无）
   */
  constructor(code, message, retryable, retryAfterSec = 0) {
    super(message);
    this.name = 'GenerateError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSec = retryAfterSec;
  }
}

/** 模型服务返回 5xx/429 时视为可重试的瞬时错误。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 调用一次模型并返回解析后的 JSON 对象；失败抛 GenerateError。 */
async function fetchModelJSON(req) {
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserMessage(req) },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs);
  let res;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 1.0,
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new GenerateError('MODEL_TIMEOUT', '生成超时了，请重试。', true);
    }
    throw new GenerateError('UPSTREAM_ERROR', '无法连接生成服务，请检查网络后重试。', true);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new GenerateError('MODEL_ERROR', '模型服务密钥无效，请联系服务管理员检查配置。', false);
    }
    if (res.status === 429) {
      throw new GenerateError('MODEL_ERROR', '模型服务繁忙，请稍后再试。', true, 30);
    }
    throw new GenerateError(
      'MODEL_ERROR',
      `模型服务返回异常（${res.status}），请稍后再试。`,
      RETRYABLE_STATUS.has(res.status)
    );
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new GenerateError('PARSE_ERROR', '模型响应解析失败，请重试。', true);
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new GenerateError('PARSE_ERROR', '模型未返回有效内容，请重试。', true);
  }
  let obj = null;
  try {
    obj = JSON.parse(content);
  } catch {
    throw new GenerateError('PARSE_ERROR', '模型输出格式异常，请重试。', true);
  }
  return obj;
}

/**
 * 把模型返回的原始对象规整为统一响应结构。
 * 容错：main.text 缺失时从 alternatives 提升一条；alternatives 允许 1–2 条；
 * 全部为空时抛 PARSE_ERROR（原始文本绝不直接进页面）。
 */
function normalizeResult(obj) {
  const textOf = (x) => (typeof x === 'string' ? x.trim() : '');
  const nullable = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);

  const rawMain = obj && typeof obj.main === 'object' && obj.main !== null ? obj.main : {};
  const rawAlts = obj && Array.isArray(obj.alternatives) ? obj.alternatives : [];
  const altItems = rawAlts
    .filter((a) => a && typeof a === 'object')
    .slice(0, 2)
    .map((a) => ({ text: textOf(a.text), reason: textOf(a.reason), risk: nullable(a.risk) }))
    .filter((a) => a.text.length > 0);

  let mainItem = { text: textOf(rawMain.text), reason: textOf(rawMain.reason), risk: nullable(rawMain.risk) };
  if (!mainItem.text && altItems.length > 0) {
    mainItem = altItems.shift(); // 主推缺失时提升第一条备选
  }
  if (!mainItem.text) {
    throw new GenerateError('PARSE_ERROR', '模型输出缺少有效回复，请重试。', true);
  }
  return {
    main: mainItem,
    alternatives: altItems,
    notes: nullable(obj && obj.notes),
  };
}

/**
 * 生成入口：最多 3 次模型调用。
 * 第 1 次失败原因可重试（解析失败/超时）→ 再来；结果与上一批撞车 → 再来。
 */
async function generate(req) {
  if (config.mockMode) return mockGenerate(req);

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const obj = normalizeResult(await fetchModelJSON(req));
      const texts = [obj.main.text].concat(obj.alternatives.map((a) => a.text));
      if (req.avoid.length > 0 && anySimilar(texts, req.avoid) && attempt < 2) {
        continue; // 撞了上一批，重来一轮（「换一批」去重兜底）
      }
      return obj;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof GenerateError && err.code !== 'MODEL_ERROR';
      if (retryable && attempt < 2) continue;
      throw err;
    }
  }
  throw lastErr || new GenerateError('UPSTREAM_ERROR', '服务暂时不可用，请稍后再试。', true);
}

// ---------------------------------------------------------------------------
// Mock 模式：不调用真实模型，返回两批固定样例（换一批去重逻辑可演示、可自测）
// ---------------------------------------------------------------------------

const BATCH_A = {
  main: {
    text: '收到你的消息了。这件事我先想一想，晚点认真回复你，可以吗？',
    reason: '先接住对方的表达，同时给自己留出思考时间，不仓促表态。',
    risk: null,
  },
  alternatives: [
    {
      text: '你的意思我大概明白了，谢谢你跟我说这些。我再琢磨一下，有想法了第一时间告诉你。',
      reason: '肯定对方的表达，用「谢谢你跟我说」降低对立感。',
      risk: '若事情紧急，对方可能觉得回应不够快。',
    },
    {
      text: '这事我记下了，也理解你的感受。给我一点时间，我会认真给你一个答复。',
      reason: '表态会认真对待，同时用「理解你的感受」安抚情绪。',
      risk: null,
    },
  ],
  notes: '可根据实际情况补充细节：如希望多久内答复、目前的主要顾虑等。',
};

const BATCH_B = {
  main: {
    text: '谢谢你愿意直接跟我说，这对我很重要。你说的点我收到了，等我想清楚再跟你细聊。',
    reason: '感谢对方的坦诚，为后续沟通留下台阶。',
    risk: null,
  },
  alternatives: [
    {
      text: '好，我明白了。这件事我需要一点时间消化，回头给你确定的回复。',
      reason: '简洁确认，不敷衍也不贸然承诺。',
      risk: null,
    },
    {
      text: '别担心，你愿意告诉我就是信任我。我会认真考虑，然后跟你把话说清楚。',
      reason: '安抚对方，传递「会认真处理」的信号。',
      risk: '「别担心」在对方情绪强烈时可能显得轻描淡写。',
    },
  ],
  notes: '（Mock 模式）这是本地样例回复。配置 DEEPSEEK_API_KEY 后即可获得针对你输入内容的真实生成结果。',
};

function mockGenerate(req) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const used = new Set((req.avoid || []).map((s) => String(s).trim()));
      const aHit = [BATCH_A.main.text, ...BATCH_A.alternatives.map((a) => a.text)].some((t) => used.has(t));
      const batch = aHit ? BATCH_B : BATCH_A;
      resolve({
        main: { ...batch.main },
        alternatives: batch.alternatives.map((a) => ({ ...a })),
        notes: batch.notes,
      });
    }, config.mockDelayMs);
  });
}

module.exports = { generate, GenerateError, normalizeResult, mockGenerate };
