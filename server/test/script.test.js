/**
 * script 沙箱节点回归：返回值合并 vars、无 require/网络泄漏、超时、空脚本失败。
 */
import assert from 'node:assert';
import { Engine } from '../src/engine.js';
let passed = 0, failed = 0;
async function ok(n, fn) { try { await fn(); passed++; console.log(`  PASS ${n}`); } catch (e) { failed++; console.log(`  FAIL ${n}: ${e.message}`); } }
function flow(nodes, vars = {}) { return { id: 't', name: 't', vars, nodes, edges: [] }; }
const scriptNode = (code) => ({ id: 's1', type: 'script', name: '脚本', x: 0, y: 0, config: { code } });
const logNode = (text) => ({ id: 'l1', type: 'log', name: '日志', x: 200, y: 0, config: { text } });

await ok('script 返回对象合并回 vars', async () => {
  const f = flow([scriptNode('return { doubled: Number(vars.n || 0) * 2 };'), logNode('d={{doubled}}')], { n: '21' });
  f.edges = [{ id: 'e1', source: 's1', sourceHandle: 'next', target: 'l1' }];
  const r = await new Engine(f).run({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.vars.doubled, '42');
  const line = r.logs.find((l) => l.type === 'log');
  assert.ok(line && line.message.includes('d=42'), JSON.stringify(r.logs.map((l) => l.message)));
});
await ok('script 拿不到 require（沙箱隔离）', async () => {
  const f = flow([scriptNode('return { x: require("fs") };')]);
  const r = await new Engine(f).run({});
  assert.strictEqual(r.ok, false);
  assert.ok(/脚本异常/.test(r.finalMessage), r.finalMessage);
});
await ok('script 空代码失败', async () => {
  const f = flow([scriptNode('  ')]);
  const r = await new Engine(f).run({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.finalMessage, '脚本为空');
});
await ok('script 在独立进程里拿不到 process/require', async () => {
  const f = flow([scriptNode('return { process: typeof process, require: typeof require, module: typeof module };')]);
  const r = await new Engine(f).run({});
  assert.strictEqual(r.ok, true);
  const line = r.logs.find((l) => l.type === 'script');
  assert.ok(line && line.message.includes('脚本返回'), JSON.stringify(r.logs.map((l) => l.message)));
  // 返回值在 vars 里可见，确认三个宿主对象均为 undefined
  assert.equal(r.vars.process, 'undefined');
  assert.equal(r.vars.require, 'undefined');
  assert.equal(r.vars.module, 'undefined');
});
await ok('script 不能通过 Function 构造器逃逸', async () => {
  const f = flow([scriptNode(`try {
    return { escaped: String(globalThis.constructor.constructor('return process')().pid) };
  } catch (err) {
    return { escaped: 'blocked' };
  }`)]);
  const r = await new Engine(f).run({});
  assert.strictEqual(r.ok, true);
  assert.equal(r.vars.escaped, 'blocked');
});
await ok('script 死循环被超时截断', async () => {
  const f = flow([scriptNode('while (true) {}')]);
  const start = Date.now();
  const r = await new Engine(f).run({});
  assert.strictEqual(r.ok, false);
  assert.ok(/超时/.test(r.finalMessage), r.finalMessage);
  assert.ok(Date.now() - start < 7000);
});
console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
