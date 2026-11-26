/**
 * AI 助手接口回归测试
 *  - 权限：PUT /api/system/ai 与 POST /api/ai/test 仅 admin；generate 登录即可（API Key 需 write）
 *  - 配置：baseUrl 归一化（/v1、/v1/chat/completions、去尾 /）、http(s) 校验、model 必填、timeoutSec/maxTokens 范围
 *  - 读取：API Key 永远只回显前缀（打码），错误信息/审计/落盘都不出现明文 Key
 *  - 测试连接：成功 / 401 / 404 / 非 JSON / 超时（中文文案）
 *  - 生成加固：非法 JSON、edges 引用不存在/重复/自环、cron 非 5 段、≤6 节点、危险键过滤、enabled:false + vars:{}
 * 运行：node --test server/test/ai.test.js
 */
process.env.ADMIN_PASSWORD = 'test1234';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const dir = fs.mkdtempSync(os.tmpdir() + '/cq-ai-');
const FAKE_KEY = 'sk-test-SECRET-1234567890';
const MASKED_KEY = FAKE_KEY.slice(0, 4) + '…';

// ---- 本地 mock OpenAI 兼容端点（临时端口）----
let lastRequest = null;
let redirectHits = 0;
const sockets = new Set();
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    lastRequest = { url: req.url, headers: req.headers, body };
    const send = (status, payload, contentType = 'application/json') => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (req.url === '/redirect-target') {
      redirectHits++;
      return send(200, { choices: [{ message: { content: 'ok' } }] });
    }
    if (req.url !== '/v1/chat/completions') return send(404, { error: { message: 'not found' } });
    const model = String(body.model || '');
    if (model === 'hang') return; // 故意不响应：测试超时（客户端 AbortSignal 中断）
    if (model === 'err-401') return send(401, { error: { message: `invalid key ${FAKE_KEY}` } });
    if (model === 'redirect') {
      res.writeHead(307, { location: '/redirect-target' });
      return res.end();
    }
    if (model === 'err-echo') return send(400, { error: { message: `upstream-private-marker ${raw}` } });
    if (model === 'bad-json') return send(200, 'this is not json', 'text/plain');
    if (model === 'gen-ok') {
      // 恶意 config：__proto__ / constructor 键必须被服务端过滤
      const dirtyConfig = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"text":"完成：{{last.status}}"}');
      return send(200, {
        choices: [{ message: { content: JSON.stringify({
          name: 'Example 签到',
          cron: '0 8 * * *',
          nodes: [
            { id: 'n0', type: 'http', name: '签到', x: 80, y: 60, config: { method: 'GET', url: 'https://example.com/checkin', headers: [{ name: 'user-agent', value: 'Mozilla/5.0', enabled: true }], body: '', asserts: [] } },
            { id: 'n1', type: 'log', name: '记录', x: 360, y: 60, config: dirtyConfig },
          ],
          // 第 2 条重复、第 3 条引用不存在的 n9 → 只应保留第 1 条
          edges: [
            { id: 'e0', source: 'n0', sourceHandle: 'success', target: 'n1' },
            { id: 'e1', source: 'n0', sourceHandle: 'success', target: 'n1' },
            { id: 'e2', source: 'n0', sourceHandle: 'success', target: 'n9' },
          ],
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    }
    if (model === 'gen-bad') {
      return send(200, { choices: [{ message: { content: '这不是 JSON，也没有花括号' } }] });
    }
    if (model === 'gen-edges') {
      return send(200, {
        choices: [{ message: { content: JSON.stringify({
          name: '边校验',
          cron: '0 8 * * * *', // 6 段 → 应被清空
          nodes: [
            { id: 'n0', type: 'http', name: '请求', x: 0, y: 0, config: { method: 'GET', url: 'https://example.com/' } },
            { id: 'n1', type: 'log', name: '记录', x: 200, y: 0, config: { text: 'ok' } },
          ],
          edges: [
            { id: 'e0', source: 'n0', sourceHandle: 'success', target: 'n1' },
            { id: 'e1', source: 'n1', sourceHandle: 'next', target: 'nX' },
            { id: 'e2', source: 'n0', sourceHandle: 'success', target: 'n1' },
          ],
        }) } }],
      });
    }
    if (model === 'gen-many') {
      const nodes = [];
      for (let i = 0; i < 8; i++) {
        nodes.push({ id: i === 0 ? 'n0' : `n${i}`, type: i === 0 ? 'http' : 'log', name: `n${i}`, x: i * 10, y: 0, config: i === 0 ? { url: 'https://example.com/' } : { text: 'ok' } });
      }
      return send(200, { choices: [{ message: { content: JSON.stringify({ name: '多节点', cron: '', nodes, edges: [] }) } }] });
    }
    return send(200, {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });
});
mock.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const MOCK = `http://127.0.0.1:${mock.address().port}/v1`;

const { buildServer } = await import('../src/api.js');
const server = buildServer({ dataDir: dir, port: 0 });
const { app, scheduler } = server;
await app.ready();

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  PASS', name);
  } catch (e) {
    failed++;
    console.log('  FAIL', name, '→', e.message);
  }
};
const status = (r, code, label) => {
  assert.strictEqual(r.statusCode, code, `${label}：期望 ${code}，实际 ${r.statusCode} ${r.body}`);
  return r;
};
const noKey = (body, label) => {
  assert.ok(!String(body).includes(FAKE_KEY), `${label}：响应/审计中不应出现明文 Key`);
};

const adminLogin = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'test1234' } });
assert.strictEqual(adminLogin.statusCode, 200, adminLogin.body);
const A = { cookie: adminLogin.headers['set-cookie'].split(';')[0] };
const O = {};

await check('准备非 admin 账号（operator）', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/system/users', headers: A, payload: { username: 'qaops', password: 'OpTest12345', role: 'operator' } });
  status(r, 200, '创建 operator');
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'qaops', password: 'OpTest12345' } });
  status(login, 200, 'operator 登录');
  O.cookie = login.headers['set-cookie'].split(';')[0];
});

await check('非 admin：PUT AI 配置 403', async () => {
  const r = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: O, payload: { baseUrl: MOCK, apiKey: FAKE_KEY, model: 'test-ok' } });
  status(r, 403, 'operator PUT');
});

await check('非 admin：POST /api/ai/test 403', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: O, payload: {} });
  status(r, 403, 'operator test');
});

await check('非 admin：GET AI 配置允许且打码', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/system/ai', headers: O });
  status(r, 200, 'operator GET');
  noKey(r.body, 'operator GET');
});

await check('OpenAPI 声明 AI 端点、权限与 schema', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  status(r, 200, 'OpenAPI');
  const doc = r.json();
  const paths = doc.paths;
  assert.ok(paths['/api/system/ai']?.get, '缺少 GET /api/system/ai');
  assert.ok(paths['/api/system/ai']?.put, '缺少 PUT /api/system/ai');
  assert.strictEqual(paths['/api/system/ai'].put['x-required-role'], 'admin');
  assert.strictEqual(paths['/api/system/ai'].put['x-required-scope'], 'write');
  assert.ok(paths['/api/ai/test']?.post, '缺少 POST /api/ai/test');
  assert.strictEqual(paths['/api/ai/test'].post['x-required-role'], 'admin');
  assert.ok(paths['/api/ai/generate']?.post, '缺少 POST /api/ai/generate');
  assert.strictEqual(paths['/api/ai/generate'].post['x-required-scope'], 'write');
  assert.ok(doc.components.schemas.AiConfig, '缺少 AiConfig schema');
  assert.ok(doc.components.schemas.AiConfigInput, '缺少 AiConfigInput schema');
  assert.ok(doc.components.schemas.AiDraft, '缺少 AiDraft schema');
});

await check('保存校验：baseUrl 仅 http(s)', async () => {
  const r = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: 'ftp://example.com/v1', apiKey: FAKE_KEY, model: 'm' } });
  status(r, 400, 'ftp baseUrl');
  assert.match(r.json().error, /http/i);
});

await check('保存校验：model 必填', async () => {
  const r = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: FAKE_KEY, model: '' } });
  status(r, 400, 'empty model');
  assert.match(r.json().error, /模型/);
});

await check('保存校验：timeoutSec / maxTokens 范围', async () => {
  let r = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: FAKE_KEY, model: 'm', timeoutSec: 300 } });
  status(r, 400, 'timeout 300');
  r = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: FAKE_KEY, model: 'm', maxTokens: 0 } });
  status(r, 400, 'maxTokens 0');
});

await check('保存：baseUrl 归一化（去尾 / 与 /chat/completions）+ GET 打码', async () => {
  const r = await app.inject({
    method: 'PUT', url: '/api/system/ai', headers: A,
    payload: { baseUrl: `${MOCK}/chat/completions/`, apiKey: FAKE_KEY, model: 'test-ok', timeoutSec: 15, maxTokens: 512 },
  });
  status(r, 200, '保存 AI 配置');
  noKey(r.body, 'PUT 响应');
  const g = await app.inject({ method: 'GET', url: '/api/system/ai', headers: A });
  status(g, 200, 'GET AI 配置');
  const j = g.json();
  assert.strictEqual(j.configured, true);
  assert.strictEqual(j.baseUrl, MOCK, `baseUrl 应归一化为 ${MOCK}，实际 ${j.baseUrl}`);
  assert.strictEqual(j.model, 'test-ok');
  assert.strictEqual(j.apiKey, MASKED_KEY);
  assert.strictEqual(j.hasKey, true);
  assert.strictEqual(j.timeoutSec, 15);
  assert.strictEqual(j.maxTokens, 512);
  noKey(g.body, 'GET 响应');
});

await check('测试连接：打码占位不覆盖旧 Key + 成功返回 latency/sample/usage', async () => {
  // 用 GET 返回的打码占位保存：旧 Key 必须保留
  const save = await app.inject({
    method: 'PUT', url: '/api/system/ai', headers: A,
    payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'test-ok', timeoutSec: 15, maxTokens: 512 },
  });
  status(save, 200, '占位保存');
  const r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: {} });
  status(r, 200, '测试连接');
  const j = r.json();
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.model, 'test-ok');
  assert.strictEqual(j.sample, 'ok');
  assert.ok(Number.isInteger(j.latencyMs) && j.latencyMs >= 0);
  assert.deepStrictEqual(j.usage, { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
  noKey(r.body, '测试连接响应');
  assert.strictEqual(lastRequest.headers.authorization, `Bearer ${FAKE_KEY}`, '旧 Key 应被保留并用于请求');
  assert.strictEqual(lastRequest.body.messages[0].content, '只回复 ok');
  assert.strictEqual(lastRequest.body.max_tokens, 16);
});

await check('生成成功：结构收敛、edges 去重/剔除悬空、危险键过滤、enabled:false/vars:{}', async () => {
  const save = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'gen-ok', timeoutSec: 15, maxTokens: 512 } });
  status(save, 200, '切换到 gen-ok');
  const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: A, payload: { sentence: '每天八点打开 https://example.com 签到' } });
  status(r, 200, '生成草稿');
  noKey(r.body, '生成响应');
  const draft = r.json().draft;
  assert.ok(draft, '应返回 draft');
  assert.strictEqual(draft.enabled, false);
  assert.deepStrictEqual(draft.vars, {});
  assert.strictEqual(draft.cron, '0 8 * * *');
  assert.ok(Array.isArray(draft.nodes) && draft.nodes.length === 2);
  const ids = new Set(draft.nodes.map((n) => n.id));
  assert.deepStrictEqual(draft.edges, [{ id: 'e0', source: 'n0', sourceHandle: 'success', target: 'n1' }]);
  for (const e of draft.edges) assert.ok(ids.has(e.source) && ids.has(e.target));
  const logCfg = draft.nodes[1].config;
  assert.strictEqual(Object.prototype.hasOwnProperty.call(logCfg, '__proto__'), false, 'config 中不应残留 __proto__');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(logCfg, 'constructor'), false, 'config 中不应残留 constructor');
  assert.strictEqual(logCfg.text, '完成：{{last.status}}');
  assert.strictEqual(Object.prototype.polluted, undefined, '不应发生原型污染');
  assert.strictEqual(lastRequest.body.max_tokens, 512, 'generate 应使用配置的 maxTokens');
});

await check('任务描述包含凭据时在本地拒绝，模型不接到请求', async () => {
  const storedValue = 'fixture-local-cookie-value';
  const inlineHeader = 'fixture inline+/header';
  const inlineBody = 'fixture-inline-json-value';
  const inlineQuery = 'fixture-inline-query-value';
  const flow = server.store.createFlow({ name: '凭据隔离用例', vars: { cookie: storedValue }, nodes: [{
    id: 'request', type: 'http', config: {
      url: `https://example.test/check?token=${inlineQuery}`,
      headers: [{ name: 'X-CSRF-Token', value: inlineHeader }],
    },
  }] });
  const template = server.store.createTemplate({ name: '模板凭据隔离用例', nodes: [{
    id: 'request', type: 'http', config: { url: 'https://example.test/', body: JSON.stringify({ password: inlineBody }) },
  }] });
  try {
    const descriptions = [
      '签到 Cookie: session=raw-first; theme=raw-second',
      'Authorization: Basic Zml4dHVyZTpwYXNz',
      '请求参数 {"password":"fixture-password"}',
      '登录 密码：fixture-password',
      '签到 https://user:fixture-password@example.com/check',
      '签到 https://example.com/check?%74oken=fixture-token',
      '签到 https://example.com/check?X-Amz-Signature=fixture-signature',
      'curl -b "fixture-cookie" https://example.com',
      'HAR 请求头 [{"name":"Cookie","value":"sid=fixture-value"}]',
      `用 ${storedValue} 签到`,
      `用 ${inlineHeader} 签到`,
      `用 ${encodeURIComponent(inlineHeader)} 签到`,
      `用 ${inlineQuery} 签到`,
      `用 ${inlineBody} 签到`,
      `用 ${FAKE_KEY} 签到`,
    ];
    const previous = lastRequest;
    for (const sentence of descriptions) {
      const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: A, payload: { sentence } });
      status(r, 400, '在本地拒绝疑似凭据');
      assert.match(r.json().error, /未发送给模型/);
      assert.ok(!r.body.includes(sentence), '回包不应复述原始描述');
      assert.strictEqual(lastRequest, previous, '模型端点没有收到请求');
    }
    const sentence = '每天签到 https://example.com/check?mode=daily，检查状态码';
    const safe = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: A, payload: { sentence } });
    status(safe, 200, '正常描述仍可生成');
    assert.equal(lastRequest.body.messages[1].content, sentence);
  } finally {
    server.store.deleteFlow(flow.id);
    server.store.deleteTemplate(template.id);
  }
});

await check('API Key：write 作用域可 generate；read 作用域 403；Key 不能调 admin 接口', async () => {
  const w = await app.inject({ method: 'POST', url: '/api/system/apikeys', headers: A, payload: { name: 'ai-write', scopes: ['write'] } });
  status(w, 200, '创建 write key');
  const writeKey = w.json().apiKey;
  let r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: { 'x-api-key': writeKey, 'content-type': 'application/json' }, payload: { sentence: '每天签到 https://example.com' } });
  status(r, 200, 'write key generate');

  const ro = await app.inject({ method: 'POST', url: '/api/system/apikeys', headers: A, payload: { name: 'ai-read', scopes: ['read'] } });
  status(ro, 200, '创建 read key');
  r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: { 'x-api-key': ro.json().apiKey, 'content-type': 'application/json' }, payload: { sentence: '每天签到' } });
  status(r, 403, 'read key generate');

  r = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: { 'x-api-key': writeKey, 'content-type': 'application/json' }, payload: { baseUrl: MOCK, apiKey: FAKE_KEY, model: 'test-ok' } });
  status(r, 403, 'write key PUT');
  r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: { 'x-api-key': writeKey, 'content-type': 'application/json' }, payload: {} });
  status(r, 403, 'write key test');
});

await check('测试连接失败：401 中文提示且不回显 Key', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'err-401' } }), 200, '切换到 err-401');
  const r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: {} });
  status(r, 502, '上游 401');
  const j = r.json();
  assert.strictEqual(j.ok, false);
  assert.match(j.error, /401/);
  assert.match(j.error, /API Key 无效或未授权/);
  assert.doesNotMatch(j.error, /invalid key/);
  noKey(r.body, '401 错误');
});

await check('AI 请求遇到 307 时不访问重定向目标', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'redirect' } }), 200, '切换到 redirect');
  const r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: {} });
  assert.equal(redirectHits, 0);
  status(r, 502, '拒绝跟随重定向');
  assert.match(r.json().error, /重定向/);
});

await check('模型错误正文不进入 API 回包或审计记录', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'err-echo' } }), 200, '切换到 err-echo');
  const sentence = '每天访问 https://example.com 检查 fixture-private-description';
  const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: A, payload: { sentence } });
  status(r, 502, '上游错误');
  assert.match(r.json().error, /400/);
  const audit = JSON.stringify(server.store.listAudit(20));
  for (const text of [r.body, audit]) assert.doesNotMatch(text, /upstream-private-marker|fixture-private-description/);
});

await check('测试连接失败：404 提示检查 Base URL', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: `${MOCK}/nope/v1`, apiKey: MASKED_KEY, model: 'test-ok' } }), 200, '切换到错误路径');
  const r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: {} });
  status(r, 502, '上游 404');
  assert.match(r.json().error, /404/);
  assert.match(r.json().error, /Base URL/);
  noKey(r.body, '404 错误');
});

await check('测试连接失败：非 JSON 返回中文提示', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'bad-json' } }), 200, '切换到 bad-json');
  const r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: {} });
  status(r, 502, '非 JSON');
  assert.match(r.json().error, /不是 JSON/);
  noKey(r.body, '非 JSON 错误');
});

await check('测试连接失败：超时（短 timeout 即时覆盖）', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'hang' } }), 200, '切换到 hang');
  const started = Date.now();
  const r = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: { timeoutSec: 1 } });
  const elapsed = Date.now() - started;
  status(r, 504, '超时');
  assert.match(r.json().error, /超时/);
  assert.ok(elapsed < 5000, `应在 5s 内返回，实际 ${elapsed}ms`);
  noKey(r.body, '超时错误');
});

await check('生成失败：非法 JSON 返回中文错误', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'gen-bad' } }), 200, '切换到 gen-bad');
  const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: A, payload: { sentence: '签到 https://example.com' } });
  status(r, 502, '非法 JSON');
  assert.match(r.json().error, /JSON/);
  noKey(r.body, '非法 JSON 错误');
});

await check('生成加固：edges 悬空/重复剔除、cron 非 5 段清空', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'gen-edges' } }), 200, '切换到 gen-edges');
  const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: A, payload: { sentence: '签到 https://example.com' } });
  status(r, 200, '生成草稿');
  const draft = r.json().draft;
  assert.strictEqual(draft.cron, '');
  const ids = new Set(draft.nodes.map((n) => n.id));
  assert.strictEqual(draft.edges.length, 1, `悬空/重复 edges 应被剔除，实际 ${JSON.stringify(draft.edges)}`);
  assert.strictEqual(draft.edges[0].source, 'n0');
  assert.strictEqual(draft.edges[0].target, 'n1');
  assert.ok(ids.has('n0') && ids.has('n1'));
});

await check('生成加固：节点最多 6 个', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'gen-many' } }), 200, '切换到 gen-many');
  const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: A, payload: { sentence: '多步签到 https://example.com' } });
  status(r, 200, '生成草稿');
  const draft = r.json().draft;
  assert.ok(draft.nodes.length <= 6, `节点应 ≤6，实际 ${draft.nodes.length}`);
  assert.strictEqual(new Set(draft.nodes.map((n) => n.id)).size, draft.nodes.length, '节点 id 应唯一');
});

await check('operator 登录可 generate（不要求 admin）', async () => {
  status(await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: MASKED_KEY, model: 'gen-ok' } }), 200, '切换到 gen-ok');
  const r = await app.inject({ method: 'POST', url: '/api/ai/generate', headers: O, payload: { sentence: '每天签到 https://example.com' } });
  status(r, 200, 'operator generate');
  assert.strictEqual(r.json().draft.enabled, false);
});

await check('审计：记录 ai.config.save/ai.test/ai.generate，且不含 Key 与完整 prompt', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/system/audit?limit=200', headers: A });
  status(r, 200, '审计列表');
  const entries = r.json().entries || [];
  const actions = new Set(entries.map((x) => x.action));
  assert.ok(actions.has('ai.config.save'), '应记录 ai.config.save');
  assert.ok(actions.has('ai.test'), '应记录 ai.test');
  assert.ok(actions.has('ai.generate'), '应记录 ai.generate');
  const text = JSON.stringify(entries);
  noKey(text, '审计');
  assert.ok(!text.includes('每天八点打开'), '审计不应记录完整 prompt');
  const gen = entries.filter((x) => x.action === 'ai.generate');
  assert.ok(gen.every((x) => x.detail.includes('输入=')), 'ai.generate 应只记录输入长度');
});

await check('落盘：meta.json 等数据文件不含明文 Key', async () => {
  for (const name of fs.readdirSync(dir)) {
    const file = `${dir}/${name}`;
    if (!fs.statSync(file).isFile()) continue;
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(FAKE_KEY), `${name} 不应包含明文 Key`);
  }
  const meta = fs.readFileSync(`${dir}/meta.json`, 'utf8');
  assert.match(meta, /enc:v1:/, 'meta.json 中的 AI Key 应为密文');
});

await check('短 Key 完全打码（不暴露任何字符）', async () => {
  const save = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: MOCK, apiKey: 'ollama', model: 'test-ok' } });
  status(save, 200, '保存短 Key');
  const g = await app.inject({ method: 'GET', url: '/api/system/ai', headers: A });
  status(g, 200, 'GET 短 Key 配置');
  assert.strictEqual(g.json().apiKey, '***…');
  assert.ok(!g.body.includes('ollama'), 'GET 不应回显短 Key');
  const t = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: {} });
  status(t, 200, '短 Key 测试连接');
  assert.strictEqual(lastRequest.headers.authorization, 'Bearer ollama');
});

await check('清空配置：全空保存 = 清空，GET configured=false，测试返回 400', async () => {
  const r = await app.inject({ method: 'PUT', url: '/api/system/ai', headers: A, payload: { baseUrl: '', apiKey: '', model: '' } });
  status(r, 200, '清空配置');
  const g = await app.inject({ method: 'GET', url: '/api/system/ai', headers: A });
  const j = g.json();
  assert.strictEqual(j.configured, false);
  assert.strictEqual(j.baseUrl, '');
  assert.strictEqual(j.apiKey, '');
  const t = await app.inject({ method: 'POST', url: '/api/ai/test', headers: A, payload: {} });
  status(t, 400, '未配置时测试');
  assert.match(t.json().error, /未配置/);
});

// ---- 清理 ----
for (const s of sockets) s.destroy();
await app.close();
scheduler.stop();
await new Promise((resolve) => mock.close(resolve));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
