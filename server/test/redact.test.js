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

test('响应日志先遮蔽凭据再截断，断言仍读取完整原文', async (t) => {
  const reflected = 'private-inline-fixture';
  const returned = 'private-response-fixture';
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/reflect' ? { value: req.headers['x-api-key'] } : { password: returned }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  for (const [route, limit] of [['/reflect', 14], ['/field', 17]]) {
    const streamed = [];
    const result = await new Engine({
      log: { record: 'all', debug: true, resBodyLimit: limit },
      nodes: [{ id: 'request', type: 'http', config: {
        url: `http://127.0.0.1:${server.address().port}${route}`,
        headers: [{ name: 'x-api-key', value: reflected }],
        asserts: [{ from: 'content', res: ['[a-z-]{20,}"'] }],
      } }],
      edges: [],
    }).run({ logSink: (entry) => streamed.push(entry) });
    assert.equal(result.ok, true);
    for (const logs of [result.logs, streamed]) {
      const preview = logs.find((entry) => entry.type === 'http').detail.response.body;
      assert.doesNotMatch(preview, /priv/);
      assert.match(preview, /\*\*\*/);
    }
  }
});

test('变量步骤的日志在截断前遮蔽长凭据', async (t) => {
  const secret = 'long-private-fixture-' + 'x'.repeat(160);
  const server = http.createServer((req, res) => {
    const value = req.headers['x-api-key'];
    res.writeHead(200, { 'content-type': 'application/json', 'x-reflected': value, 'set-cookie': `sid=${value}; Path=/` });
    res.end(JSON.stringify({ value }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const nodes = [
    { id: 'request', type: 'http', config: {
      url: `http://127.0.0.1:${server.address().port}/`, headers: [{ name: 'x-api-key', value: secret }],
    } },
    { id: 'json', type: 'extract', config: { name: 'fromJson', mode: 'json', path: 'value' } },
    { id: 'header', type: 'extract', config: { name: 'fromHeader', mode: 'header', headerName: 'X-Reflected' } },
    { id: 'cookie', type: 'extract', config: { name: 'fromCookie', mode: 'setCookie' } },
    { id: 'regex', type: 'extract', config: { name: 'fromRegex', from: 'last.text', re: '"value":"([^"]+)"' } },
    { id: 'set', type: 'set', config: { name: 'copy', value: '{{fromJson}}' } },
    { id: 'public', type: 'set', config: { name: 'ordinary', value: 'z'.repeat(150) } },
    { id: 'short', type: 'set', config: { name: 'password', value: 'pin42' } },
  ];
  const edges = nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id }));
  const streamed = [];
  const result = await new Engine({ nodes, edges, log: { record: 'all', debug: true } })
    .run({ logSink: (entry) => streamed.push(entry) });
  assert.equal(result.ok, true);
  for (const name of ['fromJson', 'fromHeader', 'fromRegex', 'copy']) assert.equal(result.vars[name], secret);
  assert.equal(result.vars.fromCookie, `sid=${secret}`);
  for (const logs of [result.logs, streamed]) {
    for (const id of ['json', 'header', 'cookie', 'regex', 'set']) {
      const message = logs.find((entry) => entry.stepId === id).message;
      assert.doesNotMatch(message, /long-private-fixture/);
      assert.match(message, /\*\*\*/);
    }
    assert.equal(logs.find((entry) => entry.stepId === 'public').message, `ordinary = ${'z'.repeat(120)}`);
    assert.equal(logs.find((entry) => entry.stepId === 'short').message, 'password = ***');
  }
});

test('上游签发的凭据提取到普通变量后仍会脱敏', async (t) => {
  const issued = 'issued-value-fixture';
  const header = 'response-header-fixture';
  const server = http.createServer((req, res) => {
    const form = req.url === '/form';
    res.writeHead(200, { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-auth-token': header });
    res.end(form ? new URLSearchParams({ refresh_token: issued }).toString() : JSON.stringify({ data: { access_token: issued } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  for (const route of ['/json', '/form']) {
    const streamed = [];
    const extract = route === '/form'
      ? { from: 'last.text', re: 'refresh_token=([^&]+)' }
      : { mode: 'json', path: 'data.access_token' };
    const result = await new Engine({
      log: { record: 'all', debug: true, include: { resBody: false } },
      nodes: [
        { id: 'request', type: 'http', config: { url: `http://127.0.0.1:${server.address().port}${route}` } },
        { id: 'body', type: 'extract', config: { ...extract, name: 'bodyCopy' } },
        { id: 'header', type: 'extract', config: { mode: 'header', headerName: 'X-Auth-Token', name: 'headerCopy' } },
      ],
      edges: [{ source: 'request', target: 'body' }, { source: 'body', target: 'header' }],
    }).run({ logSink: (entry) => streamed.push(entry) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.vars, { bodyCopy: issued, headerCopy: header });
    assert.deepEqual(result.redactedVars, { bodyCopy: '***', headerCopy: '***' });
    const output = JSON.stringify([result.logs, streamed]);
    for (const value of [issued, header]) assert.ok(!output.includes(value));
  }
});

test('引擎运行日志与 SSE 推送都不含请求/响应凭据', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const query = new URL(req.url, 'http://localhost').searchParams.getAll('token');
      const password = req.headers['content-type'] === 'application/x-www-form-urlencoded'
        ? new URLSearchParams(body).get('password') : JSON.parse(body).account.password;
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'sid=RESPONSE_COOKIE_SECRET_123456; Path=/; HttpOnly',
      });
      res.end(JSON.stringify({ ok: true, token: 'RESPONSE_TOKEN_SECRET_123456', reflected: req.headers['x-api-key'],
        echoes: [req.headers.cookie.split('=')[1], req.headers.authorization.split(' ')[1], 'RESPONSE_COOKIE_SECRET_123456', ...query, password],
        publicField: 'ordinary-response-value',
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
        url: `http://127.0.0.1:${server.address().port}/check?token=QUERY_SECRET_VALUE_123456&token=second%2Bquery%2Ffixture`,
        headers: [
          { name: 'cookie', value: 'sid=INLINE_COOKIE_FIXTURE_123456', enabled: true },
          { name: 'authorization', value: 'Bearer INLINE_AUTH_FIXTURE_123456', enabled: true },
          { name: 'x-api-key', value: 'INLINE_KEY_FIXTURE_123456', enabled: true },
        ],
        body: '{"account":{"password":"BODY_SECRET_VALUE_123456"},"name":"ok"}',
      },
    }, { id: 'extract', type: 'extract', config: { mode: 'json', path: 'reflected', name: 'copy' } }],
    edges: [{ source: 'n', target: 'extract', sourceHandle: 'success' }],
  };
  const run = () => new Engine(flow).run({ debug: true, logSink: (entry) => seen.push(entry) });
  const result = await run();
  assert.equal(result.vars.copy, 'INLINE_KEY_FIXTURE_123456', '内部步骤仍能使用原始响应');
  assert.equal(result.redactedVars.copy, '***');
  flow.nodes[0].config.headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
  flow.nodes[0].config.body = 'password=fixture+form%2Bvalue&name=ordinary';
  const formResult = await run();
  assert.equal(formResult.ok, true);
  const all = JSON.stringify([result.logs, formResult.logs, seen, result.redactedVars, result.summary]) + result.finalMessage;
  assert.match(all, /ordinary-response-value/);
  for (const secret of [
    'COOKIE_SECRET_VALUE_123456', 'TOKEN_SECRET_VALUE_123456', 'QUERY_SECRET_VALUE_123456',
    'BODY_SECRET_VALUE_123456', 'RESPONSE_COOKIE_SECRET_123456', 'RESPONSE_TOKEN_SECRET_123456',
    'INLINE_COOKIE_FIXTURE_123456', 'INLINE_AUTH_FIXTURE_123456', 'INLINE_KEY_FIXTURE_123456',
    'second+query/fixture', 'fixture form+value',
  ]) {
    assert.ok(!all.includes(secret), `日志不应包含 ${secret}`);
  }
  assert.ok(seen.length > 0, 'SSE 应收到脱敏后的日志');
});
