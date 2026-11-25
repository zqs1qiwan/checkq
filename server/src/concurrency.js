/**
 * 可取消的 FIFO 并发限制器，用于同任务串行和全局并发控制。
 */
export function createLimiter(inputLimit = 4) {
  const parsed = Number(inputLimit);
  const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(16, Math.floor(parsed))) : 4;
  let active = 0;
  const waiting = new Set();

  return {
    limit,
    get active() { return active; },
    get waiting() { return waiting.size; },
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve(false);
      if (active < limit) {
        active += 1;
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const grant = () => {
          signal?.removeEventListener('abort', cancel);
          resolve(true);
        };
        const cancel = () => {
          waiting.delete(grant);
          resolve(false);
        };
        waiting.add(grant);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    },
    release() {
      if (active === 0) return;
      const next = waiting.values().next().value;
      if (!next) {
        active -= 1;
        return;
      }
      waiting.delete(next);
      next();
    },
  };
}
