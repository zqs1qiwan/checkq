/**
 * 连续失败自动停用：规则 + 落库 + 用户恢复
 * 运行：node server/test/auto-pause.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { shouldAutoPause, applyAutoPause } from '../src/auto-pause.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.log('  FAIL', msg); }
};

console.log('连续失败自动停用');

const failed = { status: 'failed', finalMessage: '登录态失效' };
const success = { status: 'success', finalMessage: '' };

ok(shouldAutoPause('cron', failed) === true, '调度触发（cron）且失败 → 停用');
ok(shouldAutoPause('schedule', failed) === true, '兼容 schedule 标记');
ok(shouldAutoPause('schedule', success) === false, '调度触发但成功 → 不停用');
ok(shouldAutoPause('manual', failed) === false, '手动运行失败 → 不动调度');
ok(shouldAutoPause('debug', failed) === false, '调试运行失败 → 不动调度');
ok(shouldAutoPause('schedule', { status: 'failed', debug: true }) === false, '带 debug 标记的失败 → 不停用');
ok(shouldAutoPause('schedule', null) === false, '没有运行记录 → 不停用');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-pause-'));
  const store = new Store(dir);
  const f = store.createFlow({ name: '自动停用测试', cron: '0 8 * * *', enabled: true, nodes: [], edges: [] });
  const rebuilt = [];
  const scheduler = { rebuild: () => rebuilt.push(Date.now()) };

  const paused = applyAutoPause({ store, scheduler, flowId: f.id, reason: failed.finalMessage });
  const raw = store.getFlowRaw(f.id);
  ok(paused === true, '失败后停用成功');
  ok(raw.enabled === false, '调度已关闭');
  ok(typeof raw.pausedAt === 'number' && raw.pausedAt > 0, '记录停用时间');
  ok(raw.pausedReason === '登录态失效', '记录停用原因');
  ok(rebuilt.length === 1, '停用后重建调度');
  const summary = store.listFlows().find((x) => x.id === f.id);
  ok(summary.pausedAt > 0 && summary.enabled === false, '列表摘要把暂停状态带给界面');

  ok(applyAutoPause({ store, scheduler, flowId: f.id, reason: 'again' }) === false, '已停用的任务不重复停用');

  store.updateFlow(f.id, { enabled: true });
  const after = store.getFlowRaw(f.id);
  ok(after.enabled === true && after.pausedAt === null && after.pausedReason === '', '重新启用后清掉暂停标记');

  const still = store.createFlow({ name: '未启用任务', cron: '0 8 * * *', nodes: [], edges: [] });
  ok(applyAutoPause({ store, scheduler, flowId: still.id, reason: 'x' }) === false, '本来就没启用的任务不会被标记暂停');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
