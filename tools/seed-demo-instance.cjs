#!/usr/bin/env node
/**
 * 给一个**空实例**造最小可用数据，便于 ui-smoke / ui-interaction-audit 验证。
 *
 * 用法：node tools/seed-demo-instance.cjs http://localhost:19998 [密码]
 *
 * 只建「示例任务 / 示例模板」，不含任何真实站点与凭据；重复执行会自动跳过已存在同名任务。
 */
const BASE = process.argv[2] || 'http://localhost:19998';
const PASSWORD = process.argv[3] || process.env.ADMIN_PASSWORD || 'test1234';
const GROUP = process.env.SEED_GROUP || '示例分组';

let cookie = '';
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) if (c.startsWith('cq_session=') || c.startsWith('connect.sid=') || /^[a-z_]+\=/.test(c)) cookie = c.split(';')[0];
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const flow = (i) => ({
  name: `示例任务 ${i}`,
  note: `种子数据 ${i}`,
  enabled: false,
  cron: '0 8 * * *',
  timezone: 'Asia/Shanghai',
  vars: { base: BASE },
  nodes: [
    { id: `n${i}a`, type: 'http', name: '查询状态', x: 0, y: 0, config: { method: 'GET', url: '{{base}}/api/health', timeout: 10, asserts: [{ expr: 'last.json.ok', expect: true }] } },
    { id: `n${i}b`, type: 'log', name: '记录结果', x: 0, y: 120, config: { text: 'health={{last.json.version}}' } },
  ],
  edges: [{ id: `e${i}`, source: `n${i}a`, sourceHandle: 'success', target: `n${i}b` }],
  log: { mode: 'all' },
  notify: { channels: [] },
});

async function main() {
  const login = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  if (login.status !== 200) {
    console.error(`登录失败 ${login.status}: ${JSON.stringify(login.body)}`);
    process.exit(1);
  }

  const list = await api('/api/flows');
  const existing = new Set((Array.isArray(list.body) ? list.body : list.body.flows || []).map((f) => f.name));
  const ids = [];
  for (let i = 1; i <= 10; i++) {
    if (existing.has(`示例任务 ${i}`)) continue;
    const r = await api('/api/flows', { method: 'POST', body: JSON.stringify(flow(i)) });
    if (r.status >= 400) { console.error(`创建任务 ${i} 失败 ${r.status}: ${JSON.stringify(r.body)}`); continue; }
    ids.push(r.body.id);
  }
  if (ids.length) {
    const g = await api('/api/flows/batch', { method: 'POST', body: JSON.stringify({ action: 'set-group', ids: ids.slice(0, 6), group: GROUP }) });
    if (g.status >= 400) console.error(`设置分组失败 ${g.status}: ${JSON.stringify(g.body)}`);
    const en = await api('/api/flows/batch', { method: 'POST', body: JSON.stringify({ action: 'enable', ids: ids.slice(0, 3) }) });
    if (en.status >= 400) console.error(`启用失败 ${en.status}: ${JSON.stringify(en.body)}`);
  }

  const tpls = await api('/api/templates');
  const tplNames = new Set((Array.isArray(tpls.body) ? tpls.body : tpls.body.templates || []).map((t) => t.name));
  for (const name of ['示例模板 A', '示例模板 B']) {
    if (tplNames.has(name)) continue;
    const r = await api('/api/templates', {
      method: 'POST',
      body: JSON.stringify({
        name,
        desc: '种子数据模板',
        vars: { base: BASE },
        varNames: ['base'],
        nodes: [{ id: 'a', type: 'http', name: '查询状态', x: 0, y: 0, config: { method: 'GET', url: '{{base}}/api/health', timeout: 10 } }],
        edges: [],
        log: { mode: 'all' },
        notify: { channels: [] },
      }),
    });
    if (r.status >= 400) console.error(`创建模板 ${name} 失败 ${r.status}: ${JSON.stringify(r.body)}`);
  }

  console.log(`完成：新增任务 ${ids.length} 个（分组「${GROUP}」取前 6 个、启用前 3 个），模板 2 个`);
}

main().catch((e) => { console.error(e); process.exit(1); });
