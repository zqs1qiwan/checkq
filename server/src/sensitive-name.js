/**
 * 「变量名是否敏感」判定：服务端存储/导出与前端遮蔽共用同一份实现。
 * 纯函数、无 node 内置依赖，可被 vite 直接打包（与 text-regex.js 同模式）。
 */
export function isSensitiveName(name) {
  return /cookie|token|sess|auth|password|passwd|secret|api[_-]?key|credential|jwt|bearer|refresh/i.test(String(name || ''));
}
