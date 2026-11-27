/**
 * 连续失败后自动停用调度（v0.5.1）
 *
 * 规则：调度触发的一次运行，重试全部用尽仍失败 → 停用该任务的调度。
 * 手动 / 调试运行不动调度；成功运行不动调度。
 * 用户重新勾选「启用定时调度」即视为主动恢复，会清掉暂停标记（见 store.updateFlow）。
 */

import { normalizeRecovery, nextProbeTime } from './recovery.js';

/** 调度触发运行的标记（调度器传 'cron'，兼容旧写法 'schedule'） */
export const SCHEDULED_TRIGGERS = ['cron', 'schedule'];

/** 这次运行是否应该把任务停掉 */
export function shouldAutoPause(trigger, run) {
  if (!run || run.status !== 'failed') return false;
  // 恢复探测是「停用后的试探」，失败只能说明还没恢复，绝不能再次改调度状态。
  if (trigger === 'probe') return false;
  if (!SCHEDULED_TRIGGERS.includes(trigger)) return false;
  if (run.debug === true) return false;
  return true;
}

/**
 * 落库并重建调度。返回是否真的停用了。
 * 调用方负责把提示写进 run.finalMessage（本函数只做状态变更）。
 */
export function applyAutoPause({ store, scheduler, flowId, reason, skipRecovery = false }) {
  if (!flowId || !store) return false;
  const flow = store.getFlowRaw?.(flowId);
  if (!flow || flow.enabled !== true) return false;
  const rec = normalizeRecovery(flow.recovery);
  store.updateFlow(flowId, {
    enabled: false,
    pausedAt: Date.now(),
    pausedReason: String(reason || '连续失败'),
    recovery: rec.enabled
      ? (skipRecovery
        ? { ...rec, nextProbeAt: null, lastResult: 'failed', exhausted: true }
        : {
          ...rec,
          attempts: 0,
          nextProbeAt: nextProbeTime(rec),
          lastProbeAt: null,
          lastResult: null,
          exhausted: false,
        })
      : rec,
  });
  scheduler?.rebuild?.();
  return true;
}
