import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.ADMIN_PASSWORD = 'AuditPass123!';

import { buildServer } from '../src/api.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { renderTemplate } from '../src/render.js';
import { ipAllowed, isTrustedProxyPeer, normalizeIp } from '../src/iprange.js';
import { totpAt, verifyTotpStep } from '../src/totp.js';
import { applyAutoPause } from '../src/auto-pause.js';
import { parseCurl } from '../src/curl-import.js';
import { validateFlow } from '../src/model.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cq-audit-'));
}

test('Engine: 拒绝非 http(s) 协议，保留 body 空白，foreach 内部失败向上传递', async () => {
  let receivedBody = null;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/echo') {
        receivedBody = raw;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(500);
      res.end('boom');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const blocked = await new Engine({
      name: 'proto',
      nodes: [{ id: 'n0', type: 'http', config: { method: 'GET', url: 'file:///etc/passwd' } }],
      edges: [],
    }).run();
    assert.equal(blocked.ok, false);
    assert.match(blocked.finalMessage, /协议/);

    const preserved = await new Engine({
      name: 'body-preserve',
      nodes: [{ id: 'n0', type: 'http', config: { method: 'POST', url: `http://127.0.0.1:${port}/echo`, body: '  line1\n  ' } }],
      edges: [],
    }).run();
    assert.equal(preserved.ok, true);
    assert.equal(receivedBody, '  line1\n  ');

    const fe = await new Engine({
      name: 'foreach-fail',
      vars: { list: ['a'] },
      nodes: [
        { id: 'f', type: 'foreach', name: 'loop', config: { source: 'vars.list', itemVar: 'it' } },
        { id: 'h', type: 'http', name: 'fail-inner', config: { method: 'GET', url: `http://127.0.0.1:${port}/err`, asserts: [{ expr: 'last.status', expect: 200 }] } },
      ],
      edges: [{ id: 'e1', source: 'f', sourceHandle: 'each', target: 'h' }],
    }).run();
    assert.equal(fe.ok, false);
    assert.match(fe.finalMessage, /第 1 轮失败/);
  } finally {
    srv.close();
  }
});

test('renderTemplate / curl-import / validateFlow: 原型防护与结构校验', () => {
  assert.equal(renderTemplate('{{constructor.name}}', { a: 1 }), '');
  assert.equal(renderTemplate('{{__proto__.polluted}}', { a: 1 }), '');
  const curl = parseCurl('curl -4 https://example.com/a');
  assert.equal(curl.url, 'https://example.com/a');
  assert.throws(() => parseCurl('curl file:///etc/passwd'), /http/);
  const badType = validateFlow({ name: 'x', nodes: [{ id: 'n0', type: 'bogus', config: {} }], edges: [] });
  assert.ok(badType.some((e) => /类型不支持/.test(e)));
  const badHandle = validateFlow({
    name: 'x',
    nodes: [{ id: 'n0', type: 'log', config: {} }, { id: 'n1', type: 'log', config: {} }],
    edges: [{ id: 'e0', source: 'n0', sourceHandle: 'bogus', target: 'n1' }],
  });
  assert.ok(badHandle.some((e) => /无效出口/.test(e)));
});

test('iprange: 十六进制 v4-mapped IPv6 与可信反代边界', () => {
  assert.equal(normalizeIp('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(ipAllowed('::ffff:c0a8:105', ['192.168.1.0/24']), true);
  assert.equal(isTrustedProxyPeer('127.0.0.1'), true);
  assert.equal(isTrustedProxyPeer('172.18.0.5'), true);
  assert.equal(isTrustedProxyPeer('192.168.1.50'), false);
});

test('totp: verifyTotpStep 阻止同窗口重复登录', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const step = Math.floor(Date.now() / 1000 / 30);
  const code = totpAt(secret, step);
  const first = verifyTotpStep(secret, code, 1, null);
  assert.equal(first, step);
  const replay = verifyTotpStep(secret, code, 1, first);
  assert.equal(replay, null);
});

test('Store: 密文损坏中止启动且支持 batch 批量写入', () => {
  const dir = tmpDir();
  const s1 = new Store(dir);
  s1.batch(() => {
    s1.createFlow({ name: 'b1', vars: { cookie: 'secret-value-12345' }, nodes: [], edges: [] });
    s1.createFlow({ name: 'b2', nodes: [], edges: [] });
  });
  assert.equal(s1.flows.length, 2);

  const flowsPath = path.join(dir, 'flows.json');
  const raw = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  raw[0].vars.cookie = raw[0].vars.cookie.slice(0, -4) + 'XXXX';
  fs.writeFileSync(flowsPath, JSON.stringify(raw));
  assert.throws(() => new Store(dir), /无法解密/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auto-pause: credential / risk-control 失败跳过恢复探测', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const f = store.createFlow({
    name: 'cred-fail',
    cron: '0 8 * * *',
    enabled: true,
    recovery: { enabled: true, intervalMinutes: 30, maxAttempts: 3 },
    nodes: [],
    edges: [],
  });
  const ok = applyAutoPause({ store, scheduler: { rebuild() {} }, flowId: f.id, reason: '登录态失效', skipRecovery: true });
  assert.equal(ok, true);
  const raw = store.getFlowRaw(f.id);
  assert.equal(raw.enabled, false);
  assert.equal(raw.recovery.nextProbeAt, null);
  assert.equal(raw.recovery.exhausted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Agent API & MCP HTTP (/api/mcp): vars 合并、validate、wait:false 与作用域隔离', async () => {
  const dir = tmpDir();
  const { app, scheduler } = buildServer({ dataDir: dir, port: 0 });
  await app.ready();
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'AuditPass123!' } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'].split(';')[0];
    const H = { cookie, 'content-type': 'application/json' };

    const created = await app.inject({
      method: 'POST', url: '/api/flows', headers: H,
      payload: {
        name: 'cred-flow',
        vars: { cookie: 'TOP-SECRET-COOKIE', keep: 'yes' },
        nodes: [{ id: 'n0', type: 'http', config: { method: 'GET', url: 'https://example.com', allowedOrigin: 'https://example.com' } }],
        edges: [],
      },
    });
    assert.equal(created.statusCode, 200);
    const fid = created.json().id;

    const writeKey = (await app.inject({ method: 'POST', url: '/api/system/apikeys', headers: H, payload: { name: 'w', scopes: ['read', 'write'] } })).json().apiKey;
    const readKey = (await app.inject({ method: 'POST', url: '/api/system/apikeys', headers: H, payload: { name: 'r', scopes: ['read'] } })).json().apiKey;
    const runKey = (await app.inject({ method: 'POST', url: '/api/system/apikeys', headers: H, payload: { name: 'x', scopes: ['read', 'run'] } })).json().apiKey;

    // PATCH /api/flows/:id/vars works with write key without secrets scope and echoes no secrets
    const patched = await app.inject({
      method: 'PATCH', url: `/api/flows/${fid}/vars`,
      headers: { 'x-api-key': writeKey, 'content-type': 'application/json' },
      payload: { vars: { cookie: 'UPDATED-COOKIE', removeMe: null } },
    });
    assert.equal(patched.statusCode, 200);
    assert.ok(!patched.body.includes('UPDATED-COOKIE'));

    // read key cannot patch vars
    const denied = await app.inject({
      method: 'PATCH', url: `/api/flows/${fid}/vars`,
      headers: { 'x-api-key': readKey, 'content-type': 'application/json' },
      payload: { vars: { keep: 'no' } },
    });
    assert.equal(denied.statusCode, 403);

    // POST /api/flows/validate
    const valBad = await app.inject({
      method: 'POST', url: '/api/flows/validate',
      headers: { 'x-api-key': readKey, 'content-type': 'application/json' },
      payload: { name: 'bad', nodes: [{ id: 'a', type: 'nope', config: {} }], edges: [] },
    });
    assert.equal(valBad.statusCode, 200);
    assert.equal(valBad.json().ok, false);

    // POST /api/flows/:id/run { wait: false } returns 202
    const logFlow = await app.inject({
      method: 'POST', url: '/api/flows', headers: H,
      payload: { name: 'async-log', nodes: [{ id: 'n0', type: 'log', config: { text: 'ok' } }], edges: [] },
    });
    const asyncRun = await app.inject({
      method: 'POST', url: `/api/flows/${logFlow.json().id}/run`,
      headers: { 'x-api-key': runKey, 'content-type': 'application/json' },
      payload: { wait: false },
    });
    assert.equal(asyncRun.statusCode, 202);
    assert.equal(asyncRun.json().status, 'queued');

    // POST /api/mcp
    const init = await app.inject({
      method: 'POST', url: '/api/mcp',
      headers: { 'x-api-key': readKey, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    assert.equal(init.statusCode, 200);
    assert.equal(init.json().result.serverInfo.name, 'checkq-mcp');

    const list = await app.inject({
      method: 'POST', url: '/api/mcp',
      headers: { 'x-api-key': readKey, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    assert.equal(list.json().result.tools.length, 22);

    const mcpDenied = await app.inject({
      method: 'POST', url: '/api/mcp',
      headers: { 'x-api-key': readKey, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flow_update_vars', arguments: { id: fid, vars: { keep: 'hack' } } } },
    });
    assert.equal(mcpDenied.json().result.isError, true);

    const mcpVars = await app.inject({
      method: 'POST', url: '/api/mcp',
      headers: { 'x-api-key': writeKey, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'flow_update_vars', arguments: { id: fid, vars: { cookie: 'MCP-COOKIE' } } } },
    });
    assert.equal(mcpVars.json().result.isError, undefined);
  } finally {
    scheduler.stop();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
