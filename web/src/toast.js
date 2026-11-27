/**
 * 全局轻提示（toast）总线 + 提示级别策略。
 * 级别：
 *   error   仅错误提示（默认，日常最安静）
 *   success 成功 + 错误
 *   all     全部提示（含信息类）
 * 级别可由用户在「设置 → 通知与汇总」里切换，服务端与 localStorage 双存。
 */
const LEVELS = ['error', 'success', 'all'];
const KEY = 'checkq-toast-level';

let level = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) || 'error';
const queue = [];

export function getToastLevel() {
  return level;
}

export function setToastLevel(next) {
  level = LEVELS.includes(next) ? next : 'error';
  try { localStorage.setItem(KEY, level); } catch { /* ignore */ }
  return level;
}

/** 是否应当显示该类型的提示 */
export function shouldShow(kind) {
  if (kind === 'fail' || kind === 'error') return true;
  if (level === 'error') return false;
  if (level === 'success') return kind === 'ok' || kind === 'success';
  return true;
}

/** 触发一条全局提示（level 不满足时静默丢弃；opts.force 可强制显示） */
export function toast(text, kind = 'info', opts = {}) {
  if (!text) return;
  if (!opts?.force && !shouldShow(kind)) return;
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: String(text), kind };
  queue.push(item);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('checkq-toast', { detail: item }));
    window.setTimeout(() => dismissToast(item.id), 5000);
  }
}

export function toastQueue() {
  return queue;
}

export function dismissToast(id) {
  const i = queue.findIndex((t) => t.id === id);
  if (i >= 0) {
    queue.splice(i, 1);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('checkq-toast'));
    }
  }
}

// 供 UI 冒烟测试触发一条提示（不改变服务端设置、不产生任何数据）
if (typeof window !== 'undefined') window.__checkqToast = toast;
