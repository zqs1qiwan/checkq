import assert from 'node:assert';
import { createLimiter } from '../src/concurrency.js';

const waits = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// 并发上限：第 3 个 acquire 必须等待
const limiter = createLimiter(2);
assert.strictEqual(limiter.limit, 2);
await limiter.acquire();
await limiter.acquire();
assert.strictEqual(limiter.active, 2);
let started = false;
const third = limiter.acquire().then(() => { started = true; });
await waits();
assert.strictEqual(started, false, '超过上限不应立刻执行');
assert.strictEqual(limiter.waiting, 1);
limiter.release();
await third;
assert.strictEqual(started, true);
assert.strictEqual(limiter.active, 2);

// 释放后按 FIFO 唤醒
limiter.release();
limiter.release();
assert.strictEqual(limiter.active, 0);

// 异常配置收敛到 1–16
for (const [input, want] of [[0, 1], [-5, 1], [99, 16], ['4', 4], ['abc', 4]]) {
  assert.strictEqual(createLimiter(input).limit, want, `${input} -> ${want}`);
}

console.log('concurrency: 8 checks passed');
