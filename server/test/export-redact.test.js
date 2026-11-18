import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildServer } from '../src/api.js';
import { maskSecrets } from '../src/secret.js';

process.env.ADMIN_PASSWORD = 'test1234';

test('模板/任务导出：节点内联凭据、URL、body 与通知密钥全部脱敏', () => {
  const flow = {
    name: 'inline-secrets',
    vars: { cookie: 'VAR_COOKIE_SECRET_123456' },
    nodes: [
      {
        id: 'n1', type: 'http', name: '请求', config: {
          url: 'https://alice:PROXY_PASSWORD_SECRET@example.com/a?token=URL_TOKEN_SECRET_123456',
          headers: [
            { name: 'cookie', value: 'INLINE_COOKIE_SECRET_123456' },
            { name: 'authorization', value: 'Bearer INLINE_BEARER_SECRET_123456' },
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
    'TG_CHAT_SECRET_123456', 'CHANNEL_TOKEN_SECRET_123456',
  ]) {
    assert.ok(!text.includes(secret), `导出不应包含 ${secret}`);
  }
  const masked = maskSecrets(flow);
  assert.equal(masked.nodes[0].config.headers[0].value, '***');
  assert.equal(masked.nodes[0].config.headers[1].value, '***');
  assert.equal(masked.nodes[1].config.tgToken, '***');
  assert.equal(masked.nodes[1].config.tgChat, '***');
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
    logs: [{
      stepId: 'n', index: 1, name: '请求', type: 'http', ok: false,
      message: 'cookie=BACKUP_COOKIE_SECRET_123456',
      detail: {
        url: 'https://example.com/a?token=BACKUP_URL_SECRET_123456',
        headers: { cookie: 'BACKUP_INLINE_COOKIE_123456' },
        response: { headers: { 'set-cookie': 'sid=BACKUP_RESPONSE_SECRET_123456' } },
      },
    }],
  });

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
  const backup = await app.inject({ url: '/api/system/backup', headers: { cookie: login.headers['set-cookie'].split(';')[0] } });
  assert.equal(backup.statusCode, 200);
  const body = backup.json();
  const text = JSON.stringify(body);
  for (const secret of [
    'BACKUP_COOKIE_SECRET_123456', 'BACKUP_URL_SECRET_123456', 'BACKUP_INLINE_COOKIE_123456',
    'BACKUP_RESPONSE_SECRET_123456',
  ]) {
    assert.ok(!text.includes(secret), `默认备份不应包含 ${secret}`);
  }
  assert.equal(body.runs[0].logs[0].detail, undefined);
  assert.equal(body.masked, true);
});
