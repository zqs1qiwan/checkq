#!/usr/bin/env node
/**
 * 把 web/dist 同步到 server/public（服务端静态目录，.gitignore 忽略）。
 *
 * 为什么需要：`npm run build` 只产出 web/dist，服务端却从 server/public 提供前端；
 * 不同步就会「页面还是上一版」——冒烟测到的是旧 UI，护栏等于没测。
 * `tools/verify-round.cjs` 已自动调用本脚本；单独跑 ui-smoke 前也请先跑一次。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'web', 'dist');
const DST = path.join(ROOT, 'server', 'public');

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error('✗ web/dist 不存在，先运行 npm run build');
  process.exit(1);
}

fs.mkdirSync(DST, { recursive: true });
// assets 用内容哈希命名，旧文件留着只会让目录越来越大
fs.rmSync(path.join(DST, 'assets'), { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });

const files = fs.readdirSync(path.join(DST, 'assets')).length;
console.log(`✓ 前端产物已同步：web/dist → server/public（assets ${files} 个文件）`);
