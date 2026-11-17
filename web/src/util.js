/** 共享小工具：时间格式化、敏感字段判定、渠道清单、文件下载（全站唯一来源） */

// 与服务端 secret.js 共用同一份判定，避免前后端口径漂移
export { isSensitiveName } from '../../server/src/sensitive-name.js';

const p2 = (n) => String(n).padStart(2, '0');

/** 完整日期时间：2026-11-13 08:30 */
export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 当天时刻：08:30:15 */
export function fmtClock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 */
export function fmtAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff)) return '—';
  if (diff < 0) return fmtDateTime(ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtDateTime(ts);
}

/**
 * 渠道清单唯一来源：[type, 短名（列表/详情用）, 完整标签（编辑器下拉用）]。
 * CHANNEL_LABELS 与 CHANNEL_TYPE_OPTIONS 都从这里派生，不再跨文件手工同步。
 */
export const CHANNEL_TYPE_OPTIONS = [
  ['inbox', '站内通知', '站内通知（无需外部服务）'],
  ['webhook', 'Webhook', 'Webhook（通用 JSON）'],
  ['bark', 'Bark', 'Bark（iOS）'],
  ['telegram', 'Telegram', 'Telegram Bot'],
  ['serverchan', 'Server酱', 'Server酱 Turbo'],
  ['pushplus', 'PushPlus', 'PushPlus（微信）'],
  ['dingtalk', '钉钉', '钉钉机器人'],
  ['wecom', '企业微信', '企业微信机器人'],
  ['feishu', '飞书', '飞书机器人'],
  ['gotify', 'Gotify', 'Gotify（自建推送）'],
  ['ntfy', 'ntfy', 'ntfy（自建/公共）'],
  ['email', '邮件', '邮件（SMTP）'],
];

/** 渠道 type → 短中文名（任务详情 / 列表展示） */
export const CHANNEL_LABELS = Object.fromEntries(CHANNEL_TYPE_OPTIONS.map(([k, short]) => [k, short]));

/** 下载 JSON 文件（模板导出 / 脱敏备份 / 完整备份共用） */
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 角色 → 中文名 */
export const ROLE_LABELS = { admin: '管理员', operator: '操作员', viewer: '只读' };

/** 任务级失败重试策略 → 中文描述（与后端 describeRetry 同口径） */
export function describeRetryPolicy(r) {
  if (!r || !r.enabled) return '不重试（失败即结束）';
  const name = { exponential: '指数退避', linear: '线性退避', fixed: '固定间隔' }[r.backoff] || '指数退避';
  const base = Number(r.baseDelayMs) >= 60000
    ? `${Math.round(Number(r.baseDelayMs) / 60000)} 分钟`
    : `${Math.round(Number(r.baseDelayMs) / 1000)} 秒`;
  return `最多 ${r.maxAttempts} 次 · ${name} · ${base}起`;
}

/** 悬停提示用的完整策略（含单次上限 / 抖动） */
export function describeRetryPolicyDetail(r) {
  if (!r || !r.enabled) return '失败后不重试：第一次失败即判定任务失败';
  const max = Number(r.maxDelayMs) >= 60000
    ? `单次最长 ${Math.round(Number(r.maxDelayMs) / 60000)} 分钟`
    : `单次最长 ${Math.round(Number(r.maxDelayMs) / 1000)} 秒`;
  return `${describeRetryPolicy(r)} · ${max}${r.jitter ? ' · 随机抖动' : ''}`;
}
