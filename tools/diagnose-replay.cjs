#!/usr/bin/env node
/**
 * 诊断规则回放（P0-3 护栏）
 *
 * 每条 fixture 是一次真实的失败运行切片（已脱敏），声明期望命中的规则与原因片段。
 * 规则改动必须同步 fixture：任何一条规则被改坏，这里立刻变红。
 *
 * 用法：node tools/diagnose-replay.cjs        （有失败 exit 1）
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'server', 'test', 'fixtures', 'diagnose');

const main = async () => {
  const { diagnose, hasBannedWording, ACTIONS, RULES } = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'diagnose.js')).href);
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  const problems = [];
  let checked = 0;

  for (const file of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const d = diagnose({ run: fx.run, flow: fx.flow });
    checked++;
    const label = `${file}`;
    if (!d) { problems.push(`${label}: 期望诊断但返回 null`); continue; }
    if (fx.expect?.rule && d.rule !== fx.expect.rule) problems.push(`${label}: 规则 ${d.rule} ≠ 期望 ${fx.expect.rule}`);
    for (const frag of fx.expect?.causeIncludes || []) {
      if (!d.cause.includes(frag)) problems.push(`${label}: 原因缺少「${frag}」（实际：${d.cause}）`);
    }
    if (!RULES.includes(d.rule)) problems.push(`${label}: 未登记的规则 ${d.rule}`);
    if (hasBannedWording(d)) problems.push(`${label}: 出现无法验证的措辞（可能/也许/大概）`);
    for (const a of d.actions || []) {
      if (!ACTIONS[a.type]) problems.push(`${label}: 动作 ${a.type} 不在白名单`);
      if (!a.label) problems.push(`${label}: 动作 ${a.type} 缺少按钮文案`);
    }
    if (d.confidence === 'low' && (d.actions || []).length) problems.push(`${label}: 低置信不该给动作按钮`);
    // 证据里不得出现原始凭据字面值
    const ev = JSON.stringify(d.evidence || []);
    if (/qsid=|cookie:\s*c=|Authorization:\s*Bearer\s+\S+/i.test(ev)) problems.push(`${label}: 证据含未脱敏凭据`);
  }

  // 成功运行不产生诊断
  const okRun = { status: 'success', logs: [{ stepId: 'n1', index: 1, name: 'a', type: 'log', ok: true, message: 'ok' }] };
  if (diagnose({ run: okRun, flow: { name: 'x' } }) !== null) problems.push('成功运行不应产生诊断');

  console.log(`回放 ${checked} 条 fixture，规则集 ${RULES.length} 条`);
  if (!problems.length) {
    console.log('✓ 诊断回放通过：规则命中与文案护栏均符合');
    process.exit(0);
  }
  console.log(`发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
