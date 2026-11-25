import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { runWithRetry } from '../src/retry.js';
import { buildServer } from '../src/api.js';

process.env.ADMIN_PASSWORD = 'test1234';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const delayFlow = (seconds = 5) => ({
  id: 'f-run-control',
  name: 'run-control',
  vars: {},
  log: { mode: 'all' },
  retry: { enabled: false },
  nodes: [{ id: 'n1', type: 'delay', config: { seconds } }],
  edges: [],
});

test('engine aborts an in-flight delay immediately', async () => {
  const engine = new Engine(delayFlow(8));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);
  const started = Date.now();
  const run = await engine.run({ trigger: 'manual', signal: ac.signal });
  assert.equal(run.cancelled, true, '取消的运行应标记 cancelled');
  assert.equal(run.ok, false);
  assert.match(run.finalMessage, /运行已取消/);
  assert.ok(Date.now() - started < 2000, '取消应立即结束，不能等完 8 秒 delay');
  assert.ok(run.logs.some((l) => l.cancelled), '日志应标出取消');
});

test('retry backoff stops when the run is cancelled', async () => {
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 60);
  const res = await runWithRetry({
    retry: { enabled: true, maxAttempts: 5, baseDelayMs: 5000, maxDelayMs: 5000 },
    signal: ac.signal,
    shouldStop: () => ac.signal.aborted,
    runOnce: async () => ({ ok: false, finalMessage: 'boom' }),
  });
  assert.equal(res.cancelled, true, '退避期间取消应立即结束');
  assert.equal(res.finalMessage, '运行已取消');
  assert.ok(Date.now() - started < 1000, '不能等完 5 秒退避');
});

test('API exposes queued run and cancels a running flow', async (t) => {
  const dir = directory(t);
  const { app, store, scheduler } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const flow = store.createFlow({
    name: 'cancel-me', enabled: false, retry: { enabled: false },
    nodes: [{ id: 'n1', type: 'delay', config: { seconds: 10 } }], edges: [],
  });

  const started = Date.now();
  const pending = app.inject({
    method: 'POST', url: `/api/flows/${flow.id}/run`, headers,
    payload: { stream: false },
  });
  // 等运行真正进入 running，再取消
  let runId = null;
  for (let i = 0; i < 30; i++) {
    const runs = await app.inject({ method: 'GET', url: `/api/runs?flowId=${flow.id}`, headers });
    const list = runs.json();
    const live = list.find((r) => ['queued', 'running'].includes(r.status));
    if (live) { runId = live.id; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(runId, '排队/运行中的运行应立即出现在运行历史里');

  const cancel = await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, headers, payload: {} });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().cancelling, true);

  const done = await pending;
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().status, 'cancelled');
  assert.equal(done.json().cancelled, true);
  assert.match(done.json().finalMessage, /运行已取消/);
  assert.ok(Date.now() - started < 5000, '取消后不能继续等满 10 秒');

  const again = await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, headers, payload: {} });
  assert.equal(again.statusCode, 409, '已结束的运行不能再取消');
});

test('run and inbox updates persist immediately without rewriting unrelated files', async (t) => {
  const dir = directory(t);
  const { app, store, scheduler, runner } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });
  const flow = store.createFlow({
    name: 'local-notify', enabled: false,
    nodes: [{ id: 'n1', type: 'log', config: { message: 'done' } }], edges: [],
    notify: { onSuccess: true, channels: [{ type: 'inbox' }] },
  });
  const untouched = [store.flowsFile, store.templatesFile, store.channelsFile, store.metaFile];
  const oldTime = 946684800;
  for (const file of untouched) fs.utimesSync(file, oldTime, oldTime);
  const disk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

  const run = await runner.runFlow(flow, 'manual', {
    onStart: (started) => assert.equal(disk(store.runsFile).find((item) => item.id === started.id)?.status, 'running'),
  });
  assert.equal(run.status, 'success');
  assert.equal(run.notify?.ok, 1);
  assert.deepEqual(disk(store.runsFile)[0].notify, run.notify);
  assert.equal(disk(store.notificationsFile).length, 1);
  for (const file of untouched) assert.equal(fs.statSync(file).mtimeMs, oldTime * 1000, path.basename(file));

  fs.utimesSync(store.runsFile, oldTime, oldTime);
  assert.equal(store.markNotificationsRead([disk(store.notificationsFile)[0].id]), 1);
  assert.equal(disk(store.notificationsFile)[0].read, true);
  assert.equal(fs.statSync(store.runsFile).mtimeMs, oldTime * 1000);
  assert.equal(store.clearNotifications(), 1);
  assert.deepEqual(disk(store.notificationsFile), []);
  assert.equal(fs.statSync(store.runsFile).mtimeMs, oldTime * 1000);
});

test('startup closes interrupted runs without executing or changing their tasks', async (t) => {
  const dir = directory(t);
  const before = new Store(dir);
  const flow = before.createFlow({ ...delayFlow(), enabled: true, cron: '0 8 * * *' });
  const startedAt = Date.now();
  const savedLog = { index: 1, name: '等待', ok: true, message: '已开始' };
  const savedRuns = [
    { id: 'running', status: 'running', trigger: 'cron', logs: [savedLog] },
    { id: 'queued', status: 'queued', trigger: 'manual', logs: [] },
    { id: 'finished', status: 'success', trigger: 'manual', logs: [] },
    { id: 'timeout', status: 'failed', timedOut: true, trigger: 'manual', logs: [] },
  ].map((run) => ({ flowId: flow.id, startedAt, ...run }));
  fs.writeFileSync(before.runsFile, JSON.stringify(savedRuns));

  const { app, store, scheduler, runner } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const history = await app.inject({ method: 'GET', url: `/api/runs?flowId=${flow.id}`, headers });
  assert.equal(history.statusCode, 200, history.body);
  const runs = history.json();
  assert.deepEqual(runs.map((run) => run.id), ['running', 'queued', 'finished', 'timeout']);
  for (const [index, run] of runs.slice(0, 2).entries()) {
    assert.equal(run.status, 'failed');
    assert.equal(run.interrupted, true);
    assert.match(run.finalMessage, /服务重启.*运行中断/);
    assert.equal(run.logs.at(-1).ok, false);
    assert.equal(run.logs.at(-1).index, index === 0 ? 2 : 1);
  }
  assert.deepEqual(runs[0].logs[0], savedLog);
  assert.deepEqual(runs.slice(2), savedRuns.slice(2));
  assert.equal(runner.isBusy(flow.id), false);
  assert.equal(store.getFlowRaw(flow.id).enabled, true);
  assert.equal(store.getFlowRaw(flow.id).pausedAt, flow.pausedAt);
  assert.equal(store.listNotifications().total, 0);

  const flows = (await app.inject({ method: 'GET', url: '/api/flows', headers })).json();
  assert.equal(flows.find((item) => item.id === flow.id).lastRun.interrupted, true);
  const logs = (await app.inject({ method: 'GET', url: `/api/flows/${flow.id}/logs`, headers })).json();
  assert.equal(logs.entries.find((entry) => entry.runId === 'queued').interrupted, true);
  assert.equal(logs.runs.find((run) => run.id === 'timeout').timedOut, true);
  const cancel = await app.inject({ method: 'POST', url: '/api/runs/running/cancel', headers, payload: {} });
  assert.equal(cancel.statusCode, 409);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.runsFile, 'utf8')), runs);
  const reopened = new Store(dir);
  assert.deepEqual(reopened.listRuns(flow.id), runs);
  assert.deepEqual(reopened.listRuns(flow.id, 2), runs.slice(0, 2));
  assert.deepEqual(reopened.listRuns(undefined, 1), runs.slice(0, 1));
  assert.deepEqual(reopened.listRuns(flow.id, 0), []);
  assert.deepEqual(reopened.listRuns('other'), []);
});

test('cancel rejects unknown and cross-scope runs', async (t) => {
  const dir = directory(t);
  const { app, store, scheduler } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const flow = store.createFlow({ name: 'scoped', nodes: [], edges: [] });
  const otherFlow = store.createFlow({ name: 'other', nodes: [], edges: [] });
  store.addRun({ id: 'live-run', flowId: flow.id, flowName: flow.name, status: 'running', startedAt: Date.now(), logs: [], attempts: [] });
  const keyRes = await app.inject({
    method: 'POST', url: '/api/system/apikeys', headers,
    payload: { name: 'other', scopes: ['read', 'run'], flowIds: [otherFlow.id] },
  });
  assert.equal(keyRes.statusCode, 200, keyRes.body);
  const keyHeaders = { 'x-api-key': keyRes.json().apiKey };

  const missing = await app.inject({ method: 'POST', url: '/api/runs/nope/cancel', headers, payload: {} });
  assert.equal(missing.statusCode, 404);

  const scoped = await app.inject({ method: 'POST', url: '/api/runs/live-run/cancel', headers: keyHeaders, payload: {} });
  assert.equal(scoped.statusCode, 403, scoped.body);
});
