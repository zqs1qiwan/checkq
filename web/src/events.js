/**
 * 本地界面事件（P0-6 度量最小版）：
 *   - 白名单在服务端（/api/system/events 只接受 5 个名字），前端不自由发挥；
 *   - 只记在本机 meta.json，不随备份导出、不外传、没有开关（PRD §10.4 Q1）；
 *   - 失败一律静默：统计绝不影响主流程。
 */
export const EVENTS = {
  wizardOpen: 'wizard_open',
  pickApply: 'pick_apply',
  diagAction: 'diag_action',
  guideStep: 'guide_step',
  runQuick: 'run_quick',
};

export function recordEvent(name) {
  if (!name) return;
  try {
    const p = fetch('/api/system/events', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 离线/隐私模式直接跳过 */ }
}
