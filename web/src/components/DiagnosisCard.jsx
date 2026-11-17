import React from 'react';
import { diagnosisText } from '../../../server/src/diagnose.js';
import { recordEvent, EVENTS } from '../events.js';

/**
 * 可解释失败（P0-3）：失败时的第一块内容。
 * 只讲三件事：怎么了（cause）、凭什么这么判断（evidence）、下一步点哪里（actions）。
 * 动作全部来自服务端白名单（ACTIONS），前端不自己编新动作。
 */
const CONFIDENCE = { high: '把握较大', medium: '比较像', low: '线索很少' };

export default function DiagnosisCard({ diagnosis, onShowResponse, onEditVars, onEditAssert, onToast }) {
  if (!diagnosis?.cause) return null;
  const actions = diagnosis.actions || [];

  const run = (a) => {
    recordEvent(EVENTS.diagAction);
    if (a.type === 'show-response') onShowResponse?.(a.stepId);
    else if (a.type === 'edit-vars') onEditVars?.(a.vars || []);
    else if (a.type === 'edit-assert') onEditAssert?.(a.stepId);
    else if (a.type === 'copy-issue') {
      const text = diagnosisText(diagnosis);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => onToast?.('排障摘要已复制', 'ok'),
          () => onToast?.('复制失败，请手动选择文本', 'fail'),
        );
      } else onToast?.(text, 'ok');
    }
  };

  return (
    <div className={`diag-card ${diagnosis.confidence || 'medium'}`}>
      <div className="diag-head">
        <span className={`diag-dot ${diagnosis.confidence || 'medium'}`} title={CONFIDENCE[diagnosis.confidence] || ''} />
        <span className="diag-cause">{diagnosis.cause}</span>
      </div>
      {diagnosis.evidence?.length > 0 && (
        <ul className="diag-evidence">
          {diagnosis.evidence.map((e, i) => (
            <li key={i}><span className="diag-label">{e.label}</span>{e.value}</li>
          ))}
        </ul>
      )}
      {actions.length > 0 && (
        <div className="diag-actions">
          {actions.map((a, i) => (
            <button key={i} className={`small${a.type === 'edit-vars' || a.type === 'edit-assert' ? ' primary' : ''}`} onClick={() => run(a)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
