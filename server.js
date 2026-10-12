'use strict';

const path = require('path');
const express = require('express');
const config = require('./lib/config');
const { RateLimiter } = require('./lib/rate-limit');
const { validateGenerateInput } = require('./lib/validate');
const { generate } = require('./lib/generate');

const app = express();
const limiter = new RateLimiter(60 * 1000, config.rateLimitPerMin);

app.disable('x-powered-by');

// 请求体上限 64KB（2000 字 + 换一批 avoid 的上界约 20KB，留足余量；过大直接 413 拒绝）
app.use(express.json({ limit: '64kb' }));

// 静态资源：HTML 不缓存（保证更新即生效），其余资源缓存 1 小时
app.use(
  express.static(path.join(config.root, 'public'), {
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// 健康检查（供部署探活；同时向前端下发输入上限等配置，避免两端不一致）
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mock: config.mockMode, maxInputLength: config.maxInputLength });
});

app.post('/api/generate', async (req, res) => {
  // 1. 限流（先于任何处理，防止刷接口烧配额）
  const ip = req.ip || 'unknown';
  const rl = limiter.check(ip);
  if (!rl.allowed) {
    return res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: '请求太频繁了，请稍后再试。',
        retryable: true,
        retryAfterSec: Math.max(1, Math.ceil(rl.retryAfterMs / 1000)),
      },
    });
  }

  // 2. 输入校验
  const v = validateGenerateInput(req.body, config.maxInputLength);
  if (!v.ok) {
    return res.status(400).json({ error: { code: v.code, message: v.message, retryable: false } });
  }

  // 3. 生成（任何异常都返回结构化错误，前端永不白屏）
  try {
    const result = await generate({ input: v.input, tone: v.tone, length: v.length, avoid: v.avoid });
    return res.json(result);
  } catch (err) {
    const code = err && err.code ? err.code : 'UPSTREAM_ERROR';
    const message = err && err.message ? err.message : '服务暂时不可用，请稍后再试。';
    const retryable = !(err && err.retryable === false);
    const status = code === 'MODEL_TIMEOUT' || code === 'MODEL_ERROR' || code === 'UPSTREAM_ERROR' || code === 'PARSE_ERROR' ? 502 : 500;
    // 隐私承诺：日志只记错误码与时间，绝不落用户输入原文或生成内容
    console.error(`[generate] ${new Date().toISOString()} code=${code}`);
    return res.status(status).json({
      error: { code, message, retryable, retryAfterSec: (err && err.retryAfterSec) || 0 },
    });
  }
});

// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。', retryable: false } });
});

// 页面 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(config.root, 'public', '404.html'));
});

// 全局兜底：JSON 解析失败、未捕获异常 → 结构化 JSON 错误，主流程永不白屏
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: '请求内容格式不正确。', retryable: false } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'INVALID_INPUT', message: '请求内容过大。', retryable: false } });
  }
  if (res.headersSent) return next(err);
  console.error(`[server] ${new Date().toISOString()} ${err && err.message ? err.message : err}`);
  return res.status(500).json({ error: { code: 'UPSTREAM_ERROR', message: '服务暂时不可用，请稍后再试。', retryable: true } });
});

// 限流器内存定期清理（unref：不阻止进程退出）
const pruneTimer = setInterval(() => limiter.prune(), 5 * 60 * 1000);
pruneTimer.unref();

app.listen(config.port, () => {
  console.log(`高情商回复生成器已启动：http://localhost:${config.port}`);
  if (config.mockMode) console.log('当前为 Mock 模式（不调用真实模型，返回本地样例）。');
});
