import React, { useState } from 'react';
import Modal from '../Modal.jsx';
import { api } from '../../api.js';
import { isSensitiveName } from '../../util.js';

/**
 * 带改变量运行（P0-4「修改即重跑」）：不进画布，就地改参数再跑一次。
 * 敏感值默认遮蔽，点眼睛看明文；「保存并运行」= 先落盘再运行，跑的就是刚改的值。
 */
export default function VarsQuickModal({ flow, onClose, onDone, onToast }) {
  const [vars, setVars] = useState({ ...(flow.vars || {}) });
  const [newName, setNewName] = useState('');
  const [reveal, setReveal] = useState({});
  const [busy, setBusy] = useState(false);
  const keys = Object.keys(vars);

  const setVal = (k, v) => setVars((cur) => ({ ...cur, [k]: v }));

  const addVar = () => {
    const name = newName.trim();
    if (!name) return;
    if (vars[name] !== undefined) { onToast?.('这个变量已存在', 'fail'); return; }
    setVars((cur) => ({ ...cur, [name]: '' }));
    setNewName('');
  };

  const run = async () => {
    setBusy(true);
    try {
      await api.updateFlow(flow.id, { vars });
      const r = await api.runFlow(flow.id, { dedupe: true });
      if (r?.deduped) {
        onToast?.('已在运行，本次未重复提交', 'fail');
        onDone?.();
        return;
      }
      onToast?.(r?.status === 'success' ? '已按新参数跑完' : '已按新参数跑完（失败）', r?.status === 'success' ? 'ok' : 'fail');
      onDone?.(r);
    } catch (e) {
      onToast?.(e.message, 'fail');
    } finally { setBusy(false); }
  };

  return (
    <Modal
      title="带改变量运行"
      subtitle={flow.name}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>取消</button>
          <button className="primary" disabled={busy || !vars} onClick={run}>{busy ? '运行中…' : '保存并运行'}</button>
        </>
      }
    >
      {!vars ? <p className="empty-line">正在加载参数…</p> : !keys.length && <p className="empty-line">这条流程还没有变量，直接运行即可</p>}
      <div className="vars-quick">
        {(vars ? keys : []).map((k) => {
          const sensitive = isSensitiveName(k);
          return (
            <div className="field" key={k}>
              <label htmlFor={`vq-${k}`} className="vq-label">
                <span className="mono">{k}</span>
                {sensitive && (
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => setReveal((r) => ({ ...r, [k]: !r[k] }))}
                  >{reveal[k] ? '遮蔽' : '显示'}</button>
                )}
              </label>
              <input
                id={`vq-${k}`}
                className="mono"
                type={sensitive && !reveal[k] ? 'password' : 'text'}
                value={vars[k]}
                onChange={(e) => setVal(k, e.target.value)}
                placeholder={sensitive ? '已加密保存，留空则不改' : '值'}
                autoComplete="off"
              />
            </div>
          );
        })}
      </div>
      <div className="field-inline" style={{ marginTop: 6 }}>
        <div className="field" style={{ flex: '1 1 auto' }}>
          <label htmlFor="vq-new">新变量名</label>
          <input id="vq-new" className="mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如 uid" />
        </div>
        <div className="field" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end' }}>
          <button className="small" onClick={addVar}>加变量</button>
        </div>
      </div>
    </Modal>
  );
}
