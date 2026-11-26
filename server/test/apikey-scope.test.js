/**
 * T05：API Key 的任务范围与「读秘密」权限。
 * 运行：node server/test/apikey-scope.test.js
 */
process.env.ADMIN_PASSWORD = 'test1234';
import fs from 'node:fs';
import os from 'node:os';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

const dir = fs.mkdtempSync(os.tmpdir() + '/cq-apikey-');
const { buildServer } = await import('../src/api.js');
const { app, scheduler, store } = buildServer({ dataDir: dir, port: 0 });
await app.ready();

let r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
const ck = { qsid: r.headers['set-cookie'].split(';')[0].split('=')[1] };

const mkFlow = async (name, group = '') => {
  const res = await app.inject({ method: 'POST', url: '/api/flows', cookies: ck, payload: {
    name, group, cron: '',
    vars: { cookie: 'SECRET-COOKIE', site: 'demo' },
    nodes: [{
      id: 'n0', type: 'http', name: '请求', x: 0, y: 0,
      config: { method: 'GET', url: 'https://example.com/api', headers: [{ name: 'Authorization', value: 'Bearer SECRET-HEADER', enabled: true }], body: '' },
    }],
    edges: [],
  } });
  return res.json();
};
const f1 = await mkFlow('Key 范围 A', '签到');
const f2 = await mkFlow('Key 范围 B', '查询');

const mkKey = async (body) => {
  const res = await app.inject({ method: 'POST', url: '/api/system/apikeys', cookies: ck, payload: body });
  ok(res.statusCode === 200, `创建 Key：${body.name}`);
  return { key: res.json().apiKey, id: res.json().key.id };
};
const asKey = (key, method, url, payload) => app.inject({
  method, url, payload, headers: { 'x-api-key': key },
});

const readOnly = await mkKey({ name: '只读绑定 A', scopes: ['read'], flowIds: [f1.id] });
store.updateFlow(f1.id, { note: '业务备注 SECRET-HEADER', pausedReason: '旧错误 SECRET-HEADER' });
const historical = 'historical-value-fixture';
store.addRun({
  id: 'legacy-output', flowId: f1.id, startedAt: Date.now(), status: 'failed', finalMessage: '旧运行 SECRET-HEADER',
  summary: `回显 ${historical}`, vars: { ordinary: historical },
  logs: [
    { stepId: 'request', index: 1, type: 'http', detail: {
      url: 'https://example.test/', method: 'GET', headers: { 'X-CSRF-Token': historical }, response: { status: 200, body: `回显 ${historical}` },
    } },
    ...Array.from({ length: 22 }, (_, index) => ({ stepId: `line-${index}`, index: index + 2, type: 'log', name: '记录', message: `结果 ${historical}` })),
  ],
});
const listTemplate = store.createTemplate({ name: '模板 SECRET-HEADER', desc: '说明 SECRET-HEADER', nodes: f1.nodes });

r = await asKey(readOnly.key, 'GET', '/api/flows');
ok(r.statusCode === 200, '只读 Key 列表 200');
ok(r.json().length === 1 && r.json()[0].id === f1.id, '只读 Key 列表只返回绑定任务');
ok(r.json()[0].note === '业务备注 ***' && r.json()[0].pausedReason === '旧错误 ***'
  && r.json()[0].lastRun.finalMessage === '旧运行 ***', '任务列表遮蔽定义和历史摘要中的凭据副本');
for (const endpoint of [`/api/runs?flowId=${f1.id}`, '/api/runs/legacy-output', '/api/runs/legacy-output/har', `/api/flows/${f1.id}/logs?limit=20`]) {
  const masked = await asKey(readOnly.key, 'GET', endpoint);
  ok(masked.statusCode === 200 && !masked.body.includes(historical) && !masked.body.includes('SECRET-HEADER')
    && masked.body.includes('***'), `旧运行凭据已遮蔽 ${endpoint.split('?')[0]}`);
}
const legacyDetail = await app.inject({ url: '/api/runs/legacy-output', cookies: ck });
ok(legacyDetail.json().vars.ordinary === historical, '旧记录读取脱敏保留原始存储');
const rawLists = await app.inject({ url: '/api/flows', cookies: ck });
ok(rawLists.json().find((flow) => flow.id === f1.id).note === '业务备注 SECRET-HEADER', '登录会话仍可读取原始备注');
const templateReader = await mkKey({ name: '全范围列表只读', scopes: ['read'] });
const templateList = await asKey(templateReader.key, 'GET', '/api/templates');
const listedTemplate = templateList.json().find((template) => template.id === listTemplate.id);
ok(listedTemplate?.name === '模板 ***' && listedTemplate?.desc === '说明 ***', '模板列表遮蔽名称和说明中的凭据副本');

r = await asKey(readOnly.key, 'GET', `/api/flows/${f1.id}`);
ok(r.statusCode === 200, '只读 Key 读绑定任务 200');
ok(r.json().vars?.cookie === '', '无 secrets 作用域读不到变量明文');
ok(r.json().vars?.site === 'demo', '非敏感变量仍可读');
const authHeader = r.json().nodes?.[0]?.config?.headers?.find((h) => h.name === 'Authorization');
ok(authHeader?.value !== 'Bearer SECRET-HEADER', '无 secrets 作用域读不到内联 Authorization 明文');

r = await asKey(readOnly.key, 'GET', `/api/flows/${f2.id}`);
ok(r.statusCode === 403, '只读 Key 读范围外任务被拒绝');
r = await asKey(readOnly.key, 'GET', `/api/flows/${f2.id}/logs`);
ok(r.statusCode === 403, '只读 Key 读范围外日志被拒绝');
r = await asKey(readOnly.key, 'POST', `/api/flows/${f1.id}/run`, {});
ok(r.statusCode === 403, '只有 read 的 Key 不能运行任务');
r = await asKey(readOnly.key, 'POST', '/api/flows', { name: '越权新建', nodes: [], edges: [] });
ok(r.statusCode === 403, '受限 Key 不能新建任务');

const runKey = await mkKey({ name: '运行绑定 A + 秘密', scopes: ['read', 'run', 'secrets'], flowIds: [f1.id] });
r = await asKey(runKey.key, 'GET', '/api/flows?limit=1');
ok(r.statusCode === 200 && r.json().length === 1, '运行 Key 列表仍受范围限制');
r = await asKey(runKey.key, 'GET', `/api/flows/${f1.id}`);
ok(r.statusCode === 200 && r.json().vars?.cookie === 'SECRET-COOKIE', 'secrets 作用域可读变量明文');
r = await asKey(runKey.key, 'POST', `/api/flows/${f1.id}/run`, {});
ok(r.statusCode === 200, 'run 作用域可运行绑定任务');
const runId = r.json().id;

r = await asKey(runKey.key, 'GET', '/api/runs?limit=10');
ok(r.statusCode === 200, '运行 Key 可读运行历史');
ok(r.json().every((x) => x.flowId === f1.id), '运行历史按任务范围过滤');

r = await asKey(runKey.key, 'POST', '/api/flows/batch', { ids: [f1.id, f2.id], action: 'run' });
ok(r.statusCode === 403, '批量操作含范围外任务被整体拒绝');
r = await asKey(runKey.key, 'POST', '/api/flows/batch', { ids: [f1.id], action: 'set-group', group: '其它' });
ok(r.statusCode === 403, '受限 Key 不能改分组逃逸范围');
r = await asKey(runKey.key, 'POST', `/api/flows/${f1.id}/clone`, {});
ok(r.statusCode === 403, '受限 Key 不能克隆任务');
r = await asKey(runKey.key, 'PUT', `/api/flows/${f2.id}`, { name: '越权改' });
ok(r.statusCode === 403, '受限 Key 不能改范围外任务');

const groupKey = await mkKey({ name: '分组绑定', scopes: ['read'], groups: ['签到'] });
r = await asKey(groupKey.key, 'GET', '/api/flows');
ok(r.statusCode === 200 && r.json().length === 1 && r.json()[0].id === f1.id, '分组绑定只返回该分组任务');
r = await asKey(groupKey.key, 'GET', `/api/flows/${f1.id}`);
ok(r.statusCode === 200, '分组绑定可读组内任务');
r = await asKey(groupKey.key, 'GET', `/api/flows/${f2.id}`);
ok(r.statusCode === 403, '分组绑定读组外任务被拒绝');

const unionKey = await mkKey({ name: '任务与分组并集', scopes: ['read'], flowIds: [f2.id], groups: ['签到'] });
const emptyKey = await mkKey({ name: '无匹配任务', scopes: ['read'], groups: ['空分组'] });
const unrestricted = (await asKey(templateReader.key, 'GET', '/api/flows')).json();
r = await asKey(unionKey.key, 'GET', '/api/flows');
ok(r.statusCode === 200 && JSON.stringify(r.json()) === JSON.stringify(unrestricted), '任务与分组按并集匹配，摘要和顺序一致');
const projected = [];
const nextRunAt = store.nextRunAt.bind(store);
store.nextRunAt = (flow) => { projected.push(flow.id); return nextRunAt(flow); };
try {
  r = await asKey(groupKey.key, 'GET', '/api/flows');
  ok(r.statusCode === 200 && projected.join() === f1.id, '仅为匹配的任务生成摘要');
  projected.length = 0;
  r = await asKey(emptyKey.key, 'GET', '/api/flows');
  ok(r.statusCode === 200 && r.json().length === 0 && projected.length === 0, '无匹配任务时直接返回空列表');
} finally {
  delete store.nextRunAt;
}

const broadKey = await mkKey({ name: '默认全范围', scopes: ['read', 'run'] });
r = await asKey(broadKey.key, 'GET', '/api/flows');
ok(r.statusCode === 200 && r.json().length === 2, '未绑定范围的 Key 仍可看全部任务（向后兼容）');
r = await asKey(broadKey.key, 'GET', `/api/flows/${f1.id}`);
ok(r.statusCode === 200 && r.json().vars?.cookie === '', '旧式 Key 默认没有 secrets 作用域');
r = await asKey(broadKey.key, 'POST', `/api/flows/${f1.id}/run`, {});
ok(r.statusCode === 200, '旧式 Key 默认仍可运行');

r = await asKey(runKey.key, 'GET', '/api/me');
ok(r.statusCode === 200 && r.json().permissions?.secrets === true && r.json().permissions?.scope === 'limited', '/api/me 暴露范围与 secrets 权限');

r = await asKey(readOnly.key, 'GET', `/api/runs/${runId}`);
ok(r.statusCode === 200 && r.json().flowId === f1.id, '只读 Key 可读范围内运行详情');

// 管理员更新 Key 的范围：清空绑定后回到全范围
r = await app.inject({ method: 'PUT', url: `/api/system/apikeys/${readOnly.id}`, cookies: ck, payload: { flowIds: [] } });
ok(r.statusCode === 200 && r.json().key.flowIds.length === 0, '更新 Key 清空任务范围');
r = await asKey(readOnly.key, 'GET', `/api/flows/${f2.id}`);
ok(r.statusCode === 200, '清空绑定后可读其它任务');

// 模板详情同样按 secrets 脱敏
r = await asKey(readOnly.key, 'GET', '/api/templates');
ok(r.statusCode === 200, '只读 Key 可看模板列表');
const tpl = await app.inject({ method: 'POST', url: '/api/templates', cookies: ck, payload: {
  name: '秘密模板', vars: { token: 'SECRET-TOKEN', site: 'demo' },
  nodes: [{ id: 'n0', type: 'log', name: '记录', x: 0, y: 0, config: { text: 'ok' } }], edges: [],
} });
r = await asKey(readOnly.key, 'GET', `/api/templates/${tpl.json().id}`);
ok(r.statusCode === 200 && r.json().vars?.token === '', '无 secrets 作用域模板变量被脱敏');
r = await asKey(runKey.key, 'GET', `/api/templates/${tpl.json().id}`);
ok(r.statusCode === 200 && r.json().vars?.token === 'SECRET-TOKEN', 'secrets 作用域模板变量可读');

const editorKey = await mkKey({ name: '修改任务，无凭据读取权', scopes: ['read', 'write'], flowIds: [f1.id] });
const saved = await asKey(editorKey.key, 'PUT', `/api/flows/${f1.id}`, { note: 'Agent 更新备注' });
ok(saved.statusCode === 200 && saved.json().note === 'Agent 更新备注' && saved.json().vars?.cookie === '' && !saved.body.includes('SECRET-HEADER'), '任务保存回包保留编辑结果并脱敏');
const forbiddenEdit = await asKey(editorKey.key, 'PUT', `/api/flows/${f1.id}`, {
  nodes: f1.nodes.map((node) => ({ ...node, config: { ...node.config, url: 'https://other.example.test/' } })),
});
ok(forbiddenEdit.statusCode === 403 && store.getFlow(f1.id).nodes[0].config.url === 'https://example.com/api', '修改任务密钥不能改写带凭据的执行配置');
const curl = await asKey(editorKey.key, 'POST', `/api/flows/${f1.id}/curl`, { nodeId: 'n0' });
ok(curl.statusCode === 200 && !curl.body.includes('SECRET-HEADER'), 'cURL 回包不包含内联凭据');
const legacyKey = 'fixture-legacy-key';
store.meta.apiKey = legacyKey;
try {
  const legacyRead = await asKey(legacyKey, 'GET', `/api/flows/${f1.id}`);
  ok(legacyRead.statusCode === 200 && legacyRead.json().vars?.cookie === '' && !legacyRead.body.includes('SECRET-HEADER'), '旧版单密钥读取也按无 secrets 处理');
} finally {
  delete store.meta.apiKey;
}
const privileged = await asKey(runKey.key, 'GET', `/api/flows/${f1.id}`);
ok(privileged.json().vars?.cookie === 'SECRET-COOKIE' && privileged.body.includes('SECRET-HEADER'), '保存备注后原凭据仍可供授权调用者读取');

const globalEditor = await mkKey({ name: '全范围修改，无凭据读取权', scopes: ['read', 'write'] });
const savedTemplate = await asKey(globalEditor.key, 'PUT', `/api/templates/${tpl.json().id}`, { desc: 'Agent 更新描述' });
ok(savedTemplate.statusCode === 200 && savedTemplate.json().desc === 'Agent 更新描述' && savedTemplate.json().vars?.token === '', '模板保存回包脱敏');
const instance = await asKey(globalEditor.key, 'POST', `/api/templates/${tpl.json().id}/instantiate`, { name: '派生任务' });
ok(instance.statusCode === 200 && instance.json().vars?.token === '', '实例化回包不返回模板凭据');
const clone = await asKey(globalEditor.key, 'POST', `/api/flows/${f1.id}/clone`, {});
ok(clone.statusCode === 200 && clone.json().vars?.cookie === '' && !clone.body.includes('SECRET-HEADER'), '克隆回包不返回原任务凭据');
const templateAfter = await asKey(runKey.key, 'GET', `/api/templates/${tpl.json().id}`);
ok(templateAfter.json().vars?.token === 'SECRET-TOKEN', '模板更新保留原凭据');

const cleanNodes = [{ id: 'request', type: 'http', config: { method: 'POST', url: 'https://example.test', body: '{ "mode": "daily" }' } }];
const cleanTemplate = store.createTemplate({ name: '共享流程', nodes: cleanNodes, edges: [] });
const cleanFlow = store.createFlow({ name: '无凭据草稿', nodes: cleanNodes, edges: [] });
const newNodes = [{ ...cleanNodes[0], config: { ...cleanNodes[0].config, url: 'https://new.example.test/' } }];
r = await asKey(globalEditor.key, 'PUT', `/api/flows/${cleanFlow.id}`, { nodes: newNodes });
ok(r.statusCode === 200, '无凭据草稿允许编辑请求目标');
const boundNodes = newNodes.map((node) => ({ ...node, config: { ...node.config, allowedOrigin: 'https://new.example.test' } }));
r = await app.inject({ method: 'PUT', url: `/api/flows/${cleanFlow.id}`, cookies: ck, payload: { nodes: boundNodes } });
ok(r.statusCode === 200 && r.json().nodes[0].config.allowedOrigin === 'https://new.example.test', '本地会话可以设置允许请求源');
r = await asKey(globalEditor.key, 'PUT', `/api/flows/${cleanFlow.id}`, { nodes: newNodes });
ok(r.statusCode === 403 && store.getFlow(cleanFlow.id).nodes[0].config.allowedOrigin === 'https://new.example.test', '无凭据权限的密钥不能移除已有的允许请求源');
r = await app.inject({ method: 'PUT', url: `/api/templates/${cleanTemplate.id}`, cookies: ck, payload: {
  nodes: boundNodes.map((node) => ({ ...node, config: { ...node.config, allowedOrigin: 'https://new.example.test/path' } })),
} });
ok(r.statusCode === 400, '模板保存拒绝带路径的允许请求源');
const derived = store.instantiateTemplate(cleanTemplate.id, { vars: { password: 'local-fixture-password' } });
r = await asKey(globalEditor.key, 'PUT', `/api/templates/${cleanTemplate.id}`, { nodes: newNodes });
ok(r.statusCode === 403 && store.getFlow(derived.id).nodes[0].config.url === 'https://example.test', '模板更新也检查派生任务的凭据');
r = await app.inject({ method: 'PUT', url: `/api/templates/${cleanTemplate.id}`, cookies: ck, payload: { nodes: newNodes } });
ok(r.statusCode === 200 && store.getFlow(derived.id).nodes[0].config.url === 'https://new.example.test/', '本地会话仍可编辑带凭据的执行配置');

scheduler.stop?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
