import { useCallback, useRef, useState } from 'react';

/**
 * 画布编辑历史 + 内部剪贴板（从 FlowEditor 抽出，PRD §9.2 的前置拆分）。
 * stateRef 必须是"当前 nodes/edges 的实时快照"（FlowEditor 每帧写入的那个 ref）。
 */
export function useGraphHistory({ stateRef, setNodes, setEdges, decorateEdge, markDirty, showToast, getSelectedIds, clearSelection }) {
  const historyRef = useRef({ past: [], future: [] });
  const clipboardRef = useRef(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [hasClipboard, setHasClipboard] = useState(false);

  const snapshotGraph = useCallback(() => ({
    nodes: stateRef.current.nodes.map((n) => ({ id: n.id, type: 'step', position: { ...n.position }, data: JSON.parse(JSON.stringify(n.data)) })),
    edges: stateRef.current.edges.map((e) => ({ ...e, style: e.style ? { ...e.style } : undefined })),
  }), [stateRef]);

  const pushHistory = useCallback(() => {
    historyRef.current.past.push(snapshotGraph());
    if (historyRef.current.past.length > 50) historyRef.current.past.shift();
    historyRef.current.future = [];
    setCanUndo(true);
    setCanRedo(false);
  }, [snapshotGraph]);

  const applySnapshot = useCallback((snap) => {
    setNodes(snap.nodes);
    setEdges(snap.edges);
    markDirty();
  }, [setNodes, setEdges, markDirty]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    h.future.push(snapshotGraph());
    const prev = h.past.pop();
    applySnapshot(prev);
    setCanUndo(h.past.length > 0);
    setCanRedo(true);
    clearSelection?.();
  }, [snapshotGraph, applySnapshot, clearSelection]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    h.past.push(snapshotGraph());
    const nxt = h.future.pop();
    applySnapshot(nxt);
    setCanRedo(h.future.length > 0);
    setCanUndo(true);
    clearSelection?.();
  }, [snapshotGraph, applySnapshot, clearSelection]);

  /** 复制选中节点（含两端都在选区内的连线） */
  const copySelected = useCallback(() => {
    const ids = getSelectedIds();
    if (!ids.length) { showToast('先选中节点再复制', 'fail'); return; }
    const ns = stateRef.current.nodes.filter((n) => ids.includes(n.id));
    const es = stateRef.current.edges.filter((e) => ids.includes(e.source) && ids.includes(e.target));
    clipboardRef.current = {
      nodes: ns.map((n) => ({ ...n, position: { ...n.position }, data: JSON.parse(JSON.stringify(n.data)) })),
      edges: es.map((e) => ({ ...e })),
    };
    setHasClipboard(true);
    showToast(`已复制 ${ns.length} 个节点${es.length ? ` / ${es.length} 条连线` : ''}`, 'ok');
  }, [stateRef, getSelectedIds, showToast]);

  /** 粘贴：重新生成 id、整体偏移 24px，并选中新节点 */
  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip?.nodes?.length) { showToast('剪贴板为空', 'fail'); return null; }
    pushHistory();
    const stamp = Date.now().toString(36);
    const idMap = new Map();
    const added = clip.nodes.map((n, i) => {
      const id = `n${stamp}${i}`;
      idMap.set(n.id, id);
      return { ...n, id, position: { x: (n.position?.x || 0) + 24, y: (n.position?.y || 0) + 24 }, data: { ...n.data, id } };
    });
    const newEdges = (clip.edges || []).map((e, i) => decorateEdge({
      ...e, id: `e${stamp}${i}`, source: idMap.get(e.source), target: idMap.get(e.target),
    }));
    setNodes((ns) => [...ns, ...added]);
    setEdges((es) => [...es, ...newEdges]);
    markDirty();
    showToast(`已粘贴 ${added.length} 个节点`, 'ok');
    return added;
  }, [pushHistory, setNodes, setEdges, decorateEdge, markDirty, showToast]);

  const resetClipboard = useCallback(() => {
    clipboardRef.current = null;
    setHasClipboard(false);
  }, []);

  return { pushHistory, undo, redo, canUndo, canRedo, copySelected, pasteClipboard, hasClipboard, resetClipboard, snapshotGraph };
}
