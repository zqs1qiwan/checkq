/**
 * script 节点的隔离子进程。
 *
 * 为什么单独进程：
 * - 主进程持有凭据、存储、网络与调度能力，不能把宿主对象注入 vm 让脚本摸到 process/require。
 * - 子进程只通过 stdin 收一份 JSON 快照，stdout 只回一份 JSON 结果；父进程用超时与内存上限兜底。
 * - 子进程由 `--permission` 启动，没有 fs/child_process/worker 权限；vm 不注入任何宿主函数或对象。
 *
 * 这里不是“完整浏览器级沙箱”，但把脚本能触达的范围收敛到自己的输入与纯计算。
 */
const vm = require('node:vm');

const MAX_CODE = 64 * 1024;
const MAX_INPUT = 4 * 1024 * 1024;
const MAX_RESULT = 256 * 1024;
const MAX_TIMEOUT = 3000;

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(message || '脚本执行失败') }));
  process.exit(0);
}

function run(payload) {
  const code = String(payload.code || '');
  if (!code.trim()) return fail('脚本为空');
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE) return fail('脚本超过 64KB 上限');

  const timeout = Math.min(MAX_TIMEOUT, Math.max(100, Number(payload.timeoutMs) || 1000));
  const ctx = vm.createContext(Object.create(null), {
    name: 'checkq-script',
    codeGeneration: { strings: false, wasm: false },
  });

  // 用 JSON 字面量在上下文内部构造对象，避免把宿主对象/函数带进沙箱。
  const setup = [
    `globalThis.vars = ${JSON.stringify(payload.vars || {})};`,
    `globalThis.last = ${JSON.stringify(payload.last || null)};`,
    `globalThis.steps = ${JSON.stringify(payload.steps || {})};`,
    'globalThis.console = { log() {}, warn() {}, error() {} };',
  ].join('\n');
  vm.runInContext(setup, ctx, { timeout: 1000 });

  let serializedOut = '';
  try {
    serializedOut = vm.runInContext(`(() => {\n"use strict";\nconst __r = (() => {\n${code}\n})();\nif (!__r || typeof __r !== 'object' || Array.isArray(__r)) return '';\nreturn JSON.stringify(__r);\n})()`, ctx, { timeout });
  } catch (err) {
    const msg = err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      ? `脚本执行超时（>${timeout}ms）`
      : `脚本异常: ${(err && err.message) || err}`;
    return fail(msg);
  }

  const result = {};
  if (serializedOut) {
    let parsed;
    try { parsed = JSON.parse(serializedOut); } catch { return fail('脚本返回值无法序列化'); }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        result[k] = v;
      }
    }
  }
  const text = JSON.stringify({ ok: true, out: result });
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT) return fail('脚本返回值超过 256KB 上限');
  process.stdout.write(text, () => process.exit(0));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT) fail('脚本输入超过上限');
});
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    return fail('脚本运行器输入不是合法 JSON');
  }
  try {
    run(payload);
  } catch (err) {
    fail(`脚本运行器异常: ${(err && err.message) || err}`);
  }
});
