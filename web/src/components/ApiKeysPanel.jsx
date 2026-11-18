import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { confirmDialog } from '../confirm.jsx';
import Modal from './Modal.jsx';
import Dropdown from './Dropdown.jsx';
import { IconKey, IconCopy, IconMore } from './Icons.jsx';

const SCOPES = [
  ['read', '只读'],
  ['run', '可运行'],
  ['write', '可修改'],
  ['secrets', '读凭据'],
];

function scopeBadges(scopes) {
  const s = scopes || [];
  const out = [];
  if (s.includes('write')) out.push({ id: 'write', label: '完全权限' });
  else if (s.includes('run') && s.includes('read')) out.push({ id: 'run', label: '查看 + 运行' });
  else if (s.includes('run')) out.push({ id: 'run', label: '仅运行' });
  else if (s.includes('read')) out.push({ id: 'read', label: '只读' });
  else out.push({ id: 'none', label: '无权限' });
  if (s.includes('secrets')) out.push({ id: 'secrets', label: '可读凭据' });
  return out;
}

const rangeLabel = (k) => {
  const flows = Array.isArray(k.flowIds) ? k.flowIds.length : 0;
  const groups = Array.isArray(k.groups) ? k.groups.length : 0;
  if (!flows && !groups) return '全部任务';
  const parts = [];
  if (flows) parts.push(`${flows} 个任务`);
  if (groups) parts.push(`${groups} 个分组`);
  return parts.join(' + ');
};

const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '—');

/** API 密钥管理（GitHub token 风格）：一行一个密钥，右侧 ⋯ 菜单 */
export default function ApiKeysPanel({ onToast }) {
  const [keys, setKeys] = useState([]);
  const [flows, setFlows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['read', 'run']);
  const [allFlows, setAllFlows] = useState(true);
  const [flowIds, setFlowIds] = useState([]);
  const [groups, setGroups] = useState([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [allowedIps, setAllowedIps] = useState('');
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = () => api.apiKeys().then((r) => setKeys(r.keys || [])).catch(() => setKeys([]));
  const loadFlows = () => api.flows().then((r) => setFlows(r || [])).catch(() => setFlows([]));
  useEffect(() => { load(); loadFlows(); }, []);
  const groupOptions = [...new Set(flows.map((f) => f.group).filter(Boolean))];

  const create = async () => {
    if (!allFlows && !flowIds.length && !groups.length) return onToast('请选择任务或分组，或恢复为全部任务');
    setBusy(true);
    try {
      const r = await api.createApiKey(
        name.trim() || 'API 密钥',
        scopes,
        expiresAt || null,
        allowedIps.split(/[\n,;\s]+/).filter(Boolean),
        allFlows ? [] : flowIds,
        allFlows ? [] : groups,
      );
      setCreated(r);
      setCreating(false);
      setName(''); setAllowedIps(''); setExpiresAt('');
      setAllFlows(true); setFlowIds([]); setGroups([]);
      load();
    } catch (e) { onToast(e.message); } finally { setBusy(false); }
  };

  const revoke = async (k) => {
    const ok = await confirmDialog({ title: '回收密钥', message: `回收「${k.name}」？使用它的程序会立即失效。`, confirmText: '回收', danger: true });
    if (!ok) return;
    try { await api.revokeApiKey(k.id); load(); onToast('已回收'); }
    catch (e) { onToast(e.message); }
  };

  const toggleScope = (s) => setScopes((cur) => {
    if (s === 'read' && cur.includes('read')) return cur.filter((x) => x !== 'read' && x !== 'secrets');
    if (s === 'secrets' && !cur.includes('secrets')) return [...new Set([...cur, 'secrets', 'read'])];
    return cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
  });

  return (
    <div className="keys-panel">
      <div className="page-head-row">
        <div>
          <h3 className="section-title">API 密钥</h3>
        </div>
        <button className="primary" title="用于调用 REST API 与 MCP；明文只在生成时显示一次" onClick={() => setCreating(true)}>生成新密钥</button>
      </div>

      {created && (
        <div className="key-reveal">
          <div className="key-reveal-head">
            <strong>密钥已生成</strong>
            <span>仅显示这一次</span>
          </div>
          <div className="key-reveal-body">
            <code className="mono">{created.apiKey}</code>
            <button
              className="small"
              onClick={() => { navigator.clipboard?.writeText(created.apiKey); onToast('已复制'); }}
            ><IconCopy size={13} /> 复制</button>
          </div>
          <div className="key-reveal-foot">
            请求头 <code className="mono">x-api-key: {created.apiKey.slice(0, 12)}…</code>
            <button className="small" onClick={() => setCreated(null)}>完成</button>
          </div>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="empty">还没有 API 密钥</div>
      ) : (
        <div className="key-list">
          {keys.map((k) => (
            <div key={k.id} className="key-row">
              <span className="key-icon"><IconKey size={16} /></span>
              <div className="key-main">
                <div className="key-title">
                  <b>{k.name}</b>
                  {scopeBadges(k.scopes).map((s) => <span key={s.id} className={`chip chip-${s.id}`}>{s.label}</span>)}
                  <span className="chip chip-mute">{rangeLabel(k)}</span>
                  {k.allowedIps?.length ? <span className="chip chip-mute">IP 限 {k.allowedIps.length}</span> : null}
                  {k.expiresSoon ? <span className="chip chip-write">即将到期</span> : null}
                </div>
                <div className="key-meta">
                  <code className="mono">{k.prefix}…</code>
                  <span>创建 {fmt(k.createdAt)}</span>
                  <span>{k.expiresAt ? (k.expired ? '已过期' : `${k.daysLeft} 天后回收`) : '永不过期'}</span>
                  <span>{k.lastUsedAt ? `最近使用 ${fmt(k.lastUsedAt)}` : '未使用'}</span>
                  <span>{k.useCount ? `调用 ${k.useCount} 次` : ''}</span>
                  {k.lastUsedIp ? <span>来源 {k.lastUsedIp}</span> : null}
                </div>
              </div>
              <div className="key-ops">
                <Dropdown trigger={<IconMore />} triggerClass="dd-row" align="right" width={150} ariaLabel={`${k.name} 更多操作`}>
                  <button onClick={() => { setEditing({ key: k, ips: (k.allowedIps || []).join('\n'), scopes: [...(k.scopes || [])], allFlows: !(k.flowIds || []).length && !(k.groups || []).length, flowIds: [...(k.flowIds || [])], groups: [...(k.groups || [])] }); }}>设置</button>
                  <button onClick={() => onToast('请删除后重新生成')}>重新生成</button>
                  <button className="danger-text" onClick={() => revoke(k)}>立即回收</button>
                </Dropdown>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal
          title="生成 API 密钥"
          onClose={() => setCreating(false)}
          width={480}
          footer={
            <>
              <button onClick={() => setCreating(false)}>取消</button>
              <button className="primary" disabled={busy || !scopes.length} onClick={create}>{busy ? '生成中…' : '生成'}</button>
            </>
          }
        >
          <div className="field">
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：签到 Agent" autoFocus />
          </div>
          <div className="field">
            <label title="只读=查看任务与日志；可运行=触发任务；可修改=改变量与调度；读凭据=可读 cookie/token 明文">权限范围</label>
            <div className="chip-picker">
              {SCOPES.map(([id, label]) => (
                <label key={id} className={`chip-toggle${scopes.includes(id) ? ' on' : ''}`} title={id === 'secrets' ? '勾选后自动包含只读；能让调用方看到任务里的明文凭据' : undefined}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={scopes.includes(id)} onChange={() => toggleScope(id)} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label title="默认全部任务；关闭后可只授权部分任务或分组，避免 Agent 越权操作">任务范围</label>
            <div className="chip-picker" style={{ marginBottom: 8 }}>
              <label className={`chip-toggle${allFlows ? ' on' : ''}`}>
                <input type="checkbox" style={{ width: 'auto' }} checked={allFlows} onChange={() => { setAllFlows(!allFlows); setFlowIds([]); setGroups([]); }} />
                全部任务
              </label>
            </div>
            {!allFlows && (
              <>
                <select
                  multiple
                  className="scope-tasks"
                  value={flowIds}
                  onChange={(e) => setFlowIds([...e.target.selectedOptions].map((o) => o.value))}
                  aria-label="选择任务"
                >
                  {flows.map((f) => <option key={f.id} value={f.id}>{f.name}{f.group ? ` · ${f.group}` : ''}</option>)}
                </select>
                {groupOptions.length > 0 && (
                  <div className="chip-picker" style={{ marginTop: 8 }}>
                    {groupOptions.map((g) => (
                      <label key={g} className={`chip-toggle${groups.includes(g) ? ' on' : ''}`}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={groups.includes(g)} onChange={() => setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]))} />
                        {g}
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="field">
            <label title="到期后该密钥自动失效并从列表移除">回收日期</label>
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="field">
            <label title="每行一个 IP 或 CIDR；留空=不限制。来源 IP 取 X-Forwarded-For 优先，其次为连接来源">IP 允许名单</label>
            <textarea className="mono" rows={2} value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)} placeholder={'192.168.1.0/24'} />
          </div>
        </Modal>
      )}

      {editing && (
        <Modal
          title={`设置（${editing.key.name}）`}
          onClose={() => setEditing(null)}
          width={520}
          footer={
            <>
              <button onClick={() => setEditing(null)}>取消</button>
              <button className="primary" onClick={async () => {
                if (!editing.allFlows && !editing.flowIds.length && !editing.groups.length) return onToast('请选择任务或分组，或恢复为全部任务');
                const ips = editing.ips.split(/[\n,;\s]+/).filter(Boolean);
                try {
                  await api.updateApiKey(editing.key.id, {
                    scopes: editing.scopes,
                    allowedIps: ips,
                    flowIds: editing.allFlows ? [] : editing.flowIds,
                    groups: editing.allFlows ? [] : editing.groups,
                  });
                  setEditing(null);
                  load();
                  onToast('已更新');
                } catch (e) { onToast(e.message); }
              }}>保存</button>
            </>
          }
        >
          <div className="field">
            <label title="只读=查看任务与日志；可运行=触发任务；可修改=改变量与调度；读凭据=可读 cookie/token 明文">权限范围</label>
            <div className="chip-picker">
              {SCOPES.map(([id, label]) => (
                <label key={id} className={`chip-toggle${editing.scopes.includes(id) ? ' on' : ''}`} title={id === 'secrets' ? '勾选后自动包含只读；能让调用方看到任务里的明文凭据' : undefined}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={editing.scopes.includes(id)} onChange={() => setEditing((cur) => {
                    let next = [...cur.scopes];
                    if (id === 'read' && next.includes('read')) next = next.filter((x) => x !== 'read' && x !== 'secrets');
                    else if (id === 'secrets' && !next.includes('secrets')) next = [...new Set([...next, 'secrets', 'read'])];
                    else next = next.includes(id) ? next.filter((x) => x !== id) : [...next, id];
                    return { ...cur, scopes: next };
                  })} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label title="默认全部任务；关闭后可只授权部分任务或分组">任务范围</label>
            <div className="chip-picker" style={{ marginBottom: 8 }}>
              <label className={`chip-toggle${editing.allFlows ? ' on' : ''}`}>
                <input type="checkbox" style={{ width: 'auto' }} checked={editing.allFlows} onChange={() => setEditing((cur) => ({ ...cur, allFlows: !cur.allFlows, flowIds: [], groups: [] }))} />
                全部任务
              </label>
            </div>
            {!editing.allFlows && (
              <>
                <select
                  multiple
                  className="scope-tasks"
                  value={editing.flowIds}
                  onChange={(e) => setEditing((cur) => ({ ...cur, flowIds: [...e.target.selectedOptions].map((o) => o.value) }))}
                  aria-label="选择任务"
                >
                  {flows.map((f) => <option key={f.id} value={f.id}>{f.name}{f.group ? ` · ${f.group}` : ''}</option>)}
                </select>
                {groupOptions.length > 0 && (
                  <div className="chip-picker" style={{ marginTop: 8 }}>
                    {groupOptions.map((g) => (
                      <label key={g} className={`chip-toggle${editing.groups.includes(g) ? ' on' : ''}`}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={editing.groups.includes(g)} onChange={() => setEditing((cur) => ({ ...cur, groups: cur.groups.includes(g) ? cur.groups.filter((x) => x !== g) : [...cur.groups, g] }))} />
                        {g}
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="field">
            <label title="每行一个 IP 或 CIDR；留空=不限制">允许的 IP / CIDR</label>
            <textarea className="mono" rows={4} value={editing.ips} onChange={(e) => setEditing({ ...editing, ips: e.target.value })} placeholder={'192.168.1.0/24'} />
          </div>
        </Modal>
      )}
    </div>
  );
}
