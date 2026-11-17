/** 步骤类型定义：直接复用 server/src/model.js 的 STEP_TYPES，避免双事实源 */

import { STEP_TYPES } from '../../server/src/model.js';
import { outputLabel, OUTPUT_LABELS } from '../../server/src/structure.js';

export { STEP_TYPES, outputLabel, OUTPUT_LABELS };

export function defaultConfig(type) {
  switch (type) {
    case 'http':
      return { method: 'GET', url: 'https://', headers: [{ name: 'user-agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', enabled: true }], body: '', asserts: [] };
    case 'condition':
      return { expr: 'last.json.code == 0' };
    case 'set':
      return { name: 'var1', value: '' };
    case 'extract':
      return { from: 'last.text', re: '(.*)', name: 'extracted', optional: true };
    case 'random-delay':
      return { min: 1, max: 5 };
    case 'delay':
      return { seconds: 5 };
    case 'log':
      return { text: '' };
    case 'notify':
      return { text: '', channels: [] };
    case 'script':
      return { code: '// vars / last / steps 只读可用；return { 新变量: 值 } 合并回 vars\nreturn { out: "" };' };
    case 'foreach':
      return { source: 'last.json.items', itemVar: 'item', indexVar: 'index' };
    default:
      return {};
  }
}
