'use strict';

/**
 * 内存滑动窗口限流器。
 * 数据只存内存、不落盘，进程重启即清零（符合「不存储输入内容」的隐私承诺，
 * 这里连访问记录都不持久化）。
 */
class RateLimiter {
  /**
   * @param {number} windowMs 窗口毫秒数
   * @param {number} max 窗口内最大放行次数
   */
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    /** @type {Map<string, number[]>} key（如客户端 IP）→ 放行时间戳数组 */
    this.hits = new Map();
  }

  /**
   * 尝试放行一次请求。
   * @param {string} key 限流键（如客户端 IP）
   * @returns {{allowed: boolean, retryAfterMs: number}}
   */
  check(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { allowed: false, retryAfterMs: list[0] + this.windowMs - now };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 清理过期键，防止长期运行内存无限增长。 */
  prune() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      const alive = list.filter((t) => t > cutoff);
      if (alive.length === 0) this.hits.delete(key);
      else this.hits.set(key, alive);
    }
  }
}

module.exports = { RateLimiter };
