import React from 'react';
import { ViewportPortal } from '@xyflow/react';

/**
 * 循环体虚线容器（P0-2）：用 ViewportPortal 画在流程坐标系里，
 * 只改渲染、不改 nodes/edges —— 保存时不会把容器当成节点写进流程。
 *
 * 折叠：节点多时（≥60）循环体默认折叠，只留遍历节点；容器贴着遍历节点画一条小结，
 * 点「展开」才把循环内的步骤放回画布（数据一直完整）。
 */
const NODE_W = 200;
const NODE_H = 84;
const PAD = 18;

function bbox(ids, nodes) {
  const list = (ids || []).map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
  if (!list.length) return null;
  const xs = list.map((n) => n.position?.x || 0);
  const ys = list.map((n) => n.position?.y || 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX - PAD, y: minY - PAD - 14, w: maxX - minX + NODE_W + PAD * 2, h: maxY - minY + NODE_H + PAD * 2 + 14 };
}

export default function LoopFrame({ loops, nodes, onFocus, isFolded, onToggle }) {
  if (!loops?.length) return null;
  const foldedOf = (id) => (typeof isFolded === 'function' ? isFolded(id) : false);
  return (
    <ViewportPortal>
      {(loops || []).map((l) => {
        const folded = foldedOf(l.foreachId);
        // 折叠时容器只圈住遍历节点本身，避免画一大片空框
        const b = bbox(folded ? [l.foreachId] : l.nodeIds, nodes);
        if (!b) return null;
        return (
          <div
            key={l.foreachId}
            className={`loop-frame${folded ? ' is-folded' : ''}`}
            style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
          >
            <button className="loop-frame-label" onClick={() => onFocus?.(l.foreachId)} title="点这里定位到遍历节点">
              循环 · {l.nodeIds.length} 步{folded ? ' · 已折叠' : ''}
            </button>
            {typeof onToggle === 'function' && l.nodeIds.length > 0 && (
              <button
                className="loop-frame-toggle"
                onClick={() => onToggle(l.foreachId)}
                title={folded ? '展开循环体' : '折叠循环体，只留遍历节点'}
              >
                {folded ? '展开' : '折叠'}
              </button>
            )}
          </div>
        );
      })}
    </ViewportPortal>
  );
}
