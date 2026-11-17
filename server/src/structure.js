/**
 * 流程结构分析（P0-2「结构可见」）
 *
 * 纯函数：只吃 flow（nodes/edges），不读 store、不改任何数据、不决定执行。
 * 目的：让画布、保存检查清单、大纲视图共用同一份"结构事实"，避免三处各算一套。
 *
 * 返回：
 *   {
 *     ok,                      // 没有 error 级问题
 *     entries: [nodeId],       // 起点（无入线的节点，按 x 排序；引擎只跑最左一个）
 *     entryId,                 // 实际会被执行的起点
 *     issues: [{ id, kind, level, nodeId?, handle?, message }],
 *     exits:  [{ nodeId, name, type, handle, label, connected, target }],
 *     loops:  [{ foreachId, name, nodeIds: [], closed }],
 *     orphans: [{ nodeId, name }],
 *   }
 *
 * 注意：`dangling` 只描述"没接线"，不改变引擎语义
 * （failed 未接 = 判失败；true/false/next 未接 = 链路结束且判成功）。
 */

import { STEP_TYPES } from './model.js';

/** 每种节点的默认出口（沿它走 = 主链路） */
export function defaultHandle(type) {
  if (type === 'http') return 'success';
  if (type === 'condition') return 'true';
  return 'next';
}

/** 出口的中文短名（画布标注 + 检查清单共用；单出口 = 空串，画布不标） */
export const OUTPUT_LABELS = {
  'http.success': '成功',
  'http.failed': '失败',
  'condition.true': '真',
  'condition.false': '假',
  'foreach.each': '每项',
  'foreach.next': '结束',
};

export function outputLabel(type, handle) {
  const multi = STEP_TYPES[type]?.outputs?.length > 1;
  return (multi && OUTPUT_LABELS[`${type}.${handle}`]) || '';
}

const MAX_WALK = 400; // 结构分析防环上限（与引擎 500 步不同：这里只看图）

/**
 * 分析一条流程的结构。
 * @param {object} flow { nodes, edges }
 * @param {{ loopLimit?: number }} opts loopLimit = 超过该节点数视为"循环体过大"（默认 60）
 */
export function analyzeStructure(flow, { loopLimit = 60 } = {}) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow?.edges) ? flow.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 边索引：source -> handle -> [edge]（handle 为空串表示"没带出口"的兜底边）
  const outBy = new Map();
  for (const e of edges) {
    const k = `${e.source}`;
    if (!outBy.has(k)) outBy.set(k, []);
    outBy.get(k).push(e);
  }
  const targetFor = (nodeId, handle) => {
    const list = outBy.get(nodeId) || [];
    const exact = list.filter((e) => (e.sourceHandle || '') === handle);
    const pick = exact.length ? exact : list.filter((e) => !e.sourceHandle || e.sourceHandle === '');
    return pick.length ? pick[0].target : null;
  };

  const issues = [];
  const push = (kind, level, message, extra = {}) => issues.push({ id: `${kind}:${extra.nodeId || ''}:${extra.handle || ''}`, kind, level, message, ...extra });

  // ---- 1) 起点 / 孤立 ----
  const withIn = new Set(edges.filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target).map((e) => e.target));
  const entryNodes = nodes.filter((n) => !withIn.has(n.id));
  const sorted = [...entryNodes].sort((a, b) => (Number(a.x) || 0) - (Number(b.x) || 0));
  const entryId = sorted.length ? sorted[0].id : null;
  if (!nodes.length) {
    // 空草稿：不算问题（允许空白画布）
  } else if (!entryNodes.length) {
    push('no-entry', 'error', '流程没有起点：每一步都有入线，可能成环');
  } else if (entryNodes.length > 1) {
    const names = sorted.slice(1).map((n) => `「${n.name || n.type}」`).join('、');
    push('multi-entry', 'warn', `有 ${entryNodes.length} 个起点，只会从「${sorted[0].name || sorted[0].type}」开始；${names} 不会被执行`,
      { nodeId: entryNodes[1].id });
  }

  // 可达性（沿所有边）：不可达节点 = 孤岛
  const reachable = new Set();
  if (entryId) {
    const stack = [entryId];
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of outBy.get(id) || []) if (byId.has(e.target)) stack.push(e.target);
    }
  }
  const orphans = nodes.filter((n) => !reachable.has(n.id)).map((n) => ({ nodeId: n.id, name: n.name || n.type }));
  for (const o of orphans) push('orphan', 'warn', `「${o.name}」没有接进任何链路，不会被执行`, { nodeId: o.nodeId });

  // ---- 2) 出口（每个节点 × 每个声明出口） ----
  const exits = [];
  for (const n of nodes) {
    const spec = STEP_TYPES[n.type];
    const handles = (spec?.outputs || ['next']);
    const name = n.name || (spec?.label || n.type);
    for (const h of handles) {
      const target = targetFor(n.id, h);
      const connected = !!(target && byId.has(target));
      exits.push({ nodeId: n.id, name, type: n.type, handle: h, label: outputLabel(n.type, h), connected, target: connected ? target : null });
      if (connected) continue;
      if (!spec) {
        push('unknown-type', 'error', `「${name}」的步骤类型 ${n.type} 不受支持`, { nodeId: n.id });
        break;
      }
      const label = outputLabel(n.type, h);
      if (h === 'failed') {
        push('dangling', 'info', `「${name}」的失败出口没有下一步：失败时直接判失败`, { nodeId: n.id, handle: h });
      } else if (h === 'each') {
        push('dangling', 'error', `「${name}」的循环体没有连线：这一步运行时会失败`, { nodeId: n.id, handle: h });
      } else if (label) {
        push('dangling', 'warn', `「${name}」的分支「${label}」没有下一步：走到这里就结束`, { nodeId: n.id, handle: h });
      } else {
        push('dangling', 'warn', `「${name}」之后没有下一步：链路会在这里结束`, { nodeId: n.id, handle: h });
      }
    }
  }

  // ---- 3) 循环体范围（foreach 的 each 链） ----
  const loops = [];
  for (const n of nodes.filter((x) => x.type === 'foreach')) {
    const first = targetFor(n.id, 'each');
    if (!first || !byId.has(first)) continue;
    const bodyIds = [];
    const seen = new Set();
    const tailOfLoop = targetFor(n.id, 'next');
    let cursor = first;
    let closed = false;
    while (cursor && seen.size < MAX_WALK) {
      if (seen.has(cursor)) { // 绕回自己：循环体会自己打转
        push('loop-cycle', 'warn', `「${n.name || '遍历'}」的循环体绕回了自己，执行时会提前结束这一轮`, { nodeId: cursor });
        break;
      }
      if (cursor === n.id) { // 绕回遍历节点本身
        push('loop-cycle', 'warn', `「${n.name || '遍历'}」的循环体绕回了遍历节点，执行时会提前结束`, { nodeId: cursor });
        break;
      }
      seen.add(cursor);
      bodyIds.push(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      const next = targetFor(cursor, defaultHandle(node.type));
      if (!next) { closed = true; break; }        // 循环体走到链尾
      if (next === tailOfLoop) { closed = true; break; } // 走到"结束"后继 = 循环体结束
      cursor = next;
    }
    loops.push({ foreachId: n.id, name: n.name || '遍历', nodeIds: bodyIds, closed });
    if (bodyIds.length >= loopLimit) {
      push('loop-large', 'info', `「${n.name || '遍历'}」的循环体有 ${bodyIds.length} 步，画布会默认折叠`, { nodeId: n.id });
    }
  }

  const errors = issues.filter((i) => i.level === 'error');
  return {
    ok: errors.length === 0,
    entries: entryNodes.map((n) => n.id),
    entryId,
    issues,
    exits,
    loops,
    orphans,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      dangling: issues.filter((i) => i.kind === 'dangling').length,
      errors: errors.length,
      warnings: issues.filter((i) => i.level === 'warn').length,
    },
  };
}

/**
 * 检查清单的稳定签名：同一批问题不重复弹窗（用户关掉后不再打扰）。
 */
export function structureSignature(structure) {
  return (structure?.issues || []).map((i) => i.id).sort().join('|');
}
