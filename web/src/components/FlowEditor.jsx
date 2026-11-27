import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, MarkerType, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
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
import { confirmDialog } from '../confirm.jsx';
import { CHANNEL_FIELDS } from '../channel-fields.js';
import { CHANNEL_TYPE_OPTIONS } from '../util.js';
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

/**
 * 流程图编辑器。
 * target = { kind: 'flow' | 'template', id }：
 *   - flow：编辑任务（运行/调度/存为模板等全部控件）
 *   - template：编辑模板图谱（只保留画布、节点配置、变量、日志、通知；保存走 updateTemplate）
 * 兼容旧的 flowId 传法（等同 target={kind:'flow', id:flowId}）。
 */
export default function FlowEditor({ target, flowId, onBack }) {
  const kind = target?.kind === 'template' ? 'template' : 'flow';
  const id = target?.id ?? flowId;
  return (
    <ReactFlowProvider>
      <FlowEditorInner flowId={id} kind={kind} onBack={onBack} />
    </ReactFlowProvider>
  );
}

function FlowEditorInner({ flowId, kind = 'flow', onBack }) {
  const isTemplate = kind === 'template';
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
    const load = isTemplate ? api.template(flowId) : api.flow(flowId);
    load.then((f) => {
      setFlow(f);
      setNodes((f.nodes || []).map((n) => ({
        id: n.id, type: 'step', position: { x: n.x, y: n.y }, data: { ...n },
      })));
      setEdges((f.edges || []).map((e) => decorateEdge({
        id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle,
      })));
    }).catch((e) => setLoadErr(e.message));
    // decorateEdge 是稳定纯函数（每次渲染重建但语义不变），不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, isTemplate]);

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
        const payloadNodes = ns.map((n) => ({
          id: n.id, type: n.data.type, name: n.data.name,
          x: Math.round(n.position.x), y: Math.round(n.position.y),
          config: n.data.config,
          genBy: n.data.genBy,
        }));
        const payloadEdges = es.map((e) => ({
          id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle,
        }));
        // 模板模式：整份图谱写回模板（PUT /api/templates/:id），派生任务由 store.refreshDerived 自动跟随；
        // 不新建 flow。变量由 VarsEditor 单独保存，这里不再带 vars，避免两个请求互相覆盖。
        const updated = isTemplate
          ? await api.updateTemplate(f.id, {
            nodes: payloadNodes,
            edges: payloadEdges,
            log: f.log ?? null,
            notify: f.notify || {},
          })
          : await api.updateFlow(f.id, {
            baseRev,
            nodes: payloadNodes,
            edges: payloadEdges,
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
        // 模板不直接运行，保存时不打断编辑；需要时点顶栏「结构」查看
        const s = structureRef.current;
        const sig = structureSignature(s);
        const serious = (s?.issues || []).some((i) => i.level === 'error' || i.level === 'warn');
        if (!isTemplate && serious && sig && sig !== dismissedStructRef.current) {
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
  }, [showToast, isTemplate]);

  const markDirty = useCallback(() => {
    editSeqRef.current += 1;
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(), 1500);
  }, [save]);

  /**
   * 模板模式：离开前先等正在进行的保存落地；仍有未保存修改则二次确认。
   * 任务模式保持原有行为（返回即返回）。
   */
  const handleBack = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (stateRef.current.dirty && !savePromiseRef.current) {
      await save();
    }
    if (savePromiseRef.current) {
      const ok = await savePromiseRef.current;
      if (ok === false) { showToast('保存失败，请处理后重试', 'fail'); return; }
    }
    if (stateRef.current.dirty) {
      const leave = await confirmDialog({
        title: isTemplate ? '离开模板编辑器' : '离开编辑器',
        message: '还有未保存的修改，离开后这些修改会丢失。确定返回列表吗？',
        confirmText: '放弃修改并返回',
        cancelText: '继续编辑',
        danger: true,
      });
      if (!leave) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    }
    onBack();
  }, [isTemplate, onBack, showToast]);

  // 浏览器刷新/关闭页签也拦一下（只拦真正没保存的修改）
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!stateRef.current.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

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
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      const el = e.target;
      const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (typing) return; // 输入框里的 Ctrl+Z/C/V 交给浏览器
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); }
      else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, copySelected, pasteClipboard, save]);

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

  if (loadErr) {
    return (
      <div className="boot">
        加载{isTemplate ? '模板' : '流程'}失败：{loadErr}
        <button className="small" onClick={handleBack}>返回</button>
      </div>
    );
  }
  if (!flow) return <div className="boot">加载{isTemplate ? '模板' : '流程'}…</div>;
  const empty = nodes.length === 0;

  return (
    <>
      <div className="topbar editor-topbar">
        <button className="small" onClick={handleBack}>返回</button>
        {isTemplate ? (
          <div
            className="flow-title tpl-title"
            title="当前编辑的是模板流程图。模板名称/描述/默认变量在「模板设置」里修改；保存后由模板创建的任务会自动跟随。"
          >
            模板 · {flow.name}
          </div>
        ) : (
          <input
            className="flow-title"
            value={flow.name}
            onChange={(e) => { setFlow({ ...flow, name: e.target.value }); markDirty(); }}
            onBlur={() => api.updateFlow(flow.id, { name: flow.name }).then((nf) => setFlow((cur) => ({ ...cur, rev: nf.rev }))).catch((e) => showToast(e.message))}
          />
        )}
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
        {!isTemplate && (
          <button className="small" onClick={() => setScheduleOpen(true)} title="cron / 时区 / 抖动 / 启用调度">调度</button>
        )}
        <button className={`small${showPalette ? ' active' : ''}`} onClick={() => setShowPalette((v) => !v)} title="显示/收起步骤积木">积木</button>
        <button className={`small${showConfig ? ' active' : ''}`} onClick={() => setShowConfig((v) => !v)} title="显示/收起参数面板">参数</button>
        <button className="small" onClick={layoutNow} title="按连线层级从左到右自动排列">整理</button>
        <span className="spacer" />
        {saving ? <span className="save-state" title="正在写入服务器">保存中…</span>
          : saveError ? <span className="save-state error" title={saveError}>保存失败</span>
            : dirty ? <span className="save-state dirty" title="修改后约 1.5 秒自动保存">未保存</span>
              : isTemplate ? <span className="save-state" title="修改自动保存；由该模板创建的任务会自动跟随">已保存</span> : null}
        {!isTemplate && (
          <>
            <button className="small" disabled={!runResult} onClick={() => setDrawerOpen(true)} title={runResult ? '展开运行日志' : '先运行一次'}>日志</button>
            <button className="small primary" onClick={runNow} title="从头执行整个流程">运行</button>
          </>
        )}
        <button className="iconbtn" onClick={() => setGuideOpen(true)} title="使用引导" aria-label="使用引导"><IconHelp size={16} /></button>
        <Dropdown trigger="更多" caret triggerClass="dd-menu" align="right" width={190} ariaLabel="编辑器更多操作">
          <button disabled={!canUndo} onClick={undo}>撤销</button>
          <button disabled={!canRedo} onClick={redo}>重做</button>
          <button onClick={copySelected}>复制节点</button>
          <button disabled={!hasClipboard} onClick={pasteClipboard}>粘贴节点</button>
          <div className="menu-sep" />
          <button onClick={layoutNow}>整理布局</button>
          {!isTemplate && (
            <>
              <div className="menu-sep" />
              <button onClick={runDebug} title="记录每一步的请求/响应并展开运行过程窗口"><IconBug size={14} /> 调试运行</button>
              <div className="menu-sep" />
              <button onClick={() => setDetailOpen(true)}>任务详情…</button>
            </>
          )}
          <button onClick={() => setNotifyOpen(true)}>通知渠道</button>
          {!isTemplate && <button onClick={testNotify}>测试通知</button>}
          {!isTemplate && <button onClick={() => setCookieOpen(true)}>填入 Cookie</button>}
          <button onClick={() => setLogOpen(true)}>日志配置</button>
          {!isTemplate && (
            <>
              <div className="menu-sep" />
              <button onClick={saveAsTemplate}>存为模板</button>
            </>
          )}
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
          <VarsEditor
            flow={flow}
            onVars={(vars) => {
              if (!isTemplate) return api.updateFlow(flow.id, { vars }).then(setFlow);
              // 模板模式的变量写回模板；变量名列表同步，派生任务读取时自动补默认值
              return api.updateTemplate(flow.id, { vars, varNames: Object.keys(vars) }).then((t) => {
                setFlow((cur) => ({ ...cur, vars: t.vars || vars, varNames: t.varNames || Object.keys(vars) }));
              });
            }}
          />
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
            onNodeDragStart={() => pushHistory()}
            onNodeDragStop={() => markDirty()}
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
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{isTemplate ? '空白模板' : '空白流程'}</p>
                <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 12, lineHeight: 1.7 }}>
                  {isTemplate
                    ? <>从「积木」里点 HTTP 请求开始：填 URL（支持 <code>{'{{变量}}'}</code>）→ 再加一个日志节点。保存后由这个模板创建的任务会自动跟随。</>
                    : <>从「积木」里点 HTTP 请求开始：填 URL（支持 <code>{'{{变量}}'}</code>）→ 再加一个日志节点 → 点「运行」验证。</>}
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
          onDebugTo={isTemplate ? undefined : debugTo}
          flowId={isTemplate ? undefined : flow?.id}
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

      {logOpen && (isTemplate
        ? <TemplateLogModal tpl={flow} onClose={() => setLogOpen(false)} onSaved={(t) => setFlow((cur) => ({ ...cur, log: t.log }))} />
        : <LogConfigModal flow={flow} onClose={() => setLogOpen(false)} onSaved={(f) => setFlow(f)} />)}
      {notifyOpen && (isTemplate
        ? <TemplateNotifyModal tpl={flow} onClose={() => setNotifyOpen(false)} onSaved={(t) => setFlow((cur) => ({ ...cur, notify: t.notify }))} onToast={showToast} />
        : <NotifyModal flow={flow} onClose={() => setNotifyOpen(false)} onSaved={(f) => setFlow(f)} onToast={showToast} />)}
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}

      {!isTemplate && cookieOpen && (
        <CookieHelpModal
          flow={flow}
          onClose={() => setCookieOpen(false)}
          onSaved={async (payload) => {
            if (!payload) {
              const nf = await api.flow(flow.id);
              setFlow(nf);
              showToast('cookie 已自动写入变量', 'ok');
              return nf;
            }
            const nf = await api.updateFlow(flow.id, { vars: { ...(flow.vars || {}), cookie: String(payload.cookie || '').trim() } });
            setFlow(nf);
            showToast('cookie 已保存到变量', 'ok');
            return nf;
          }}
        />
      )}

      {!isTemplate && detailOpen && (
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

      {!isTemplate && scheduleOpen && (
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

      {!isTemplate && tplOpen && (
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

/* ------------------------------------------------------------------ *
 * 模板模式的日志 / 通知配置
 * 任务版 LogConfigModal / NotifyModal 内部固定调用 api.updateFlow，
 * 模板没有 flow id，所以这里复用同样的字段与校验，保存改走 updateTemplate。
 * ------------------------------------------------------------------ */

function TemplateLogModal({ tpl, onClose, onSaved }) {
  const cur = tpl.log && typeof tpl.log === 'object' ? tpl.log : {};
  const [level, setLevel] = useState(cur.level || 'all');
  const [record, setRecord] = useState(cur.record || 'log');
  const [debug, setDebug] = useState(cur.debug === true);
  const [include, setInclude] = useState({
    reqHeaders: cur.include?.reqHeaders !== false,
    reqBody: cur.include?.reqBody !== false,
    resBody: cur.include?.resBody !== false,
    varsSnapshot: cur.include?.varsSnapshot !== false,
  });
  const [resBodyLimit, setResBodyLimit] = useState(cur.resBodyLimit ?? 2000);
  const [keywords, setKeywords] = useState(Array.isArray(cur.keywords) ? cur.keywords : []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const t = await api.updateTemplate(tpl.id, {
        log: { level, record, debug, include, resBodyLimit: Number(resBodyLimit) || 0, keywords },
      });
      onSaved(t);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const chk = (k, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={include[k]} onChange={(e) => setInclude({ ...include, [k]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <Modal
      title={`日志配置：模板 · ${tpl.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="field">
        <label title="低档位会自动忽略下方的内容开关">记录档位</label>
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">all —— 全部步骤完整记录（调试期）</option>
          <option value="failure">failure —— 仅失败步骤完整记录（稳定运行期）</option>
          <option value="summary">summary —— 只记标题/关键字/耗时（长期免维护）</option>
        </select>
      </div>
      <div className="field">
        <label title="决定运行日志里出现哪些步骤">记录范围</label>
        <select value={record} onChange={(e) => setRecord(e.target.value)}>
          <option value="log">仅 log 节点（默认：日常干净日志，只有你写的 log 才出现）</option>
          <option value="log-final">合并为一条（所有 log 合并成最终一条日志）</option>
          <option value="all">全部步骤（每个节点一行）</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={debug} onChange={(e) => setDebug(e.target.checked)} />
          调试模式（保留每步请求/响应细节；日常请关闭）
        </label>
      </div>
      <div className="field">
        <label title="仅在「全部」档位生效">记录内容开关</label>
        {chk('reqHeaders', '请求头')}
        {chk('reqBody', '请求体')}
        {chk('resBody', '响应体')}
        {chk('varsSnapshot', '运行后变量快照')}
      </div>
      <div className="field">
        <label title="单位为字符，填 0 表示不记录响应体">响应体截断长度</label>
        <input className="mono" type="number" min={0} max={100000} value={resBodyLimit} onChange={(e) => setResBodyLimit(e.target.value)} />
      </div>
      <div className="field">
        <label title="命中值进运行摘要；只影响日志与通知，不影响流程执行">关键字规则</label>
        {keywords.map((k, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input style={{ flex: 1 }} placeholder="规则名（如 积分）" value={k.name || ''} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <button className="small danger" onClick={() => setKeywords(keywords.filter((_, j) => j !== i))}>删除</button>
            </div>
            <input className="mono" placeholder="正则（第 1 捕获组为值）" value={k.regex || ''} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, regex: e.target.value } : x)))} style={{ marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={k.from || 'response'} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}>
                <option value="response">响应体</option>
                <option value="headers">响应头</option>
                <option value="status">状态码</option>
              </select>
              <select value={k.into || 'summary'} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, into: e.target.value } : x)))}>
                <option value="summary">进摘要</option>
                <option value="notify">进通知</option>
                <option value="var">写变量(仅日志侧)</option>
              </select>
            </div>
          </div>
        ))}
        <button className="small" onClick={() => setKeywords([...keywords, { name: '新规则', regex: '', from: 'response', into: 'summary' }])}>+ 添加规则</button>
      </div>
      {err && <p className="form-error">{err}</p>}
    </Modal>
  );
}

function TemplateNotifyModal({ tpl, onClose, onSaved, onToast }) {
  const cur = tpl.notify && typeof tpl.notify === 'object' ? tpl.notify : {};
  const [channels, setChannels] = useState(Array.isArray(cur.channels) ? cur.channels : []);
  const [onSuccess, setOnSuccess] = useState(cur.onSuccess !== false);
  const [onFailure, setOnFailure] = useState(cur.onFailure !== false);
  const [template, setTemplate] = useState(cur.template || '[CheckQ] {{flow.name}} {{status}}\n{{message}}');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const TYPES = CHANNEL_TYPE_OPTIONS.map(([k, , label]) => [k, label]);
  const patch = (i, k, v) => setChannels(channels.map((c, j) => (j === i ? { ...c, [k]: v } : c)));

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const t = await api.updateTemplate(tpl.id, { notify: { onSuccess, onFailure, template, channels } });
      onSaved(t);
      onToast?.('通知渠道已保存', 'ok');
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`通知渠道：模板 · ${tpl.name}`}
      onClose={onClose}
      className="notify-modal"
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={save} title="保存到模板；已创建任务的通知渠道保持不变">{busy ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <label className="checkline">
        <input type="checkbox" checked={onSuccess} onChange={(e) => setOnSuccess(e.target.checked)} />
        成功时通知
      </label>
      <label className="checkline">
        <input type="checkbox" checked={onFailure} onChange={(e) => setOnFailure(e.target.checked)} />
        失败时通知
      </label>
      <div className="field">
        <label title={'可用变量：{{flow.name}} / {{status}} / {{message}} / {{duration}} / {{time}}'}>通知模板</label>
        <textarea rows={2} className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} />
      </div>
      {channels.length === 0 && (
        <div className="notify-empty">
          还没有通知渠道。点下方「+ 添加渠道」选类型；站内通知不需要任何外部服务，消息会显示在首页铃铛里。
        </div>
      )}
      {channels.map((c, i) => (
        <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <select value={c.type || 'webhook'} onChange={(e) => patch(i, 'type', e.target.value)}>
              {TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <button className="small danger" onClick={() => setChannels(channels.filter((_, j) => j !== i))}>删除</button>
          </div>
          {(CHANNEL_FIELDS[c.type || 'webhook'] || CHANNEL_FIELDS.webhook).map(([k, label]) => (
            <div className="field" key={k} style={{ marginBottom: 8 }}>
              <label>{label}</label>
              <input className="mono" value={c[k] || ''} placeholder={label} onChange={(e) => patch(i, k, e.target.value)} />
            </div>
          ))}
        </div>
      ))}
      <button className="small" onClick={() => setChannels([...channels, { type: 'webhook', url: '' }])}>+ 添加渠道</button>
      {err && <p className="form-error">{err}</p>}
    </Modal>
  );
}
