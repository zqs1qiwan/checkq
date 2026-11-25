import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import DiagnosisCard from './DiagnosisCard.jsx';
import { IconDownload, IconBug } from './Icons.jsx';

/**
 * 连续日志流（qinglong 面板风格）
 * - 一个面板里连续滚动显示该任务多次运行的人话日志（默认只有 log 节点输出 + 失败行）
 * - 工具栏可加载更早的记录，保留当前阅读位置
 * - 「调试」开关：展开某次运行的每步请求/响应细节（日常不需要）
 */
function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function LogStream({ flowId, flowName, onClose, onToast, onFix }) {
  const [entries, setEntries] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [filter, setFilter] = useState('all'); // all | error
  const [debugRun, setDebugRun] = useState(null); // 展开调试的 runId
  const [debugData, setDebugData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const boxRef = useRef(null);
  const olderRequest = useRef(null);
  const scrollAfterLoad = useRef(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadingOlder(false);
    setError('');
    setEntries([]);
    setNextBefore(null);
    api.flowLogs(flowId, { limit: 300 })
      .then((r) => {
        if (!alive) return;
        scrollAfterLoad.current = { latest: true };
        setEntries(r.entries || []);
        setNextBefore(r.hasMore ? r.nextBefore : null);
      })
      .catch(() => { if (alive) setError('日志加载失败，请重试。'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
      olderRequest.current = null;
      scrollAfterLoad.current = null;
    };
  }, [flowId, reload]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const target = scrollAfterLoad.current;
    scrollAfterLoad.current = null;
    if (!target || !box) return;
    if (target.latest) box.scrollTop = box.scrollHeight;
    else if (target.element.isConnected) {
      box.scrollTop += target.element.getBoundingClientRect().top - target.top;
    }
  }, [entries]);

  const loadMore = async () => {
    if (!nextBefore || olderRequest.current) return;
    const request = Symbol();
    olderRequest.current = request;
    setLoadingOlder(true);
    setError('');
    try {
      const r = await api.flowLogs(flowId, { limit: 300, before: nextBefore });
      if (olderRequest.current !== request) return;
      const box = boxRef.current;
      const edge = box.getBoundingClientRect().top;
      const element = Array.from(box.querySelectorAll('.logstream-run, .logstream-line'))
        .find((line) => line.getBoundingClientRect().bottom > edge);
      if (element) scrollAfterLoad.current = { element, top: element.getBoundingClientRect().top };
      setEntries((prev) => [...prev, ...(r.entries || [])]);
      setNextBefore(r.hasMore ? r.nextBefore : null);
    } catch {
      if (olderRequest.current === request) setError('更早的记录加载失败，请重试。');
    } finally {
      if (olderRequest.current === request) {
        olderRequest.current = null;
        setLoadingOlder(false);
      }
    }
  };

  // 导出某次运行的日志（人话日志 + 状态 + 摘要）
  const exportRun = async (group) => {
    let full = null;
    try { full = await api.run(group.runId); } catch { full = null; }
    const lines = [];
    lines.push(`# ${group.runId}`);
    lines.push(`任务：${flowName || ''}`);
    lines.push(`时间：${fmtClock(group.startedAt)}`);
    lines.push(`状态：${group.status}`);
    if (group.summary) lines.push(`摘要：${group.summary}`);
    lines.push('');
    for (const l of (full?.logs || group.items)) {
      lines.push(`[${l.ok === false ? 'ERROR' : 'OK'}] ${l.name}${l.message ? ' — ' + l.message : ''}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(flowName || 'task').replace(/[\\/:*?"<>|]/g, '_')}-${fmtClock(group.startedAt).replace(/[: ]/g, '')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggleDebug = async (runId) => {
    if (debugRun === runId) { setDebugRun(null); setDebugData(null); return; }
    setDebugRun(runId);
    setDebugData(null);
    const full = await api.run(runId).catch(() => null);
    if (full) setDebugData(full);
  };

  // API 由新到旧返回运行，同次运行内的步骤已经按执行顺序排列。
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.runId === e.runId) {
      last.items.push(e);
      if (!last.diagnosis && e.diagnosis) last.diagnosis = e.diagnosis;
    }
    else groups.push({
      runId: e.runId, startedAt: e.startedAt, status: e.status, summary: e.summary,
      interrupted: e.interrupted, timedOut: e.timedOut,
      finalMessage: e.finalMessage, diagnosis: e.diagnosis, items: [e],
    });
  }
  const visibleGroups = groups.reverse()
    .map((g) => {
      if (g.items[0].position !== undefined) g.items.sort((a, b) => a.position - b.position);
      return { ...g, items: filter === 'error' ? g.items.filter((i) => !i.ok) : g.items };
    })
    .filter((g) => g.items.length > 0);

  return (
    <Modal
      title={`日志 · ${flowName || ''}`}
      onClose={onClose}
      className="logstream-modal"
      bodyClassName="logstream-wrap"
    >
      <div className="logstream-tools">
        <button className={`small${filter === 'all' ? ' primary' : ''}`} onClick={() => setFilter('all')}>全部</button>
        <button className={`small${filter === 'error' ? ' primary' : ''}`} onClick={() => setFilter('error')}>仅错误</button>
        {nextBefore && (
          <button className="small logstream-more" disabled={loadingOlder} onClick={loadMore}>
            {loadingOlder ? '加载中…' : '加载更早的记录'}
          </button>
        )}
        {error && !nextBefore && <button className="small logstream-more" onClick={() => setReload((n) => n + 1)}>重试</button>}
      </div>
      {error && <div className="logstream-error" role="alert">{error}</div>}
      <div className="logstream-body" ref={boxRef}>
          {loading && <div className="empty">加载中…</div>}
          {!loading && !error && visibleGroups.length === 0 && <div className="empty">暂无日志</div>}
          {visibleGroups.map((g) => (
            <div key={g.runId + '@' + g.startedAt} className="logstream-group">
              <div className="logstream-run">
                <span className={`badge ${g.status === 'success' ? 'ok' : g.status === 'failed' ? 'fail' : g.status === 'cancelled' ? 'warn' : ''}`}>
                  {g.status === 'success' ? '成功' : g.status === 'failed'
                    ? (g.interrupted ? '已中断' : g.timedOut ? '超时' : '失败')
                    : g.status === 'cancelled' ? '已取消' : g.status === 'queued' ? '排队中' : '运行中'}
                </span>
                <span className="logstream-time">{fmtClock(g.startedAt)}</span>
                <span className="logstream-count">{g.items.length} 条</span>
                {g.summary && <span className="logstream-summary">摘要：{g.summary}</span>}
                <span className="spacer" />
                <button className="small icon-text" onClick={() => toggleDebug(g.runId)} title="展开这次运行的每步细节">
                  <IconBug size={13} /> {debugRun === g.runId ? '收起调试' : '调试'}
                </button>
                <button className="small icon-text" onClick={() => exportRun(g)} title="导出这次运行日志为 .log 文件">
                  <IconDownload size={13} /> 导出
                </button>
              </div>
              {g.status === 'failed' && g.diagnosis?.cause && (
                <div className="logstream-diag">
                  <DiagnosisCard
                    diagnosis={g.diagnosis}
                    onShowResponse={() => toggleDebug(g.runId)}
                    onEditVars={(vars) => onFix?.({ type: 'edit-vars', vars })}
                    onEditAssert={(stepId) => onFix?.({ type: 'edit-assert', stepId })}
                    onToast={onToast}
                  />
                </div>
              )}
              {g.items.map((e, i) => (
                <div key={e.position ?? i} className={`logstream-line${e.ok ? '' : ' bad'}`}>
                  <span className="logstream-ts">{fmtClock(e.startedAt).slice(6)}</span>
                  <span className="logstream-node">{e.name}</span>
                  <span className="logstream-msg">{e.message}</span>
                </div>
              ))}
              {debugRun === g.runId && (
                <div className="logstream-debug">
                  {debugData ? (debugData.logs || []).map((l, i) => (
                    <div key={i} className={`logstream-line${l.ok ? '' : ' bad'}`}>
                      <span className="logstream-ts">#{l.index}</span>
                      <span className="logstream-node">{l.name}</span>
                      <span className="logstream-msg">
                        {l.message}
                        {l.detail?.response && (
                          <span className="meta" style={{ marginLeft: 8 }}>
                            <span className="mono">HTTP {l.detail.response.status}</span>
                            <span className="mono">{l.detail.response.ms}ms</span>
                          </span>
                        )}
                      </span>
                      {l.detail?.response?.body && (
                        <pre className="logstream-body-pre">{String(l.detail.response.body).slice(0, 4000)}</pre>
                      )}
                    </div>
                  )) : <div className="empty">加载调试信息…</div>}
                </div>
              )}
            </div>
          ))}
      </div>
    </Modal>
  );
}
