import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { buildServer } from '../src/api.js';
import { maskSecrets } from '../src/secret.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';

process.env.ADMIN_PASSWORD = 'test1234';

test('模板/任务导出：节点内联凭据、URL、body 与通知密钥全部脱敏', () => {
  const flow = {
    name: 'inline-secrets',
    vars: { cookie: 'VAR_COOKIE_SECRET_123456', copy: 'INLINE_CSRF_FIXTURE_123456' },
    note: '请求使用 INLINE_BODY_SECRET_123456',
    nodes: [
      {
        id: 'n1', type: 'http', name: '请求', config: {
          url: 'https://alice:PROXY_PASSWORD_SECRET@example.com/a?token=URL_TOKEN_SECRET_123456',
          headers: [
            { name: 'cookie', value: 'INLINE_COOKIE_SECRET_123456' },
            { name: 'authorization', value: 'Bearer INLINE_BEARER_SECRET_123456' },
            { name: 'X-CSRF-Token', value: 'INLINE_CSRF_FIXTURE_123456' },
            { name: 'X-Copy', value: 'INLINE_BODY_SECRET_123456' },
            { name: 'X-Auth-Token', value: '{{runtimeCredential}}' },
            { name: 'X-Template-Reference', value: '{{runtimeCredential}}' },
          ],
          body: '{"password":"INLINE_BODY_SECRET_123456","name":"ok"}',
          proxy: { url: 'http://user:PROXY_CREDENTIAL_SECRET_123456@127.0.0.1:8080' },
        },
      },
      {
        id: 'n2', type: 'notify', name: '通知', config: {
          webhookUrl: 'https://hooks.example.com/a?token=WEBHOOK_SECRET_123456',
          tgToken: 'TG_TOKEN_SECRET_123456', tgChat: 'TG_CHAT_SECRET_123456',
        },
      },
    ],
    notify: { channels: [{ type: 'telegram', token: 'CHANNEL_TOKEN_SECRET_123456' }] },
  };
  const text = JSON.stringify(maskSecrets(flow));
  for (const secret of [
    'VAR_COOKIE_SECRET_123456', 'PROXY_PASSWORD_SECRET', 'URL_TOKEN_SECRET_123456',
    'INLINE_COOKIE_SECRET_123456', 'INLINE_BEARER_SECRET_123456', 'INLINE_BODY_SECRET_123456',
    'PROXY_CREDENTIAL_SECRET_123456', 'WEBHOOK_SECRET_123456', 'TG_TOKEN_SECRET_123456',
    'TG_CHAT_SECRET_123456', 'CHANNEL_TOKEN_SECRET_123456', 'INLINE_CSRF_FIXTURE_123456',
  ]) {
    assert.ok(!text.includes(secret), `导出不应包含 ${secret}`);
  }
  const masked = maskSecrets(flow);
  assert.equal(masked.nodes[0].config.headers[0].value, '***');
  assert.equal(masked.nodes[0].config.headers[1].value, '***');
  assert.equal(masked.nodes[0].config.headers[2].value, '***');
  assert.equal(masked.nodes[0].config.headers[3].value, '***');
  assert.equal(masked.nodes[0].config.headers[4].value, '***');
  assert.equal(masked.nodes[0].config.headers[5].value, '{{runtimeCredential}}');
  assert.equal(masked.vars.copy, '***');
  assert.equal(masked.note, '请求使用 ***');
  assert.equal(masked.nodes[1].config.tgToken, '***');
  assert.equal(masked.nodes[1].config.tgChat, '***');
});

test('旧任务与模板的内联配置重写后加密，重启仍能发出同样的请求', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-inline-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    seen.push({ header: req.headers['x-csrf-token'], body: JSON.parse(text) });
    res.end('ok');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const username = 'inline-login-fixture';
  const value = 'inline-header-fixture';
  const url = `http://127.0.0.1:${upstream.address().port}/`;
  const config = { url, method: 'POST', headers: [{ name: 'X-CSRF-Token', value }], body: JSON.stringify({ username }) };
  const clean = { url, method: 'GET', headers: [{ name: 'X-Mode', value: 'plain' }] };
  const nodes = [{ id: 'protected', type: 'http', config }, { id: 'public', type: 'http', config: clean }];
  const flowsFile = path.join(dir, 'flows.json');
  const templatesFile = path.join(dir, 'templates.json');
  fs.writeFileSync(flowsFile, JSON.stringify([{ id: 'legacy-flow', name: '旧任务', nodes, edges: [] }]));
  fs.writeFileSync(templatesFile, JSON.stringify([{ id: 'legacy-template', name: '旧模板', nodes, edges: [] }]));
  const store = new Store(dir);
  assert.deepEqual(store.getFlow('legacy-flow').nodes[0].config, config);
  store.flush();
  for (const file of [flowsFile, templatesFile]) {
    const disk = fs.readFileSync(file, 'utf8');
    assert.ok(!disk.includes(value) && !disk.includes(username));
    const [protectedNode, publicNode] = JSON.parse(disk)[0].nodes;
    assert.match(protectedNode.config, /^enc:v1:/);
    assert.deepEqual(publicNode.config, clean);
  }
  const reopened = new Store(dir);
  const flow = reopened.getFlow('legacy-flow');
  assert.deepEqual(flow.nodes[0].config, config);
  assert.deepEqual(reopened.getTemplate('legacy-template').nodes[0].config, config);
  const result = await new Engine(flow).run();
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ header: value, body: { username } }]);
});

test('默认备份：历史运行日志只留审计摘要，不带原始 detail', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { app, store, scheduler } = buildServer({ dataDir: dir, port: 0 });
  t.after(async () => { scheduler.stop(); await app.close(); });

  const flow = store.createFlow({
    name: 'backup-redact',
    vars: { cookie: 'BACKUP_COOKIE_SECRET_123456' },
    nodes: [{
      id: 'n', type: 'http', config: {
        url: 'https://example.com/a?token=BACKUP_URL_SECRET_123456',
        headers: [{ name: 'cookie', value: 'BACKUP_INLINE_COOKIE_123456' }],
      },
    }],
  });
  store.addRun({
    id: 'run-legacy', flowId: flow.id, flowName: flow.name, trigger: 'manual',
    startedAt: Date.now(), status: 'failed', finalMessage: 'cookie=BACKUP_COOKIE_SECRET_123456',
    summary: '服务返回 BACKUP_RESPONSE_SECRET_123456',
    logs: [{
      stepId: 'n', index: 1, name: '请求', type: 'http', ok: false,
      message: '站点回显 BACKUP_INLINE_COOKIE_123456',
      detail: {
        url: 'https://example.com/a?token=BACKUP_URL_SECRET_123456',
        headers: { cookie: 'BACKUP_INLINE_COOKIE_123456' },
        response: { headers: { 'set-cookie': 'sid=BACKUP_RESPONSE_SECRET_123456' } },
      },
    }],
  });

  store.addRun({
    id: 'run-without-flow', flowId: 'deleted-flow', startedAt: Date.now(), status: 'success',
    finalMessage: '旧令牌 BACKUP_ORPHAN_FIXTURE_123456',
    logs: [{ type: 'http', detail: { headers: [{ name: 'X-Auth-Token', value: 'BACKUP_ORPHAN_FIXTURE_123456' }] } }],
  });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const headers = { cookie: login.headers['set-cookie'].split(';')[0] };
  const template = store.createTemplate({ name: 'shareable', desc: '业务说明 BACKUP_INLINE_COOKIE_123456', vars: { alias: 'BACKUP_INLINE_COOKIE_123456' }, nodes: flow.nodes });
  const shared = await app.inject({ url: `/api/templates/${template.id}/export`, headers });
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.json().desc, '业务说明 ***');
  assert.equal(shared.json().vars.alias, '***');
  assert.ok(!shared.body.includes('BACKUP_INLINE_COOKIE_123456'));
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const backup = await fetch(`${base}/api/system/backup`, { headers });
  assert.equal(backup.status, 200);
  const body = await backup.json();
  const text = JSON.stringify(body);
  for (const secret of [
    'BACKUP_COOKIE_SECRET_123456', 'BACKUP_URL_SECRET_123456', 'BACKUP_INLINE_COOKIE_123456',
    'BACKUP_RESPONSE_SECRET_123456', 'BACKUP_ORPHAN_FIXTURE_123456',
  ]) {
    assert.ok(!text.includes(secret), `默认备份不应包含 ${secret}`);
  }
  assert.ok(body.runs.every((run) => run.logs.every((entry) => entry.detail === undefined)));
  assert.equal(body.runs.find((run) => run.id === 'run-legacy').summary, '服务返回 ***');
  assert.equal(body.runs.find((run) => run.id === 'run-without-flow').finalMessage, '旧令牌 ***');
  assert.equal(body.masked, true);

  const full = await app.inject({ method: 'POST', url: '/api/system/backup', headers, payload: { password: 'test1234' } });
  assert.equal(full.statusCode, 200);
  assert.equal(full.json().masked, false);
  assert.equal(full.json().runs.find((run) => run.id === 'run-without-flow').finalMessage, '旧令牌 BACKUP_ORPHAN_FIXTURE_123456');
});
