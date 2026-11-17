import assert from 'node:assert';
import {
  normalizeRecovery, recoveryAction, nextProbeTime,
  afterProbeFailure, afterProbeSuccess,
  RECOVERY_MIN_INTERVAL_MINUTES, RECOVERY_MAX_INTERVAL_MINUTES, RECOVERY_MAX_ATTEMPTS,
} from '../src/recovery.js';
import { shouldAutoPause, applyAutoPause } from '../src/auto-pause.js';

// 默认关闭，避免升级后任何任务自动开始探测
const d = normalizeRecovery(undefined);
assert.strictEqual(d.enabled, false);
assert.strictEqual(d.intervalMinutes, 60);
assert.strictEqual(d.maxAttempts, 2);
assert.strictEqual(d.nextProbeAt, null);

// 非法输入收敛：间隔 30–1440，次数 1–5
assert.strictEqual(normalizeRecovery({ intervalMinutes: 5 }).intervalMinutes, RECOVERY_MIN_INTERVAL_MINUTES);
assert.strictEqual(normalizeRecovery({ intervalMinutes: 99999 }).intervalMinutes, RECOVERY_MAX_INTERVAL_MINUTES);
assert.strictEqual(normalizeRecovery({ maxAttempts: 99 }).maxAttempts, RECOVERY_MAX_ATTEMPTS);
assert.strictEqual(normalizeRecovery('bad').enabled, false);

// 关闭时清空运行态；重新开启是一次新周期
const off = normalizeRecovery({ enabled: false, attempts: 3, nextProbeAt: 123, exhausted: true });
assert.strictEqual(off.attempts, 0);
assert.strictEqual(off.nextProbeAt, null);
assert.strictEqual(off.exhausted, false);

// 只有「已暂停 + 开启 + 未耗尽」才进入探测流程
const paused = { enabled: false, pausedAt: 1000, recovery: { enabled: true, intervalMinutes: 30, maxAttempts: 2 } };
assert.strictEqual(recoveryAction({ ...paused, enabled: true }, 2000).action, 'none');
assert.strictEqual(recoveryAction({ ...paused, pausedAt: null }, 2000).action, 'none');
assert.strictEqual(recoveryAction({ ...paused, recovery: { enabled: false } }, 2000).action, 'none');

// 没有 nextProbeAt → init（补齐时间，不立即打站点）
const init = recoveryAction(paused, 2000);
assert.strictEqual(init.action, 'init');
assert.strictEqual(init.nextProbeAt, 2000 + 30 * 60_000);

// 未到点 wait；到点 probe
assert.strictEqual(recoveryAction({ ...paused, recovery: { ...paused.recovery, nextProbeAt: 2000 + 60_000 } }, 2000).action, 'wait');
assert.strictEqual(recoveryAction({ ...paused, recovery: { ...paused.recovery, nextProbeAt: 2000 } }, 2000).action, 'probe');

// 耗尽后永远不再探测
assert.strictEqual(recoveryAction({ ...paused, recovery: { ...paused.recovery, exhausted: true, nextProbeAt: 2000 } }, 2000).action, 'none');

// 失败计数与上限
const now = 10_000;
const f1 = afterProbeFailure({ enabled: true, intervalMinutes: 30, maxAttempts: 2, attempts: 0 }, now);
assert.strictEqual(f1.attempts, 1);
assert.strictEqual(f1.exhausted, false);
assert.strictEqual(f1.nextProbeAt, now + 30 * 60_000);
const f2 = afterProbeFailure(f1, now);
assert.strictEqual(f2.attempts, 2);
assert.strictEqual(f2.exhausted, true);
assert.strictEqual(f2.nextProbeAt, null);

// 成功清空排期与次数，保留配置
const s = afterProbeSuccess({ enabled: true, intervalMinutes: 30, maxAttempts: 2, attempts: 2, exhausted: true }, now);
assert.strictEqual(s.enabled, true);
assert.strictEqual(s.attempts, 0);
assert.strictEqual(s.nextProbeAt, null);
assert.strictEqual(s.lastResult, 'success');
assert.strictEqual(s.exhausted, false);

// probe 失败绝不能再次自动停用；cron/manual 的既有判定不变
assert.strictEqual(shouldAutoPause('probe', { status: 'failed' }), false);
assert.strictEqual(shouldAutoPause('cron', { status: 'failed' }), true);
assert.strictEqual(shouldAutoPause('cron', { status: 'failed', debug: true }), false);
assert.strictEqual(shouldAutoPause('manual', { status: 'failed' }), false);

// 自动停用落库时：开启探测 → 写入下一次时间；关闭 → 不写
let patch = null;
const store = {
  getFlowRaw: () => ({ enabled: true, recovery: { enabled: true, intervalMinutes: 30, maxAttempts: 2 } }),
  updateFlow: (_id, p) => { patch = p; return {}; },
};
applyAutoPause({ store, scheduler: { rebuild() {} }, flowId: 'f1', reason: '失败' });
assert.strictEqual(patch.enabled, false);
assert.ok(patch.recovery.nextProbeAt > Date.now());
assert.strictEqual(patch.recovery.attempts, 0);
patch = null;
store.getFlowRaw = () => ({ enabled: true, recovery: { enabled: false } });
applyAutoPause({ store, scheduler: { rebuild() {} }, flowId: 'f2', reason: '失败' });
assert.strictEqual(patch.recovery.nextProbeAt, null);

console.log('recovery: 38 checks passed');
