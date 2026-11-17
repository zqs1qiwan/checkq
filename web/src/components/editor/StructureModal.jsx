import React, { useState } from 'react';
import Modal from '../Modal.jsx';

/**
 * 结构检查清单（P0-2）：保存后如果出现了"断头出口 / 孤岛 / 多起点"，把问题逐条列出来。
 * 只是提示：可以忽略并继续保存（不阻断保存，不改执行语义）。
 */
const LEVEL_LABEL = { error: '会出错', warn: '要注意', info: '了解即可' };

export default function StructureModal({ structure, onClose, onFocus }) {
  const [filter, setFilter] = useState('all');
  const issues = structure?.issues || [];
  const shown = filter === 'all' ? issues : issues.filter((i) => i.level === filter);
  const counts = {
    error: issues.filter((i) => i.level === 'error').length,
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length,
  };
  return (
    <Modal
      title="结构检查"
      subtitle={`${issues.length ? `${issues.length} 条` : '没有隐患'}`}
      onClose={onClose}
      footer={<button className="primary" onClick={onClose}>知道了</button>}
    >
      <div className="seg">
        {[['all', '全部'], ['error', `会出错 ${counts.error}`], ['warn', `要注意 ${counts.warn}`], ['info', `了解 ${counts.info}`]].map(([k, label]) => (
          <button key={k} className={`small${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      {!shown.length && <p className="empty-line">这条流程结构完整：每个出口都接上了下一步</p>}
      <div className="struct-list">
        {shown.map((i) => (
          <div key={i.id} className={`struct-row ${i.level}`}>
            <span className={`struct-level ${i.level}`}>{LEVEL_LABEL[i.level]}</span>
            <span className="struct-text">{i.message}</span>
            {i.nodeId && onFocus && (
              <button className="small" onClick={() => { onFocus(i.nodeId); onClose(); }}>定位</button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
