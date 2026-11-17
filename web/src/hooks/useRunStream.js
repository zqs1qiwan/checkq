import { useCallback, useState } from 'react';
import { api } from '../api.js';

/**
 * 运行 / 调试运行 / 断点调试三件事的公共部分（从 FlowEditor 抽出）：
 * 打开日志坞、把 SSE 日志灌进结果对象、把每一步的状态回显到画布。
 * 并集到一处，保证"日志唯一入口"（不变量 6）——画布状态、抽屉、结束提示都来自同一个结果对象。
 */
export function useRunStream({ flowId, saveIfDirty, setRunStatus, setRunStatusAll, showToast }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [debugView, setDebugView] = useState(false);
  const [runResult, setRunResult] = useState(null);

  const applyFinal = useCallback((r) => {
    setRunResult(r);
    for (const log of r.logs || []) {
      if (log.ok === false) setRunStatus(log.stepId, 'failed');
      else setRunStatus(log.stepId, 'ok');
    }
  }, [setRunStatus]);

  const run = useCallback(async ({ debug = false, debugStopId = null } = {}) => {
    if (saveIfDirty) await saveIfDirty();
    setDrawerOpen(true);
    if (debug) setDebugView(true);
    setRunResult({ id: 'pending', status: 'running', logs: [] });
    try {
      const r = await api.runFlowStream(flowId, {
        debugStopId,
        debug,
        onStart: () => {
          setRunResult({ id: 'pending', status: 'running', logs: [] });
          setRunStatusAll(null);
        },
        onLog: (log) => {
          setRunResult((cur) => ({ ...cur, status: 'running', logs: [...(cur.logs || []), log] }));
          setRunStatus(log.stepId, log.ok === false ? 'failed' : 'running');
        },
      });
      if (r && r.deduped) {
        // 同一任务已有一次运行在跑：不重复提交，只提示（P0-4）
        setRunResult({ id: 'busy', status: 'running', logs: [], finalMessage: r.message || '已在运行' });
        showToast('已在运行，本次未重复提交', 'fail');
        return r;
      }
      applyFinal(r);
      return r;
    } catch (e) {
      setRunResult({ id: 'err', status: 'failed', logs: [], finalMessage: e.message, durationMs: 0 });
      if (debug) showToast(`调试运行失败: ${e.message}`, 'fail');
      return null;
    }
  }, [flowId, saveIfDirty, applyFinal, setRunStatus, setRunStatusAll, showToast]);

  const runNow = useCallback(() => run({}), [run]);
  const runDebug = useCallback(async () => {
    const r = await run({ debug: true });
    if (r && !r.deduped) showToast(`调试运行完成（${r.logs?.length || 0} 步）`, r.status === 'success' ? 'ok' : 'fail');
  }, [run, showToast]);
  const debugTo = useCallback((nodeId) => run({ debug: true, debugStopId: nodeId }), [run]);

  return { drawerOpen, setDrawerOpen, debugView, setDebugView, runResult, setRunResult, runNow, runDebug, debugTo };
}
