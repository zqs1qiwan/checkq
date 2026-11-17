/**
 * 诊断纯函数（P0-3）：优先级、脱敏、无禁用措辞
 * 运行：node server/test/diagnose.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, diagnosisText, redactText, redactUrl, hasBannedWording, ACTIONS, RULES } from '../src/diagnose.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = fs.readdirSync(path.join(here, 'fixtures', 'diagnose'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'diagnose', f), 'utf8')) }));

for (const fx of fixtures) {
  const d = diagnose({ run: fx.run, flow: fx.flow });
  ok(!!d, `${fx.file}：产生诊断`);
  ok(d?.rule === fx.expect.rule, `${fx.file}：规则 = ${fx.expect.rule}`);
  for (const frag of fx.expect.causeIncludes || []) ok(d?.cause.includes(frag), `${fx.file}：原因含「${frag}」`);
  ok(!hasBannedWording(d), `${fx.file}：无「可能/也许」类措辞`);
}

// 优先级：缺变量先于网络失败
{
  const run = { status: 'failed', logs: [{ stepId: 'n1', index: 1, name: '请求', type: 'http', ok: false, errorType: 'network', message: 'fetch failed', missing: ['token'], detail: {} }] };
  const d = diagnose({ run });
  ok(d.rule === 'missing-var', '缺变量优先于网络错误');
  ok(d.actions.some((a) => a.type === 'edit-vars' && a.vars.includes('token')), '动作带上变量名');
}

// 4xx 且无挑战特征：判为请求被拒
{
  const run = { status: 'failed', logs: [{ stepId: 'n1', index: 1, name: '请求', type: 'http', ok: false, errorType: 'assert', asserts: [{ expr: 'last.status', expect: 200, actual: 404, pass: false }], detail: { response: { status: 404, headers: {}, body: 'not found' } } }] };
  const d = diagnose({ run });
  ok(d.rule === 'client-error', '404 = 请求被拒（不是断言问题）');
  ok(d.cause.includes('404'), '原因带状态码');
}

// 成功运行无诊断
ok(diagnose({ run: { status: 'success', logs: [] } }) === null, '成功运行返回 null');
ok(diagnose({}) === null, '空输入返回 null');

// 低置信不给按钮
{
  const d = diagnose({ run: { status: 'failed', finalMessage: '莫名失败', logs: [] } });
  ok(d.rule === 'unknown' && d.confidence === 'low', '无线索 = unknown + low');
  ok(d.actions.length === 0, '低置信不给动作按钮');
}

// 文案不含凭据
{
  const d = diagnose({ run: { status: 'failed', logs: [{ stepId: 'n1', index: 1, name: '请求', type: 'http', ok: false, errorType: 'assert', detail: { response: { status: 200, headers: {}, body: 'cookie: abc123secretvalue; token=zzz999' } } }] } });
  const text = diagnosisText(d, { flow: { name: 't' } });
  ok(!text.includes('abc123secretvalue') && !text.includes('zzz999'), '摘要抹掉凭据字面值');
  ok(text.includes('原因：'), '摘要含原因行');
}

ok(redactUrl('https://a.b/c?token=abc&x=1').includes('token=***'), 'URL 查询值打码');
ok(redactText('x'.repeat(300), 20).length <= 21, '长文本截断');
ok(Object.keys(ACTIONS).length === 4, '动作白名单 4 种');
ok(RULES.length >= 6, '规则集已登记');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
