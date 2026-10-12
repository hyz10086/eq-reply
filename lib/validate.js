'use strict';

/** 按 Unicode 码点计数字符数（emoji 等算 1 个字符，与前端口径一致）。 */
const countChars = (s) => Array.from(s).length;

const TONES = ['warm', 'formal', 'humorous'];
const LENGTHS = ['short', 'medium', 'long'];

/**
 * 校验生成请求体。
 * 规则（与产品约束一致）：
 * - input 必须为字符串，trim 后非空；
 * - 超过 maxLength 直接拒绝，不静默截断（前端已实时拦截，这里是服务端兜底）；
 * - 纯表情 / 纯符号 / 乱码：不拒绝，交给模型给出通用回复；
 * - avoid 为「换一批」去重用的上批文本，最多保留 6 条、每条截到 500 字符。
 *
 * @returns {{ok: true, input: string, tone: string, length: string, avoid: string[]}
 *          | {ok: false, code: string, message: string}}
 */
function validateGenerateInput(body, maxLength) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'INVALID_INPUT', message: '请求格式不正确。' };
  }
  const input = typeof body.input === 'string' ? body.input : '';
  if (input.trim().length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: '请先输入对方的话或描述一下场景。' };
  }
  if (countChars(input) > maxLength) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `输入过长：当前 ${countChars(input)} 字，上限 ${maxLength} 字。请删减后重试。`,
    };
  }
  const tone = typeof body.tone === 'string' ? body.tone : 'warm';
  const length = typeof body.length === 'string' ? body.length : 'medium';
  if (!TONES.includes(tone)) {
    return { ok: false, code: 'INVALID_INPUT', message: '语气选项无效。' };
  }
  if (!LENGTHS.includes(length)) {
    return { ok: false, code: 'INVALID_INPUT', message: '长度选项无效。' };
  }
  const avoid = Array.isArray(body.avoid)
    ? body.avoid
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 6)
        .map((s) => s.slice(0, 500))
    : [];
  return { ok: true, input, tone, length, avoid };
}

module.exports = { validateGenerateInput, countChars };
