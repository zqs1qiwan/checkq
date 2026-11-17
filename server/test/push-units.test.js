/**
 * 每日汇总与任务解耦后的兼容测试（v0.5.3）
 *  - push-targets 返回系统渠道摘要（不再列任务）
 *  - daily-summary-config 的 targetFlowIds 只读
 *  - 旧 POST /api/system/daily-summary { flowIds } 仍按任务渠道发送
 *  - 新系统汇总与任务渠道无关
 */
process.env.ADMIN_PASSWORD = 'test1234';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { buildServer } from '../src/api.js';

const dir = fs.mkdtempSync(os.tmpdir() + '/cq-push-');
const server = buildServer({ dataDir: dir, port: 0 });
const { app, scheduler } = server;
await app.ready();

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    assert.ok(await fn(), '断言未通过');
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}：${e.message}`);
  }
}

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
const H = { cookie: (login.headers['set-cookie'] || '').split(';')[0] };

const mk = async (name, channels, extra = {}) => {
  const r = await app.inject({
    method: 'POST', url: '/api/flows', headers: H,
    payload: { name, nodes: [], vars: {}, cron: '', enabled: false, notify: { onSuccess: true, onFailure: true, channels }, ...extra },
  });
  assert.strictEqual(r.statusCode, 200, r.body);
  return r.json();
};
const a = await mk('推送甲', [{ type: 'webhook', url: 'http://127.0.0.1:9/a' }]);
const b = await mk('推送乙', [{ type: 'webhook', url: 'http://127.0.0.1:9/b' }, { type: 'telegram', token: '1:x', chat: '2' }]);
const c = await mk('没有渠道', []);

await check('push-targets 返回系统渠道摘要（内置站内通知）', async () => {
  const j = (await app.inject({ method: 'GET', url: '/api/system/push-targets', headers: H })).json();
  return Array.isArray(j) && j.some((x) => x.type === 'inbox') && !j.some((x) => x.id === a.id || x.id === b.id);
});

await check('daily-summary-config 的 targetFlowIds 只读', async () => {
  server.store.meta.dailySummary = { ...(server.store.meta.dailySummary || {}), targetFlowIds: [a.id], targetFlowId: a.id };
  server.store.flush();
  const put = await app.inject({ method: 'PUT', url: '/api/system/daily-summary-config', headers: H, payload: { enabled: true, time: '09:30', timezone: 'Asia/Shanghai', targetFlowIds: [b.id, c.id] } });
  assert.strictEqual(put.statusCode, 200, put.body);
  const j = (await app.inject({ method: 'GET', url: '/api/system/daily-summary-config', headers: H })).json();
  return j.enabled === true && j.time === '09:30' && j.targetFlowIds.length === 1 && j.targetFlowIds[0] === a.id;
});

await check('旧端点按任务渠道发送（兼容一版）', async () => {
  calls.length = 0;
  const r = await app.inject({ method: 'POST', url: '/api/system/daily-summary', headers: H, payload: { flowIds: [a.id, b.id] } });
  assert.strictEqual(r.statusCode, 200, r.body);
  const j = r.json();
  return j.groups.length === 2 && j.results.length === 3 && calls.some((u) => u.includes('/a')) && calls.some((u) => u.includes('api.telegram.org'));
});

await check('旧端点文案保持「每日汇总：今日」', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/system/daily-summary', headers: H, payload: { flowIds: [a.id] } });
  return /每日汇总：今日 \d+ 次/.test(r.json().text || '');
});

await check('所选任务都没有渠道时 400', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/system/daily-summary', headers: H, payload: { flowIds: [c.id] } });
  return r.statusCode === 400;
});

await check('stats 带 nextFlowName', async () => {
  await mk('有调度的任务', [], { cron: '0 3 * * *', enabled: true });
  const j = (await app.inject({ method: 'GET', url: '/api/system/stats', headers: H })).json();
  return !!j.nextRunAt && j.nextFlowName === '有调度的任务';
});

await check('系统汇总不借任务渠道：只走 channels.json', async () => {
  await app.inject({ method: 'PUT', url: '/api/system/notify', headers: H, payload: { daily: { enabled: true, time: '09:30', skipEmpty: false }, channels: [{ type: 'inbox', id: 'ch_inbox' }, { type: 'webhook', url: 'http://127.0.0.1:9/system' }] } });
  calls.length = 0;
  const out = await server.runner.sendDailySummary('manual');
  return out.ok === true && out.results.length === 2 && out.results.some((x) => x.type === 'webhook') && calls.length === 1 && calls[0].includes('/system');
});

await check('站内汇总标题固定、不挂任务名', async () => {
  const item = server.store.listNotifications(5).items.find((x) => x.title === '每日汇总');
  return !!item && item.flowId === null && item.flowName === '' && item.content.startsWith('每日汇总 · ');
});

await app.close();
scheduler.stop();
console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
