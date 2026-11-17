import React, { useMemo } from 'react';
import { STEP_TYPES } from '../../stepTypes.js';
import { defaultHandle } from '../../../../server/src/structure.js';

/**
 * 大纲视图（P0-2）：把流程图拍成"能读的清单"。
 * 用途：一屏看清执行顺序、循环体嵌套与断头出口；键盘可完成建流程（选中 → 在它后面加一步）。
 */
export default function OutlinePanel({ nodes, edges, structure, onFocus, onAddAfter, onClose }) {
  const rows = useMemo(() => {
    const byId = new Map((nodes || []).map((n) => [n.id, n]));
    const target = (nodeId, handle) => {
      const list = (edges || []).filter((e) => e.source === nodeId);
      const exact = list.find((e) => (e.sourceHandle || '') === handle);
      return (exact || list.find((e) => !e.sourceHandle))?.target || null;
    };
    const out = [];
    const seen = new Set();
    const walk = (startId, depth, inLoop) => {
      let cur = startId;
      while (cur && byId.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        const n = byId.get(cur);
        out.push({ id: cur, node: n, depth, inLoop });
        if (n.data?.type === 'foreach') {
          const loop = (structure?.loops || []).find((l) => l.foreachId === cur);
          for (const b of loop?.nodeIds || []) {
            if (byId.has(b) && !seen.has(b)) {
              seen.add(b);
              out.push({ id: b, node: byId.get(b), depth: depth + 1, inLoop: true });
            }
          }
          cur = target(cur, 'next');
          continue;
        }
        cur = target(cur, defaultHandle(n.data?.type));
      }
    };
    walk(structure?.entryId, 0, false);
    // 未进链路的步骤单独列在末尾（结构与画布一致：它们不会被执行）
    for (const n of nodes || []) {
      if (!seen.has(n.id)) out.push({ id: n.id, node: n, depth: 0, orphan: true });
    }
    return out;
  }, [nodes, edges, structure]);

  const issueOf = (id) => (structure?.issues || []).filter((i) => i.nodeId === id);

  return (
    <div className="outline-panel">
      <div className="panel-head">
        <h4>大纲</h4>
        <button className="linkbtn" onClick={onClose}>收起</button>
      </div>
      {!rows.length && <div className="outline-empty">还没有步骤</div>}
      <ol className="outline-list">
        {rows.map((row) => {
          const meta = STEP_TYPES[row.node.data?.type] || { label: row.node.data?.type, color: '#666', outputs: ['next'] };
          const issues = issueOf(row.id);
          const exits = (structure?.exits || []).filter((e) => e.nodeId === row.id && !e.connected && e.handle !== 'failed');
          return (
            <li
              key={row.id}
              className={`outline-row${row.orphan ? ' orphan' : ''}`}
              style={{ paddingLeft: 10 + row.depth * 18 }}
            >
              <button className="outline-main" onClick={() => onFocus(row.id)} title="定位到画布">
                <span className="dot" style={{ background: meta.color }} />
                <span className="outline-name">{row.node.data?.name || meta.label}</span>
                <span className="outline-type">{meta.label}</span>
                {row.inLoop && <span className="outline-tag">循环内</span>}
                {row.orphan && <span className="outline-tag warn">未接入</span>}
              </button>
              {exits.length > 0 && (
                <span className="outline-exit" title={exits.map((e) => e.label || '下一步').join('、')}>
                  断头 {exits.length}
                </span>
              )}
              {issues.length > 0 && !exits.length && <span className="outline-issue" title={issues[0].message}>!</span>}
              {onAddAfter && (
                <select
                  className="outline-add"
                  aria-label="在这一步后面加一步"
                  value=""
                  onChange={(e) => { if (e.target.value) onAddAfter(row.id, e.target.value); e.target.value = ''; }}
                >
                  <option value="">+ 加一步</option>
                  {Object.entries(STEP_TYPES).map(([t, m]) => (
                    <option key={t} value={t}>{m.label}</option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
