import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import { IconBell, IconSparkle, IconShield, IconUsers, IconKey, IconGear } from '../Icons.jsx';
import AccountPanel from '../AccountPanel.jsx';
import UsersPanel from '../UsersPanel.jsx';
import ApiKeysPanel from '../ApiKeysPanel.jsx';
import MetricsPanel from './metrics.jsx';
import { setToastLevel, getToastLevel } from '../../toast.js';
import { setToast } from './helpers.js';
import SystemNotify from './system-notify.jsx';

function SettingsModal({ onClose }) {
  const [tab, setTab] = useState('general');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [me, setMe] = useState(null);
  useEffect(() => {
    api.me().then((r) => setMe(r.authenticated ? r.user : null)).catch(() => {});
  }, []);
  const TABS = [
    { id: 'general', label: '通知与推送', desc: '系统通知与界面提示', Icon: IconBell },
    { id: 'metrics', label: '统计', desc: '本机运行与修复速度', Icon: IconGear },
    { id: 'ai', label: 'AI 助手', desc: '快速组装用的模型', Icon: IconSparkle },
    { id: 'security', label: '账号安全', desc: '密码、两步验证、会话', Icon: IconShield },
    ...(me?.role === 'admin' ? [{ id: 'users', label: '用户管理', desc: '账号与角色', Icon: IconUsers }] : []),
    { id: 'api', label: 'API 密钥', desc: '外部程序接入', Icon: IconKey },
  ];
  const cur = TABS.find((x) => x.id === tab) || TABS[0];
  return (
    <Modal
      title="设置"
      onClose={onClose}
      className="settings-modal"
      bodyClassName="settings-split"
    >
      <nav className="settings-nav">
        {TABS.map((x) => (
          <button
            key={x.id}
            className={`settings-tab${tab === x.id ? ' active' : ''}`}
            onClick={() => { setTab(x.id); setMsg(''); setErr(''); }}
          >
            <x.Icon size={16} />
            <span className="settings-tab-text">
              <b>{x.label}</b>
              <em>{x.desc}</em>
            </span>
          </button>
        ))}
      </nav>
      <div className="settings-panel">
        <div className="settings-page-head">
          <h2>{cur.label}</h2>
          <p>{cur.desc}</p>
        </div>

        {tab === 'general' && <SettingsFlow isAdmin={me?.role === 'admin'} onToast={(text) => { setMsg(text); setErr(''); }} />}

        {tab === 'metrics' && <MetricsPanel />}

        {tab === 'ai' && <AiSettings />}

        {tab === 'security' && <AccountPanel onToast={(text) => { setMsg(text); setErr(''); }} />}

        {tab === 'users' && me?.role === 'admin' && <UsersPanel onToast={(text) => { setMsg(text); setErr(''); }} />}

        {tab === 'api' && <ApiKeysPanel onToast={(text) => { setMsg(text); setErr(''); }} />}

        {msg && <p className="settings-msg">{msg}</p>}
        {err && <p className="settings-msg err">{err}</p>}
      </div>
    </Modal>
  );
}

/** 设置内：AI 助手（快速组装 LLM，OpenAI 兼容接口；key 只存服务端） */
function AiSettings() {
  const [cfg, setCfg] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [configured, setConfigured] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api.aiSettings().then((s) => { setConfigured(s.configured); setCfg({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model }); }).catch(() => {});
  }, []);
  const save = async () => {
    setMsg('');
    try {
      await api.saveAiSettings(cfg);
      const s = await api.aiSettings();
      setConfigured(s.configured); setCfg({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model });
      setMsg('AI 配置已保存');
    } catch (e) { setMsg('保存失败: ' + e.message); }
  };
  return (
    <>
      <div className="field">
        <label title="快速组装用的 LLM，OpenAI 兼容接口">AI 助手（{configured ? '已配置' : '未配置'}）</label>
        <input placeholder="Base URL，例：https://api.deepseek.com/v1" value={cfg.baseUrl} onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} />
      </div>
      <div className="field-inline">
        <div className="field">
          <label>API Key</label>
          <input type="password" autoComplete="off" placeholder={cfg.apiKey || 'sk-…'} value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} />
        </div>
        <div className="field">
          <label>模型</label>
          <input placeholder="deepseek-chat / gpt-4o-mini" value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} />
        </div>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>
        支持 OpenAI 兼容接口（DeepSeek / OpenAI / Ollama 等）。Key 只存服务端 meta.json，不回显明文。未配置时快速组装走本地规则模式（不耗 API）。
      </div>
      <button className="small" onClick={save}>保存 AI 配置</button>
      {msg && <p style={{ color: msg.startsWith('保存失败') ? 'var(--fail)' : 'var(--ok)', fontSize: 12 }}>{msg}</p>}
    </>
  );
}

/* 设置内：界面提示级别 + 系统通知（每日汇总） */
function SettingsFlow({ onToast, isAdmin }) {
  const [level, setLevel] = useState(getToastLevel());
  const changeLevel = async (v) => {
    setLevel(v);
    setToastLevel(v);
    try { await api.saveUiSettings({ toastLevel: v }); } catch (e) { onToast(e.message); }
  };
  return (
    <>
      <div className="field">
        <label title="只控制右上角弹出的提示；面板上的「今日汇总」始终是实时数据，打开首页就能看到。">界面提示</label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="radio" name="toast-level" style={{ width: 'auto' }} checked={level === 'error'} onChange={() => changeLevel('error')} />
          仅错误提示（默认，日常最安静）
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="radio" name="toast-level" style={{ width: 'auto' }} checked={level === 'success'} onChange={() => changeLevel('success')} />
          成功 + 错误提示
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="radio" name="toast-level" style={{ width: 'auto' }} checked={level === 'all'} onChange={() => changeLevel('all')} />
          全部提示
        </label>
      </div>
      <SystemNotify isAdmin={isAdmin} onToast={onToast} />
    </>
  );
}

export default SettingsModal;

