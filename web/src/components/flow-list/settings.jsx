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

        {tab === 'ai' && <AiSettings isAdmin={me?.role === 'admin'} />}

        {tab === 'security' && <AccountPanel onToast={(text) => { setMsg(text); setErr(''); }} />}

        {tab === 'users' && me?.role === 'admin' && <UsersPanel onToast={(text) => { setMsg(text); setErr(''); }} />}

        {tab === 'api' && <ApiKeysPanel onToast={(text) => { setMsg(text); setErr(''); }} />}

        {msg && <p className="settings-msg">{msg}</p>}
        {err && <p className="settings-msg err">{err}</p>}
      </div>
    </Modal>
  );
}

/** AI 供应商预设（只填 Base URL / 模型，Key 由用户自己填） */
const AI_PRESETS = [
  { id: 'custom', label: '自定义', baseUrl: '', model: '' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
];

function presetOf(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const hit = AI_PRESETS.find((p) => p.baseUrl && p.baseUrl === b);
  return hit ? hit.id : 'custom';
}

/** 设置内：AI 助手（快速组装 LLM，OpenAI 兼容接口；key 只存服务端，写入/测试仅管理员） */
function AiSettings({ isAdmin = false }) {
  const [cfg, setCfg] = useState({ baseUrl: '', apiKey: '', model: '', timeoutSec: 60, maxTokens: 1024 });
  const [configured, setConfigured] = useState(false);
  const [preset, setPreset] = useState('custom');
  const [msg, setMsg] = useState('');
  const [test, setTest] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api.aiSettings();
    setConfigured(!!s.configured);
    setCfg({
      baseUrl: s.baseUrl || '',
      apiKey: s.apiKey || '',
      model: s.model || '',
      timeoutSec: s.timeoutSec ?? 60,
      maxTokens: s.maxTokens ?? 1024,
    });
    setPreset(presetOf(s.baseUrl));
  };

  useEffect(() => { load().catch(() => {}); }, []);

  const set = (patch) => {
    setCfg((c) => ({ ...c, ...patch }));
    setMsg('');
    setTest(null);
  };

  const applyPreset = (id) => {
    setPreset(id);
    const p = AI_PRESETS.find((x) => x.id === id);
    if (p && p.baseUrl) set({ baseUrl: p.baseUrl, model: p.model });
  };

  const save = async () => {
    setBusy(true);
    setMsg('');
    setTest(null);
    try {
      await api.saveAiSettings({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutSec: Number(cfg.timeoutSec) || 60,
        maxTokens: Number(cfg.maxTokens) || 1024,
      });
      await load();
      setMsg('AI 配置已保存');
    } catch (e) {
      setMsg('保存失败：' + (e.data?.error || e.message));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const r = await api.testAi();
      setTest({
        ok: true,
        text: `连接成功 · ${r.model || cfg.model} · ${r.latencyMs}ms${r.sample ? ' · 返回：' + r.sample : ''}`,
      });
    } catch (e) {
      setTest({ ok: false, text: '连接失败：' + (e.data?.error || e.message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="field">
        <label>供应商预设</label>
        <select value={preset} onChange={(e) => applyPreset(e.target.value)} disabled={!isAdmin || busy}>
          {AI_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label title="快速组装用的 LLM，OpenAI 兼容接口">
          Base URL
          <span style={{ marginLeft: 8, color: configured ? 'var(--ok)' : 'var(--muted)', fontWeight: 400 }}>
            {configured ? '已配置' : '未配置'}
          </span>
        </label>
        <input
          placeholder="https://api.deepseek.com/v1"
          value={cfg.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          disabled={!isAdmin || busy}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            autoComplete="off"
            placeholder={cfg.apiKey || 'sk-…'}
            value={cfg.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            disabled={!isAdmin || busy}
          />
        </div>
        <div className="field">
          <label>模型</label>
          <input
            placeholder="deepseek-chat / gpt-4o-mini"
            value={cfg.model}
            onChange={(e) => set({ model: e.target.value })}
            disabled={!isAdmin || busy}
          />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label title="5-120 秒，默认 60">超时（秒）</label>
          <input
            type="number" min="5" max="120"
            value={cfg.timeoutSec}
            onChange={(e) => set({ timeoutSec: e.target.value })}
            disabled={!isAdmin || busy}
          />
        </div>
        <div className="field">
          <label title="1-4096，默认 1024">最大输出 tokens</label>
          <input
            type="number" min="1" max="4096"
            value={cfg.maxTokens}
            onChange={(e) => set({ maxTokens: e.target.value })}
            disabled={!isAdmin || busy}
          />
        </div>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, margin: '4px 0 10px', lineHeight: 1.6 }}>
        Base URL 可填 <code>.../v1</code> 或 <code>.../v1/chat/completions</code>，保存时自动归一化。
        Key 只存服务端（加密落盘），不回显明文；「测试连接」使用已保存的配置。
        本地 Ollama 无需真实 Key，可填任意占位符（如 <code>ollama</code>）；未配置时快速组装走本地规则模式（不耗 API）。
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="small" onClick={save} disabled={!isAdmin || busy}>{busy ? '处理中…' : '保存 AI 配置'}</button>
        <button
          className="small"
          onClick={runTest}
          disabled={!isAdmin || busy || !configured}
          title={configured ? '用已保存的配置发一条最小请求' : '请先保存配置'}
        >
          测试连接
        </button>
        {!isAdmin && <span style={{ color: 'var(--muted)', fontSize: 12 }}>仅管理员可修改 AI 配置</span>}
      </div>
      {msg && <p style={{ color: msg.startsWith('保存失败') ? 'var(--fail)' : 'var(--ok)', fontSize: 12 }}>{msg}</p>}
      {test && <p style={{ color: test.ok ? 'var(--ok)' : 'var(--fail)', fontSize: 12, wordBreak: 'break-word' }}>{test.text}</p>}
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

