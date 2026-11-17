/**
 * 自动恢复探测（v0.6.1）
 *
 * 自动停用后的可选补偿：按固定间隔重新跑一次任务，用来确认站点是否恢复。
 * 默认关闭；开启后也要受最小间隔与最大次数约束，避免把失败账号反复打向站点。
 *
 * 设计口径：
 *   - 只对「自动停用」（有 pausedAt、enabled=false）的任务生效；
 *   - 探测是真实运行（trigger='probe'），但静默：不发任务通知、不写外部渠道；
 *   - 探测失败不再触发自动停用，也不会缩短间隔；
 *   - 成功 → 重新启用并清掉暂停标记；失败到上限 → 停止探测并留站内记录。
 */

export const RECOVERY_MIN_INTERVAL_MINUTES = 30;
export const RECOVERY_MAX_INTERVAL_MINUTES = 1440;
export const RECOVERY_MAX_ATTEMPTS = 5;

export const DEFAULT_RECOVERY = Object.freeze({
  enabled: false,
  intervalMinutes: 60,
  maxAttempts: 2,
  attempts: 0,
  nextProbeAt: null,
  lastProbeAt: null,
  lastResult: null,
  exhausted: false,
});

function intInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function nullableTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 把用户输入 / 旧数据收敛成可安全落盘的 recovery 对象。
 * 只会保留已知字段，避免前端或手写 API 塞入任意结构。
 */
export function normalizeRecovery(input) {
  const src = input && typeof input === 'object' ? input : {};
  const enabled = src.enabled === true;
  const intervalMinutes = intInRange(
    src.intervalMinutes,
    DEFAULT_RECOVERY.intervalMinutes,
    RECOVERY_MIN_INTERVAL_MINUTES,
    RECOVERY_MAX_INTERVAL_MINUTES,
  );
  const maxAttempts = intInRange(
    src.maxAttempts,
    DEFAULT_RECOVERY.maxAttempts,
    1,
    RECOVERY_MAX_ATTEMPTS,
  );
  const attempts = intInRange(src.attempts, 0, 0, maxAttempts);
  const lastProbeAt = nullableTs(src.lastProbeAt);
  const lastResult = src.lastResult === 'success' || src.lastResult === 'failed' ? src.lastResult : null;
  // 关闭时必须清掉运行态：重新开启是一次新的探测周期。
  if (!enabled) {
    return {
      ...DEFAULT_RECOVERY,
      intervalMinutes,
      maxAttempts,
    };
  }
  const exhausted = src.exhausted === true || (attempts >= maxAttempts && lastResult === 'failed');
  return {
    enabled: true,
    intervalMinutes,
    maxAttempts,
    attempts,
    nextProbeAt: exhausted ? null : nullableTs(src.nextProbeAt),
    lastProbeAt,
    lastResult,
    exhausted,
  };
}

/** 开启探测后的下一次时间（用于首次配置 / 自动停用落库） */
export function nextProbeTime(recovery, now = Date.now()) {
  const rec = normalizeRecovery(recovery);
  if (!rec.enabled) return null;
  return now + rec.intervalMinutes * 60_000;
}

/**
 * 调度器每 60 秒对账时使用：
 *   none  = 不需要探测（没暂停 / 未开启 / 已到上限）
 *   init  = 已开启但还没算好下一次（补齐 nextProbeAt，不立即跑）
 *   wait  = 还没到时间
 *   probe = 到点了，可以跑一次
 */
export function recoveryAction(flow, now = Date.now()) {
  if (!flow || flow.enabled === true || !flow.pausedAt) return { action: 'none' };
  const rec = normalizeRecovery(flow.recovery);
  if (!rec.enabled || rec.exhausted) return { action: 'none', recovery: rec };
  if (!rec.nextProbeAt) {
    return { action: 'init', recovery: rec, nextProbeAt: nextProbeTime(rec, now) };
  }
  if (rec.nextProbeAt <= now) return { action: 'probe', recovery: rec };
  return { action: 'wait', recovery: rec };
}

/** 探测失败后的状态：次数 +1；到上限时清空下一次并标记 exhausted */
export function afterProbeFailure(recovery, now = Date.now()) {
  const rec = normalizeRecovery({ ...recovery, lastResult: 'failed', lastProbeAt: now });
  const attempts = Math.min(rec.maxAttempts, rec.attempts + 1);
  const exhausted = attempts >= rec.maxAttempts;
  return normalizeRecovery({
    ...rec,
    attempts,
    lastProbeAt: now,
    lastResult: 'failed',
    exhausted,
    nextProbeAt: exhausted ? null : now + rec.intervalMinutes * 60_000,
  });
}

/** 探测成功后的状态：清空次数与下一次，保留用户配置（enabled/interval/maxAttempts） */
export function afterProbeSuccess(recovery, now = Date.now()) {
  const rec = normalizeRecovery(recovery);
  return {
    ...rec,
    enabled: rec.enabled,
    attempts: 0,
    nextProbeAt: null,
    lastProbeAt: now,
    lastResult: 'success',
    exhausted: false,
  };
}
