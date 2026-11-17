import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import GroupPicker from './GroupPicker.jsx';
import RecoveryFields from './RecoveryFields.jsx';
import { api } from '../api.js';
import { fmtDateTime, fmtAgo, isSensitiveName, CHANNEL_LABELS, describeRetryPolicy, describeRetryPolicyDetail } from '../util.js';

const EMPTY_GROUPS = [];

/**
 * 任务详情：点任务名打开（对齐 qiandao 框架的核心交互）
 *
 * 允许直接修改：
 *   - 基础信息：任务名、备注、分组
 *   - 定时调度：启用状态、cron 表达式、时区、抖动延迟、失败重试策略
 *   - 任务变量：Cookie、Token 等变量的查看与修改（敏感项遮蔽/解蔽）、新增与删除
 * 同时提供只读概览（运行状态、流程规模、通知渠道、来源模板、时间），
 * 用户无需打开复杂流程画布即可随时调整 Cookie 与调度。
 */
export default function TaskDetailModal({ summary, onClose, onSaved, onToast, onEdit, groupOptions = EMPTY_GROUPS }) {
  const [flow, setFlow] = useState(null);
  const [name, setName] = useState(summary.name || '');
  const [note, setNote] = useState(summary.note || '');
  const [group, setGroup] = useState(summary.group || '');
  const [cron, setCron] = useState(summary.cron || '');
  const [timezone, setTimezone] = useState(summary.timezone || 'Asia/Shanghai');
  const [enabled, setEnabled] = useState(!!summary.enabled);
  const [jitter, setJitter] = useState(summary.jitterMinutes ?? 0);
  const [retry, setRetry] = useState(() => ({
    enabled: true,
    maxAttempts: 3,
    backoff: 'exponential',
    baseDelayMs: 5000,
    maxDelayMs: 300000,
    jitter: true,
    ...(summary.retry || {}),
  }));
  const [recovery, setRecovery] = useState(() => ({
    enabled: false,
    intervalMinutes: 60,
    maxAttempts: 2,
    ...(summary.recovery || {}),
  }));
  const [vars, setVars] = useState({});
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarVal, setNewVarVal] = useState('');
  const [revealed, setRevealed] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [knownGroups, setKnownGroups] = useState(groupOptions);

  // 从编辑器打开时调用方拿不到分组列表，这里补一次，保证下拉里始终有已有分组
  useEffect(() => {
    if (groupOptions.length) { setKnownGroups(groupOptions); return undefined; }
    let alive = true;
    api.flows().then((list) => {
      if (!alive) return;
      const gs = [...new Set((list || []).map((x) => x.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
      setKnownGroups(gs);
    }).catch(() => {});
    return () => { alive = false; };
  }, [groupOptions]);

  useEffect(() => {
    let alive = true;
    api.flow(summary.id).then((f) => {
      if (!alive) return;
      setFlow(f);
      setName(f.name || '');
      setNote(f.note || '');
      setGroup(f.group || '');
      setCron(f.cron || '');
      setTimezone(f.timezone || 'Asia/Shanghai');
      setEnabled(!!f.enabled);
      setJitter(f.jitterMinutes ?? 0);
      if (f.retry) {
        setRetry((r) => ({
          ...r,
          ...f.retry,
          baseDelayMs: Number(f.retry.baseDelayMs) || 5000,
          maxDelayMs: Number(f.retry.maxDelayMs) || 300000,
        }));
      }
      if (f.recovery) setRecovery({ enabled: false, intervalMinutes: 60, maxAttempts: 2, ...f.recovery });
      setVars(f.vars ? { ...f.vars } : {});
    }).catch((e) => onToast?.(e.message, 'fail'));
    return () => { alive = false; };
  }, [summary.id]);

  const setR = (patch) => setRetry((r) => ({ ...r, ...patch }));

  const retryPreview = (() => {
    if (!retry?.enabled) return '';
    const base = Math.max(1000, Number(retry.baseDelayMs) || 5000);
    const max = Math.max(base, Number(retry.maxDelayMs) || 300000);
    const fmt = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`);
    const waits = [];
    for (let n = 1; n < Math.min(4, Number(retry.maxAttempts) || 3); n++) {
      let d = retry.backoff === 'fixed' ? base : retry.backoff === 'linear' ? base * n : base * 2 ** (n - 1);
      d = Math.min(d, max);
      // equal jitter 的真实区间是 delay/2 ～ delay，不再伪装成固定 0.75 倍
      waits.push(retry.jitter ? `${fmt(d / 2)}–${fmt(d)}` : fmt(d));
    }
    return waits.length ? `失败后依次等待：${waits.join(' → ')}${Number(retry.maxAttempts) > 4 ? ' …' : ''}` : '';
  })();

  const addVar = () => {
    const k = newVarKey.trim();
    if (!k) return;
    setVars((prev) => ({ ...prev, [k]: newVarVal }));
    setRevealed((r) => ({ ...r, [k]: true }));
    setNewVarKey('');
    setNewVarVal('');
  };

  const removeVar = (k) => {
    setVars((prev) => {
      const next = { ...prev };
      delete next[k];
      return next;
    });
  };

  const changeVar = (k, v) => {
    setVars((prev) => ({ ...prev, [k]: v }));
  };

  const save = async () => {
    if (!name.trim()) return;
    if (enabled && !cron.trim()) {
      onToast?.('启用定时调度需要填写 cron 表达式', 'fail');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const patch = {
        name: name.trim(),
        note,
        group: group.trim(),
        cron: cron.trim(),
        timezone,
        enabled: enabled && !!cron.trim(),
        jitterMinutes: Math.min(60, Math.max(0, Number(jitter) || 0)),
        retry: {
          enabled: !!retry.enabled,
          maxAttempts: Math.min(10, Math.max(1, Number(retry.maxAttempts) || 3)),
          backoff: ['exponential', 'linear', 'fixed'].includes(retry.backoff) ? retry.backoff : 'exponential',
          baseDelayMs: Math.round(Number(retry.baseDelayMs) || 5000),
          maxDelayMs: Math.round(Number(retry.maxDelayMs) || 300000),
          jitter: retry.jitter !== false,
        },
        recovery: {
          enabled: !!recovery.enabled,
          intervalMinutes: Math.min(1440, Math.max(30, Math.round(Number(recovery.intervalMinutes) || 60))),
          maxAttempts: Math.min(5, Math.max(1, Math.round(Number(recovery.maxAttempts) || 2))),
        },
        vars,
      };
      const nf = await api.updateFlow(summary.id, patch);
      onSaved?.(nf);
      onToast?.(`已保存「${name.trim()}」`, 'ok');
      onClose();
    } catch (e) {
      setErr(e.message);
      onToast?.(e.message, 'fail');
    } finally {
      setBusy(false);
    }
  };

  const channels = flow?.notify?.channels || [];
  const last = summary.lastRun;
  const varCount = Object.keys(vars).length;
  const pausedAt = flow?.pausedAt || summary.pausedAt;
  const pausedReason = flow?.pausedReason || summary.pausedReason || '';
  const rec = { ...recovery };
  let recoveryText = '';
  if (rec.enabled) {
    if (rec.exhausted) recoveryText = `自动恢复探测已停止（${rec.attempts}/${rec.maxAttempts} 次失败）。`;
    else {
      recoveryText = `自动恢复探测每 ${rec.intervalMinutes} 分钟一次`;
      if (rec.nextProbeAt) recoveryText += `，下次 ${fmtDateTime(rec.nextProbeAt)}`;
      if (rec.attempts > 0) recoveryText += `（已失败 ${rec.attempts}/${rec.maxAttempts} 次）`;
      recoveryText += '。';
    }
  }

  return (
    <Modal
      title="任务详情"
      onClose={onClose}
      width={600}
      footer={
        <>
          {onEdit && (
            <button
              type="button"
              onClick={() => { onClose(); onEdit(summary.id); }}
              title="打开流程编辑器"
            >
              编辑流程
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>关闭</button>
          <button
            type="button"
            className="primary"
            disabled={busy || !name.trim()}
            onClick={save}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>任务名</label>
        <input value={name} aria-label="任务名" onChange={(e) => setName(e.target.value)} placeholder="给任务起个好找的名字" />
      </div>
      <div className="field">
        <label title="备注会显示在任务列表里，也能被搜索">备注</label>
        <textarea rows={2} value={note} aria-label="任务备注" onChange={(e) => setNote(e.target.value)} placeholder="例如：账号 A，每天一次" />
      </div>

      <div className="field">
        <label title="分组用于列表折叠；留空=未分组">分组</label>
        <GroupPicker
          value={group}
          onChange={setGroup}
          groups={knownGroups}
          placeholder="选已有分组或输入新名字（留空=未分组）"
        />
      </div>

      <div className="detail-section">
        <div className="detail-section-head">
          <span className="detail-k">定时调度</span>
          <label className="checkline" style={{ margin: 0, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用定时调度
          </label>
        </div>
        {pausedAt && (
          <p className="pause-note" title={pausedReason}>
            <span>连续失败已自动停用。</span>
            {rec.enabled ? <span>{recoveryText}</span> : <span>勾选上方开关即恢复调度；需要时可在下方开启探测。</span>}
          </p>
        )}
        <div className="field" style={{ marginTop: 8 }}>
          <label title="cron 格式：分 时 日 月 周，如 30 8 * * * 为每天 08:30">cron 表达式</label>
          <input
            className="mono"
            placeholder="30 8 * * *（留空=手动）"
            aria-label="cron 表达式"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
          />
        </div>
        <div className="field-inline">
          <div className="field">
            <label>时区</label>
            <select value={timezone} aria-label="时区" onChange={(e) => setTimezone(e.target.value)}>
              <option value="Asia/Shanghai">Asia/Shanghai</option>
              <option value="UTC">UTC</option>
              <option value="Asia/Tokyo">Asia/Tokyo</option>
              <option value="America/New_York">America/New_York</option>
            </select>
          </div>
          <div className="field">
            <label title="cron 触发后随机延迟 0-N 分钟，0=不抖动">抖动（分钟）</label>
            <input
              type="number"
              min={0}
              max={60}
              value={jitter}
              aria-label="抖动（分钟）"
              onChange={(e) => setJitter(e.target.value)}
            />
          </div>
        </div>

        <div className="retry-box" style={{ marginTop: 8, paddingTop: 8 }}>
          <label className="checkline retry-head">
            <input
              type="checkbox"
              checked={!!retry.enabled}
              onChange={(e) => setR({ enabled: e.target.checked })}
            />
            <span>失败后重试</span>
            <span className="retry-hint">跑满次数才判定失败</span>
          </label>
          {retry.enabled && (
            <>
              <div className="field-inline" style={{ marginTop: 6 }}>
                <div className="field">
                  <label>最多尝试</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={retry.maxAttempts}
                    aria-label="最多尝试次数"
                    onChange={(e) => setR({ maxAttempts: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>退避方式</label>
                  <select
                    value={retry.backoff}
                    aria-label="退避方式"
                    onChange={(e) => setR({ backoff: e.target.value })}
                  >
                    <option value="exponential">指数退避</option>
                    <option value="linear">线性退避</option>
                    <option value="fixed">固定间隔</option>
                  </select>
                </div>
              </div>
              <div className="field-inline">
                <div className="field">
                  <label>首次等待（秒）</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={Math.round((Number(retry.baseDelayMs) || 5000) / 1000)}
                    aria-label="首次等待（秒）"
                    onChange={(e) => setR({ baseDelayMs: Math.max(1, Number(e.target.value)) * 1000 })}
                  />
                </div>
                <div className="field">
                  <label>最长等待（分钟）</label>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={Math.round((Number(retry.maxDelayMs) || 300000) / 60000)}
                    aria-label="最长等待（分钟）"
                    onChange={(e) => setR({ maxDelayMs: Math.max(1, Number(e.target.value)) * 60000 })}
                  />
                </div>
              </div>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={retry.jitter !== false}
                  onChange={(e) => setR({ jitter: e.target.checked })}
                />
                随机抖动（避免多个任务同时重试）
              </label>
              {retryPreview && <p className="retry-preview">{retryPreview}</p>}
            </>
          )}
        </div>

        <div style={{ marginTop: 8 }}>
          <RecoveryFields value={recovery} onChange={setRecovery} />
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-head">
          <span className="detail-k">任务变量（Cookie 与参数）</span>
          <span className="detail-k-sub">{varCount} 个变量</span>
        </div>
        {varCount === 0 ? (
          <div className="muted" style={{ fontSize: 12, padding: '4px 0' }}>暂无变量</div>
        ) : (
          <div className="var-edit-list">
            {Object.entries(vars).map(([k, v]) => {
              const sensitive = isSensitiveName(k);
              const shown = revealed[k] || !sensitive;
              return (
                <div key={k} className="var-edit-item">
                  <div className="var-edit-head">
                    <span className="var-name mono">{k}</span>
                    <div className="var-edit-actions">
                      {sensitive && (
                        <button
                          type="button"
                          className="small"
                          onClick={() => setRevealed((r) => ({ ...r, [k]: !r[k] }))}
                        >
                          {shown ? '隐藏' : '显示'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="small danger"
                        title={`删除变量 ${k}`}
                        onClick={() => removeVar(k)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  {shown ? (
                    <textarea
                      className="mono var-textarea"
                      rows={Math.min(4, Math.max(1, Math.ceil(String(v ?? '').length / 60)))}
                      value={v ?? ''}
                      placeholder="变量值"
                      onChange={(e) => changeVar(k, e.target.value)}
                    />
                  ) : (
                    <div className="var-masked mono">••••••••</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="var-add-row">
          <input
            className="mono"
            placeholder="变量名（如 cookie）"
            value={newVarKey}
            onChange={(e) => setNewVarKey(e.target.value)}
            aria-label="新变量名"
          />
          <input
            placeholder="变量值"
            value={newVarVal}
            onChange={(e) => setNewVarVal(e.target.value)}
            aria-label="新变量值"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addVar();
              }
            }}
          />
          <button
            type="button"
            className="small"
            disabled={!newVarKey.trim()}
            onClick={addVar}
          >
            + 添加
          </button>
        </div>
      </div>

      <div className="detail-panel" style={{ marginTop: 14 }}>
        <div className="detail-grid">
          <div className="detail-cell">
            <span className="detail-k">调度</span>
            <span className="detail-v">
              {cron ? <code className="mono cron-code">{cron}</code> : <span className="muted">手动（不定时）</span>}
            </span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">时区</span>
            <span className="detail-v mono">{timezone || 'Asia/Shanghai'}</span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">状态</span>
            <span className="detail-v">
              <span className={`status-dot${enabled ? ' on' : (pausedAt ? ' paused' : '')}`} />
              {enabled ? '已启用调度' : (pausedAt ? <span title={pausedReason || '连续失败已自动停用'}>已暂停</span> : '已停用')}
              {jitter ? <span className="muted">抖动 {jitter} 分钟</span> : null}
            </span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">失败重试</span>
            <span className="detail-v">
              <span className={retry?.enabled ? '' : 'muted'} title={describeRetryPolicyDetail(retry)}>{describeRetryPolicy(retry)}</span>
            </span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">下次运行</span>
            <span className="detail-v">{summary.nextRunAt ? fmtDateTime(summary.nextRunAt) : <span className="muted">—</span>}</span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">上次运行</span>
            <span className="detail-v">
              {last ? (
                <>
                  <span className={last.status === 'success' ? 'ok-text' : 'fail-text'}>{last.status === 'success' ? '成功' : '失败'}</span>
                  <span className="muted">{fmtAgo(last.startedAt)}</span>
                </>
              ) : <span className="muted">未运行</span>}
            </span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">流程规模</span>
            <span className="detail-v">
              <span className="meta">
                <span><b>{summary.nodesCount}</b> 步</span>
                <span><b>{flow?.edges?.length || 0}</b> 连线</span>
              </span>
            </span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">通知渠道</span>
            <span className="detail-v">
              {channels.length === 0 ? <span className="muted">未配置</span>
                : channels.map((c) => (
                  <span key={c.type} className="chip chip-mute">{CHANNEL_LABELS[c.type] || c.type}</span>
                ))}
            </span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">来源模板</span>
            <span className="detail-v">
              {summary.template ? (
                <>
                  {summary.template.name}
                  <span className="muted">流程跟随模板</span>
                </>
              ) : <span className="muted">独立任务</span>}
            </span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">创建于</span>
            <span className="detail-v">{flow?.createdAt ? fmtDateTime(flow.createdAt) : '—'}</span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">最后修改</span>
            <span className="detail-v">{flow?.updatedAt ? fmtAgo(flow.updatedAt) : '—'}</span>
          </div>
          <div className="detail-cell">
            <span className="detail-k">使用的变量</span>
            <span className="detail-v">{varCount} 个</span>
          </div>
        </div>
      </div>
      {err && <p style={{ color: 'var(--fail)', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </Modal>
  );
}
