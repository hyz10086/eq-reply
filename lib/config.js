'use strict';

const path = require('path');
const dotenv = require('dotenv');

// 项目根目录（本文件所在目录的上一级）
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

/** 读取非负整数环境变量；非法值直接抛错（启动即失败，不留隐患）。 */
function intEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`环境变量 ${name} 无效："${raw}"（应为 >= ${min} 的整数）`);
  }
  return n;
}

const mockMode = (process.env.MOCK_MODE || '0') === '1';
const apiKey = (process.env.DEEPSEEK_API_KEY || '').trim();

if (!mockMode && !apiKey) {
  throw new Error(
    '未配置 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填入密钥；' +
      '或设置 MOCK_MODE=1 以本地演示/自测模式运行（不调用真实模型）。'
  );
}

const config = {
  root: ROOT,
  port: intEnv('PORT', 3000, 1),
  mockMode,
  apiKey,
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  mockDelayMs: intEnv('MOCK_DELAY_MS', 300, 0),
  maxInputLength: intEnv('MAX_INPUT_LENGTH', 2000, 1),
  rateLimitPerMin: intEnv('RATE_LIMIT_PER_MIN', 6, 1),
  modelTimeoutMs: intEnv('MODEL_TIMEOUT_MS', 25000, 1000),
};

module.exports = config;
