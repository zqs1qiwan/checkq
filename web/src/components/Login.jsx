import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Logo from './Logo.jsx';
import ThemeToggle from './ThemeToggle.jsx';

function Intro() {
  return (
    <aside className="login-intro">
      <Logo size={44} wordSize={26} />
      <h2>
        把每天点一下，<br />
        <em>变成看得见的自动化。</em>
      </h2>
      <p className="login-intro-text">开源的可视化自动挂机、签到框架。</p>
      <ul className="login-promises">
        <li><b>看得见</b><span>流程图就是真实执行</span></li>
        <li><b>说得清</b><span>失败给原因，也给下一步</span></li>
        <li><b>拿得走</b><span>一份模板，派生多份任务</span></li>
      </ul>
    </aside>
  );
}

export default function Login({ onOk }) {
  const [mode, setMode] = useState('loading'); // loading | setup | login
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.bootstrap()
      .then((r) => {
        setMode(r.needsSetup ? 'setup' : 'login');
        if (r.username) setUsername(r.username);
      })
      .catch(() => setMode('login'));
  }, []);

  const submitLogin = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const { user } = await api.login(username.trim() || undefined, password, code.trim() || undefined);
      onOk(user);
    } catch (e2) {
      const msg = e2.message || '登录失败';
      if (e2.data?.needTotp || e2.needTotp || msg.includes('两步')) {
        setNeedCode(true);
        setErr('该账号已启用两步验证，请输入验证码或恢复码');
      } else if (msg.includes('锁定')) {
        setErr(msg);
      } else {
        setErr(msg.includes('未登录') ? '用户名或密码错误' : msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const submitSetup = async (e) => {
    e.preventDefault();
    setErr('');
    if (username.trim().length < 3) { setErr('用户名至少 3 位'); return; }
    if (password.length < 10) { setErr('密码至少 10 位'); return; }
    if (password !== confirm) { setErr('两次输入的密码不一致'); return; }
    setBusy(true);
    try {
      await api.setupAccount(username.trim(), password);
      const { user } = await api.login(username.trim(), password);
      onOk(user);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'loading') {
    return (
      <div className="login-wrap">
        <div className="login-shell login-shell--loading">
          <div className="login-card login-card--loading">
            <Logo size={40} wordSize={22} />
            <p className="login-loading">正在加载…</p>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'setup') {
    return (
      <div className="login-wrap">
        <div className="login-theme"><ThemeToggle /></div>
        <div className="login-shell">
          <Intro />
          <form className="login-card" onSubmit={submitSetup}>
            <div className="login-card-head">
              <p className="login-eyebrow">首次启动</p>
              <h1>创建管理员</h1>
              <p className="sub">这组账号只属于你的实例。</p>
            </div>
            <label className="login-field">
              <span>用户名</span>
              <input placeholder="字母数字，3–32 位" aria-label="用户名" name="username" autoComplete="username" value={username} autoFocus onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="login-field">
              <span>登录密码</span>
              <input type="password" placeholder="至少 10 位，含两类字符" aria-label="登录密码" name="new-password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="login-field">
              <span>确认密码</span>
              <input type="password" placeholder="再输入一次" aria-label="确认密码" name="confirm-password" autoComplete="new-password" minLength={10} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button className="primary" type="submit" disabled={busy || !username || !password}>{busy ? '创建中…' : '创建并进入'}</button>
            <div className="login-err" role="alert" aria-live="polite">{err}</div>
            <p className="login-note">CheckQ · <a href="https://github.com/zqs1qiwan/checkq" target="_blank" rel="noreferrer">GitHub 仓库</a></p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div className="login-theme"><ThemeToggle /></div>
      <div className="login-shell">
        <Intro />
        <form className="login-card" onSubmit={submitLogin}>
          <div className="login-card-head">
            <p className="login-eyebrow">登录</p>
            <h1>欢迎回来</h1>
            <p className="sub">继续管理你的任务与调度。</p>
          </div>
          <label className="login-field">
            <span>用户名</span>
            <input
              placeholder="用户名"
              aria-label="用户名"
              name="username"
              value={username}
              autoFocus={!needCode}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="login-field">
            <span>密码</span>
            <input
              type="password"
              placeholder="密码"
              aria-label="密码"
              name="password"
              value={password}
              autoFocus={needCode}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {needCode && (
            <label className="login-field">
              <span>验证码</span>
              <input
                placeholder="验证码或恢复码"
                aria-label="验证码或恢复码"
                name="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </label>
          )}
          <button className="primary" type="submit" disabled={busy || !password}>{busy ? '验证中…' : '进入工作台'}</button>
          <div className="login-err" role="alert" aria-live="polite">{err}</div>
          <p className="login-note">CheckQ · <a href="https://github.com/zqs1qiwan/checkq" target="_blank" rel="noreferrer">GitHub 仓库</a></p>
        </form>
      </div>
    </div>
  );
}
