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
const POLL_INTERVAL_MS = 3000;
const MAX_RETRY_DELAY_MS = 30000;

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const RUN_STATUS_LABELS = { success: '成功', cancelled: '已取消', queued: '排队中', running: '运行中' };

function runStatus({ status, interrupted, timedOut }) {
  if (status === 'failed') return interrupted ? '已中断' : timedOut ? '超时' : '失败';
  return Object.hasOwn(RUN_STATUS_LABELS, status) ? RUN_STATUS_LABELS[status] : '未知';
}

function pageEntries({ entries = [], runs = [] }) {
  const rows = [];
  let index = 0;
  for (const { id, count, ...run } of runs) {
    if (count === 0 && entries[index]?.runId !== id) {
      rows.push({ ...run, runId: id, emptyRun: true });
    }
    while (entries[index]?.runId === id) rows.push(entries[index++]);
  }
  return rows.concat(entries.slice(index));
}

function RunDebug({ runId }) {
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    api.run(runId, { signal }).then(
      (run) => { if (!signal.aborted) setResult({ logs: run.logs || [] }); },
      () => { if (!signal.aborted) setResult({ error: true }); },
    );
    return () => controller.abort();
  }, [runId, attempt]);

  return (
    <div className="logstream-debug">
      {!result && <div className="empty" role="status">加载调试信息…</div>}
      {result?.error && (
        <div className="empty">
          <p role="alert">调试信息加载失败。</p>
          <button className="small" onClick={() => { setResult(null); setAttempt((n) => n + 1); }}>重试</button>
        </div>
      )}
      {result?.logs?.length === 0 && <div className="empty">这次运行没有调试信息。</div>}
      {result?.logs?.map((line, i) => (
        <div key={i} className={`logstream-line${line.ok ? '' : ' bad'}`}>
          <span className="logstream-ts">#{line.index}</span>
          <span className="logstream-node">{line.name}</span>
          <span className="logstream-msg">
            {line.message}
            {line.detail?.response && (
              <span className="meta" style={{ marginLeft: 8 }}>
                <span className="mono">HTTP {line.detail.response.status}</span>
                <span className="mono">{line.detail.response.ms}ms</span>
              </span>
            )}
          </span>
          {line.detail?.response?.body && (
            <pre className="logstream-body-pre">{String(line.detail.response.body).slice(0, 4000)}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

export default function LogStream({ flowId, flowName, onClose, onToast, onFix }) {
  const [entries, setEntries] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [filter, setFilter] = useState('all'); // all | error
  const [debugRun, setDebugRun] = useState(null); // 展开调试的 runId
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [exportingRun, setExportingRun] = useState(null);
  const [cancellingRun, setCancellingRun] = useState(null);
  const exportRequest = useRef(null);
  const boxRef = useRef(null);
  const olderRequest = useRef(null);
  const scrollAfterLoad = useRef(null);
  const readingHistory = useRef(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadingOlder(false);
    setError('');
    readingHistory.current = false;
    const controller = new AbortController();
    let timer;
    let retryDelay = POLL_INTERVAL_MS;
    const shouldPause = () => {
      const box = boxRef.current;
      return document.hidden || (box && box.scrollHeight - box.scrollTop - box.clientHeight > 24);
    };
    const poll = async (initial = false) => {
      if (readingHistory.current) return;
      if (!initial && shouldPause()) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      try {
        const result = await api.flowLogs(flowId, { limit: 300, signal: controller.signal });
        if (!alive || readingHistory.current) return;
        if (!initial && shouldPause()) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
          return;
        }
        const active = (result.runs || []).some((run) => run.status === 'queued' || run.status === 'running');
        scrollAfterLoad.current = { latest: true };
        setEntries(pageEntries(result));
        setNextBefore(result.hasMore ? result.nextBefore : null);
        setError('');
        retryDelay = POLL_INTERVAL_MS;
        if (active) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!alive || readingHistory.current) return;
        if (initial) {
          setError('日志加载失败，请重试。');
        } else {
          setError('日志自动刷新失败，稍后重试。');
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
          timer = setTimeout(poll, retryDelay);
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    poll(true);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
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
    if (loading || !nextBefore || olderRequest.current) return;
    readingHistory.current = true;
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
      setEntries((prev) => [...prev, ...pageEntries(r)]);
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

  useEffect(() => () => exportRequest.current?.abort(), []);

  const exportRun = async (group) => {
    if (exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExportingRun(group.runId);
    try {
      let full;
      try {
        const result = await api.run(group.runId, { signal: controller.signal });
        if (result?.id !== group.runId) throw new Error('无效的运行详情');
        full = result;
      } catch (error) {
        if (controller.signal.aborted || error.status === 401) return;
        if (error.status === 403 || !group.items.length) throw error;
      }
      if (controller.signal.aborted) return;
      const run = full ?? group;
      const name = full?.flowName || flowName || '';
      const time = fmtClock(run.startedAt ?? group.startedAt);
      const lines = [
        `# ${group.runId}`,
        `任务：${name}`,
        `时间：${time}`,
        `状态：${runStatus(run)}`,
      ];
      if (!full) lines.push('范围：部分日志，仅包含导出时已加载的记录。');
      if (run.summary) lines.push(`摘要：${run.summary}`);
      if (run.finalMessage) lines.push(`结论：${run.finalMessage}`);
      lines.push('');
      for (const line of (full ? full.logs || [] : group.items)) {
        lines.push(`[${line.ok === false ? 'ERROR' : 'OK'}] ${line.name}${line.message ? ' — ' + line.message : ''}`);
      }
      const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(name || 'task').replace(/[\\/:*?"<>|]/g, '_')}-${time.replace(/[: ]/g, '')}${full ? '' : '-部分'}.log`;
      try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
      if (!full) onToast?.('完整日志获取失败，已下载部分日志。', 'fail');
    } catch {
      onToast?.('日志导出失败，请重试。', 'fail');
    } finally {
      exportRequest.current = null;
      if (!controller.signal.aborted) setExportingRun(null);
    }
  };

  // API 由新到旧返回运行，同次运行内的步骤已经按执行顺序排列。
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.runId === e.runId) {
      if (!e.emptyRun) last.items.push(e);
      if (!last.diagnosis && e.diagnosis) last.diagnosis = e.diagnosis;
    }
    else groups.push({
      runId: e.runId, startedAt: e.startedAt, status: e.status, summary: e.summary,
      interrupted: e.interrupted, timedOut: e.timedOut,
      finalMessage: e.finalMessage, diagnosis: e.diagnosis, items: e.emptyRun ? [] : [e],
    });
  }
  const visibleGroups = groups.reverse()
    .map((g) => {
      if (g.items[0]?.position !== undefined) g.items.sort((a, b) => a.position - b.position);
      return { ...g, visibleItems: filter === 'error' ? g.items.filter((i) => !i.ok) : g.items };
    })
    .filter((g) => filter === 'all' || g.status === 'failed' || g.visibleItems.length > 0);

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
          <button className="small logstream-more" disabled={loading || loadingOlder} onClick={loadMore}>
            {loadingOlder ? '加载中…' : '加载更早的记录'}
          </button>
        )}
        <button className="small" disabled={loading || loadingOlder} onClick={() => setReload((n) => n + 1)}>
          {error && !nextBefore ? '重试' : '刷新最新日志'}
        </button>
      </div>
      {error && <div className="logstream-error" role="alert">{error}</div>}
      <div className="logstream-body" ref={boxRef}>
          {loading && <div className="empty">加载中…</div>}
          {!loading && !error && visibleGroups.length === 0 && <div className="empty">{filter === 'error' ? '当前记录中没有错误' : '暂无日志'}</div>}
          {visibleGroups.map((g) => (
            <div key={g.runId} className="logstream-group">
              <div className="logstream-run">
                <span className={`badge ${g.status === 'success' ? 'ok' : g.status === 'failed' ? 'fail' : g.status === 'cancelled' ? 'warn' : ''}`}>
                  {runStatus(g)}
                </span>
                <span className="logstream-time">{fmtClock(g.startedAt)}</span>
                <span className="logstream-count">{g.visibleItems.length} 条</span>
                {g.summary && <span className="logstream-summary">摘要：{g.summary}</span>}
                <span className="spacer" />
                {(g.status === 'running' || g.status === 'queued') && (
                  <button
                    className="small danger"
                    disabled={cancellingRun === g.runId}
                    onClick={async () => {
                      setCancellingRun(g.runId);
                      try { await api.cancelRun(g.runId); setReload((n) => n + 1); }
                      catch (e) { setError(e.message || '取消失败'); }
                      finally { setCancellingRun(null); }
                    }}
                  >
                    {cancellingRun === g.runId ? '取消中…' : '取消运行'}
                  </button>
                )}
                <button className="small icon-text" aria-expanded={debugRun === g.runId} onClick={() => setDebugRun((id) => id === g.runId ? null : g.runId)} title="查看这次运行的每步细节">
                  <IconBug size={13} /> {debugRun === g.runId ? '收起调试' : '调试'}
                </button>
                <button className="small icon-text" disabled={exportingRun !== null} onClick={() => exportRun(g)} title="导出这次运行日志为 .log 文件">
                  <IconDownload size={13} /> {exportingRun === g.runId ? '导出中…' : '导出'}
                </button>
              </div>
              {g.status === 'failed' && g.diagnosis?.cause && (
                <div className="logstream-diag">
                  <DiagnosisCard
                    diagnosis={g.diagnosis}
                    onShowResponse={() => setDebugRun(g.runId)}
                    onEditVars={(vars) => onFix?.({ type: 'edit-vars', vars })}
                    onEditAssert={(stepId) => onFix?.({ type: 'edit-assert', stepId })}
                    onToast={onToast}
                  />
                </div>
              )}
              {g.status === 'failed' && !g.diagnosis?.cause && !g.visibleItems.some((item) => !item.ok) && g.finalMessage && (
                <div className="logstream-diag">{g.finalMessage}</div>
              )}
              {g.visibleItems.map((e, i) => (
                <div key={e.position ?? i} className={`logstream-line${e.ok ? '' : ' bad'}`}>
                  <span className="logstream-ts">{fmtClock(e.startedAt).slice(6)}</span>
                  <span className="logstream-node">{e.name}</span>
                  <span className="logstream-msg">{e.message}</span>
                </div>
              ))}
              {debugRun === g.runId && <RunDebug key={`${g.status}:${g.items.length}`} runId={g.runId} />}
            </div>
          ))}
      </div>
    </Modal>
  );
}
