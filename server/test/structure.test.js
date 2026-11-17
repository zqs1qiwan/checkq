/**
 * 结构分析（P0-2）：缺线出口 / 孤立节点 / 起点 / 循环体范围
 * 运行：node server/test/structure.test.js
 */
import { analyzeStructure, structureSignature, outputLabel } from '../src/structure.js';
import { STEP_TYPES } from '../src/model.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

const N = (id, type, x = 0, extra = {}) => ({ id, type, name: extra.name || id, x, y: 0, config: extra.config || {} });
const E = (source, sourceHandle, target, id = `${source}-${target}`) => ({ id, source, sourceHandle, target });

// 1) 线性链路：失败出口未接 = info，不阻断；next 已接
{
  const flow = { nodes: [N('n1', 'http', 0), N('n2', 'log', 200)], edges: [E('n1', 'success', 'n2')] };
  const s = analyzeStructure(flow);
  ok(s.ok === true, '只缺失败出口时结构仍可用');
  ok(s.entryId === 'n1', '起点 = 最左无入线节点');
  const dangles = s.issues.filter((i) => i.kind === 'dangling');
  ok(dangles.length === 2, '两个未接出口都被列出（n1.failed / n2.next）');
  ok(dangles.some((d) => d.level === 'info' && d.handle === 'failed'), '失败出口 = info 级');
  ok(dangles.some((d) => d.level === 'warn' && d.handle === 'next'), '链尾 next = warn 级');
  ok(s.exits.find((e) => e.nodeId === 'n1' && e.handle === 'success').connected, '成功出口标记已连接');
  ok(s.counts.dangling === 2, '计数一致');
}

// 2) 条件分支：一个分支没接 → 点名「假」
{
  const flow = {
    nodes: [N('c1', 'condition', 0), N('a', 'log', 200), N('b', 'log', 200)],
    edges: [E('c1', 'true', 'a'), E('a', 'next', 'b')],
  };
  const s = analyzeStructure(flow);
  const d = s.issues.find((i) => i.handle === 'false');
  ok(!!d && d.level === 'warn', '分支「假」未接 = warn');
  ok(!!d && d.message.includes('假'), '文案点名分支名');
  ok(outputLabel('condition', 'false') === '假', '分支标注 = 假');
  ok(outputLabel('log', 'next') === '', '单出口节点不标注文字');
}

// 3) foreach：循环体范围 = each 链，直到「结束」后继
{
  const flow = {
    nodes: [N('f', 'foreach', 0), N('b1', 'http', 200), N('b2', 'log', 400), N('after', 'log', 600)],
    edges: [
      E('f', 'each', 'b1'),
      E('b1', 'success', 'b2'),
      E('b2', 'next', 'after'),
      E('f', 'next', 'after', 'f-after'),
    ],
  };
  const s = analyzeStructure(flow);
  const loop = s.loops[0];
  ok(!!loop && loop.foreachId === 'f', '找到遍历节点');
  ok(loop.nodeIds.join(',') === 'b1,b2', '循环体 = each 链上的两步');
  ok(loop.closed === true, '循环体在主链汇合处闭合');
  ok(!s.issues.some((i) => i.kind === 'dangling' && i.nodeId === 'f' && i.handle === 'each'), '循环体已接不算缺线');
}

// 4) foreach 没有循环体 → error
{
  const flow = {
    nodes: [N('f', 'foreach', 0), N('after', 'log', 400)],
    edges: [E('f', 'next', 'after')],
  };
  const s = analyzeStructure(flow);
  const d = s.issues.find((i) => i.handle === 'each');
  ok(!!d && d.level === 'error', '空循环体 = error');
  ok(s.ok === false, '有 error 时 ok=false');
}

// 5) 孤岛：不在任何链路上的步骤
{
  const flow = {
    nodes: [N('n1', 'log', 0), N('n2', 'log', 300), N('n3', 'log', 600)],
    edges: [E('n2', 'next', 'n3')],
  };
  const s = analyzeStructure(flow);
  ok(s.entries.includes('n1'), 'n1 是起点');
  ok(s.orphans.length === 2 && s.orphans.some((o) => o.nodeId === 'n3'), '起点之外的孤立链路都算孤岛');
  ok(s.issues.some((i) => i.kind === 'orphan'), '孤岛进入问题清单');
}

// 6) 多起点：只跑最左
{
  const flow = { nodes: [N('x', 'log', 500), N('y', 'log', 0)], edges: [] };
  const s = analyzeStructure(flow);
  ok(s.entries.length === 2, '两个起点都被列出');
  ok(s.entryId === 'y', '引擎实际从左起第一个开始');
  const m = s.issues.find((i) => i.kind === 'multi-entry');
  ok(!!m && m.level === 'warn', '多起点 = warn');
}

// 7) 成环没有起点 → error
{
  const flow = { nodes: [N('a', 'log', 0), N('b', 'log', 200)], edges: [E('a', 'next', 'b'), E('b', 'next', 'a')] };
  const s = analyzeStructure(flow);
  ok(s.ok === false && s.issues.some((i) => i.kind === 'no-entry'), '无起点 = error');
}

// 8) 节点类型未知：给出明确问题而不是崩
{
  const flow = { nodes: [N('u', 'no-such-type', 0)], edges: [] };
  const s = analyzeStructure(flow);
  ok(s.issues.some((i) => i.kind === 'unknown-type'), '未知类型被抓出');
}

// 9) 空流程不报警
{
  const s = analyzeStructure({ nodes: [], edges: [] });
  ok(s.issues.length === 0 && s.counts.nodes === 0, '空画布不产生问题');
}

// 10) 签名稳定
{
  const a = { nodes: [N('n1', 'http', 0)], edges: [] };
  ok(structureSignature(analyzeStructure(a)) === structureSignature(analyzeStructure(a)), '同一结构签名稳定');
}

// 11) 每种节点都声明了出口，且分析不遗漏
{
  const missing = Object.keys(STEP_TYPES).filter((t) => !Array.isArray(STEP_TYPES[t].outputs) || !STEP_TYPES[t].outputs.length);
  ok(missing.length === 0, `所有节点类型都声明出口（${missing.join(',') || '无'}）`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
