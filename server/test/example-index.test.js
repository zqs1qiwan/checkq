/**
 * 随包示例索引必须能通过自己的解析器：version=1、字段齐全、sha256 与内联模板对得上。
 * 这个测试的价值在于——示例文件是给人抄格式用的，抄错格式的人会先抄到它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIndex, resolveEntry, sha256, stableJson } from '../src/market.js';

const path = new URL('../../docs/template-index.example.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

test('示例索引：version=1 且能被 parseIndex 接受', () => {
  const parsed = parseIndex(data, 'file://example');
  assert.equal(parsed.ok, true, parsed.errors?.join('；'));
  assert.ok(parsed.entries.length >= 1);
  assert.equal(parsed.name, data.name);
});

test('示例索引：每条都有 sha256 / tags / vars 声明', () => {
  const parsed = parseIndex(data, 'file://example');
  for (const e of parsed.entries) {
    assert.match(e.sha256, /^[0-9a-f]{64}$/, `sha256 格式不对：${e.id}`);
    assert.ok(e.tags.length <= 8, `tags 越界：${e.id}`);
    assert.ok(Array.isArray(e.vars), `vars 缺失：${e.id}`);
    assert.ok(e.inline || e.templateUrl, `既没有内联也没有地址：${e.id}`);
  }
});

test('示例索引：内联模板的 sha256 与声明一致', () => {
  for (const e of data.entries.filter((x) => x.template)) {
    assert.equal(sha256(e.template), e.sha256, `哈希不符：${e.id}`);
  }
});

test('示例索引：sha256 按规范化 JSON 计算（键序无关）', () => {
  const a = sha256({ b: 1, a: [2, { d: 4, c: 3 }] });
  const b = sha256({ a: [2, { c: 3, d: 4 }], b: 1 });
  assert.equal(a, b);
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('示例索引：resolveEntry 能校验通过并给出模板', async () => {
  const parsed = parseIndex(data, 'file://example');
  const resolved = await resolveEntry(parsed.entries[0]);
  assert.equal(resolved.ok, true, resolved.errors?.join('；'));
  assert.equal(resolved.template.name, data.entries[0].name);
  assert.equal(resolved.hasScript, false);
});
