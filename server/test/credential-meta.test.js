import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { Store } from '../src/store.js';

const dir = fs.mkdtempSync(os.tmpdir() + '/cq-meta-secret-');
const aiKey = 'sk-test-meta-secret-123456';
const legacyKey = 'legacy-admin-key-abcdef';

fs.writeFileSync(`${dir}/meta.json`, JSON.stringify({ ai: { baseUrl: 'https://api.example.com', model: 'm', apiKey: aiKey }, apiKey: legacyKey }));
const store = new Store(dir);

assert.strictEqual(store.meta.ai.apiKey, aiKey, '内存里应解密为明文');
assert.strictEqual(store.meta.apiKey, legacyKey, '旧 API Key 内存里应解密');

store.flush();
await new Promise((r) => setTimeout(r, 600));
const disk = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
assert.ok(String(disk.ai.apiKey).startsWith('enc:v1:'), 'AI Key 落盘必须是密文');
assert.ok(String(disk.apiKey).startsWith('enc:v1:'), '旧 API Key 落盘必须是密文');
assert.ok(!JSON.stringify(disk).includes(aiKey), '磁盘不能出现明文 AI Key');
assert.ok(!JSON.stringify(disk).includes(legacyKey), '磁盘不能出现明文旧 API Key');

const reopened = new Store(dir);
assert.strictEqual(reopened.meta.ai.apiKey, aiKey);
assert.strictEqual(reopened.meta.apiKey, legacyKey);

// 初始密码只打印在日志，不得进入 meta.json
const emptyDir = fs.mkdtempSync(os.tmpdir() + '/cq-meta-fresh-');
process.env.ADMIN_PASSWORD = 'first-run-password';
const fresh = new Store(emptyDir);
fresh.flush();
await new Promise((r) => setTimeout(r, 600));
const freshDisk = fs.readFileSync(`${emptyDir}/meta.json`, 'utf8');
assert.ok(!freshDisk.includes('first-run-password'), '初始密码不能落盘');

console.log('credential-meta: 7 checks passed');
