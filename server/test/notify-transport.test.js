import assert from 'node:assert';
import { sendChannel, sendToChannels, signBotUrl, SUMMARY_CHANNEL_TYPES } from '../src/notify.js';

assert.ok(SUMMARY_CHANNEL_TYPES.has('feishu'));
assert.ok(SUMMARY_CHANNEL_TYPES.has('inbox'));

// 站内通知：通过注入的 inbox 回调落库，返回结构统一
const got = [];
const results = await sendToChannels(
  [{ type: 'inbox', title: '每日汇总' }, { type: 'unknown-type' }],
  '正文',
  { title: '每日汇总', flowId: null, flowName: '', status: 'success' },
  { inbox: (p) => got.push(p) },
);
assert.strictEqual(results.length, 2);
assert.strictEqual(results[0].ok, true);
assert.strictEqual(results[1].ok, false);
assert.strictEqual(got.length, 1);
assert.strictEqual(got[0].title, '每日汇总');
assert.strictEqual(got[0].content, '正文');

// 缺少 inbox 注入时，不能假装发送成功
const noDeps = await sendChannel({ type: 'inbox' }, 'x');
assert.strictEqual(noDeps.ok, false);

// 钉钉/飞书签名：只在有 secret 时追加 timestamp/sign
assert.strictEqual(signBotUrl({ url: 'https://example.com/hook' }), 'https://example.com/hook');
const signed = signBotUrl({ url: 'https://example.com/hook?x=1', secret: 's3cret' });
assert.ok(signed.startsWith('https://example.com/hook?x=1&timestamp='));
assert.ok(signed.includes('&sign='));

console.log('notify-transport: 9 checks passed');
