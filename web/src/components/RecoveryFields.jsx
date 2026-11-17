import { useEffect, useState } from 'react';

const MIN_INTERVAL = 30;
const MAX_INTERVAL = 1440;
const MAX_ATTEMPTS = 5;
const DEFAULTS = { enabled: false, intervalMinutes: 60, maxAttempts: 2 };

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 自动恢复探测配置（任务详情 / 调度弹窗共用）。
 * 默认关闭；开启后 scheduler 会按 intervalMinutes 静默探测已停用的任务。
 */
export default function RecoveryFields({ value, onChange }) {
  const v = { ...DEFAULTS, ...(value || {}) };
  const [interval, setIntervalMin] = useState(String(v.intervalMinutes));
  const [attempts, setAttempts] = useState(String(v.maxAttempts));

  // 外部切换任务 / 重新拉取详情时同步本地输入
  useEffect(() => { setIntervalMin(String(v.intervalMinutes)); }, [v.intervalMinutes]);
  useEffect(() => { setAttempts(String(v.maxAttempts)); }, [v.maxAttempts]);

  const set = (patch) => onChange?.({ ...v, ...patch });

  const commitInterval = (raw) => {
    const n = clampInt(raw, MIN_INTERVAL, MAX_INTERVAL, DEFAULTS.intervalMinutes);
    setIntervalMin(String(n));
    set({ intervalMinutes: n });
  };
  const commitAttempts = (raw) => {
    const n = clampInt(raw, 1, MAX_ATTEMPTS, DEFAULTS.maxAttempts);
    setAttempts(String(n));
    set({ maxAttempts: n });
  };

  return (
    <div className="retry-box" title="探测是真实运行，可能触发站点风控">
      <label className="checkline retry-head">
        <input type="checkbox" checked={!!v.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>失败后自动恢复探测</span>
        <span className="retry-hint">{v.enabled ? '真实运行 · 注意风控' : '默认关闭'}</span>
      </label>
      {v.enabled && (
        <>
          <div className="field-inline">
            <div className="field">
              <label>探测间隔（分钟）</label>
              <input type="number" min={MIN_INTERVAL} max={MAX_INTERVAL} value={interval} aria-label="探测间隔分钟"
                onChange={(e) => setIntervalMin(e.target.value)}
                onBlur={(e) => commitInterval(e.target.value)} />
            </div>
            <div className="field">
              <label>最多探测</label>
              <input type="number" min={1} max={MAX_ATTEMPTS} value={attempts} aria-label="最多探测次数"
                onChange={(e) => setAttempts(e.target.value)}
                onBlur={(e) => commitAttempts(e.target.value)} />
            </div>
          </div>
          <p className="retry-preview">
            每 {v.intervalMinutes} 分钟探测一次，最多 {v.maxAttempts} 次；失败后保持停用
            {v.attempts > 0 ? `，已探测 ${v.attempts}/${v.maxAttempts} 次` : ''}
            {v.exhausted ? '（已停止）' : ''}
          </p>
        </>
      )}
    </div>
  );
}
