import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { STEP_TYPES, outputLabel } from '../../stepTypes.js';

/**
 * 画布上的一个步骤。
 * data.exits: { [出口]: boolean } —— 该出口是否已连线（由 useStructure 统一算出来）
 * 结构可见（P0-2）的约定：
 *   - 只有多出口节点标文字（成功/失败/真/假/每项/结束），单出口不标；
 *   - 未连线的出口画成空心点，一眼能看出"这里断头了"；
 *   - 失败出口未连线时，节点左下角加一个虚线小角标。
 */
function StepNode({ id, data, selected }) {
  const meta = STEP_TYPES[data.type] || { color: '#666', outputs: ['next'] };
  const rs = data.runStatus; // 'running' | 'ok' | 'failed' | undefined
  const exits = data.exits || {};
  const failedOpen = exits.failed === false;
  return (
    <div className={`node ${selected ? 'selected' : ''} ${rs ? `run-${rs}` : ''}${failedOpen ? ' has-open-exit' : ''}`} style={{ minWidth: 170 }}>
      <div className="node-bar" style={{ background: meta.color }} />
      <div className="node-title">{data.name || meta.label}</div>
      <div className="node-type">{meta.label}</div>
      {rs === 'running' && <span className="run-badge running" title="运行中">●</span>}
      {rs === 'ok' && <span className="run-badge ok" title="成功">✓</span>}
      {rs === 'failed' && <span className="run-badge failed" title="失败">✗</span>}
      {failedOpen && <span className="exit-flag" title="失败出口未连线：失败时直接判失败">失败未接</span>}
      {data.loopFolded && <span className="loop-folded-hint" title="循环体已折叠：点容器上的「展开」查看循环内步骤">循环体已折叠</span>}
      <Handle type="target" position={Position.Left} />
      {meta.outputs.map((out, i) => {
        const label = outputLabel(data.type, out);
        const unconnected = exits[out] === false;
        return (
          <React.Fragment key={out}>
            <Handle
              type="source"
              position={Position.Right}
              id={out}
              className={unconnected ? 'unconnected' : ''}
              style={{ top: 30 + i * 20 }}
              title={unconnected ? `${label || '出口'}未连线` : undefined}
            />
            {label ? <span className={`handle-label${unconnected ? ' unconnected' : ''}`} style={{ top: 23 + i * 20 }}>{label}</span> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default StepNode;
