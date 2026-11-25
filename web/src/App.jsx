import React, { useEffect, useState } from 'react';
import { api, set401Handler } from './api.js';
import Login from './components/Login.jsx';
import FlowList from './components/FlowList.jsx';
import GlobalToast from './components/GlobalToast.jsx';
import Logo from './components/Logo.jsx';
import { ConfirmHost } from './confirm.jsx';
import { setToastLevel } from './toast.js';

export default function App() {
  const [view, setView] = useState('loading');
  const [user, setUser] = useState(null);
  const [sessionError, setSessionError] = useState(false);
  // 编辑器目标：任务流程图，或模板流程图（模板编辑不新建任务）
  const [editor, setEditor] = useState(null); // { kind: 'flow' | 'template', id }
  const [Editor, setEditorComponent] = useState(null);
  const [editorLoadFailed, setEditorLoadFailed] = useState(false);

  const openEditor = (kind, id) => {
    if (!id) return;
    setEditor({ kind, id });
    setView('editor');
    if (Editor) return;
    setEditorLoadFailed(false);
    import('./components/FlowEditor.jsx').then(
      ({ default: Component }) => setEditorComponent(() => Component),
      () => setEditorLoadFailed(true),
    );
  };
  const backToList = () => setView('list');

  const showLogin = () => {
    setUser(null);
    setView('login');
  };
  const enterList = (account) => {
    setUser(account);
    setView('list');
    api.uiSettings().then((s) => setToastLevel(s.toastLevel)).catch(() => {});
  };
  const checkSession = () => {
    setSessionError(false);
    api.me().then((session) => {
      if (session.authenticated) enterList(session.user);
      else showLogin();
    }).catch(() => setSessionError(true));
  };

  useEffect(() => {
    set401Handler(showLogin);
    checkSession();
    return () => set401Handler(null);
  }, []);

  return (
    <>
      {view === 'loading' && (
        <div className="boot">
          <Logo size={30} wordSize={17} />
          {sessionError ? <span role="alert">无法检查登录状态。</span> : <span role="status">正在加载…</span>}
          {sessionError && <button className="small" onClick={checkSession}>重试</button>}
        </div>
      )}
      {view === 'login' && <Login onOk={enterList} />}
      {view === 'list' && (
        <FlowList
          me={user}
          onOpen={(id) => openEditor('flow', id)}
          onEditTemplate={(id) => openEditor('template', id)}
          onSettingsClose={() => api.me().then((session) => {
            if (session.authenticated) setUser(session.user);
            else showLogin();
          }).catch(() => {})}
          onLogout={async () => { try { await api.logout(); } catch {} showLogin(); }}
        />
      )}
      {view === 'editor' && editor && (
        Editor ? (
          <Editor key={`${editor.kind}:${editor.id}`} target={editor} onBack={backToList} />
        ) : (
          <div className="boot">
            <Logo size={30} wordSize={17} />
            {editorLoadFailed
              ? <span role="alert">编辑器加载失败，请刷新页面后重试。</span>
              : <span role="status">正在加载编辑器…</span>}
            <button className="small" onClick={backToList}>返回列表</button>
          </div>
        )
      )}
      <GlobalToast />
      <ConfirmHost />
    </>
  );
}
