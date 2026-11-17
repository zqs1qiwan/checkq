/**
 * 度量最小版（P0-6）
 *
 * 纯函数：从 flows + runs 聚合四个数字。不落库、不上报、不埋第三方 SDK。
 *
 *   1) 首跑用时：任务创建 → 第一次运行 的时间差（中位数 / P90）
 *   2) 修复用时：一次失败 → 同一任务下一次成功 的时间差（中位数）
 *   3) 模板复用：模板数、派生任务数、平均派生数
 *   4) 成功率：近 N 天整体成功率 + 每日序列 + 每个任务的成功率
 *
 * 口径见 docs/PRD.md §7；空库全部返回 0（不是 null），保证界面不用做特判。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function median(list) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function dayKey(ms) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * @param {{ flows: object[], runs: object[], templates?: object[], days?: number, now?: number }} input
 */
export function computeMetrics({ flows = [], runs = [], templates = [], days = 7, now = Date.now() } = {}) {
  const spanDays = Math.min(90, Math.max(1, Number(days) || 7));
  const since = now - spanDays * DAY_MS;

  // ---- 4) 成功率（窗口内 + 每日） ----
  const inWindow = runs.filter((r) => num(r.startedAt) >= since);
  const succ = inWindow.filter((r) => r.status === 'success').length;
  const fail = inWindow.filter((r) => r.status === 'failed').length;
  const rate = inWindow.length ? Math.round((succ / inWindow.length) * 100) : 0;

  const daily = [];
  for (let i = spanDays - 1; i >= 0; i--) {
    const day = dayKey(now - i * DAY_MS);
    const list = inWindow.filter((r) => dayKey(num(r.startedAt)) === day);
    const s = list.filter((r) => r.status === 'success').length;
    daily.push({ date: day, runs: list.length, success: s, failed: list.filter((r) => r.status === 'failed').length, rate: list.length ? Math.round((s / list.length) * 100) : null });
  }

  const byFlow = new Map();
  for (const r of inWindow) {
    const rec = byFlow.get(r.flowId) || { runs: 0, success: 0 };
    rec.runs++;
    if (r.status === 'success') rec.success++;
    byFlow.set(r.flowId, rec);
  }
  const topFlows = [...byFlow.entries()]
    .map(([id, rec]) => {
      const f = flows.find((x) => x.id === id);
      return { id, name: f ? f.name : '已删除', runs: rec.runs, rate: Math.round((rec.success / rec.runs) * 100) };
    })
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 8);

  // ---- 1) 首跑用时：创建 → 第一次运行 ----
  const firstRunGaps = [];
  for (const f of flows) {
    const created = num(f.createdAt);
    const firsts = runs
      .filter((r) => r.flowId === f.id && num(r.startedAt) >= created)
      .map((r) => num(r.startedAt));
    if (!firsts.length) continue;
    firstRunGaps.push(Math.max(0, Math.min(...firsts) - created));
  }

  // ---- 2) 修复用时：失败 → 同任务下一次成功 ----
  const repairGaps = [];
  const sorted = [...runs].sort((a, b) => num(a.startedAt) - num(b.startedAt));
  const pendingFail = new Map(); // flowId → 该次失败的时间
  for (const r of sorted) {
    if (r.status === 'failed') { pendingFail.set(r.flowId, num(r.startedAt)); continue; }
    if (r.status === 'success' && pendingFail.has(r.flowId)) {
      repairGaps.push(Math.max(0, num(r.startedAt) - pendingFail.get(r.flowId)));
      pendingFail.delete(r.flowId);
    }
  }

  // ---- 3) 模板复用 ----
  const liveTemplates = templates.length;
  const derived = flows.filter((f) => f.tplId).length;

  const minutes = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.round((ms / 60000) * 10) / 10 : 0);

  return {
    generatedAt: new Date(now).toISOString(),
    days: spanDays,
    window: { runs: inWindow.length, success: succ, failed: fail, rate },
    daily,
    firstRun: {
      samples: firstRunGaps.length,
      medianMinutes: minutes(median(firstRunGaps)),
      p90Minutes: minutes(percentile(firstRunGaps, 90)),
    },
    repair: {
      samples: repairGaps.length,
      medianMinutes: minutes(median(repairGaps)),
    },
    template: {
      templates: liveTemplates,
      derivedTasks: derived,
      avgDerived: liveTemplates ? Math.round((derived / liveTemplates) * 10) / 10 : 0,
    },
    topFlows,
    totals: {
      flows: flows.length,
      enabled: flows.filter((f) => f.enabled).length,
      runs: runs.length,
    },
    localOnly: true,
  };
}

/** 本地界面事件（只存本机 meta，不外传）：白名单 + 计数 */
export const EVENT_NAMES = ['wizard_open', 'pick_apply', 'diag_action', 'guide_step', 'run_quick'];

/** 事件累计（跨会话保留，最多 500 条命名计数） */
export function bumpEvents(prev, name) {
  const base = { ...(prev || {}) };
  if (!EVENT_NAMES.includes(name)) return base;
  base[name] = Math.min(99999, num(base[name]) + 1);
  base.lastAt = Date.now();
  return base;
}
