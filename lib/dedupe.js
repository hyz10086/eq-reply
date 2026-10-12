'use strict';

/**
 * 简单文本相似度（字符 2-gram Jaccard），用于「换一批」去重兜底。
 * 场景：中文短句（几十到一百多字），模型偶尔会把上一批的句子换个说法又吐出来。
 * 实测该口径下，两条不相关的得体回复相似度通常 < 0.35；同义改写 > 0.6，取 0.55 分界。
 */

/** 去掉空白后提取字符 n-gram 集合。 */
function ngrams(s, n) {
  const set = new Set();
  const clean = s.replace(/\s+/g, '');
  for (let i = 0; i + n <= clean.length; i += 1) {
    set.add(clean.slice(i, i + n));
  }
  return set;
}

/** Jaccard 相似度。 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 判断两条文本是否「高度相似」。
 * @param {string} a
 * @param {string} b
 * @param {number} threshold 相似度阈值（默认 0.55）
 */
function similarEnough(a, b, threshold = 0.55) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return jaccard(ngrams(x, 2), ngrams(y, 2)) >= threshold;
}

/**
 * 候选文本是否与「上一批」列表中的任一条高度相似。
 * @param {string[]} candidateTexts 本批全部回复文本
 * @param {string[]} avoidList 上批全部回复文本
 */
function anySimilar(candidateTexts, avoidList) {
  return candidateTexts.some((t) => avoidList.some((a) => similarEnough(t, a)));
}

module.exports = { similarEnough, anySimilar };
