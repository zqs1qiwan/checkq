/**
 * 每日汇总独立成系统通知（v0.5.3）验收：AC-1～AC-12
 *  - channels.json 独立加密存储与迁移
 *  - 统计窗口 / 幂等 / 补发 / 空日 / 外部失败兜底
 *  - 权限、旧端点兼容、备份脱敏
 */
process.env.ADMIN_PASSWORD = 'test1234';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { buildServer } from '../src/api.js';

let passed = 0;
let failed = 0;
const fails = [];
async function check(name, fn) {
  try {
    const ok = await fn();
    assert.ok(ok, '断言未通过');
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed += 1;
    fails.push(name);
    console.log(`  FAIL ${name}：${e.message}`);
  }
}

const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (date, h, m = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0).getTime();
const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
const yesterday = dayStr(yesterdayDate);
const twoDaysAgoDate = new Date(); twoDaysAgoDate.setDate(twoDaysAgoDate.getDate() - 2);
const twoDaysAgo = dayStr(twoDaysAgoDate);
const emptyDateObj = new Date(); emptyDateObj.setDate(emptyDateObj.getDate() - 40);
const emptyDate = dayStr(emptyDateObj);

const dir = fs.mkdtempSync(os.tmpdir() + '/cq-sysnotify-');
const server = buildServer({ dataDir: dir, port: 0 });
const { app, store, scheduler, runner } = server;
await app.ready();

let fetchMode = 'ok';
globalThis.fetch = async (url) => {
  if (fetchMode === 'fail' && String(url).includes('fail.local')) {
    return new Response('unauthorized', { status: 401 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const login = async (username = 'admin', password = 'test1234') => {
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  return (r.headers['set-cookie'] || '').split(';')[0];
};
const H = { cookie: await login() };

const putNotify = async (daily, channels) => app.inject({ method: 'PUT', url: '/api/system/notify', headers: H, payload: { daily, channels } });
const mkFlow = async (name, enabled = false) => {
  const r = await app.inject({ method: 'POST', url: '/api/flows', headers: H, payload: { name, nodes: [], edges: [], vars: {}, cron: enabled ? '0 3 * * *' : '', enabled } });
  assert.strictEqual(r.statusCode, 200, r.body);
  return r.json();
};
const addRun = (flowId, status, startedAt, message) => store.addRun({
  id: crypto.randomUUID(), flowId, status, startedAt, finishedAt: new Date(startedAt).getTime() + 1000,
  finalMessage: message, logs: [], durationMs: 1000,
});

const a = await mkFlow('汇总甲');
const b = await mkFlow('汇总乙');
addRun(a.id, 'failed', at(yesterdayDate, 23, 58), '夜间失败：HTTP 500');
addRun(a.id, 'success', at(new Date(), 0, 2), '凌晨成功');
addRun(b.id, 'success', at(yesterdayDate, 12, 0), '正常运行');

const baseDaily = { enabled: true, time: '08:00', timezone: 'Asia/Shanghai', skipEmpty: true };
let r = await putNotify(baseDaily, [{ type: 'inbox', id: 'ch_inbox' }]);
assert.strictEqual(r.statusCode, 200, r.body);
assert.deepStrictEqual(store.getSystemChannels().map((c) => c.type), ['inbox'], '初始只有内置站内通知');

await check('AC-1 所有任务停用后，系统汇总仍发送', async () => {
  store.flows.forEach((f) => { f.enabled = false; });
  const out = await runner.sendDailySummary('manual', { date: yesterday });
  return out.ok && out.results.some((x) => x.type === 'inbox' && x.ok);
});

await check('AC-3 标题/flowId/正文身份干净', async () => {
  const n = store.listNotifications(5).items.find((x) => x.title === '每日汇总');
  return !!n && n.flowId === null && n.flowName === '' && n.content.startsWith('每日汇总 · ');
});

await check('AC-4 昨日 23:58 与今日 00:02 只统计昨日', async () => {
  const p = await app.inject({ method: 'POST', url: '/api/system/notify/preview', headers: H, payload: { date: yesterday } });
  const j = p.json();
  return j.counts.runs === 2 && j.counts.failed === 1 && j.counts.success === 1 && j.text.includes('夜间失败') && !j.text.includes('凌晨成功');
});

await check('汇总用时间顺序计算最后失败与连续失败，兼容 ISO 时间', async () => {
  const flow = await mkFlow('失败时序');
  const cutoff = new Date(2001, 0, 1, 23, 59, 59, 999).getTime();
  const start = new Date(2001, 0, 1).getTime();
  addRun(flow.id, 'failed', cutoff, '最后一次失败\n保留首行');
  addRun(flow.id, 'success', start - 300, '上次成功');
  addRun(flow.id, 'failed', start - 300, '同毫秒失败，历史中排在成功之后写入');
  addRun(flow.id, 'failed', start - 301, '上次成功之前的失败');
  addRun(flow.id, 'failed', start - 5, '前一日失败');
  addRun(flow.id, 'failed', new Date(start + 5).toISOString(), '窗口内较早失败');
  addRun(flow.id, 'cancelled', start + 15, '已取消');
  addRun(flow.id, 'running', start + 20, '仍在运行');
  addRun(flow.id, 'success', cutoff + 1, '次日成功');
  const stats = store.statsForRange(start, cutoff);
  assert.deepEqual([stats.runs, stats.success, stats.failed], [3, 0, 2]);
  assert.deepEqual(stats.failures, [{ flowName: flow.name, at: cutoff, message: '最后一次失败', consecutive: 4 }]);
  return true;
});

await check('AC-5 同一窗口重复触发返回 duplicate', async () => {
  store.meta.dailySummary.lastSentDate = yesterday;
  store.flush();
  const before = store.listNotifications(1).total;
  const out = await runner.sendDailySummary('cron');
  return out.skipped === 'duplicate' && store.listNotifications(1).total === before;
});

await check('AC-6 停机错过触发后补发一次，正文标注补发', async () => {
  store.meta.dailySummary.lastSentDate = twoDaysAgo;
  store.flush();
  const out = await runner.catchUpDailySummary();
  return out.ok && out.text.includes('（补发）') && store.meta.dailySummary.lastSentDate === yesterday;
});

await check('AC-7 空日 skipEmpty 两态', async () => {
  store.meta.dailySummary.lastSentDate = yesterday;
  store.meta.dailySummary.skipEmpty = true;
  store.flush();
  const before = store.listNotifications(1).total;
  const skipped = await runner.sendDailySummary('cron', { date: emptyDate });
  if (skipped.skipped !== 'empty' || store.listNotifications(1).total !== before) return false;
  await putNotify({ ...baseDaily, skipEmpty: false }, [{ type: 'inbox', id: 'ch_inbox' }]);
  const sent = await runner.sendDailySummary('cron', { date: emptyDate });
  return sent.ok && sent.text.includes('昨日无任务运行');
});

await check('AC-12 20 个失败任务正文 ≤2000、失败条目 ≤5、含另有 15 个', async () => {
  for (let i = 0; i < 20; i++) {
    const f = await mkFlow(`失败任务${i + 1}`);
    addRun(f.id, 'failed', at(twoDaysAgoDate, 10, i), `失败原因 ${i + 1}：请求超时，上游服务暂时不可用，重试后仍然失败`);
  }
  const p = await app.inject({ method: 'POST', url: '/api/system/notify/preview', headers: H, payload: { date: twoDaysAgo } });
  const j = p.json();
  const bullets = (j.text.match(/\n· /g) || []).length;
  return j.text.length <= 2000 && bullets <= 5 && j.text.includes('另有 15 个任务失败');
});

await check('AC-8 外部渠道 401 写「汇总推送失败」且不抛异常', async () => {
  await putNotify({ ...baseDaily, skipEmpty: true }, [{ type: 'inbox', id: 'ch_inbox' }, { type: 'webhook', url: 'http://fail.local/hook' }]);
  fetchMode = 'fail';
  const out = await runner.sendDailySummary('manual', { date: yesterday });
  fetchMode = 'ok';
  const n = store.listNotifications(5).items.find((x) => x.title === '汇总推送失败');
  const last = store.meta.dailySummary.lastResult;
  return out.ok === false && last.failed.some((f) => f.type === 'webhook' && f.error.includes('401')) && !!n && n.content.includes('webhook: HTTP 401');
});

await check('AC-10 operator GET 200 / PUT 403', async () => {
  const cu = await app.inject({ method: 'POST', url: '/api/system/users', headers: H, payload: { username: 'viewer1', password: 'test123456', role: 'operator' } });
  assert.strictEqual(cu.statusCode, 200, cu.body);
  const OH = { cookie: await login('viewer1', 'test123456') };
  const g = await app.inject({ method: 'GET', url: '/api/system/notify', headers: OH });
  const p = await app.inject({ method: 'PUT', url: '/api/system/notify', headers: OH, payload: { daily: baseDaily } });
  return g.statusCode === 200 && p.statusCode === 403;
});

await check('AC-11 旧端点 200 且字段完整、targetFlowIds 只读', async () => {
  store.meta.dailySummary.targetFlowIds = [a.id];
  store.flush();
  const put = await app.inject({ method: 'PUT', url: '/api/system/daily-summary-config', headers: H, payload: { enabled: true, time: '08:10', timezone: 'Asia/Shanghai', targetFlowIds: [b.id] } });
  const get = await app.inject({ method: 'GET', url: '/api/system/daily-summary-config', headers: H });
  const j = get.json();
  const pid = await app.inject({ method: 'GET', url: '/api/system/push-targets', headers: H });
  return put.statusCode === 200 && get.statusCode === 200
    && j.targetFlowIds.length === 1 && j.targetFlowIds[0] === a.id
    && j.enabled === true && j.time === '08:10'
    && Array.isArray(pid.json()) && pid.json().some((x) => x.type === 'inbox');
});

await check('AC-9 channels.json 落盘 pass 为 enc:v1、GET 明文、备份脱敏/完整', async () => {
  await putNotify({ ...baseDaily, skipEmpty: true }, [
    { type: 'inbox', id: 'ch_inbox' },
    { type: 'email', id: 'ch_mail', host: 'smtp.example.com', port: '465', user: 'mailer', pass: 'super-secret-pass', from: 'a@example.com', to: 'b@example.com' },
  ]);
  const raw = JSON.parse(fs.readFileSync(`${dir}/channels.json`, 'utf8'));
  const storedMail = raw.system.find((c) => c.type === 'email');
  const g = await app.inject({ method: 'GET', url: '/api/system/notify', headers: H });
  const getMail = g.json().channels.find((c) => c.type === 'email');
  const masked = await app.inject({ method: 'GET', url: '/api/system/backup', headers: H });
  const full = await app.inject({ method: 'POST', url: '/api/system/backup', headers: H, payload: { password: 'test1234' } });
  const maskedMail = masked.json().channels.find((c) => c.type === 'email');
  const fullMail = full.json().channels.find((c) => c.type === 'email');
  return String(storedMail.pass).startsWith('enc:v1:')
    && getMail.pass === 'super-secret-pass'
    && maskedMail.pass === '***'
    && fullMail.pass === 'super-secret-pass';
});

// AC-2：迁移来源任务被删除，系统渠道与发送不受影响
const legacyDir = fs.mkdtempSync(os.tmpdir() + '/cq-sysnotify-legacy-');
const legacyFlow = {
  id: 'legacy-flow-1', name: '历史签到', enabled: true, cron: '0 8 * * *', timezone: 'Asia/Shanghai',
  vars: {}, nodes: [], edges: [], retry: null,
  notify: { onSuccess: true, onFailure: true, channels: [{ type: 'telegram', token: '123:abc', chat: '42' }] },
};
fs.writeFileSync(`${legacyDir}/flows.json`, JSON.stringify([legacyFlow]));
fs.writeFileSync(`${legacyDir}/meta.json`, JSON.stringify({ dailySummary: { enabled: true, time: '08:00', timezone: 'Asia/Shanghai', targetFlowIds: [legacyFlow.id] } }));
const legacy = buildServer({ dataDir: legacyDir, port: 0 });
await legacy.app.ready();
const LH = { cookie: (await legacy.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } })).headers['set-cookie'].split(';')[0] };

await check('迁移：复制启用任务的渠道并写入 migratedFrom', async () => {
  const channels = legacy.store.getSystemChannels();
  return channels.some((c) => c.type === 'telegram' && c.token === '123:abc')
    && legacy.store.meta.dailySummary.migratedFrom === legacyFlow.id
    && fs.existsSync(`${legacyDir}/channels.json`);
});

await check('AC-2 删除迁移来源任务后渠道仍在且可发送', async () => {
  legacy.store.addRun({ id: 'lr1', flowId: legacyFlow.id, status: 'success', startedAt: at(yesterdayDate, 9, 0), finalMessage: 'ok', logs: [] });
  const del = await legacy.app.inject({ method: 'DELETE', url: `/api/flows/${legacyFlow.id}`, headers: LH });
  assert.strictEqual(del.statusCode, 200, del.body);
  fetchMode = 'ok';
  const out = await legacy.runner.sendDailySummary('manual', { date: yesterday });
  return out.ok && out.results.some((x) => x.type === 'telegram' && x.ok) && legacy.store.getSystemChannels().some((c) => c.type === 'telegram');
});

// 迁移幂等：channels.json 被删但 migratedAt 还在 → 不再复制旧任务渠道
const guardDir = fs.mkdtempSync(os.tmpdir() + '/cq-sysnotify-guard-');
fs.writeFileSync(`${guardDir}/flows.json`, JSON.stringify([{ ...legacyFlow, id: 'guard-flow' }]));
fs.writeFileSync(`${guardDir}/meta.json`, JSON.stringify({ dailySummary: { enabled: true, migratedAt: 1, migratedFrom: 'guard-flow', targetFlowIds: ['guard-flow'] } }));
const guard = buildServer({ dataDir: guardDir, port: 0 });
await guard.app.ready();
await check('迁移幂等：已有 migratedAt 时不再复制任务渠道', async () => guard.store.getSystemChannels().length === 1 && guard.store.getSystemChannels()[0].type === 'inbox');
await guard.app.close();
guard.scheduler.stop();

await app.close();
scheduler.stop();
await legacy.app.close();
legacy.scheduler.stop();
console.log(`\n${passed}/${passed + failed} passed`);
if (failed) {
  console.log(`FAILED: ${fails.join(', ')}`);
  process.exit(1);
}
