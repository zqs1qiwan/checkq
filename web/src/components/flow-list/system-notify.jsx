import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import { CHANNEL_TYPE_OPTIONS, CHANNEL_LABELS } from '../../util.js';
import { CHANNEL_FIELDS, blankChannel, channelSummary } from '../../channel-fields.js';

const TIMEZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles'];
const stamp = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

/** 渠道编辑弹窗（系统通知用，字段表与任务通知共用） */
function ChannelModal({ initial, onClose, onApply }) {
  const [c, setC] = useState({ ...initial });
  const types = CHANNEL_TYPE_OPTIONS.filter(([id]) => id !== 'inbox');
  const patch = (k, v) => setC({ ...c, [k]: v });
  return (
    <Modal
      title={`${initial.id ? '编辑' : '添加'}系统通知渠道`}
      onClose={onClose}
      footer={<button className="primary" onClick={() => onApply(c)}>确定</button>}
    >
      <div className="field">
        <label>类型</label>
        <select
          value={c.type}
          onChange={(e) => {
            const type = e.target.value;
            setC({ ...blankChannel(type), id: c.id, title: c.title });
          }}
        >
          {types.map(([id, , label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      {(CHANNEL_FIELDS[c.type] || CHANNEL_FIELDS.webhook).map(([k, label]) => (
        <div className="field" key={k}>
          <label>{label}</label>
          <input className="mono" value={c[k] || ''} placeholder={label} onChange={(e) => patch(k, e.target.value)} />
        </div>
      ))}
    </Modal>
  );
}

export default function SystemNotify({ onToast, isAdmin }) {
  const [data, setData] = useState(null);
  const [cfg, setCfg] = useState({ enabled: false, time: '08:00', timezone: 'Asia/Shanghai', skipEmpty: true });
  const [channels, setChannels] = useState([]);
  const [customTz, setCustomTz] = useState(false);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [showMigrated, setShowMigrated] = useState(() => localStorage.getItem('checkq-summary-migrated') !== '1');

  const load = async () => {
    try {
      const r = await api.systemNotify();
      setData(r);
      setCfg(r.daily);
      setChannels(r.channels || []);
      setCustomTz(!TIMEZONES.includes(r.daily.timezone));
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setErr(''); setBusy('save');
    try {
      const r = await api.saveSystemNotify({ daily: cfg, channels });
      setData(r); setCfg(r.daily); setChannels(r.channels);
      onToast('系统通知设置已保存');
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const doPreview = async () => {
    setErr(''); setBusy('preview');
    try { setPreview(await api.previewSystemNotify()); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const doTest = async () => {
    setErr(''); setBusy('test');
    try {
      const saved = await api.saveSystemNotify({ daily: cfg, channels });
      setData(saved); setCfg(saved.daily); setChannels(saved.channels);
      const r = await api.testSystemNotify();
      onToast(`测试已发送 ${r.results.filter((x) => x.ok).length}/${r.results.length} 个渠道`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const doSend = async () => {
    setErr(''); setBusy('send');
    try {
      const saved = await api.saveSystemNotify({ daily: cfg, channels });
      setData(saved); setCfg(saved.daily); setChannels(saved.channels);
      const r = await api.sendSystemNotify({});
      if (r.skipped) onToast(`已跳过：${r.skipped}`);
      else onToast(`已发送 ${r.results.filter((x) => x.ok).length}/${r.results.length} 个渠道`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  if (!data) return <div className="hint">加载中…</div>;

  const last = data.lastResult;

  return (
    <>
      <div className="field">
        <label title="每天按设定时间把昨日的运行情况汇总成一条系统通知；与任何任务的通知渠道无关。">每日汇总</label>
        <label className="checkline">
          <input type="checkbox" disabled={!isAdmin} checked={!!cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          启用
          {!cfg.enabled && <span className="hint">已关闭</span>}
        </label>
        {data.migratedFromName && showMigrated && (
          <div className="hint">
            汇总已从任务「{data.migratedFromName}」独立
            <button className="small" style={{ marginLeft: 8 }} onClick={() => { localStorage.setItem('checkq-summary-migrated', '1'); setShowMigrated(false); }}>知道了</button>
          </div>
        )}
        <div className="field-inline">
          <div className="field">
            <label>发送时间</label>
            <input type="time" disabled={!isAdmin} style={{ width: 120 }} value={cfg.time} onChange={(e) => setCfg({ ...cfg, time: e.target.value })} />
          </div>
          <div className="field">
            <label title="只影响每天几点触发；统计窗口固定为服务器本地时间的昨日 00:00–23:59。">时区</label>
            <select
              disabled={!isAdmin}
              value={customTz ? '__custom__' : cfg.timezone}
              onChange={(e) => {
                if (e.target.value === '__custom__') { setCustomTz(true); return; }
                setCustomTz(false); setCfg({ ...cfg, timezone: e.target.value });
              }}
            >
              {!TIMEZONES.includes(cfg.timezone) && <option value={cfg.timezone}>{cfg.timezone}</option>}
              {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              <option value="__custom__">自定义时区…</option>
            </select>
            {customTz && (
              <input className="mono" disabled={!isAdmin} value={cfg.timezone} placeholder="Asia/Shanghai" onChange={(e) => setCfg({ ...cfg, timezone: e.target.value })} />
            )}
          </div>
        </div>
        <label className="checkline">
          <input type="checkbox" disabled={!isAdmin} checked={cfg.skipEmpty !== false} onChange={(e) => setCfg({ ...cfg, skipEmpty: e.target.checked })} />
          昨日无任务运行时不发送
        </label>
      </div>

      <div className="field">
        <label title="站内通知内置且始终保留；外部渠道最多 10 条。">通知渠道</label>
        <div className="sys-channel-list">
          {channels.map((c, i) => (
            <div className="sys-channel" key={c.id || i}>
              <span className="sys-channel-type">{CHANNEL_LABELS[c.type] || c.type}</span>
              <span className="sys-channel-sum">{channelSummary(c)}</span>
              {c.type === 'inbox' ? (
                <span className="hint">内置</span>
              ) : (
                <span className="sys-channel-ops">
                  {isAdmin && <button className="small" onClick={() => setEditing({ ...c })}>编辑</button>}
                  {isAdmin && <button className="small danger" onClick={() => setChannels(channels.filter((_, j) => j !== i))}>删除</button>}
                </span>
              )}
            </div>
          ))}
        </div>
        <button
          className="small"
          disabled={!isAdmin || channels.filter((c) => c.type !== 'inbox').length >= 10}
          onClick={() => setEditing(blankChannel('webhook'))}
        >
          + 添加渠道
        </button>
        {!isAdmin && <div className="hint">仅管理员可修改</div>}
      </div>

      <div className="field">
        <label>上次发送</label>
        <div className="hint">
          {cfg.lastSentAt ? `${stamp(cfg.lastSentAt)} · ${last ? `${last.total - (last.failed || []).length}/${last.total} 成功` : '已发送'}` : '还没有发送记录'}
        </div>
        {last?.failed?.length > 0 && (
          <div className="sys-last-errors">{last.failed.slice(0, 3).map((f) => `${f.type}: ${f.error}`).join('；')}</div>
        )}
      </div>

      <div className="sys-notify-actions">
        {isAdmin && <button className="primary" disabled={!!busy} onClick={save}>{busy === 'save' ? '保存中…' : '保存设置'}</button>}
        {isAdmin && <button disabled={!!busy} onClick={doTest}>{busy === 'test' ? '发送中…' : '测试发送'}</button>}
        <button disabled={!!busy} onClick={doPreview}>{busy === 'preview' ? '生成中…' : '预览'}</button>
        {isAdmin && <button disabled={!!busy} onClick={doSend}>{busy === 'send' ? '发送中…' : '立即发送'}</button>}
      </div>
      {err && <p className="settings-msg err">{err}</p>}

      <div className="field">
        <label>任务通知</label>
        <div className="hint">任务通知在编辑器「更多 → 通知渠道」里配置。</div>
      </div>

      {editing && (
        <ChannelModal
          initial={editing}
          onClose={() => setEditing(null)}
          onApply={(c) => {
            setChannels(editing.id ? channels.map((x) => (x.id === editing.id ? c : x)) : [...channels, c]);
            setEditing(null);
          }}
        />
      )}
      {preview && (
        <Modal
          title="汇总预览"
          onClose={() => setPreview(null)}
          footer={<button className="primary" onClick={() => setPreview(null)}>关闭</button>}
        >
          <pre className="summary-preview">{preview.text}</pre>
          {preview.skipped === 'empty' && <div className="hint">空日将跳过</div>}
          <div className="hint">统计窗口：{preview.window.date} 00:00–23:59</div>
        </Modal>
      )}
    </>
  );
}
