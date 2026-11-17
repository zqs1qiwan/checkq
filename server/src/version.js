/**
 * 版本号唯一来源：server/package.json。
 * API 响应（/api/health、/api、备份文件）、OpenAPI、HAR 导出都从这里取，
 * 不要在其它运行时代码里写具体版本号：发版时只改三处 package.json 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
export const VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
