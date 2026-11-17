import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import { fmtTime } from './helpers.js';

/**
 * 模板市场 v1（P0-5）：自填索引地址 → 浏览 → 预览 → 导入。
 * 通道要点：
 *   - 索引必须声明 version=1、每条带 sha256；导入前服务端重算哈希，不一致直接拒绝（不做"信任来源"式放行）。
 *   - 同一 sourceId 已导入过 → 409，由用户决定「覆盖」或「另存副本」，不静默改别人的模板。
 *   - 内容里的敏感变量默认清空；含脚本的模板在预览里标出来，让人自己决定要不要用。
 */
export default function MarketPanel({ onImported, onToast }) {
  const [subs, setSubs] = useState(null);
  const [url, setUrl] = useState('');
  const [active, setActive] = useState(null);       // 当前索引 { url, name, entries, newCount, ... }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [preview, setPreview] = useState(null);     // { entry, template, varsCleared, hasScript, sha256 }
  const [knownScripts, setKnownScripts] = useState({}); // id -> true（预览过/导入过的含脚本条目）
  const [conflict, setConflict] = useState(null);   // { id, name }

  const loadSubs = () => api.marketSubscriptions().then((r) => setSubs(r.items || [])).catch(() => setSubs([]));
  useEffect(() => { loadSubs(); }, []);

  const openIndex = async (target) => {
    const u = String(target || url || '').trim();
    if (!u) return;
    setBusy(true);
    setErr('');
    try {
      const data = await api.marketIndex(u);
      setActive(data);
      setUrl(u);
      const sub = (subs || []).find((s) => s.url === u);
      if (sub) api.marketAck(u, (data.entries || []).length).then(() => loadSubs()).catch(() => {});
    } catch (e) {
      setActive(null);
      setErr(e.message);
    } finally { setBusy(false); }
  };

  const subscribe = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.marketSubscribe(url.trim());
      setSubs(r.items || []);
      await openIndex(url.trim());
      onToast?.('已订阅这个索引', 'ok');
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(false); }
  };

  const unsubscribe = async (u) => {
    const r = await api.marketUnsubscribe(u);
    setSubs(r.items || []);
    if (active?.url === u) setActive(null);
  };

  const doPreview = async (entry) => {
    setBusy(true);
    try {
      const r = await api.marketPreview(active.url, entry.id);
      setPreview({ ...r, entry: { ...entry, ...r.entry } });
      if (r.hasScript) setKnownScripts((k) => ({ ...k, [entry.id]: true }));
    } catch (e) {
      onToast?.(e.message, 'fail');
    } finally { setBusy(false); }
  };

  const doImport = async (entry, mode) => {
    setBusy(true);
    try {
      const r = await api.marketImport(active.url, entry.id, mode);
      if (r.hasScript) setKnownScripts((k) => ({ ...k, [entry.id]: true }));
      setConflict(null);
      setPreview(null);
      onToast?.(r.replaced ? `已覆盖「${r.name}」` : `已导入「${r.name}」`, 'ok');
      onImported?.();
    } catch (e) {
      const msg = e.message || '';
      if (/已经导入过/.test(msg)) {
        setConflict({ id: entry.id, name: entry.name, entry });
      } else onToast?.(msg, 'fail');
    } finally { setBusy(false); }
  };

  const tags = useMemo(() => {
    const set = new Set();
    for (const e of active?.entries || []) for (const t of e.tags || []) set.add(t);
    return [...set].sort();
  }, [active]);

  const entries = (active?.entries || []).filter((e) => {
    if (tag && !(e.tags || []).includes(tag)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return String(e.name).toLowerCase().includes(q) || String(e.desc || '').toLowerCase().includes(q);
  });

  return (
    <div className="market">
      <div className="page-head">
        <h2>模板市场</h2>
        <span className="market-note">自填索引地址；不连接任何官方仓库</span>
      </div>

      <div className="field-inline" style={{ maxWidth: 640 }}>
        <div className="field" style={{ flex: '1 1 auto' }}>
          <label htmlFor="mk-url">索引地址</label>
          <input id="mk-url" className="mono" placeholder="https://example.com/templates.json" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="field" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', gap: 6 }}>
          <button className="small" disabled={busy} onClick={() => openIndex()}>浏览</button>
          <button className="small primary" disabled={busy} onClick={subscribe}>订阅</button>
        </div>
      </div>

      {err && <p className="market-err">{err}</p>}

      {subs?.length > 0 && (
        <div className="market-subs">
          {subs.map((s) => (
            <span key={s.url} className={`market-sub${active?.url === s.url ? ' on' : ''}`}>
              <button className="linkbtn" onClick={() => openIndex(s.url)} title={s.url}>{s.name || s.url}</button>
              <button className="market-sub-x" onClick={() => unsubscribe(s.url)} title="取消订阅" aria-label={`取消订阅 ${s.name}`}>✕</button>
            </span>
          ))}
        </div>
      )}

      {active && (
        <>
          <div className="market-head">
            <span className="meta">
              <span>{active.name || active.url}</span>
              <span><b>{active.entries?.length || 0}</b> 条</span>
              {active.newCount ? <span className="market-new">新增 {active.newCount}</span> : null}
              {active.updatedAt ? <span>更新 {fmtTime(active.updatedAt)}</span> : null}
            </span>
            <span className="spacer" />
            <input className="toolbar-search" placeholder="搜索模板" aria-label="搜索模板" value={search} onChange={(e) => setSearch(e.target.value)} />
            {tags.length > 0 && (
              <select className="toolbar-select" aria-label="按标签筛选" value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">全部标签</option>
                {tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </div>

          {!entries.length ? (
            <div className="empty-line">没有匹配的模板</div>
          ) : (
            <div className="tpl-grid">
              {entries.map((e) => {
                const local = (active.localTemplates || []).find((t) => t.sourceId === e.id);
                return (
                  <div key={e.id} className="tpl-card market-card">
                    <div className="tpl-name">
                      {e.name}
                      {knownScripts[e.id] && <span className="chip chip-warn" title="模板里有脚本步骤，导入后请自己看一遍代码">含脚本</span>}
                      {local && <span className="chip chip-mute" title={local.name}>已导入</span>}
                    </div>
                    <div className="tpl-desc">{e.desc || '—'}</div>
                    {(e.tags || []).length > 0 && (
                      <div className="market-tags">
                        {(e.tags || []).map((t) => <button key={t} className="market-tag" onClick={() => setTag(t)}>{t}</button>)}
                      </div>
                    )}
                    <div className="tpl-meta">
                      <span className="meta">
                        {(e.nodeCount || 0) > 0 ? <span><b>{e.nodeCount}</b> 步</span> : null}
                        <span><b>{(e.vars || []).length}</b> 个变量</span>
                        <span className="mono market-hash" title={`sha256 前 12 位：${e.hash12}`}>{e.hash12}</span>
                        {e.source ? <span>{e.source}</span> : null}
                      </span>
                    </div>
                    <div className="tpl-actions">
                      <button className="small" disabled={busy} onClick={() => doPreview(e)}>预览</button>
                      <button className="small primary" disabled={busy} onClick={() => doImport(e)}>{local ? '覆盖导入' : '导入'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {!active && subs?.length > 0 && <div className="empty-line">点上面的订阅名字开始浏览</div>}

      {preview && (
        <Modal
          title={preview.entry?.name || '预览'}
          subtitle={`${preview.entry?.id || ''}`}
          width={620}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button onClick={() => setPreview(null)}>关闭</button>
              <button className="primary" disabled={busy} onClick={() => doImport(preview.entry)}>导入这个模板</button>
            </>
          }
        >
          {preview.entry?.desc && <p className="market-desc">{preview.entry.desc}</p>}
          <div className="meta market-pmeta">
            <span>步数 <b>{preview.entry?.nodeCount ?? '—'}</b></span>
            <span className="mono" title={`校验通过的 sha256：${preview.sha256 || ''}`}>{(preview.sha256 || '').slice(0, 12)}</span>
            {preview.hasScript ? <span className="chip chip-warn">含脚本</span> : null}
            {preview.varsCleared ? <span className="market-warn">敏感默认值已清空</span> : null}
          </div>
          <div className="section-title">需要的变量</div>
          {!(preview.entry?.vars || []).length ? (
            <p className="empty-line">这条模板不需要变量</p>
          ) : (
            <ul className="market-vars">
              {(preview.entry.vars || []).map((v) => (
                <li key={v.name} className={v.required ? 'req' : ''}>
                  <span className="mono">{v.name}</span>
                  {v.required ? <span className="market-req">必填</span> : <span className="market-opt">可选</span>}
                  {v.desc ? <span className="market-vdesc">{v.desc}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {preview.hasScript && (
            <div className="market-script-tip">模板含脚本步骤，导入后请打开代码自己看一遍再运行</div>
          )}
        </Modal>
      )}

      {conflict && (
        <Modal
          title="已经导入过"
          onClose={() => setConflict(null)}
          footer={
            <>
              <button onClick={() => setConflict(null)}>取消</button>
              <button disabled={busy} onClick={() => doImport(conflict.entry, 'copy')}>另存为副本</button>
              <button className="primary" disabled={busy} onClick={() => doImport(conflict.entry, 'overwrite')}>覆盖已有</button>
            </>
          }
        >
          <p className="market-desc">「{conflict.name}」此前导入过。覆盖＝更新那一份；副本＝另建一份。</p>
        </Modal>
      )}
    </div>
  );
}
