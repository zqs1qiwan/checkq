import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

/**
 * 统计面板（P0-6）：口径「近 N 天 · 本机」，全部由本机 runs 现算，不做任何上送。
 * 空库时显示 0，而不是「暂无数据」——数字是 0 就是 0，别让人以为坏了。
 */
function fmtMin(m) {
  if (m === null || m === undefined) return '—';
  if (m < 1) return '<1 分钟';
  if (m < 90) return `${Math.round(m)} 分钟`;
  const h = m / 60;
  return h < 24 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`;
}

export default function MetricsPanel() {
  const [days, setDays] = useState(7);
  const [m, setM] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.metrics(days).then(setM).catch((e) => setErr(e.message));
  }, [days]);

  return (
    <>
      <div className="field-inline" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '0 0 auto' }}>
          <label htmlFor="mt-days">统计窗口</label>
          <select id="mt-days" className="toolbar-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>近 7 天</option>
            <option value={14}>近 14 天</option>
            <option value={30}>近 30 天</option>
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 auto' }}>
          <label>口径</label>
          <div className="meta" style={{ paddingTop: 8 }}>
            <span>本机数据</span>
            <span>不外传</span>
            <span>不随备份导出</span>
          </div>
        </div>
      </div>

      {err && <p className="settings-msg err">{err}</p>}
      {!m ? <div className="empty-line">统计加载中…</div> : (
        <>
          <div className="stat-grid">
            <div className="stat-cell">
              <span className="stat-num">{m.window?.runs ?? 0}</span>
              <span className="stat-label">运行次数</span>
            </div>
            <div className="stat-cell">
              <span className={`stat-num ${(m.window?.failed || 0) > 0 ? 'fail-n' : ''}`}>{m.window?.success ?? 0}</span>
              <span className="stat-label">成功</span>
            </div>
            <div className="stat-cell">
              <span className={`stat-num ${(m.window?.failed || 0) > 0 ? 'fail-n' : ''}`}>{m.window?.failed ?? 0}</span>
              <span className="stat-label">失败</span>
            </div>
            <div className="stat-cell">
              <span className="stat-num">{m.window?.rate === null || m.window?.rate === undefined ? '—' : `${m.window.rate}%`}</span>
              <span className="stat-label">成功率</span>
            </div>
          </div>

          <div className="section-title">第一次上手到跑通</div>
          <div className="meta stat-line">
            <span>样本 <b>{m.firstRun?.samples ?? 0}</b></span>
            <span>中位 <b>{fmtMin(m.firstRun?.medianMinutes)}</b></span>
            <span>p90 <b>{fmtMin(m.firstRun?.p90Minutes)}</b></span>
          </div>

          <div className="section-title">失败后修复</div>
          <div className="meta stat-line">
            <span>样本 <b>{m.repair?.samples ?? 0}</b></span>
            <span>中位 <b>{fmtMin(m.repair?.medianMinutes)}</b></span>
          </div>

          <div className="section-title">模板复用</div>
          <div className="meta stat-line">
            <span>模板 <b>{m.template?.templates ?? 0}</b></span>
            <span>派生任务 <b>{m.template?.derivedTasks ?? 0}</b></span>
            <span>平均每个 <b>{m.template?.avgDerived ?? 0}</b></span>
          </div>

          {(m.daily || []).some((d) => d.runs > 0) && (
            <>
              <div className="section-title">每天</div>
              <div className="spark">
                {(m.daily || []).map((d) => {
                  const max = Math.max(1, ...(m.daily || []).map((x) => x.runs));
                  const h = Math.round((d.runs / max) * 34);
                  return (
                    <span key={d.date} className="spark-bar" title={`${d.date}：${d.runs} 次，失败 ${d.failed}`}>
                      <i style={{ height: Math.max(d.runs ? 3 : 0, h) }} className={d.failed ? 'has-fail' : ''} />
                    </span>
                  );
                })}
              </div>
            </>
          )}

          {m.topFlows?.length > 0 && (
            <>
              <div className="section-title">跑得最多的任务</div>
              <ul className="stat-list">
                {m.topFlows.map((f) => (
                  <li key={f.id}><span>{f.name}</span><span className="mono">{f.runs} 次</span></li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
