/**
 * 模板市场 v1（P0-5）：索引协议解析、哈希校验、导入
 *
 * 协议见 docs/TEMPLATE-MARKET.md §3。这里是它的唯一实现点：
 *   - 索引 = 用户自己填的静态 JSON（本框架不托管、不内置官方索引）
 *   - 条目可带 templateUrl，也可内联完整模板；两者都强制 sha256
 *   - sha256 统一按「模板对象规范化 JSON」计算（键排序、无空白、UTF-8），
 *     所以分发方重新格式化文件不会误报不一致
 *
 * 只做三件事：拉取、校验、入库。不执行模板里的任何代码、不自动运行任务。
 */

import crypto from 'node:crypto';
import { validateFlow, STEP_TYPES } from './model.js';

export const MARKET_LIMITS = {
  indexBytes: 1024 * 1024,      // 索引 ≤ 1 MB
  templateBytes: 1024 * 1024,   // 单个模板 ≤ 1 MB
  entries: 500,                 // 条目 ≤ 500
  timeoutMs: 10000,             // 拉取超时 10 秒
};

/** 规范化 JSON：键递归排序、无空白 —— 哈希与"内容等价"判定都基于它 */
export function stableJson(value) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => {
        if (v[k] === undefined) return acc;
        acc[k] = canon(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(canon(value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

const isHttpUrl = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch { return false; }
};

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

/** 拉 JSON（限体积 + 超时），失败给出人话原因 */
export async function fetchJson(url, { maxBytes = MARKET_LIMITS.indexBytes, timeoutMs = MARKET_LIMITS.timeoutMs } = {}) {
  if (!isHttpUrl(url)) throw new Error('地址必须是 http/https');
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new Error(`拉取失败：${e.message}`);
  }
  if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`内容过大（${len} 字节，上限 ${maxBytes}）`);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error(`内容过大（上限 ${Math.round(maxBytes / 1024)} KB）`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回的不是合法 JSON');
  }
}

/** 校验单条变量声明 */
function checkVar(v, at) {
  const errors = [];
  if (!v || typeof v !== 'object') return [`${at}：变量项不是对象`];
  if (!v.name || typeof v.name !== 'string' || /\s/.test(v.name)) errors.push(`${at}：name 必填且不能含空白`);
  if (v.label !== undefined && typeof v.label !== 'string') errors.push(`${at}：label 必须是字符串`);
  if (v.required !== undefined && typeof v.required !== 'boolean') errors.push(`${at}：required 必须是布尔`);
  if (v.sensitive !== undefined && typeof v.sensitive !== 'boolean') errors.push(`${at}：sensitive 必须是布尔`);
  return errors;
}

/**
 * 校验索引对象（不联网）。
 * @param {object} data
 * @param {string} sourceUrl 索引自身地址（写进每条的 source）
 */
export function parseIndex(data, sourceUrl) {
  const errors = [];
  const entries = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['索引不是 JSON 对象'], entries };
  if (data.version !== 1) errors.push(`不支持的协议版本 ${JSON.stringify(data.version)}，请升级 CheckQ`);
  if (!Array.isArray(data.entries)) errors.push('entries 必须是数组');
  else if (data.entries.length > MARKET_LIMITS.entries) errors.push(`条目过多（${data.entries.length} > ${MARKET_LIMITS.entries}）`);

  const seen = new Set();
  const appVersion = process.env.CHECKQ_VERSION || '';

  for (const [i, e] of (Array.isArray(data.entries) ? data.entries : []).entries()) {
    const at = `第 ${i + 1} 条`;
    const local = [];
    if (!e || typeof e !== 'object') { errors.push(`${at}：不是对象`); continue; }
    if (!e.id || typeof e.id !== 'string') local.push(`${at}：id 必填`);
    else if (seen.has(e.id)) local.push(`${at}：id「${e.id}」重复`);
    else seen.add(e.id);
    if (!e.name || typeof e.name !== 'string') local.push(`${at}：name 必填`);
    else if (e.name.length > 100) local.push(`${at}：name 超过 100 字符`);
    if (e.tags !== undefined && (!Array.isArray(e.tags) || e.tags.length > 8)) local.push(`${at}：tags 最多 8 个`);
    if (!Array.isArray(e.vars)) local.push(`${at}：vars 必须显式声明（数组）`);
    else for (const [j, v] of e.vars.entries()) local.push(...checkVar(v, `${at} 变量 ${j + 1}`));
    if (!Number.isFinite(Number(e.nodes))) local.push(`${at}：nodes 必须是节点数量`);
    if (!isHex64(e.sha256)) local.push(`${at}：sha256 必须是 64 位十六进制`);

    const hasInline = Array.isArray(e.nodes_inline) || Array.isArray(e.template?.nodes);
    const hasUrl = e.templateUrl !== undefined;
    if (!hasInline && !hasUrl) local.push(`${at}：templateUrl 与内联模板必须二选一`);
    if (hasUrl && !isHttpUrl(e.templateUrl)) local.push(`${at}：templateUrl 必须是 http/https`);
    if (!e.source && !sourceUrl) local.push(`${at}：缺少 source（来源地址）`);

    if (local.length) { errors.push(...local); continue; }
    entries.push({
      id: e.id,
      name: e.name,
      desc: e.desc || '',
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [],
      vars: e.vars.map((v) => ({ name: v.name, label: v.label || v.name, required: v.required !== false, sensitive: v.sensitive === true })),
      nodes: Number(e.nodes),
      sha256: String(e.sha256).toLowerCase(),
      templateUrl: hasUrl ? e.templateUrl : null,
      inline: hasInline ? (Array.isArray(e.template?.nodes) ? e.template : { nodes: e.nodes_inline, edges: e.edges || [] }) : null,
      minApp: e.minApp || null,
      needsUpdate: !!(e.minApp && appVersion && e.minApp > appVersion),
      updatedAt: e.updatedAt || null,
      source: e.source || sourceUrl,
    });
  }

  return { ok: errors.length === 0, errors, name: data.name || '', updatedAt: data.updatedAt || null, entries };
}

/** 敏感变量名（与导出/加密口径一致） */
const SENSITIVE_RE = /cookie|token|password|secret|key|session|auth/i;

/**
 * 校验并清洗模板（不执行、不运行）。
 * @returns {{ ok: boolean, errors: string[], template?: object, varsCleared: string[] }}
 */
export function checkTemplate(tpl) {
  const errors = [];
  if (!tpl || typeof tpl !== 'object') return { ok: false, errors: ['模板不是对象'], varsCleared: [] };
  if (!tpl.name || typeof tpl.name !== 'string') errors.push('name 必填');
  else if (tpl.name.length > 100) errors.push('name 超过 100 字符');
  if (!Array.isArray(tpl.nodes) || !tpl.nodes.length) errors.push('nodes 必须是非空数组');

  const unknownTypes = [];
  for (const n of Array.isArray(tpl.nodes) ? tpl.nodes : []) {
    if (!STEP_TYPES[n?.type]) unknownTypes.push(n?.type);
  }
  if (unknownTypes.length) errors.push(`不支持的节点类型：${unknownTypes.join('、')}（本版本无法导入）`);

  if (!errors.length) {
    const v = validateFlow({ name: tpl.name, nodes: tpl.nodes, edges: tpl.edges || [], vars: tpl.vars || {} });
    errors.push(...v);
  }

  const vars = { ...(tpl.vars || {}) };
  const varsCleared = [];
  for (const k of Object.keys(vars)) {
    if (SENSITIVE_RE.test(k) && vars[k]) { vars[k] = ''; varsCleared.push(k); }
  }

  return {
    ok: errors.length === 0,
    errors,
    varsCleared,
    template: {
      name: tpl.name,
      desc: tpl.desc || '',
      vars,
      varNames: Array.isArray(tpl.varNames) ? tpl.varNames : Object.keys(vars),
      nodes: tpl.nodes,
      edges: tpl.edges || [],
      log: tpl.log || null,
      hasScript: (tpl.nodes || []).some((n) => n.type === 'script'),
    },
  };
}

/**
 * 取出一条模板（内联直接返回，URL 先拉取），并做哈希校验。
 * @returns {{ ok: boolean, errors: string[], template?: object, varsCleared: string[], sha256: string }}
 */
export async function resolveEntry(entry) {
  let raw;
  if (entry.inline) raw = entry.inline;
  else {
    try { raw = await fetchJson(entry.templateUrl, { maxBytes: MARKET_LIMITS.templateBytes }); } catch (e) { return { ok: false, errors: [e.message] }; }
  }
  const digest = sha256(raw);
  if (digest !== entry.sha256) {
    return { ok: false, errors: [`内容与声明不符（声明 ${entry.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`] };
  }
  const checked = checkTemplate(raw);
  // 顶层也带一份 hasScript：预览/导入两处都要读，避免各自往下钻
  return { ...checked, hasScript: !!checked.template?.hasScript, sha256: digest, fetchedFrom: entry.templateUrl || null };
}

/** 条目 → 预览视图（市场页卡片/预览弹窗用） */
export function previewOf(entry) {
  return {
    id: entry.id,
    name: entry.name,
    desc: entry.desc,
    tags: entry.tags,
    nodeCount: entry.nodes,
    vars: entry.vars,
    hash12: entry.sha256.slice(0, 12),
    source: entry.source,
    templateUrl: entry.templateUrl,
    minApp: entry.minApp,
    needsUpdate: entry.needsUpdate,
    updatedAt: entry.updatedAt,
    inline: !!entry.inline,
  };
}
