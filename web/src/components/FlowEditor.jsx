import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, MarkerType, useReactFlow,
} from '@xyflow/react';
import { api } from '../api.js';
import { STEP_TYPES, defaultConfig } from '../stepTypes.js';
import { structureSignature, defaultHandle } from '../../../server/src/structure.js';
import { currentMode, onMode } from '../theme.js';
import ThemeToggle from './ThemeToggle.jsx';
import ConfigPanel from './ConfigPanel.jsx';
import RunDrawer from './RunDrawer.jsx';
import GuideModal from './GuideModal.jsx';
import Modal from './Modal.jsx';
import Dropdown from './Dropdown.jsx';
import TaskDetailModal from './TaskDetailModal.jsx';
import { IconHelp, IconBug } from './Icons.jsx';
import { toast as globalToast } from '../toast.js';
import { recordEvent, EVENTS } from '../events.js';
import { autoLayout } from '../layout.js';
import StepNode from './editor/StepNode.jsx';
import LoopFrame from './editor/LoopFrame.jsx';
import OutlinePanel from './editor/OutlinePanel.jsx';
import StructureModal from './editor/StructureModal.jsx';
import { useStructure } from '../hooks/useStructure.js';
import { useGraphHistory } from '../hooks/useGraphHistory.js';
import { useRunStream } from '../hooks/useRunStream.js';
import { CookieHelpModal, NotifyModal, LogConfigModal, VarsEditor, ScheduleModal } from './editor/modals.jsx';

const COLOR = Object.fromEntries(Object.entries(STEP_TYPES).map(([k, v]) => [k, v.color]));
const nodeTypes = { step: StepNode };
const AUTO_FOLD_AT = 60;   // 节点数到 60 起，循环体默认折叠，只显示遍历节点本身

export default function FlowEditor({ flowId, onBack }) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner flowId={flowId} onBack={onBack} />
    </ReactFlowProvider>
  );
}

function FlowEditorInner({ flowId, onBack }) {
  const [flow, setFlow] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [focusStepId, setFocusStepId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [showPalette, setShowPalette] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth > 900));
  const [showConfig, setShowConfig] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth > 900));
  const [outlineOpen, setOutlineOpen] = useState(false);   // 大纲视图（P0-2）
  const [structOpen, setStructOpen] = useState(false);     // 结构检查清单（P0-2）
  const [foldedLoops, setFoldedLoops] = useState({});      // 循环体手动展开/折叠覆盖（P0-2）
  const [logOpen, setLogOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false); // 调度弹窗
  const [cookieOpen, setCookieOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false); // 任务详情弹窗
  const [tplName, setTplName] = useState('');
  const [tplErr, setTplErr] = useState('');
  const saveTimer = useRef(null);
  const savePromiseRef = useRef(null);
  const editSeqRef = useRef(0);
  const stateRef = useRef({});
  const structureRef = useRef(null);
  const dismissedStructRef = useRef('');   // 已被用户忽略的结构问题签名（同一批不重复弹）
  const [themeMode, setThemeMode] = useState(currentMode()); // 'dark' | 'light'（画布 attr 需要解析色值）
  const { screenToFlowPosition, fitView, setCenter } = useReactFlow();

  useEffect(() => onMode(setThemeMode), []);

  stateRef.current = { nodes, edges, flow, dirty };

  // 结构事实（P0-2）：与服务端同一个 analyzeStructure，画布标注、大纲、检查清单共用
  const structure = useStructure(nodes, edges);
  structureRef.current = structure;

  // 画布上的节点额外带上"这个出口有没有接线"（只用于渲染，保存时不会写进流程）
  // ≥60 节点时循环体默认折叠（只影响画布显示，数据与大纲不变）
  const autoFold = nodes.length >= AUTO_FOLD_AT;
  const isFolded = useCallback((foreachId) => (
    Object.prototype.hasOwnProperty.call(foldedLoops, foreachId) ? foldedLoops[foreachId] : autoFold
  ), [foldedLoops, autoFold]);
  const hiddenIds = useMemo(() => {
    const hidden = new Set();
    for (const l of structure.loops || []) {
      if (!isFolded(l.foreachId)) continue;
      for (const id of l.nodeIds || []) hidden.add(id);
    }
    return hidden;
  }, [structure, isFolded]);
  const displayNodes = useMemo(
    () => nodes
      .filter((n) => !hiddenIds.has(n.id))
      .map((n) => ({
        ...n,
        data: { ...n.data, exits: structure.exitsByNode[n.id] || {}, loopFolded: (structure.loops || []).some((l) => l.foreachId === n.id && isFolded(l.foreachId)) },
      })),
    [nodes, structure, hiddenIds, isFolded],
  );
  const displayEdges = useMemo(
    () => edges.filter((e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target)),
    [edges, hiddenIds],
  );

  // 折叠后若选中的节点被藏起来了，把选择与配置面板一并清掉，免得对着空白面板改配置
  useEffect(() => {
    if (selectedId && hiddenIds.has(selectedId)) {
      setSelectedId(null);
      setSelectedIds([]);
    }
  }, [hiddenIds, selectedId]);

  useEffect(() => {
    api.flow(flowId).then((f) => {
      setFlow(f);
      setNodes((f.nodes || []).map((n) => ({
        id: n.id, type: 'step', position: { x: n.x, y: n.y }, data: { ...n },
      })));
      setEdges((f.edges || []).map((e) => decorateEdge({
        id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle,
      })));
    }).catch((e) => setLoadErr(e.message));
  }, [flowId]);

  /**
   * 连线的样子就说明结构：失败出口用虚线 + 失败色，其余实线。
   * 只在创建/连接时计算，不改 edges 语义。
   */
  const decorateEdge = (e) => {
    const isFail = (e.sourceHandle || '') === 'failed';
    const stroke = isFail ? 'var(--fail)' : 'var(--edge, #2a3245)';
    return {
      ...e,
      animated: false,
      style: { stroke, strokeWidth: isFail ? 1.2 : 1.5, strokeDasharray: isFail ? '5 4' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
    };
  };

  const showToast = (text, kind = 'fail') => {
    globalToast(text, kind === 'ok' ? 'ok' : 'fail');
  };

  const save = useCallback(() => {
    // 单写队列：同一时间只有一次保存请求；期间的新修改由保存完成后的补存逻辑处理
    if (savePromiseRef.current) return savePromiseRef.current;
    const task = (async () => {
      const { nodes: ns, edges: es, flow: f } = stateRef.current;
      if (!f) return true;
      const seq = editSeqRef.current;
      const baseRev = Number(f.rev) || 0;
      setSaving(true);
      setSaveError('');
      try {
        const updated = await api.updateFlow(f.id, {
          baseRev,
          nodes: ns.map((n) => ({
            id: n.id, type: n.data.type, name: n.data.name,
            x: Math.round(n.position.x), y: Math.round(n.position.y),
            config: n.data.config,
            genBy: n.data.genBy,
          })),
          edges: es.map((e) => ({
            id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle,
          })),
        });
        // 只更新版本/模板信息，不回滚保存期间用户继续输入的内容
        setFlow((cur) => (cur ? {
          ...cur,
          ...(updated && Number.isFinite(updated.rev) ? { rev: updated.rev } : {}),
          ...(updated?.detached ? { template: null } : {}),
        } : cur));
        if (updated && updated.detached) {
          showToast(`已转为独立任务，不再跟随模板「${updated.detached}」`, 'ok');
        }
        if (editSeqRef.current === seq) {
          setDirty(false);
        } else {
          // 保存期间又改了画布：保持未保存状态，稍后补存，避免把新改动标成已保存
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => save(), 500);
        }
        // 保存后结构有问题 → 弹一次检查清单（只提示、可忽略，同一批不重复打扰）
        const s = structureRef.current;
        const sig = structureSignature(s);
        const serious = (s?.issues || []).some((i) => i.level === 'error' || i.level === 'warn');
        if (serious && sig && sig !== dismissedStructRef.current) {
          dismissedStructRef.current = sig;
          setStructOpen(true);
        }
        return true;
      } catch (e) {
        setSaveError(e.message);
        showToast(`保存失败: ${e.message}`);
        return false;
      } finally {
        setSaving(false);
      }
    })();
    savePromiseRef.current = task;
    task.finally(() => {
      if (savePromiseRef.current === task) savePromiseRef.current = null;
    });
    return task;
  }, [showToast]);

  const markDirty = useCallback(() => {
    editSeqRef.current += 1;
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(), 1500);
  }, [save]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId),
    [nodes, selectedId]
  );

  const updateNode = useCallback((nodeId, patch) => {
    setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  }, [setNodes, markDirty]);

  const updateConfig = useCallback((nodeId, patch) => {
    setNodes((ns) => ns.map((n) => (n.id === nodeId
      ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } }
      : n)));
    markDirty();
  }, [setNodes, markDirty]);

  // 编辑历史 + 内部剪贴板（抽到 hooks/useGraphHistory.js）
  const {
    pushHistory, undo, redo, canUndo, canRedo, copySelected: copyNodes,
    pasteClipboard: pasteNodeClipboard, hasClipboard, resetClipboard,
  } = useGraphHistory({
    stateRef,
    setNodes,
    setEdges,
    decorateEdge,
    markDirty,
    showToast,
    getSelectedIds: () => (selectedIds.length ? selectedIds : (selectedId ? [selectedId] : [])),
  });

  // 选中节点后复制/粘贴：粘贴完顺带选中新节点
  const copySelected = useCallback(() => copyNodes(), [copyNodes]);
  const pasteClipboard = useCallback(() => {
    const added = pasteNodeClipboard();
    if (added?.length) { setSelectedIds(added.map((n) => n.id)); setSelectedId(added[0].id); }
  }, [pasteNodeClipboard]);

  const onConnect = useCallback((c) => {
    pushHistory();
    setEdges((es) => addEdge(decorateEdge({ ...c, id: `e${Date.now()}` }), es));
    markDirty();
  }, [setEdges, markDirty, pushHistory]);

  const addNodeAt = useCallback((type, pos) => {
    pushHistory();
    const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    setNodes((ns) => [...ns, {
      id, type: 'step', position: pos,
      data: { id, type, name: STEP_TYPES[type].label, config: defaultConfig(type) },
    }]);
    markDirty();
  }, [setNodes, markDirty, pushHistory]);

  /** 大纲里"在这一步后面加一步"：接在该节点的默认出口（失败出口除外） */
  const addAfter = useCallback((nodeId, type) => {
    const node = stateRef.current.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    pushHistory();
    const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const out = defaultHandle(node.data?.type);
    const nx = (node.position?.x || 0) + 240;
    const ny = (node.position?.y || 0) + 40;
    setNodes((ns) => [...ns, { id, type: 'step', position: { x: nx, y: ny }, data: { id, type, name: STEP_TYPES[type].label, config: defaultConfig(type) } }]);
    setEdges((es) => {
      // 该出口已有连线时，新节点插在中间（原目标改接到新节点上），保持单链语义
      const existing = es.find((e) => e.source === nodeId && (e.sourceHandle || '') === out);
      const kept = existing ? es.filter((e) => e.id !== existing.id) : es;
      const mid = decorateEdge({ id: `e${id}`, source: nodeId, sourceHandle: out, target: id });
      const tail = existing ? decorateEdge({ ...existing, id: `e${id}b`, source: id, sourceHandle: defaultHandle(type), target: existing.target }) : null;
      return [...kept, mid, ...(tail ? [tail] : [])];
    });
    markDirty();
    setOutlineOpen(true);
  }, [pushHistory, setNodes, setEdges, markDirty]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/checkq-step');
    if (!type) return;
    addNodeAt(type, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [screenToFlowPosition, addNodeAt]);

  // 运行回显: 通过 data.runStatus 驱动节点样式(蓝=运行中/绿=成功/红=失败)
  const setRunStatus = useCallback((nodeId, status) => {
    setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, runStatus: status } } : n)));
  }, [setNodes]);
  const setRunStatusAll = useCallback((status) => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, runStatus: status } })));
  }, [setNodes]);

  // 运行 / 调试运行 / 断点调试：统一走 hooks/useRunStream.js（日志唯一入口）
  const {
    drawerOpen, setDrawerOpen, debugView, setDebugView, runResult,
    runNow, runDebug, debugTo,
  } = useRunStream({
    flowId,
    saveIfDirty: () => (stateRef.current.dirty ? save() : Promise.resolve(true)),
    setRunStatus,
    setRunStatusAll,
    showToast,
  });

  // 面板/日志坞开合后重排视口：节点多也能一屏看全，不用来回拖拽
  // （必须放在 useRunStream 之后：drawerOpen 由它提供，早引用会触发 TDZ）
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.12, duration: 220 }), 90);
    return () => clearTimeout(t);
  }, [drawerOpen, showPalette, showConfig, outlineOpen, fitView]);

  const deleteNode = useCallback((id) => {
    pushHistory();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    if (selectedId === id) setSelectedId(null);
    setSelectedIds((ids) => ids.filter((x) => x !== id));
    markDirty();
  }, [setNodes, setEdges, selectedId, markDirty, pushHistory]);

  /** 按连线层级左→右自动排列，并 fitView */
  const layoutNow = useCallback(() => {
    pushHistory();
    setNodes((ns) => autoLayout(ns, stateRef.current.edges));
    markDirty();
    setTimeout(() => fitView({ padding: 0.12, duration: 260 }), 60);
    showToast('已按层级整理布局', 'ok');
  }, [pushHistory, setNodes, markDirty, fitView, showToast]);

  /** 日志步骤 ↔ 画布节点联动：选中并居中 */
  const focusNode = useCallback((id) => {
    const n = stateRef.current.nodes.find((x) => x.id === id);
    if (!n) return;
    setSelectedId(id);
    setSelectedIds([id]);
    setCenter((n.position?.x || 0) + 130, (n.position?.y || 0) + 48, { zoom: 1.1, duration: 300 });
  }, [setCenter]);

  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (typing) return; // 输入框里的 Ctrl+Z/C/V 交给浏览器
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); }
      else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, copySelected, pasteClipboard]);

  const testNotify = async () => {
    try {
      const r = await api.notifyTest(flow.id);
      showToast(`测试通知已发送（${r.results?.length || 0} 个渠道）`, r.ok ? 'ok' : 'fail');
    } catch (e) { showToast(`测试通知失败：${e.message}`); }
  };
  const sendSummary = async () => {
    try {
      const r = await api.dailySummary(flow.id);
      showToast(r.text || '汇总已发送', 'ok');
    } catch (e) { showToast(`汇总发送失败：${e.message}`); }
  };

  const saveAsTemplate = async () => {
    if (dirty && (await save()) === false) return;
    setTplName(flow.name.replace(/\s*·\s*\d+$/, '') + ' 模板');
    setTplErr('');
    setTplOpen(true);
  };
  const confirmSaveTemplate = async () => {
    const name = (tplName || '').trim();
    if (!name) { setTplErr('模板名称不能为空'); return; }
    try {
      const t = await api.saveFlowAsTemplate(flow.id, name);
      setTplOpen(false);
      showToast(`已存为模板「${t.name}」，可在首页基于它创建多个任务`, 'ok');
    } catch (e) {
      setTplErr(`保存模板失败: ${e.message}`);
    }
  };

  const toggleEnabled = async () => {
    const f = await api.updateFlow(flow.id, { enabled: !flow.enabled });
    setFlow(f);
  };

  /** 演练任务 → 自己的任务：去掉演示标记，之后就能存为模板 / 正常调度 */
  const adoptDemo = async () => {
    const f = await api.updateFlow(flow.id, { isDemo: false, name: flow.name.replace(/演练任务 · 演示数据/, '我的任务') });
    setFlow(f);
    showToast('已转为自己的任务，把地址和凭据换成你的即可', 'ok');
  };

  // 失败重选：原位替换失败节点的提取/断言配置（PRD §4.0.5）
  const replaceFailedNode = useCallback((picked, log) => {
    const { nodes: ns, flow: f } = stateRef.current;
    if (!f || !log.stepId) return;
    const node = ns.find((n) => n.id === log.stepId);
    if (!node) return;
    if (node.data.type === 'extract' && picked.nodes?.[0]) {
      updateConfig(node.id, { ...node.data.config, ...picked.nodes[0].config, name: picked.varName || node.data.config.name });
      showToast('已原位替换提取配置，立即重跑验证', 'ok');
    } else if (picked.assert) {
      // repick=原位替换整组断言，避免追加后旧错断言仍失败（PRD §4.0.5）
      const asserts = [picked.assert];
      updateConfig(node.id, { asserts });
      showToast('已原位替换断言，立即重跑验证', 'ok');
    }
    markDirty();
  }, [updateConfig, markDirty]);

  /** 点选结果 → 画布流式生长（PRD §4.0.1） */
  const handlePickResponse = useCallback(async (picked, log) => {
    const { nodes: ns, edges: es, flow: f } = stateRef.current;
    if (!f) return;
    recordEvent(EVENTS.pickApply);

    // 1. 新增节点：接到产生该响应的 http 节点的下游链尾（引擎是单链执行器，
    //    同一出口多条边只走第一条，所以必须接在链尾而非另开分支）
    if (picked.nodes && picked.nodes.length) {
      const sourceId = log.stepId;
      const added = [];
      const edgesToAdd = [];

      // 沿默认出口（http:success / condition:true / 其他:next）找到链尾节点
      const defaultOut = (t) => (t === 'http' ? 'success' : t === 'condition' ? 'true' : 'next');
      let tailId = sourceId;
      const seen = new Set([sourceId]);
      for (;;) {
        const outEdges = es.filter((e) => e.source === tailId && (e.sourceHandle || '') === defaultOut(ns.find((n) => n.id === tailId)?.data?.type));
        const nextE = outEdges[0];
        if (!nextE || seen.has(nextE.target)) break;
        seen.add(nextE.target);
        tailId = nextE.target;
      }

      let prevId = tailId;
      for (const def of picked.nodes) {
        const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        const srcNode = ns.find((n) => n.id === prevId);
        // sourceHandle 取决于源节点的出口类型：http/condition 是分支出口，其余是 next
        const srcType = srcNode?.data?.type;
        const outHandle = (srcType === 'http' || srcType === 'condition')
          ? (srcType === 'http' ? 'success' : 'true')
          : 'next';
        added.push({
          id, type: 'step',
          position: { x: (srcNode?.position.x ?? 0) + 220, y: (srcNode?.position.y ?? 0) + (added.length) * 90 - 30 },
          data: { id, type: def.type, name: def.name, config: def.config, genBy: 'pick' },
        });
        edgesToAdd.push({
          id: `e${id}`,
          source: prevId, target: id,
          sourceHandle: outHandle,
        });
        prevId = id;
      }
      setNodes((cur) => [...cur, ...added]);
      setEdges((cur) => [...cur, ...edgesToAdd.map((e) => decorateEdge(e))]);
      markDirty();
      showToast(`已生成 ${added.length} 个节点（沿响应节点 success 边连接）`, 'ok');
      return;
    }

    // 2. 断言：合并进产生该响应的 http 节点
    if (picked.assert) {
      const nodeId = log.stepId;
      const node = ns.find((n) => n.id === nodeId);
      if (node) {
        const asserts = [...(node.data.config?.asserts || []), picked.assert];
        updateConfig(nodeId, { asserts });
        showToast('已合并断言到该请求节点（可编辑）', 'ok');
      }
      return;
    }

    // 3. 关键字规则：合并进 flow.log.keywords
    if (picked.keyword) {
      const logCfg = f.log && typeof f.log === 'object' ? f.log : { level: 'all', include: {}, keywords: [] };
      const keywords = [...(logCfg.keywords || []), picked.keyword];
      const newLog = { ...logCfg, keywords };
      const nf = await api.updateFlow(f.id, { log: newLog });
      setFlow(nf);
      showToast(`已添加关键字规则「${picked.keyword.name}」`, 'ok');
    }
  }, [setNodes, setEdges, markDirty, updateConfig]);

  if (loadErr) return <div className="boot">加载失败：{loadErr} <button className="small" onClick={onBack}>返回</button></div>;
  if (!flow) return <div className="boot">加载流程…</div>;
  const empty = nodes.length === 0;

  return (
    <>
      <div className="topbar editor-topbar">
        <button className="small" onClick={onBack}>返回</button>
        <input
          className="flow-title"
          value={flow.name}
          onChange={(e) => { setFlow({ ...flow, name: e.target.value }); markDirty(); }}
          onBlur={() => api.updateFlow(flow.id, { name: flow.name }).then((nf) => setFlow((cur) => ({ ...cur, rev: nf.rev }))).catch((e) => showToast(e.message))}
        />
        {flow.template && (
          <span className="chip chip-mute tpl-chip" title={`流程始终跟随模板「${flow.template.name}」；改这里的流程会把这个任务转成独立任务`}>
            模板 {flow.template.name}
          </span>
        )}
        {flow.isDemo && (
          <button className="chip chip-demo" onClick={adoptDemo} title="演示数据只用来试跑；点一下换成你自己的站点">
            演示 · 换成我的站点
          </button>
        )}
        <button
          className={`small structure-btn${structure.issues?.length ? ' has-issue' : ''}`}
          onClick={() => setStructOpen(true)}
          title="检查断头出口、孤岛步骤、多起点"
        >
          结构{structure.issues?.length ? ` · ${structure.issues.length}` : ''}
        </button>
        <button className={`small${outlineOpen ? ' active' : ''}`} onClick={() => setOutlineOpen((v) => !v)} title="把流程图拍成能读的清单">大纲</button>
        <button className="small" onClick={() => setScheduleOpen(true)} title="cron / 时区 / 抖动 / 启用调度">调度</button>
        <button className={`small${showPalette ? ' active' : ''}`} onClick={() => setShowPalette((v) => !v)} title="显示/收起步骤积木">积木</button>
        <button className={`small${showConfig ? ' active' : ''}`} onClick={() => setShowConfig((v) => !v)} title="显示/收起参数面板">参数</button>
        <button className="small" onClick={layoutNow} title="按连线层级从左到右自动排列">整理</button>
        <span className="spacer" />
        {saving ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>保存中…</span>
          : saveError ? <span style={{ color: 'var(--fail)', fontSize: 12 }} title={saveError}>保存失败</span>
            : dirty ? <span style={{ color: 'var(--warn)', fontSize: 12 }}>未保存</span> : null}
        <button className="small" disabled={!runResult} onClick={() => setDrawerOpen(true)} title={runResult ? '展开运行日志' : '先运行一次'}>日志</button>
        <button className="small primary" onClick={runNow} title="从头执行整个流程">运行</button>
        <button className="iconbtn" onClick={() => setGuideOpen(true)} title="使用引导" aria-label="使用引导"><IconHelp size={16} /></button>
        <Dropdown trigger="更多" caret triggerClass="dd-menu" align="right" width={170} ariaLabel="编辑器更多操作">
          <button disabled={!canUndo} onClick={undo}>撤销</button>
          <button disabled={!canRedo} onClick={redo}>重做</button>
          <button onClick={copySelected}>复制节点</button>
          <button disabled={!hasClipboard} onClick={pasteClipboard}>粘贴节点</button>
          <div className="menu-sep" />
          <button onClick={layoutNow}>整理布局</button>
          <div className="menu-sep" />
          <button onClick={runDebug} title="记录每一步的请求/响应并展开运行过程窗口"><IconBug size={14} /> 调试运行</button>
          <div className="menu-sep" />
          <button onClick={() => setDetailOpen(true)}>任务详情…</button>
          <button onClick={() => setNotifyOpen(true)}>通知渠道</button>
          <button onClick={testNotify}>测试通知</button>
          <button onClick={() => setCookieOpen(true)}>填入 Cookie</button>
          <button onClick={() => setLogOpen(true)}>日志配置</button>
          <button onClick={saveAsTemplate}>存为模板</button>
        </Dropdown>
        <ThemeToggle />
      </div>

      <div className={`editor${showPalette ? '' : ' no-palette'}${showConfig ? '' : ' no-config'}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="editor-main">
        <div className="palette">
          <div className="panel-head">
            <h4>步骤积木</h4>
            <button className="linkbtn" onClick={() => setShowPalette(false)}>收起</button>
          </div>
          {Object.entries(STEP_TYPES).map(([type, meta]) => (
            <div
              key={type}
              className="item"
              draggable
              title="点击直接加到画布，或拖到画布指定位置"
              onDragStart={(e) => e.dataTransfer.setData('application/checkq-step', type)}
              onClick={() => addNodeAt(type, { x: 80 + (nodes.length % 3) * 40, y: 60 + (nodes.length % 3) * 40 })}
            >
              <span className="dot" style={{ background: meta.color }} />
              {meta.label}
            </div>
          ))}
          <div className="hint">
            点击左侧积木直接加到画布<br />
            或拖拽到画布添加节点<br />
            拉动节点右侧圆点连线<br />
            点节点配置，Delete 删除
          </div>
          <div className="section-title">流程变量</div>
          <VarsEditor flow={flow} onVars={(vars) => api.updateFlow(flow.id, { vars }).then(setFlow)} />
        </div>

        {outlineOpen && (
          <OutlinePanel
            nodes={nodes}
            edges={edges}
            structure={structure}
            onFocus={focusNode}
            onAddAfter={addAfter}
            onClose={() => setOutlineOpen(false)}
          />
        )}

        <div className="canvas-wrap">
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={(chg) => { onNodesChange(chg); if (chg.some((c) => c.type === 'position' || c.type === 'remove')) markDirty(); }}
            onEdgesChange={(chg) => { onEdgesChange(chg); if (chg.some((c) => c.type === 'remove')) markDirty(); }}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            multiSelectionKeyCode={['Meta', 'Control']}
            onSelectionChange={(p) => setSelectedIds((p.nodes || []).map((n) => n.id))}
            onNodeClick={(_, n) => { setSelectedId(n.id); setSelectedIds([n.id]); setFocusStepId(n.id); }}
            onPaneClick={() => { setSelectedId(null); setSelectedIds([]); setFocusStepId(null); }}
            deleteKeyCode={['Delete', 'Backspace']}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color={themeMode === 'dark' ? '#232933' : '#d8d2c6'} gap={22} />
            <Controls />
            <MiniMap
              pannable
              nodeColor={(n) => COLOR[n.data.type] || '#666'}
              maskColor={themeMode === 'dark' ? 'rgba(15,17,21,.7)' : 'rgba(244,242,237,.72)'}
              style={{ background: themeMode === 'dark' ? '#161a20' : '#fffefa' }}
            />
            <LoopFrame
              loops={structure.loops}
              nodes={nodes}
              isFolded={isFolded}
              onToggle={(id) => setFoldedLoops((m) => ({ ...m, [id]: !isFolded(id) }))}
              onFocus={focusNode}
            />
          </ReactFlow>

          {empty && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
              <div style={{ background: 'var(--panel)', border: '1px dashed var(--border)', borderRadius: 14, padding: '26px 32px', textAlign: 'center', pointerEvents: 'auto', maxWidth: 420 }}>
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>空白流程</p>
                <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 12, lineHeight: 1.7 }}>
                  从「积木」里点 HTTP 请求开始：填 URL（支持 <code>{'{{变量}}'}</code>）→ 再加一个日志节点 → 点「运行」验证。
                </p>
                <button className="small primary" onClick={() => addNodeAt('http', { x: 80, y: 60 })}>+ 加一个 HTTP 请求</button>
              </div>
            </div>
          )}
        </div>

        <ConfigPanel
          node={selectedNode?.data}
          onUpdate={(patch) => updateNode(selectedId, patch)}
          onConfigUpdate={(p) => updateConfig(selectedId, p)}
          onDelete={() => deleteNode(selectedId)}
          onDebugTo={debugTo}
          flowId={flow?.id}
          flowVars={flow?.vars || {}}
          onCollapse={() => setShowConfig(false)}
        />
        </div>

        {drawerOpen && (
          <RunDrawer
            run={runResult}
            flowId={flow.id}
            onClose={() => setDrawerOpen(false)}
            onPickResponse={handlePickResponse}
            onRepPick={replaceFailedNode}
            debug={debugView}
            onDebugChange={setDebugView}
            focusStepId={focusStepId}
            onFocusStep={focusNode}
            onEditVars={() => { setShowPalette(true); showToast('变量在左侧展开', 'ok'); }}
            onEditAssert={(stepId) => { setShowConfig(true); focusNode(stepId); }}
          />
        )}
      </div>

      {logOpen && <LogConfigModal flow={flow} onClose={() => setLogOpen(false)} onSaved={(f) => setFlow(f)} />}
      {notifyOpen && <NotifyModal flow={flow} onClose={() => setNotifyOpen(false)} onSaved={(f) => setFlow(f)} onToast={showToast} />}
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}

      {cookieOpen && (
        <CookieHelpModal
          flow={flow}
          onClose={() => setCookieOpen(false)}
          onSaved={async ({ cookie }) => {
            const nf = await api.updateFlow(flow.id, { vars: { ...(flow.vars || {}), cookie: cookie.trim() } });
            setFlow(nf);
            showToast('cookie 已保存到变量', 'ok');
            return nf;
          }}
        />
      )}

      {detailOpen && (
        <TaskDetailModal
          summary={{
            id: flow.id, name: flow.name, note: flow.note, enabled: flow.enabled,
            nodesCount: (flow.nodes || []).length, template: flow.template,
          }}
          onClose={() => setDetailOpen(false)}
          onSaved={(nf) => setFlow(nf)}
          onToast={(text, kind) => showToast(text, kind)}
        />
      )}

      {scheduleOpen && (
        <ScheduleModal
          flow={flow}
          onClose={() => setScheduleOpen(false)}
          onSave={async (patch) => {
            const nf = await api.updateFlow(flow.id, patch);
            setFlow((cur) => ({ ...cur, ...patch, ...(Number.isFinite(nf.rev) ? { rev: nf.rev } : {}) }));
            return nf;
          }}
        />
      )}

      {tplOpen && (
        <Modal
          title="存为模板"
          onClose={() => setTplOpen(false)}
          footer={
            <>
              <button onClick={() => setTplOpen(false)}>取消</button>
              <button className="primary" onClick={confirmSaveTemplate}>保存为模板</button>
            </>
          }
        >
          <div className="field">
            <label>模板名称</label>
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="如：每日签到模板" />
          </div>
          {tplErr && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{tplErr}</p>}
        </Modal>
      )}
      {structOpen && (
        <StructureModal structure={structure} onClose={() => setStructOpen(false)} onFocus={focusNode} />
      )}

    </>
  );
}
