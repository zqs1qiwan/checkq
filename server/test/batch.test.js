/**
 * 批量操作 + 备份/恢复回归（青龙/千岛多选批处理对标）。
 */
process.env.ADMIN_PASSWORD = 'test1234';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(os.tmpdir() + '/cq-batch-');
const { buildServer } = await import('../src/api.js');
const { app, scheduler } = buildServer({ dataDir: dir, port: 0 });
await app.ready();
let passed = 0, failed = 0;
function check(n, c) { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } }
let r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'test1234' } });
const sid = r.headers['set-cookie'].split(';')[0].split('=')[1];
const ck = { qsid: sid };
const mk = async (name) => (await app.inject({ method: 'POST', url: '/api/flows', cookies: ck, payload: { name, nodes: [{ id: 'n0', type: 'log', name: '记录', x: 0, y: 0, config: { text: name } }], edges: [] } })).json();
const a = await mk('a'), b = await mk('b'), c = await mk('c');
r = await app.inject({ method: 'POST', url: '/api/flows/batch', cookies: ck, payload: { ids: [a.id, b.id], action: 'enable' } });
check('批量 enable', r.json().ok === 2);
r = await app.inject({ method: 'POST', url: '/api/flows/batch', cookies: ck, payload: { ids: [a.id, b.id], action: 'run' } });
check('批量 run 全部成功', r.statusCode === 200 && r.json().ok === 2 && r.json().results.every((item) => item.status === 'success'));
const slow = (await app.inject({ method: 'POST', url: '/api/flows', cookies: ck, payload: {
  name: '慢任务', nodes: [{ id: 'delay', type: 'delay', config: { seconds: 2 } }], edges: [],
} })).json();
try {
  const accepted = await app.inject({ method: 'POST', url: '/api/flows/batch', cookies: ck, payload: {
    ids: [slow.id, 'missing', a.id], action: 'run', wait: false,
  } });
  check('后台批量接收有效任务，并报告缺失任务', accepted.statusCode === 202 && accepted.json().ok === 2 && accepted.json().failed === 1);
  const [slowRun, missing, fastRun] = accepted.json().results;
  check('后台批量返回有序的提交回执', slowRun.status === 'queued' && missing.ok === false && fastRun.status === 'queued');
  const loadRun = async (id) => (await app.inject({ url: `/api/runs/${id}`, cookies: ck })).json();
  const inFlight = await loadRun(slowRun.runId);
  check('后台回执在慢任务完成前返回', ['queued', 'running'].includes(inFlight.status));
  const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${slowRun.runId}/cancel`, cookies: ck, payload: {} });
  check('已提交的慢任务可通过运行 ID 取消', cancelled.statusCode === 200);
  let finished;
  for (let i = 0; i < 50; i++) {
    finished = await loadRun(fastRun.runId);
    if (finished.status === 'success' && (await loadRun(slowRun.runId)).status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('有效任务在后台继续执行并保存结果', finished?.status === 'success' && (await loadRun(slowRun.runId)).status === 'cancelled');
} finally {
  await app.inject({ method: 'DELETE', url: `/api/flows/${slow.id}`, cookies: ck });
}
r = await app.inject({ method: 'POST', url: '/api/flows/batch', cookies: ck, payload: { ids: [a.id], action: 'disable' } });
check('批量 disable', r.json().ok === 1);
r = await app.inject({ method: 'POST', url: '/api/flows/batch', cookies: ck, payload: { ids: [c.id], action: 'delete' } });
check('批量 delete', r.json().ok === 1);
r = await app.inject({ method: 'POST', url: '/api/flows/batch', cookies: ck, payload: { ids: [], action: 'run' } });
check('空 ids 400', r.statusCode === 400);
r = await app.inject({ method: 'GET', url: '/api/system/backup', cookies: ck });
const bk = r.json();
check('备份含 flows 且不含密码', Array.isArray(bk.flows) && bk.flows.length === 2 && !JSON.stringify(bk).includes('passwordHash'));
r = await app.inject({ method: 'POST', url: '/api/system/restore', cookies: ck, payload: bk });
const rs = r.json();
check('恢复 2 个任务（新 ID、停用）', rs.createdFlows?.length === 2 && rs.createdFlows.every((x) => x.name.includes('恢复')));
r = await app.inject({ method: 'GET', url: '/api/flows', cookies: ck });
const list = r.json();
check('恢复后共 4 任务', list.length === 4);
check('恢复任务默认停用', list.filter((x) => x.name.includes('恢复')).every((x) => x.enabled === false));
await app.close(); scheduler.stop();
console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
