/**
 * v0.5 六件事的服务端行为（P0-1 演练 / P0-2 结构 / P0-3 诊断 / P0-4 去重 / P0-5 市场 / P0-6 度量）
 * 运行：node server/test/v05.test.js
 */
process.env.ADMIN_PASSWORD = 'test1234';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { computeMetrics, bumpEvents, EVENT_NAMES } from '../src/metrics.js';
import { parseIndex, resolveEntry, sha256, stableJson, checkTemplate } from '../src/market.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

// ---------- 一个本地站点桩：用来制造真实的失败运行（不发外网） ----------
const stub = http.createServer((req, res) => {
  if (req.url.startsWith('/api/need-login')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"code":401,"msg":"unauthorized"}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"code":0,"msg":"ok"}');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const SPORT = stub.address().port;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-v05-'));
const { buildServer } = await import('../src/api.js');
const { app, scheduler } = buildServer({ dataDir: dir, port: 0 });
await app.ready();

let r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
const sid = r.headers['set-cookie'].split(';')[0].split('=')[1];
const ck = { qsid: sid };

const get = (url, label, expect = 200, cookies = ck) => app.inject({ method: 'GET', url, cookies }).then((res) => {
  ok(res.statusCode === expect, `${label} → ${res.statusCode}`);
  return res;
});
const post = (url, payload, label, expect = 200) => app.inject({ method: 'POST', url, payload, cookies: ck }).then((res) => {
  ok(res.statusCode === expect, `${label} → ${res.statusCode}`);
  return res;
});

// ---------- P0-1 演练场 ----------
console.log('P0-1 演练场');
const prof = await app.inject({ method: 'GET', url: '/api/demo/profile' });
ok(prof.statusCode === 200, '演示 profile 公开可访问');
ok(/demo_sid=/.test(prof.headers['set-cookie'] || ''), '演示 profile 下发会话 Cookie');
const noCookie = await app.inject({ method: 'POST', url: '/api/demo/checkin' });
ok(noCookie.json().code === 401, '没 Cookie 时空签到 = 401');
const withCookie = await app.inject({ method: 'POST', url: '/api/demo/checkin', headers: { cookie: 'demo_sid=x' } });
ok(withCookie.json().code === 0, '带 Cookie 演示签到成功');
const risk = await app.inject({ method: 'POST', url: '/api/demo/checkin?mode=risk', headers: { cookie: 'demo_sid=x' } });
ok(risk.statusCode === 403, 'mode=risk → 403（可造风控失败）');
const items = await app.inject({ method: 'GET', url: '/api/demo/items?count=7' });
ok(items.json().items.length === 7, '演示列表按 count 返回');
const feats = await get('/api/system/features', '功能开关');
ok(feats.json().demo === true, '默认开启演练场');

const demoFlow = await post('/api/demo/flow', {}, '创建演练任务');
const demoId = demoFlow.json().id;
ok(demoFlow.json().created === true, '首次创建返回 created');
const again = await post('/api/demo/flow', {}, '再次点击演练');
ok(again.json().id === demoId && again.json().created === false, '重复点击复用同一条演练任务');
const demoDetail = await get(`/api/flows/${demoId}`, '演练任务详情');
ok(demoDetail.json().isDemo === true, '任务带演示标记');
ok((demoDetail.json().nodes || []).length === 3, '演练任务 3 步');
ok(demoDetail.json().vars.baseUrl.startsWith('http'), '演练地址是一个 URL');
ok((demoDetail.json().nodes[0].config.url || '').startsWith(demoDetail.json().vars.baseUrl), '节点地址跟随 baseUrl 变量');
ok(JSON.stringify(demoDetail.json().nodes).includes('/api/demo/checkin'), '演练任务只用演示端点');

// 关闭开关
process.env.CHECKQ_DEMO = '0';
const off = await app.inject({ method: 'GET', url: '/api/demo/profile' });
ok(off.statusCode === 404, 'CHECKQ_DEMO=0 时演示端点关闭');
const feats2 = await get('/api/system/features', '功能开关（关闭态）');
ok(feats2.json().demo === false, '开关关闭时前端能看到 demo=false');
delete process.env.CHECKQ_DEMO;

// ---------- P0-2 结构随详情返回 ----------
console.log('P0-2 结构可见');
const sf = await post('/api/flows', {
  name: '结构测试', cron: '', vars: {},
  nodes: [
    { id: 'n1', type: 'http', name: '请求', x: 0, y: 0, config: { method: 'GET', url: 'http://127.0.0.1/x' } },
    { id: 'n2', type: 'condition', name: '判断', x: 0, y: 120, config: { expr: 'last.status == 200' } },
    { id: 'n3', type: 'log', name: '记录', x: 0, y: 240, config: { text: 'ok' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', sourceHandle: 'success', target: 'n2' },
    { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
  ],
}, '创建结构测试任务');
const sid2 = sf.json().id;
const sd = await get(`/api/flows/${sid2}`, '详情带结构');
const st = sd.json().structure;
ok(!!st && Array.isArray(st.issues), '详情返回 structure');
ok(st.exits.some((e) => e.nodeId === 'n2' && e.handle === 'false' && !e.connected), '未连线的「假」分支被发现');
ok(st.issues.some((i) => i.handle === 'false'), '问题清单点名假分支');
ok(st.entryId === 'n1', '起点正确');

// ---------- P0-3 诊断：真实失败运行 ----------
console.log('P0-3 可解释失败');
const df = await post('/api/flows', {
  name: '诊断测试', cron: '', vars: {}, retry: { enabled: false },
  nodes: [{ id: 'h1', type: 'http', name: '查询', x: 0, y: 0, config: { method: 'GET', url: `http://127.0.0.1:${SPORT}/api/need-login`, timeout: 5, asserts: [{ expr: 'last.json.code', expect: 0 }] } }],
  edges: [],
}, '创建诊断测试任务');
const runRes = await post(`/api/flows/${df.json().id}/run`, { dedupe: true }, '运行诊断任务');
ok(runRes.json().status === 'failed', '运行失败');
ok(runRes.json().diagnosis?.rule === 'credential', `失败运行带诊断（${runRes.json().diagnosis?.rule}）`);
ok((runRes.json().diagnosis?.actions || []).length > 0, '诊断给出下一步动作');
ok(!JSON.stringify(runRes.json().diagnosis).includes('cookie='), '诊断不含凭据字面值');

// ---------- P0-4 并发只跑一次 ----------
console.log('P0-4 修改即重跑');
const slow = await post('/api/flows', {
  name: '慢任务', cron: '', vars: {},
  nodes: [{ id: 'd1', type: 'delay', name: '等待', x: 0, y: 0, config: { seconds: 1 } }],
  edges: [],
}, '创建慢任务');
const slowId = slow.json().id;
const [p1, p2] = await Promise.all([
  post(`/api/flows/${slowId}/run`, { dedupe: true }, '并发运行 #1'),
  post(`/api/flows/${slowId}/run`, { dedupe: true }, '并发运行 #2'),
]);
const deduped = [p1.json(), p2.json()].filter((x) => x && x.deduped === true).length;
ok(deduped === 1, '并发两次只产生一次运行（另一次被去重）');
const runsOfSlow = await get(`/api/runs?flowId=${slowId}&limit=10`, '慢任务运行记录');
ok(runsOfSlow.json().length === 1, '运行记录只有 1 条');

// ---------- P0-6 度量 ----------
console.log('P0-6 度量');
const now = Date.now();
const flows = [
  { id: 'f1', name: 'A', createdAt: now - 10 * 60000, enabled: true, tplId: 't1' },
  { id: 'f2', name: 'B', createdAt: now - 60 * 60000, enabled: false },
];
const runs = [
  { id: 'r1', flowId: 'f1', status: 'failed', startedAt: now - 8 * 60000 },
  { id: 'r2', flowId: 'f1', status: 'success', startedAt: now - 4 * 60000 },
  { id: 'r3', flowId: 'f2', status: 'success', startedAt: now - 30 * 60000 },
  { id: 'r4', flowId: 'f2', status: 'failed', startedAt: now - 200 * 3600 * 1000 },
];
const m = computeMetrics({ flows, runs, templates: [{ id: 't1' }], days: 7, now });
ok(m.window.runs === 3, '窗口内只统计近 7 天（3 条）');
ok(m.window.rate === 67, `近 7 天成功率 67%（实际 ${m.window.rate}）`);
ok(m.firstRun.samples === 2, '两个任务都有首跑样本');
ok(m.firstRun.medianMinutes === 16, `首跑用时中位数 16 分钟（实际 ${m.firstRun.medianMinutes}）`);
const m1 = computeMetrics({
  flows: [{ id: 'a', createdAt: now - 10 * 60000 }],
  runs: [
    { id: 'x', flowId: 'a', status: 'failed', startedAt: now - 8 * 60000 },
    { id: 'y', flowId: 'a', status: 'success', startedAt: now - 4 * 60000 },
  ],
  templates: [], days: 7, now,
});
ok(m1.repair.samples === 1 && m1.repair.medianMinutes === 4, `失败→成功的修复用时 4 分钟（实际 ${m1.repair.medianMinutes}）`);
ok(m.template.derivedTasks === 1, '派生任务计数');
ok(m.daily.length === 7, '每日序列 7 天');
ok(computeMetrics({ flows: [], runs: [], templates: [] }).window.rate === 0, '空库为 0 而不是 null');
ok(EVENT_NAMES.includes('wizard_open'), '事件白名单含向导');
ok(bumpEvents({}, 'wizard_open').wizard_open === 1, '事件计数');
ok(Object.keys(bumpEvents({}, 'bad_event')).length === 0, '白名单外事件被忽略');
const met = await get('/api/system/metrics?days=30', '度量端点');
ok(met.json().days === 30 && Array.isArray(met.json().daily), '度量端点返回口径与序列');
const ev = await post('/api/system/events', { name: 'run_quick' }, '记录界面事件');
ok(ev.json().events.run_quick === 1, '事件落库');
await post('/api/system/events', { name: 'nope' }, '非法事件', 400);

// 本地事件不随备份导出
const backup = await get('/api/system/backup', '脱敏备份');
ok(!JSON.stringify(backup.json()).includes('run_quick'), '备份不含本地事件');

// ---------- P0-5 模板市场（离线可测的部分） ----------
console.log('P0-5 模板市场');
const tplBody = { name: '示例模板', vars: { cookie: 'x', ua: 'M' }, nodes: [{ id: 'a', type: 'log', name: '记录', x: 0, y: 0, config: { text: 'ok' } }], edges: [] };
const digest = sha256(tplBody);
const goodIndex = {
  version: 1,
  name: '测试索引',
  entries: [{ id: 'demo-1', name: '示例签到', desc: 'd', tags: ['签到'], vars: [{ name: 'cookie', label: '登录 Cookie', required: true, sensitive: true }], nodes: 1, sha256: digest, template: tplBody, source: 'https://example.org/index.json' }],
};
const parsed = parseIndex(goodIndex, 'https://example.org/index.json');
ok(parsed.ok, `合法索引通过校验（${parsed.errors.join('；') || '无错误'}）`);
ok(parsed.entries[0].sha256 === digest, '条目哈希保留');
ok(parsed.entries[0].vars[0].sensitive === true, '变量声明保留');

const badVersion = parseIndex({ ...goodIndex, version: 2 }, 'https://example.org/i.json');
ok(!badVersion.ok && badVersion.errors[0].includes('版本'), '未知版本被拒绝');

const dup = parseIndex({ ...goodIndex, entries: [goodIndex.entries[0], goodIndex.entries[0]] }, 'https://example.org/i.json');
ok(!dup.ok && dup.errors.some((e) => e.includes('重复')), '重复 id 被拒绝');

const noHash = parseIndex({ ...goodIndex, entries: [{ ...goodIndex.entries[0], sha256: 'abc' }] }, 'https://example.org/i.json');
ok(!noHash.ok, '哈希格式不对被拒绝');

const resolved = await resolveEntry(parsed.entries[0]);
ok(resolved.ok, '内联模板解析成功');
ok(resolved.varsCleared.includes('cookie'), '敏感默认值被强制清空');
ok(resolved.template.vars.cookie === '', '清空后的模板变量为空串');

const tampered = await resolveEntry({ ...parsed.entries[0], sha256: sha256({ other: 1 }) });
ok(!tampered.ok && tampered.errors[0].includes('内容与声明不符'), '哈希不一致被拒绝');

ok(stableJson({ b: 1, a: [2, { d: 4, c: 3 }] }) === '{"a":[2,{"c":3,"d":4}],"b":1}', '规范化 JSON 键排序稳定');
ok(sha256({ a: 1 }) === sha256({ a: 1 }), '同一对象哈希稳定');
const badTpl = checkTemplate({ name: 'x', nodes: [{ id: 'a', type: 'not-real' }] });
ok(!badTpl.ok && badTpl.errors[0].includes('不支持的节点类型'), '未知节点类型拒绝导入');

const sub = await post('/api/market/subscribe', { url: 'http://127.0.0.1:1/x.json' }, '订阅不可达索引', 502);
ok(sub.statusCode === 502, '不可达索引给出原因');
await get('/api/market/subscriptions', '订阅列表');

// 清理
for (const id of [demoId, sid2, df.json().id, slowId]) await app.inject({ method: 'DELETE', url: `/api/flows/${id}`, cookies: ck });
await app.close();
scheduler.stop();
stub.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
