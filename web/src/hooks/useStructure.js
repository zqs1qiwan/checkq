import { useMemo } from 'react';
import { analyzeStructure } from '../../../server/src/structure.js';

/**
 * 画布结构（P0-2）：把 React Flow 的 nodes/edges 投成纯数据，交给共享的 analyzeStructure。
 * 与服务端 GET /api/flows/:id 里返回的 structure 是同一个函数，画布与检查清单不会各算一套。
 */
export function useStructure(nodes, edges) {
  return useMemo(() => {
    const plainNodes = (nodes || []).map((n) => ({
      id: n.id, type: n.data?.type, name: n.data?.name, x: n.position?.x, y: n.position?.y,
    }));
    const plainEdges = (edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle }));
    const s = analyzeStructure({ nodes: plainNodes, edges: plainEdges });
    const exitsByNode = {};
    for (const ex of s.exits) {
      if (!exitsByNode[ex.nodeId]) exitsByNode[ex.nodeId] = {};
      exitsByNode[ex.nodeId][ex.handle] = ex.connected;
    }
    return { ...s, exitsByNode };
  }, [nodes, edges]);
}
