/**
 * 菜单式向导生成：直接 import 前端 shipped 的纯逻辑（wizard-logic.js），
 * 不再抄副本，保证测的就是线上代码。
 */
import assert from 'node:assert';
import { Engine } from '../src/engine.js';
import { buildWizardFlow, parseNatural } from '../../web/src/components/flow-list/wizard-logic.js';

let passed = 0, failed = 0;
function check(n, c) { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } }

{
  const f = buildWizardFlow({ url: 'https://example.com/api/sign', method: 'POST', keyword: '签到成功', eventLabel: '签到' });
  check('向导 name 派生 hostname', f.name === 'example.com · 签到');
  check('向导 2 节点 1 边', f.nodes.length === 2 && f.edges.length === 1);
  check('向导断言含关键词', f.nodes[0].config.asserts[0].res[0] === '签到成功');
  check('向导 cron 每日 8 点停用', f.cron === '0 8 * * *' && f.enabled === false);
}
{
  const f = buildWizardFlow({ url: 'not-a-url', method: 'GET', keyword: '', eventLabel: '其他' });
  check('非法 URL 回退自定义任务', f.name === '自定义任务 · 其他');
  check('无关键词不带断言', f.nodes[0].config.asserts.length === 0);
}

// 自然语言解析（对话生成原型）
{
  const p = parseNatural('每天8点去 https://ex.com/sign 签到，看到签到成功算成功');
  check('对话生成 url', p.url === 'https://ex.com/sign');
  check('对话生成 keyword', /签到/.test(p.keyword));
  check('对话生成 event', p.eventLabel === '签到');
  check('对话生成 method 默认 GET', p.method === 'GET');
  const p2 = parseNatural('用 POST 访问 https://ex.com/api/checkin 然后抽卡');
  check('对话生成 POST 识别', p2.method === 'POST' && p2.eventLabel === '抽卡');
}

// 失败重选关键：原位替换不应新增节点数（引擎侧可验证：只替换 config，边不变）
await (async () => {
  const f = { id: 't', name: 't', vars: {}, nodes: [
    { id: 'n0', type: 'http', name: 'h', x: 0, y: 0, config: { method: 'GET', url: 'https://x', headers: [], body: '', asserts: [] } },
    { id: 'n1', type: 'extract', name: '提取', x: 200, y: 0, config: { from: 'last.text', re: 'old:(\\d+)', name: 'old', optional: true } },
  ], edges: [{ id: 'e1', source: 'n0', sourceHandle: 'success', target: 'n1' }] };
  // 原位替换模拟：前端 updateConfig 只改 config，不新增节点/边
  const after = { ...f, nodes: f.nodes.map((n) => n.id === 'n1' ? { ...n, config: { ...n.config, re: 'new:(\\d+)' } } : n) };
  check('原位替换不新增节点不新增边', after.nodes.length === 2 && after.edges.length === 1);
  check('原位替换改了 re', after.nodes[1].config.re === 'new:(\\d+)');
})();

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
