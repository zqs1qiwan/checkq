/**
 * 全局并发限制器（v0.6.0）
 *
 * 同任务串行由 api.js 的 per-flow 队列保证；这里只限制「同时真正执行」的任务数，
 * 防止 0:0x 的排期洪峰把所有任务同时打到一个站点/一条出口。
 * 纯函数、无定时器，便于单测。
 */
export function createLimiter(inputLimit = 4) {
  const parsed = Number(inputLimit);
  const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(16, Math.floor(parsed))) : 4;
  let active = 0;
  const waiting = [];

  return {
    limit,
    get active() { return active; },
    get waiting() { return waiting.length; },
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    release() {
      if (active > 0) active -= 1;
      const next = waiting.shift();
      if (next) {
        active += 1;
        next();
      }
    },
  };
}
