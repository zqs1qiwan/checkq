import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import GroupPicker from '../GroupPicker.jsx';
import { confirmDialog } from '../../confirm.jsx';
import { setToast } from './helpers.js';
import { downloadJson } from '../../util.js';

function InstantiateModal({ tpl, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [vars, setVars] = useState(null); // {name, value}[]，从模板详情拉默认值
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.template(tpl.id).then((t) => {
      setVars(t.varNames.map((n) => ({ name: n, value: (t.vars || {})[n] || '' })));
    }).catch(() => setVars([]));
  }, [tpl.id]);

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const varsObj = {};
      for (const v of vars || []) if (v.name.trim()) varsObj[v.name.trim()] = v.value;
      const f = await api.instantiate(tpl.id, { name: name.trim() || undefined, vars: varsObj });
      onCreated(f);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`从模板创建任务：${tpl.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || vars === null} onClick={submit}>{busy ? '创建中…' : '创建任务'}</button>
        </>
      }
    >
        <div className="field">
          <label>任务名</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`默认：${tpl.name} · 序号`} />
        </div>
        {(vars || []).map((v, i) => (
          <div className="field" key={i}>
            <label className="mono">{v.name}</label>
            <textarea
              className="mono" rows={v.name === 'ua' ? 2 : Math.min(3, (v.value.length / 60 | 0) + 1)}
              value={v.value}
              onChange={(e) => setVars(vars.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
            />
          </div>
        ))}
        {vars === null && <p style={{ color: 'var(--muted)' }}>加载变量中…</p>}
        {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
    </Modal>
  );
}

/** cURL 导入 → 新任务 */
function CurlImportModal({ onClose, onCreated }) {
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);

  const parse = async () => {
    setErr(''); setPreview(null);
    if (!cmd.trim()) return;
    setBusy(true);
    try {
      const { config } = await api.importCurl(cmd);
      setPreview(config);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const f = await api.createFlow({
        name: `cURL · ${new URL(preview.url).hostname}`,
        nodes: [{ id: 'n0', type: 'http', name: '请求', x: 0, y: 0, config: preview }],
        edges: [], vars: {}, cron: '', enabled: false,
      });
      onCreated(f);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="导入 cURL 命令"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !cmd.trim()} onClick={parse}>{busy ? '解析中…' : '解析预览'}</button>
        </>
      }
    >
        <textarea
          className="mono" rows={5}
          placeholder={`curl 'https://example.com/api' \\\n  -H 'cookie: sess=...' \\\n  --data-raw '{"a":1}'`}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
        />
        {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
        {preview && (
          <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 12 }}>
            <div><b>{preview.method}</b> <span className="mono">{preview.url}</span></div>
            {(preview.headers || []).length > 0 && (
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                {(preview.headers || []).map((h) => `${h.name}: ${h.value.length > 40 ? h.value.slice(0, 40) + '…' : h.value}`).join(' | ')}
              </div>
            )}
            {preview.body && <div className="mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>body: {preview.body.slice(0, 120)}</div>}
            <button className="primary" style={{ marginTop: 8 }} disabled={busy} onClick={create}>创建任务</button>
          </div>
        )}
    </Modal>
  );
}

/** CSV 批量建任务：首行=变量名（可含 name 列），每行一条任务 */
function CsvImportModal({ tpl, onClose, onDone }) {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  const submit = async () => {
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await api.instantiateCsv(tpl.id, csv);
      const count = Array.isArray(r.created) ? r.created.length : (Number(r.created) || 0);
      setResult({ ...r, createdCount: count });
      if (count > 0) onDone(count);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`批量创建任务：${tpl.name}`}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button onClick={onClose}>关闭</button>
          <button className="primary" disabled={busy || !csv.trim()} onClick={submit}>{busy ? '创建中…' : '批量创建'}</button>
        </>
      }
    >
        <div className="csv-help">
          <div className="csv-help-title">怎么填</div>
          <ol>
            <li>第一行 = 列名（变量名），只写一次</li>
            <li>从第二行开始，<b>每一行就是一个新任务</b></li>
            <li>第一列写任务名，后面的列按第一行的变量名依次填值</li>
          </ol>
          <div className="csv-example">
            <code>任务名,cookie</code>
            <code>账号A,sess=aaaa1111</code>
            <code>账号B,sess=bbbb2222</code>
          </div>
          <div className="hint">
            {tpl.varNames.length > 0
              ? <>模板需要这些变量：{(tpl.varNames || []).join('、')}；名字要和第一行完全一致。</>
              : <>这个模板没有变量，只填任务名即可。</>}
          </div>
        </div>
        <textarea
        className="mono" rows={7}
        placeholder={'任务名,cookie\n账号A,sess=aaaa1111\n账号B,sess=bbbb2222'}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        />
        {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
        {result && (
          <p style={{ color: 'var(--ok)', fontSize: 12 }}>
            已创建 {result.createdCount ?? 0} 个任务{result.errors?.length ? `，${result.errors.length} 行失败` : ''}
          </p>
        )}
    </Modal>
  );
}

/** 站内通知中心：列表 / 已读 / 清空 */
function NotificationsModal({ onClose, onUnreadChange }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    const result = await api.notifications(100);
    setData(result);
    onUnreadChange(result.unread);
  };
  useEffect(() => { load().catch((err) => setError(err.message)); }, []);
  const update = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const clearAll = async () => {
    if (await confirmDialog({ title: '清空站内通知', message: '清空全部站内通知？此操作不可恢复。', confirmText: '清空', danger: true })) {
      await update(() => api.clearNotifications());
    }
  };
  const fmt = (ts) => new Date(ts).toLocaleString('zh-CN');
  return (
    <Modal
      title={`站内通知${data ? `（${data.total} 条，未读 ${data.unread}）` : ''}`}
      onClose={onClose}
      className="notif-modal"
      footer={
        <>
          <button className="danger" onClick={clearAll} disabled={busy || !data?.total}>清空</button>
          <span className="spacer" />
          <button className="primary" onClick={() => update(() => api.markNotificationsRead())} disabled={busy || !data?.unread}>全部已读</button>
        </>
      }
    >
      {error && <div className="notif-error" role="alert">{error}</div>}
      <div className="notif-list">
        {!data && !error && <div className="notif-empty" role="status">正在加载…</div>}
        {data && data.items.length === 0 && <div className="notif-empty">还没有通知。</div>}
        {data?.items.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`notif-item${n.read ? '' : ' unread'}`}
            aria-disabled={n.read || busy}
            tabIndex={n.read ? -1 : 0}
            onClick={() => { if (!n.read && !busy) update(() => api.markNotificationsRead([n.id])); }}
          >
            <span className="notif-item-head">
              <span className={`dot ${n.level}`} aria-hidden="true" />
              <strong>{n.title}</strong>
              <span className="notif-time">{fmt(n.createdAt)}</span>
            </span>
            <span className="notif-content">{n.content}</span>
            {n.flowName && <span className="notif-flow">来自任务：{n.flowName}</span>}
            {!n.read && <span className="notif-read-action">标为已读</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function RestoreModal({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const data = JSON.parse(text);
      const r = await api.restore(data);
      setDoneInfo(r);
      setTimeout(onDone, 300);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const [doneInfo, setDoneInfo] = useState(null);
  return (
    <Modal
      title="从备份恢复"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? '恢复中…' : '开始恢复'}</button>
        </>
      }
    >
        <textarea className="mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"flows": [...]}' title="粘贴「备份」下载的文件内容" />
        {doneInfo && <p style={{ color: 'var(--ok)', fontSize: 12 }}>已恢复 {doneInfo.createdFlows?.length || 0} 个任务、{doneInfo.createdTemplates?.length || 0} 个模板</p>}
        {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
    </Modal>
  );
}
/**
 * 模板设置：改名/描述/默认变量编辑（PRD §4.3 默认变量编辑）。
 * 变量行用 grid（变量名 | 默认值 | 删除），窄屏自动单列；保存成功后提示并关闭。
 */
function TemplateEditorModal({ tpl, onDone }) {
  const [name, setName] = useState(tpl.name);
  const [desc, setDesc] = useState(tpl.desc || '');
  const [detail, setDetail] = useState(null);
  const [vars, setVars] = useState([]); // [{name, value}]
  const [newVarName, setNewVarName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.template(tpl.id).then((t) => {
      setDetail(t);
      const names = t.varNames && t.varNames.length ? t.varNames : Object.keys(t.vars || {});
      setVars(names.map((n) => ({ name: n, value: (t.vars || {})[n] ?? '' })));
    }).catch((e) => setErr(`加载模板失败：${e.message}`));
  }, [tpl.id]);

  const addVar = () => {
    const n = newVarName.trim() || `var${vars.length + 1}`;
    setVars((cur) => [...cur, { name: n, value: '' }]);
    setNewVarName('');
    setErr('');
  };

  const save = async () => {
    const nm = name.trim();
    if (!nm) { setErr('模板名称不能为空'); return; }
    // 变量名去空格后不能重复，否则保存后会被后一个覆盖
    const seen = new Set();
    for (const v of vars) {
      const key = v.name.trim();
      if (!key) { setErr('变量名不能为空：请填写或删除空白行'); return; }
      if (seen.has(key)) { setErr(`变量名重复：${key}`); return; }
      seen.add(key);
    }
    setBusy(true);
    setErr('');
    try {
      const varsObj = {};
      for (const v of vars) if (v.name.trim()) varsObj[v.name.trim()] = v.value;
      await api.updateTemplate(tpl.id, {
        name: nm,
        desc,
        vars: varsObj,
        varNames: Object.keys(varsObj),
      });
      setToast({ kind: 'ok', text: `模板「${nm}」已保存` });
      // 提示级别默认只显示错误：弹窗内再给一次「已保存」反馈，然后自动关闭
      setSaved(true);
      window.setTimeout(onDone, 600);
    } catch (e) {
      setErr(`保存失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`模板设置：${tpl.name}`}
      subtitle={detail ? `${(detail.nodes || []).length} 个步骤，${vars.length} 个默认变量` : '正在加载模板…'}
      onClose={onDone}
      className="tpl-editor-modal"
      bodyClassName="tpl-editor"
      footer={
        <>
          <button onClick={onDone} disabled={saved}>取消</button>
          <button className="primary" disabled={busy || saved || !detail} onClick={save}>{saved ? '已保存' : busy ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="field">
        <label>模板名</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：每日签到模板" />
      </div>
      <div className="field">
        <label>描述</label>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话说明这个模板做什么（可留空）" />
      </div>
      <div className="field">
        <label title="敏感项（cookie/token 等）建议留空，实例化时再填真实值">默认变量值</label>
        {detail && vars.length === 0 && (
          <p className="hint tpl-vars-empty">还没有默认变量。模板里用到的 {'{{变量}}'} 会在这里列出，可在下方添加。</p>
        )}
        {vars.length > 0 && (
          <div className="tpl-vars-head" aria-hidden="true">
            <span>变量名</span>
            <span>默认值</span>
            <span />
          </div>
        )}
        <div className="tpl-vars">
          {vars.map((v, i) => (
            <div className="tpl-var-row" key={i}>
              <input
                className="mono"
                value={v.name}
                placeholder="变量名"
                aria-label={`第 ${i + 1} 个变量名`}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <textarea
                className="mono"
                rows={2}
                value={v.value}
                placeholder="默认值（敏感项建议留空）"
                aria-label={`变量 ${v.name || i + 1} 的默认值`}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <button
                type="button"
                className="small danger tpl-var-del"
                title={`删除变量「${v.name || i + 1}」`}
                aria-label={`删除变量「${v.name || i + 1}」`}
                onClick={() => setVars(vars.filter((_, j) => j !== i))}
              >×</button>
            </div>
          ))}
        </div>
        <div className="tpl-var-add">
          <input
            className="mono"
            placeholder="新变量名"
            aria-label="新变量名"
            value={newVarName}
            onChange={(e) => setNewVarName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addVar(); }
            }}
          />
          <button type="button" className="small" onClick={addVar}>+ 添加变量</button>
        </div>
      </div>
      {err && <p className="form-error">{err}</p>}
      {saved && <p className="form-ok">模板已保存，正在关闭…</p>}
    </Modal>
  );
}

/** 完整备份（含明文凭据）：需再次输入当前密码 */
function BackupFullModal({ onClose }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const data = await api.backupFull(password);
      downloadJson(`checkq-backup-full-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, data);
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      title="完整备份（含凭据）"
      onClose={onClose}
      width={440}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !password} onClick={submit}>{busy ? '导出中…' : '确认导出'}</button>
        </>
      }
    >
      <div className="field">
        <label>当前密码</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </div>
      {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
    </Modal>
  );
}

/** 批量设置分组（列表「分组…」按钮） */
function GroupAssignModal({ ids, groups = [], onClose, onDone }) {
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.batch(ids, 'set-group', { group: group.trim() });
      setToast({ kind: 'ok', text: `已设置 ${r.ok || 0}/${r.total || ids.length} 个任务的分组` });
      onDone?.(group.trim());
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      title={`分组：已选 ${ids.length} 个任务`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={submit}>{busy ? '设置中…' : '设置分组'}</button>
        </>
      }
    >
      <div className="field">
        <label title="留空=移出分组；选已有分组=并入该组；只影响列表折叠与统计展示">分组名</label>
        <GroupPicker
          value={group}
          onChange={setGroup}
          groups={groups}
          ariaLabel="分组名"
          placeholder="选已有分组或输入新名字（留空=未分组）"
        />
      </div>
      {err && <p style={{ color: 'var(--fail)', fontSize: 12, margin: '8px 0 0' }}>{err}</p>}
    </Modal>
  );
}

export { InstantiateModal, CurlImportModal, CsvImportModal, NotificationsModal, RestoreModal, TemplateEditorModal, BackupFullModal, GroupAssignModal };

