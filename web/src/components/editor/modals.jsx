import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Modal from '../Modal.jsx';
import RecoveryFields from '../RecoveryFields.jsx';
import { isSensitiveName, CHANNEL_TYPE_OPTIONS } from '../../util.js';
import { CHANNEL_FIELDS } from '../../channel-fields.js';

function CookieHelpModal({ flow, onClose, onSaved }) {
  const [url, setUrl] = useState('https://');
  const [cookie, setCookie] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [tabId, setTabId] = useState('');
  const origin = window.location.origin;
  const captureUrl = `${origin}/api/cookie-capture`;
  const bookmarklet = `javascript:fetch('${captureUrl}',{method:'POST',headers:{'Content-Type':'application/json'},mode:'no-cors',body:JSON.stringify({flowId:'${flow?.id || ''}',cookie:document.cookie,varName:'cookie'})}).then(()=>alert('已回填到 CheckQ'));`;
  const snippet = "copy(document.cookie); // 备用：已登录页面 Console 回车后粘贴";
  const openLogin = () => window.open(url, '_blank');
  const unified = async () => {
    try {
      setErr('');
      const r = await api.browserLoginStart(flow.id, url.trim());
      setTabId(r.tabId);
      setDone(false);
    } catch (e) { setErr(e.message); }
  };
  const captureNow = async () => {
    try {
      setErr('');
      const r = await api.browserLoginCapture(flow.id, tabId);
      setCookie(`已抓到 ${r.length} 字符，已写入 {{${r.varName}}}`);
      setDone(true);
      onSaved({ cookie: '' }); // 已由服务端写入
      setTimeout(onClose, 800);
    } catch (e) { setErr(e.message); }
  };
  const save = async () => {
    try {
      const f = await onSaved({ cookie: cookie.trim() });
      if (f) { setDone(true); setTimeout(onClose, 600); }
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal
      title="统一浏览器登录（自动抓 Cookie）"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!cookie.trim()} onClick={save}>保存 cookie</button>
        </>
      }
    >
        <p className="modal-steps">
          1. 点「打开登录页」→ CheckQ 在统一浏览器打开站点，你在那登录一次
          <br />
          2. 回到这里点「已登录，自动抓」→ CheckQ 自动读 cookie 写进 <code>{'{{cookie}}'}</code>，无需粘贴
          <br />
          3. 点「运行」验证
        </p>
        <div className="field">
          <label>站点地址</label>
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button className="primary" onClick={unified}>打开登录页（统一浏览器）</button>
          <button className="small" disabled={!tabId} onClick={captureNow}>已登录，自动抓 Cookie</button>
        </div>
        {tabId && <p style={{ color: 'var(--muted)', fontSize: 11 }}>tab: {String(tabId).slice(0, 12)}… 登录后点上方抓取</p>}
        <pre className="code-block">{bookmarklet}</pre>
        <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>
          书签脚本仅在同域会话下可用（会话 Cookie 为 SameSite=Strict）；跨域请用上方「自动抓 Cookie」或手动粘贴。
        </p>
        <div className="field">
          <label>备用：粘贴 cookie 后保存</label>
          <input className="mono" readOnly value={snippet} onFocus={(e) => e.target.select()} />
        </div>
        <div className="field">
          <textarea className="mono" rows={2} value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="或在这里粘贴 cookie" />
        </div>
        {done && <p style={{ color: 'var(--ok)', fontSize: 12 }}>已回填到变量</p>}
        {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
    </Modal>
  );
}

/** 通知渠道弹窗：任务级通知渠道、触发条件与消息模板 */
function NotifyModal({ flow, onClose, onSaved, onToast }) {
  const cur = flow.notify && typeof flow.notify === 'object' ? flow.notify : {};
  const [channels, setChannels] = useState(Array.isArray(cur.channels) ? cur.channels : []);
  const [onSuccess, setOnSuccess] = useState(cur.onSuccess !== false);
  const [onFailure, setOnFailure] = useState(cur.onFailure !== false);
  const [template, setTemplate] = useState(cur.template || '[CheckQ] {{flow.name}} {{status}}\n{{message}}');
  const [err, setErr] = useState('');
  const [testResult, setTestResult] = useState(null);

  const TYPES = CHANNEL_TYPE_OPTIONS.map(([k, , label]) => [k, label]);

  const patch = (i, k, v) => setChannels(channels.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const save = async (opts = {}) => {
    setErr(''); setTestResult(null);
    try {
      const nf = await api.updateFlow(flow.id, { notify: { onSuccess, onFailure, template, channels } });
      onSaved(nf);
      if (onToast) onToast('通知渠道已保存', 'ok');
      if (opts.close !== false) onClose(); // 保存成功后必须关闭弹窗；「测试发送」不关
    } catch (e) { setErr(e.message); }
  };
  const test = async () => {
    setErr(''); setTestResult(null);
    try {
      await save({ close: false });
      const r = await api.notifyTest(flow.id);
      setTestResult({ ok: true, results: r.results, text: r.text });
    } catch (e) { setTestResult({ ok: false, error: e.message }); }
  };

  return (
    <Modal
      title={`通知渠道：${flow.name}`}
      onClose={onClose}
      className="notify-modal"
      footer={
        <>
          <button onClick={test} disabled={!channels.length}>测试发送</button>
          <button className="primary" onClick={save}>保存</button>
        </>
      }
    >
        <label className="checkline">
          <input type="checkbox" checked={onSuccess} onChange={(e) => setOnSuccess(e.target.checked)} />
          成功时通知
        </label>
        <label className="checkline">
          <input type="checkbox" checked={onFailure} onChange={(e) => setOnFailure(e.target.checked)} />
          失败时通知
        </label>
        <div className="field">
          <label title={'可用变量：{{flow.name}} / {{status}} / {{message}} / {{duration}} / {{time}}'}>通知模板</label>
          <textarea rows={2} className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} />
        </div>
        {channels.length === 0 && (
          <div className="notify-empty">
            还没有通知渠道。点下方「+ 添加渠道」选类型；站内通知不需要任何外部服务，消息会显示在首页铃铛里。
          </div>
        )}
        {channels.map((c, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <select value={c.type || 'webhook'} onChange={(e) => patch(i, 'type', e.target.value)}>
                {TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <button className="small danger" onClick={() => setChannels(channels.filter((_, j) => j !== i))}>删除</button>
            </div>
            {(CHANNEL_FIELDS[c.type || 'webhook'] || CHANNEL_FIELDS.webhook).map(([k, label]) => (
              <div className="field" key={k} style={{ marginBottom: 8 }}>
                <label>{label}</label>
                <input className="mono" value={c[k] || ''} placeholder={label} onChange={(e) => patch(i, k, e.target.value)} />
              </div>
            ))}
          </div>
        ))}
        <button className="small" onClick={() => setChannels([...channels, { type: 'webhook', url: '' }])}>+ 添加渠道</button>
        {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
        {testResult && (
          <div style={{ fontSize: 12, color: testResult.ok ? 'var(--ok)' : 'var(--fail)', marginTop: 8 }}>
            {testResult.ok ? `已发送 ${testResult.results.filter((r) => r.ok).length}/${testResult.results.length} 个渠道` : `发送失败：${testResult.error}`}
            {testResult.ok && testResult.results.some((r) => !r.ok) && (
              <div>{testResult.results.filter((r) => !r.ok).map((r) => `${r.type}: ${r.error}`).join('；')}</div>
            )}
          </div>
        )}
    </Modal>
  );
}

function LogConfigModal({ flow, onClose, onSaved }) {
  const cur = flow.log && typeof flow.log === 'object' ? flow.log : {};
  const [level, setLevel] = useState(cur.level || 'all');
  const [record, setRecord] = useState(cur.record || 'log');
  const [debug, setDebug] = useState(cur.debug === true);
  const [include, setInclude] = useState({
    reqHeaders: cur.include?.reqHeaders !== false,
    reqBody: cur.include?.reqBody !== false,
    resBody: cur.include?.resBody !== false,
    varsSnapshot: cur.include?.varsSnapshot !== false,
  });
  const [resBodyLimit, setResBodyLimit] = useState(cur.resBodyLimit ?? 2000);
  const [keywords, setKeywords] = useState(Array.isArray(cur.keywords) ? cur.keywords : []);
  const [err, setErr] = useState('');

  const save = async () => {
    try {
      const nf = await api.updateFlow(flow.id, { log: { level, record, debug, include, resBodyLimit: Number(resBodyLimit) || 0, keywords } });
      onSaved(nf);
      onClose();
    } catch (e) { setErr(e.message); }
  };

  const chk = (k, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={include[k]} onChange={(e) => setInclude({ ...include, [k]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <Modal
      title={`日志配置：${flow.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>保存</button>
        </>
      }
    >
        <div className="field">
          <label title="低档位会自动忽略下方的内容开关">记录档位</label>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">all —— 全部步骤完整记录（调试期）</option>
            <option value="failure">failure —— 仅失败步骤完整记录（稳定运行期）</option>
            <option value="summary">summary —— 只记标题/关键字/耗时（长期免维护）</option>
          </select>
        </div>
        <div className="field">
          <label title="决定运行日志里出现哪些步骤">记录范围</label>
          <select value={record} onChange={(e) => setRecord(e.target.value)}>
            <option value="log">仅 log 节点（默认：日常干净日志，只有你写的 log 才出现）</option>
            <option value="log-final">合并为一条（所有 log 合并成最终一条日志）</option>
            <option value="all">全部步骤（每个节点一行）</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            调试模式（保留每步请求/响应细节；日常请关闭）
          </label>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
            调试模式开启后，运行日志会记录完整的请求头/请求体/响应体，排障用；关闭时只留人话日志与失败步骤。
          </div>
        </div>
        <div className="field">
          <label title="仅在「全部」档位生效">记录内容开关</label>
          {chk('reqHeaders', '请求头')}
          {chk('reqBody', '请求体')}
          {chk('resBody', '响应体')}
          {chk('varsSnapshot', '运行后变量快照')}
        </div>
        <div className="field">
          <label title="单位为字符，填 0 表示不记录响应体">响应体截断长度</label>
          <input className="mono" type="number" min={0} max={100000} value={resBodyLimit} onChange={(e) => setResBodyLimit(e.target.value)} />
        </div>
        <div className="field">
          <label title="命中值进运行摘要；只影响日志与通知，不影响流程执行">关键字规则</label>
          {keywords.map((k, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input style={{ flex: 1 }} placeholder="规则名（如 积分）" value={k.name || ''} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <button className="small danger" onClick={() => setKeywords(keywords.filter((_, j) => j !== i))}>删除</button>
              </div>
              <input className="mono" placeholder="正则（第 1 捕获组为值）" value={k.regex || ''} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, regex: e.target.value } : x)))} style={{ marginBottom: 6 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={k.from || 'response'} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}>
                  <option value="response">响应体</option>
                  <option value="headers">响应头</option>
                  <option value="status">状态码</option>
                </select>
                <select value={k.into || 'summary'} onChange={(e) => setKeywords(keywords.map((x, j) => (j === i ? { ...x, into: e.target.value } : x)))}>
                  <option value="summary">进摘要</option>
                  <option value="notify">进通知</option>
                  <option value="var">写变量(仅日志侧)</option>
                </select>
              </div>
            </div>
          ))}
          <button className="small" onClick={() => setKeywords([...keywords, { name: '新规则', regex: '', from: 'response', into: 'summary' }])}>+ 添加规则</button>
        </div>
        {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
    </Modal>
  );
}

function VarsEditor({ flow, onVars }) {
  const [vars, setVars] = useState(flow.vars || {});
  const [nk, setNk] = useState('');
  const [nv, setNv] = useState('');

  useEffect(() => setVars(flow.vars || {}), [flow]);

  const add = () => {
    if (!nk.trim()) return;
    const next = { ...vars, [nk.trim()]: nv };
    setVars(next);
    setNk(''); setNv('');
    onVars(next);
  };
  const remove = (k) => {
    const next = { ...vars };
    delete next[k];
    setVars(next);
    onVars(next);
  };
  const change = (k, v) => setVars({ ...vars, [k]: v });
  const [missing, setMissing] = useState(null);
  useEffect(() => {
    api.runs(flow.id, 5).then((runs) => {
      const set = new Set();
      for (const r of runs) for (const l of r.logs || []) for (const m of l.missing || []) set.add(m);
      setMissing([...set]);
    }).catch(() => setMissing([]));
  }, [flow.id]);


  return (
    <div>
      {Object.keys(vars).length === 0 && (
        <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6, marginBottom: 8 }}>
          暂无变量。在请求里写 {'{{cookie}}'} 即可，运行时会自动替换；敏感值（cookie/token）请在这里填。
        </p>
      )}
      {missing && missing.length > 0 && (
        <div style={{ border: '1px solid var(--warn)', borderRadius: 8, padding: 8, marginBottom: 8, fontSize: 11 }}>
          ⚠ 运行日志里出现过未定义的变量：{missing.join('、 ')}
          <div style={{ color: 'var(--muted)' }}>在下面「变量名」输入同名后填值（顺序随便），重跑即自动替换。</div>
        </div>
      )}
      {Object.entries(vars).map(([k, v]) => (
        <VarRow key={k} k={k} v={v} vars={vars} sensitive={isSensitiveName(k)} remove={remove} change={change} onVars={onVars} />
      ))}
      <input style={{ fontSize: 11, padding: '4px 6px', marginBottom: 4 }} placeholder="变量名" value={nk} onChange={(e) => setNk(e.target.value)} />
      <input style={{ fontSize: 11, padding: '4px 6px', marginBottom: 4 }} placeholder="值" value={nv} onChange={(e) => setNv(e.target.value)} />
      <button className="small" style={{ width: '100%' }} onClick={add}>+ 添加变量</button>
    </div>
  );
}

/** 变量行组件：显隐状态放行组件内（hooks 不能写在 map 回调里——变量增删会改变 hook 数量导致崩溃） */
function VarRow({ k, v, vars, sensitive, remove, change, onVars }) {
  const [open, setOpen] = useState(!sensitive);
  return (
    <div className="var-row" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input className="mono" style={{ fontSize: 11, padding: '4px 6px' }} value={k} disabled />
        <button className="small var-eye" title={open ? '隐藏值' : '显示值'} aria-label={open ? '隐藏值' : '显示值'} onClick={() => setOpen(!open)}>{open ? '隐藏' : '显示'}</button>
        <button className="small danger var-del" title={`删除变量 ${k}`} aria-label={`删除变量 ${k}`} onClick={() => remove(k)}>删除</button>
      </div>
      {open ? (
        <textarea
          className="mono"
          style={{ fontSize: 11, padding: '4px 6px', marginTop: 3 }}
          rows={Math.min(3, String(v).length / 60 + 1)}
          value={v}
          onChange={(e) => change(k, e.target.value)}
          onBlur={() => onVars(vars)}
        />
      ) : (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>•••••••• <button className="small" onClick={() => setOpen(true)}>显示</button></div>
      )}
    </div>
  );
}

/** 调度弹窗（v0.4.2）：cron / 时区 / 抖动 / 启用调度 + 失败重试，独立弹窗统一风格 */
function ScheduleModal({ flow, onClose, onSave }) {
  const [cron, setCron] = useState(flow.cron || '');
  const [timezone, setTimezone] = useState(flow.timezone || 'Asia/Shanghai');
  const [jitter, setJitter] = useState(flow.jitterMinutes ?? 0);
  const [enabled, setEnabled] = useState(!!flow.enabled);
  const [retry, setRetry] = useState(() => ({
    enabled: true, maxAttempts: 3, backoff: 'exponential', baseDelayMs: 5000, maxDelayMs: 300000, jitter: true,
    ...(flow.retry || {}),
  }));
  const [recovery, setRecovery] = useState(() => ({
    enabled: false, intervalMinutes: 60, maxAttempts: 2,
    ...(flow.recovery || {}),
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setR = (patch) => setRetry((r) => ({ ...r, ...patch }));
  // 预览前三次重试的等待时间（与后端 retryDelayMs 同公式，抖动取中值）
  const preview = (() => {
    if (!retry.enabled) return '';
    const base = Math.max(1000, Number(retry.baseDelayMs) || 5000);
    const max = Math.max(base, (Number(retry.maxDelayMs) || 300000));
    const fmt = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`);
    const waits = [];
    for (let n = 1; n < Math.min(4, Number(retry.maxAttempts) || 3); n++) {
      let d = retry.backoff === 'fixed' ? base : retry.backoff === 'linear' ? base * n : base * 2 ** (n - 1);
      d = Math.min(d, max);
      waits.push(retry.jitter ? `${fmt(d / 2)}–${fmt(d)}` : fmt(d));
    }
    return waits.length ? `失败后依次等待：${waits.join(' → ')}${Number(retry.maxAttempts) > 4 ? ' …' : ''}` : '';
  })();

  const save = async () => {
    if (enabled && !cron.trim()) {
      setErr('启用定时调度需要填写 cron 表达式');
      return;
    }
    setBusy(true); setErr('');
    try {
      await onSave({
        cron: cron.trim(), timezone, jitterMinutes: Number(jitter) || 0, enabled,
        retry: {
          enabled: !!retry.enabled,
          maxAttempts: Number(retry.maxAttempts) || 3,
          backoff: retry.backoff,
          baseDelayMs: Math.round(Number(retry.baseDelayMs) || 5000),
          maxDelayMs: Math.round(Number(retry.maxDelayMs) || 300000),
          jitter: !!retry.jitter,
        },
        recovery: {
          enabled: !!recovery.enabled,
          intervalMinutes: Math.min(1440, Math.max(30, Math.round(Number(recovery.intervalMinutes) || 60))),
          maxAttempts: Math.min(5, Math.max(1, Math.round(Number(recovery.maxAttempts) || 2))),
        },
      });
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal
      title="调度"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="field">
        <label title="例：30 8 * * * = 每天 08:30；13 0 * * * = 每天 00:13">cron 表达式</label>
        <input className="mono" placeholder="30 8 * * *（留空=手动）" aria-label="cron 表达式" value={cron} onChange={(e) => setCron(e.target.value)} />
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
          <label>抖动（分钟）</label>
          <input type="number" min={0} max={60} value={jitter} aria-label="抖动（分钟）" onChange={(e) => setJitter(e.target.value)} title="cron 触发后随机延迟 0-N 分钟，0=不抖动" />
        </div>
      </div>
      <label className="checkline">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用定时调度
      </label>
      {flow.pausedAt && (
        <p className="pause-note" title={flow.pausedReason || ''}>
          {flow.recovery?.enabled
            ? `连续失败已自动停用；自动恢复探测已开启（每 ${flow.recovery.intervalMinutes} 分钟）。`
            : '连续失败已自动停用。勾选上方开关即恢复；也可以开启下方自动探测。'}
        </p>
      )}

      <div className="retry-box">
        <label className="checkline retry-head">
          <input type="checkbox" checked={!!retry.enabled} onChange={(e) => setR({ enabled: e.target.checked })} />
          <span>失败后重试</span>
          <span className="retry-hint">跑满次数才判定失败</span>
        </label>
        {retry.enabled && (
          <>
            <div className="field-inline">
              <div className="field">
                <label>最多尝试</label>
                <input type="number" min={1} max={10} value={retry.maxAttempts} aria-label="最多尝试次数"
                  onChange={(e) => setR({ maxAttempts: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>退避方式</label>
                <select value={retry.backoff} aria-label="退避方式" onChange={(e) => setR({ backoff: e.target.value })}>
                  <option value="exponential">指数退避</option>
                  <option value="linear">线性退避</option>
                  <option value="fixed">固定间隔</option>
                </select>
              </div>
            </div>
            <div className="field-inline">
              <div className="field">
                <label>首次等待（秒）</label>
                <input type="number" min={1} max={60} value={Math.round((Number(retry.baseDelayMs) || 5000) / 1000)} aria-label="首次等待（秒）"
                  onChange={(e) => setR({ baseDelayMs: Number(e.target.value) * 1000 })} />
              </div>
              <div className="field">
                <label>最长等待（分钟）</label>
                <input type="number" min={1} max={30} value={Math.round((Number(retry.maxDelayMs) || 300000) / 60000)} aria-label="最长等待（分钟）"
                  onChange={(e) => setR({ maxDelayMs: Number(e.target.value) * 60000 })} />
              </div>
            </div>
            <label className="checkline">
              <input type="checkbox" checked={!!retry.jitter} onChange={(e) => setR({ jitter: e.target.checked })} />
              随机抖动（避免多个任务同时重试）
            </label>
            {preview && <p className="retry-preview">{preview}</p>}
          </>
        )}
      </div>
      <div style={{ marginTop: 8 }}>
        <RecoveryFields value={recovery} onChange={setRecovery} />
      </div>
      {err && <p style={{ color: 'var(--fail)', fontSize: 12 }}>{err}</p>}
    </Modal>
  );
}

export { CookieHelpModal, NotifyModal, LogConfigModal, VarsEditor, ScheduleModal };

