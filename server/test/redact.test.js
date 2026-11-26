import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { Engine } from '../src/engine.js';
import { collectSecrets, redactBody, redactLogEntry, redactUrl } from '../src/redact.js';

test('URL 脱敏：userinfo 与敏感 query 不外泄', () => {
  const out = redactUrl('https://alice:super-secret@example.com/check?token=query-secret-value&page=1', ['query-secret-value']);
  assert.ok(!out.includes('alice'));
  assert.ok(!out.includes('super-secret'));
  assert.ok(!out.includes('query-secret-value'));
  assert.ok(out.includes('page=1'));
});

test('body 脱敏：JSON 与表单敏感字段整体打码', () => {
  const json = redactBody('{"username":"u","password":"p@ss-value","nested":{"token":"tok-value"}}', 'application/json');
  const parsed = JSON.parse(json);
  assert.equal(parsed.username, 'u');
  assert.equal(parsed.password, '***');
  assert.equal(parsed.nested.token, '***');

  const form = redactBody('username=u&token=tok-value&next=%2Fhome', 'application/x-www-form-urlencoded');
  assert.ok(!form.includes('tok-value'));
  assert.ok(form.includes('username=u'));
  assert.ok(form.includes('next=%2Fhome'));
});

test('日志条目脱敏覆盖请求头、响应 Set-Cookie 与动态提取值', () => {
  const secrets = collectSecrets({ cookie: 'COOKIE_SECRET_VALUE_123456', token: 'TOKEN_SECRET_VALUE_123456' });
  const entry = redactLogEntry({
    message: 'cookie = COOKIE_SECRET_VALUE_123456',
    detail: {
      url: 'https://example.com/a?token=TOKEN_SECRET_VALUE_123456',
      headers: [
        { name: 'cookie', value: 'COOKIE_SECRET_VALUE_123456' },
        { name: 'authorization', value: 'Bearer TOKEN_SECRET_VALUE_123456' },
      ],
      body: '{"password":"BODY_SECRET_VALUE_123456"}',
      response: {
        headers: { 'set-cookie': 'sid=RESPONSE_COOKIE_123456', 'content-type': 'application/json' },
        setCookie: ['sid=RESPONSE_COOKIE_123456; Path=/'],
        body: '{"token":"RESPONSE_TOKEN_123456"}',
      },
    },
  }, secrets);
  const text = JSON.stringify(entry);
  assert.ok(!text.includes('COOKIE_SECRET_VALUE_123456'));
  assert.ok(!text.includes('TOKEN_SECRET_VALUE_123456'));
  assert.ok(!text.includes('BODY_SECRET_VALUE_123456'));
  assert.ok(!text.includes('RESPONSE_COOKIE_123456'));
  assert.ok(!text.includes('RESPONSE_TOKEN_123456'));
  assert.ok(text.includes('***'));
});

test('引擎运行日志与 SSE 推送都不含请求/响应凭据', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    void req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'sid=RESPONSE_COOKIE_SECRET_123456; Path=/; HttpOnly',
      });
      res.end(JSON.stringify({ ok: true, token: 'RESPONSE_TOKEN_SECRET_123456', reflected: req.headers['x-api-key'],
        echoes: [req.headers.cookie.split('=')[1], req.headers.authorization.split(' ')[1], 'RESPONSE_COOKIE_SECRET_123456'],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const flow = {
    name: 'redact-test',
    vars: {
      cookie: 'COOKIE_SECRET_VALUE_123456',
      apiToken: 'TOKEN_SECRET_VALUE_123456',
    },
    log: { record: 'all', debug: true },
    nodes: [{
      id: 'n', type: 'http', name: '请求', config: {
        method: 'POST',
        url: `http://127.0.0.1:${server.address().port}/check?token=QUERY_SECRET_VALUE_123456`,
        headers: [
          { name: 'cookie', value: 'sid=INLINE_COOKIE_FIXTURE_123456', enabled: true },
          { name: 'authorization', value: 'Bearer INLINE_AUTH_FIXTURE_123456', enabled: true },
          { name: 'x-api-key', value: 'INLINE_KEY_FIXTURE_123456', enabled: true },
        ],
        body: '{"password":"BODY_SECRET_VALUE_123456","name":"ok"}',
      },
    }, { id: 'extract', type: 'extract', config: { mode: 'json', path: 'reflected', name: 'copy' } }],
    edges: [{ source: 'n', target: 'extract', sourceHandle: 'success' }],
  };
  const result = await new Engine(flow).run({
    debug: true,
    logSink: (entry) => seen.push(entry),
  });
  assert.equal(result.vars.copy, 'INLINE_KEY_FIXTURE_123456', '内部步骤仍能使用原始响应');
  assert.equal(result.redactedVars.copy, '***');
  const all = JSON.stringify([result.logs, seen, result.redactedVars, result.summary]) + result.finalMessage;
  for (const secret of [
    'COOKIE_SECRET_VALUE_123456', 'TOKEN_SECRET_VALUE_123456', 'QUERY_SECRET_VALUE_123456',
    'BODY_SECRET_VALUE_123456', 'RESPONSE_COOKIE_SECRET_123456', 'RESPONSE_TOKEN_SECRET_123456',
    'INLINE_COOKIE_FIXTURE_123456', 'INLINE_AUTH_FIXTURE_123456', 'INLINE_KEY_FIXTURE_123456',
  ]) {
    assert.ok(!all.includes(secret), `日志不应包含 ${secret}`);
  }
  assert.ok(seen.length > 0, 'SSE 应收到脱敏后的日志');
});
