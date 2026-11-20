import React, { useEffect, useState } from 'react';
import { api, set401Handler } from './api.js';
import Login from './components/Login.jsx';
import FlowList from './components/FlowList.jsx';
import FlowEditor from './components/FlowEditor.jsx';
import GlobalToast from './components/GlobalToast.jsx';
import Logo from './components/Logo.jsx';
import { ConfirmHost } from './confirm.jsx';
import { setToastLevel } from './toast.js';

export default function App() {
  const [view, setView] = useState('loading');
  // 编辑器目标：任务流程图，或模板流程图（模板编辑不新建任务）
  const [editor, setEditor] = useState(null); // { kind: 'flow' | 'template', id }

  const openEditor = (kind, id) => {
    if (!id) return;
    setEditor({ kind, id });
    setView('editor');
  };

  useEffect(() => {
    set401Handler(() => setView('login'));
    // 先问「我是谁」：/api/me 是公开端点，未登录也返回 200，
    // 直接拉 /api/flows 会在登录页产生一堆 401 报错（控制台噪音）。
    api.me()
      .then((r) => {
        if (!r.authenticated) { setView('login'); return; }
        api.flows().then(() => setView('list')).catch(() => setView('login'));
        // 提示级别（服务端为准，失败则用本地缓存）
        api.uiSettings().then((s) => setToastLevel(s.toastLevel)).catch(() => {});
      })
      .catch(() => setView('login'));
  }, []);

  return (
    <>
      {view === 'loading' && <div className="boot"><Logo size={30} wordSize={17} /><span>正在加载…</span></div>}
      {view === 'login' && <Login onOk={() => { setView('list'); api.uiSettings().then((s) => setToastLevel(s.toastLevel)).catch(() => {}); }} />}
      {view === 'list' && (
        <FlowList
          onOpen={(id) => openEditor('flow', id)}
          onEditTemplate={(id) => openEditor('template', id)}
          onLogout={async () => { try { await api.logout(); } catch {} setView('login'); }}
        />
      )}
      {view === 'editor' && editor && (
        <FlowEditor
          key={`${editor.kind}:${editor.id}`}
          target={editor}
          onBack={() => setView('list')}
        />
      )}
      <GlobalToast />
      <ConfirmHost />
    </>
  );
}
