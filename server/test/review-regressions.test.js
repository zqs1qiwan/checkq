import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { secretKey, encryptValue, decryptValue } from '../src/secret.js';
import { Scheduler } from '../src/scheduler.js';
import { Engine } from '../src/engine.js';
import { buildServer } from '../src/api.js';
import { VERSION } from '../src/version.js';
import { sha256 } from '../src/market.js';

process.env.ADMIN_PASSWORD = 'test1234';
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('different data directories retain their own durable encryption keys', (t) => {
  const a = directory(t), b = directory(t);
  const ka = secretKey(a), kb = secretKey(b);
  assert.notDeepEqual(ka, kb);
  assert.deepEqual(secretKey(a), ka);
  assert.deepEqual(secretKey(b), kb);
  assert.equal(decryptValue(secretKey(a), encryptValue(ka, 'test-value')), 'test-value');
  fs.writeFileSync(path.join(b, '.secret'), 'broken');
  assert.throws(() => secretKey(b), /密钥文件/);
  assert.equal(fs.readFileSync(path.join(b, '.secret'), 'utf8'), 'broken');
});

test('corrupt storage aborts startup and preserves original files', (t) => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'flows.json'), '{broken');
  assert.throws(() => new Store(dir), /flows.json/);
  assert.equal(fs.readFileSync(path.join(dir, 'flows.json'), 'utf8'), '{broken');
});

test('partial recovery edits preserve attempts, schedule and result', (t) => {
  const store = new Store(directory(t));
  const flow = store.createFlow({ name: 'recovery', pausedAt: 1000, recovery: {
    enabled: true, intervalMinutes: 60, maxAttempts: 5, attempts: 2,
    lastProbeAt: 2000, lastResult: 'failed', nextProbeAt: Date.now() + 3600000,
  } });
  const before = { ...flow.recovery };
  const edited = store.updateFlow(flow.id, { recovery: { intervalMinutes: 90 } });
  assert.deepEqual(edited.recovery, { ...before, intervalMinutes: 90 });
  const resumed = store.updateFlow(flow.id, { enabled: true });
  assert.equal(resumed.recovery.attempts, 0);
  assert.equal(resumed.recovery.lastResult, 'failed');
  assert.equal(resumed.recovery.lastProbeAt, 2000);
});

test('task and daily summary schedules rebuild when only timezone changes', (t) => {
  const flow = { id: 'f', enabled: true, cron: '0 8 * * *', timezone: 'Asia/Shanghai' };
  const store = { flows: [flow], meta: { dailySummary: { enabled: true, time: '08:00', timezone: 'Asia/Shanghai' } } };
  const scheduler = new Scheduler(store, {});
  t.after(() => scheduler.stop());
  scheduler.rebuild();
  const oldFlow = scheduler.jobs.get('f'), oldSummary = scheduler.jobs.get('__summary__');
  scheduler.rebuild();
  assert.equal(scheduler.jobs.get('f'), oldFlow);
  flow.timezone = 'UTC';
  store.meta.dailySummary.timezone = 'UTC';
  scheduler.rebuild();
  assert.notEqual(scheduler.jobs.get('f'), oldFlow);
  assert.notEqual(scheduler.jobs.get('__summary__'), oldSummary);
  const timer = setTimeout(() => assert.fail('jitter survived shutdown'), 20);
  scheduler.pendingTimers.set('f', timer);
  scheduler.stop();
  assert.equal(scheduler.pendingTimers.size, 0);
});

test('HTTP timeout covers response body after headers arrive', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('body starts');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const start = Date.now();
  const result = await new Engine({ name: 'timeout', nodes: [{ id: 'n', type: 'http', config: {
    url: `http://127.0.0.1:${server.address().port}`, timeout: 1,
  } }], edges: [] }).run();
  assert.equal(result.ok, false);
  assert.ok(Date.now() - start < 5000);
});

test('HTTP response body is stopped at the byte limit instead of being read whole', async (t) => {
  let sent = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const chunk = Buffer.alloc(16 * 1024, 'x');
    const push = () => {
      if (sent >= 40) return res.end();
      sent++;
      res.write(chunk, () => setTimeout(push, 0));
    };
    push();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await new Engine({ name: 'limit', nodes: [{ id: 'n', type: 'http', config: {
    url: `http://127.0.0.1:${server.address().port}`,
    maxRespBytes: 64 * 1024,
  } }], edges: [] }).run();
  assert.equal(result.ok, false);
  assert.match(result.finalMessage, /响应体超过上限 65536 字节/);
});

test('MCP reports the package version and filters tasks using its search argument', async (t) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta', group: 'target' }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../mcp/checkq-mcp.cjs', import.meta.url))], { env: {
    ...process.env, CHECKQ_URL: `http://127.0.0.1:${server.address().port}`, CHECKQ_API_KEY: 'local-test',
  } });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flows_list', arguments: { search: 'TARGET' } } }),
    '',
  ].join('\n'));
  assert.equal(await closed, 0);
  const messages = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.find((m) => m.id === 1).result.serverInfo.version, VERSION);
  const flows = JSON.parse(messages.find((m) => m.id === 2).result.content[0].text);
  assert.deepEqual(flows.map((f) => f.id), ['b']);
});

test('log pagination advances by last included run, not a fixed offset', async (t) => {
  const dir = directory(t);
  const { app, store, scheduler } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const flow = store.createFlow({ name: 'pagination', nodes: [], edges: [] });
  for (let i = 0; i < 10; i++) {
    store.addRun({
      id: `run-${i}`, flowId: flow.id, startedAt: new Date(Date.now() - i * 1000).toISOString(),
      status: 'success', logs: Array.from({ length: 5 }, (_, j) => ({ index: j + 1, name: `s${j}`, type: 'log', ok: true, message: `run${i}-line${j}` })),
    });
  }
  const first = await app.inject({ url: `/api/flows/${flow.id}/logs?limit=20`, headers });
  assert.equal(first.statusCode, 200);
  const page1 = first.json();
  assert.equal(page1.entries.length, 20, '两次 10 行运行刚好一页');
  assert.equal(new Set(page1.entries.map((e) => e.runId)).size, 4, '按整次运行分页');
  const second = await app.inject({ url: `/api/flows/${flow.id}/logs?limit=20&before=${page1.nextBefore}`, headers });
  const page2 = second.json();
  assert.equal(page2.entries.length, 20);
  assert.equal(page2.entries.some((e) => page1.entries.some((x) => x.runId === e.runId)), false, '翻页不重复上一页运行');
});

test('API scopes, legacy key revocation, debug retries and restore fields', async (t) => {
  const dir = directory(t);
  const { app, store, scheduler } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const key = await app.inject({ method: 'POST', url: '/api/system/apikeys', headers, payload: { scopes: [] } });
  const denied = await app.inject({ url: '/api/flows', headers: { 'x-api-key': key.json().apiKey } });
  assert.equal(denied.statusCode, 403);
  const legacy = await app.inject({ method: 'POST', url: '/api/system/apikey', headers, payload: {} });
  const rec = store.meta.apiKeys.find((k) => k.name === '默认 Key');
  await app.inject({ method: 'DELETE', url: `/api/system/apikeys/${rec.id}`, headers });
  const revoked = await app.inject({ url: '/api/flows', headers: { 'x-api-key': legacy.json().apiKey } });
  assert.equal(revoked.statusCode, 401);
  const flow = store.createFlow({ name: 'broken script', nodes: [{ id: 'n', type: 'script', config: { code: '' } }] });
  const run = await app.inject({ method: 'POST', url: `/api/flows/${flow.id}/run`, headers, payload: { debug: true } });
  assert.equal(run.json().attempts.length, 1);
  const restored = await app.inject({ method: 'POST', url: '/api/system/restore', headers, payload: {
    flows: [{ name: 'restored', group: 'group', retry: { enabled: false }, recovery: { enabled: true, intervalMinutes: 90, maxAttempts: 4, attempts: 3 } }],
    templates: [{ name: 'template', notify: { onFailure: true } }],
  } });
  const restoredFlow = store.getFlow(restored.json().createdFlows[0].id);
  assert.equal(restoredFlow.group, 'group');
  assert.equal(restoredFlow.retry.enabled, false);
  assert.equal(restoredFlow.recovery.intervalMinutes, 90);
  assert.equal(restoredFlow.recovery.attempts, 0);
  assert.equal(restoredFlow.enabled, false);
  assert.equal(store.getTemplate(restored.json().createdTemplates[0].id).notify.onFailure, true);
  const template = { name: 'shared id', nodes: [{ id: 'n', type: 'log', config: { text: 'demo' } }], edges: [], vars: {} };
  const index = { version: 1, entries: [{ id: 'same-id', name: template.name, nodes: 1, vars: [], sha256: sha256(template), template }] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json' } });
  try {
    const first = await app.inject({ method: 'POST', url: '/api/market/import', headers, payload: { url: 'https://example.com/a.json', id: 'same-id' } });
    const second = await app.inject({ method: 'POST', url: '/api/market/import', headers, payload: { url: 'https://example.com/b.json', id: 'same-id' } });
    const repeat = await app.inject({ method: 'POST', url: '/api/market/import', headers, payload: { url: 'https://example.com/a.json', id: 'same-id' } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.notEqual(first.json().id, second.json().id);
    assert.equal(repeat.statusCode, 409);
  } finally { globalThis.fetch = originalFetch; }
});

test('flow writes expose revision and reject stale baseRev', async (t) => {
  const dir = directory(t);
  const { app, store, scheduler } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const flow = store.createFlow({ name: 'rev', nodes: [], edges: [] });
  assert.equal(flow.rev, 0, '新任务 rev 从 0 开始');

  const first = await app.inject({
    method: 'PUT', url: `/api/flows/${flow.id}`, headers,
    payload: { name: 'rev-1', baseRev: 0 },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().rev, 1, '保存后 rev 递增');
  assert.equal(store.getFlow(flow.id).name, 'rev-1');

  const stale = await app.inject({
    method: 'PUT', url: `/api/flows/${flow.id}`, headers,
    payload: { name: 'rev-stale', baseRev: 0 },
  });
  assert.equal(stale.statusCode, 409, '旧版本保存必须冲突');
  assert.equal(stale.json().conflict, true);
  assert.equal(stale.json().rev, 1);
  assert.equal(store.getFlow(flow.id).name, 'rev-1', '冲突写入不能落盘');

  const fresh = await app.inject({
    method: 'PUT', url: `/api/flows/${flow.id}`, headers,
    payload: { name: 'rev-2', baseRev: 1 },
  });
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().rev, 2);
  assert.equal(fresh.json().name, 'rev-2');

  // 旧客户端/脚本不带 baseRev 仍可写，保持兼容；但 rev 继续递增，让挂着的编辑页下次保存时发现冲突
  const legacy = await app.inject({ method: 'PUT', url: `/api/flows/${flow.id}`, headers, payload: { name: 'rev-legacy' } });
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.equal(legacy.json().rev, 3);
});
