/**
 * 运行日志 / 导出内容的统一脱敏（纯函数）
 *
 * 原则：
 * - 执行过程中的 vars、last、cookie 罐保持原值，提取链不受影响；
 * - 只在「写盘 / SSE / 备份 / 模板导出」出口复制并脱敏；
 * - 已知敏感变量值、常见凭据头、URL userinfo/敏感 query、表单与 JSON 敏感字段都要覆盖。
 */
import { isSensitiveName } from './sensitive-name.js';

const PLACEHOLDER = '***';

const SENSITIVE_HEADERS = new Set([
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization',
  'x-api-key', 'api-key', 'x-auth-token', 'x-access-token',
  'x-csrf-token', 'x-xsrf-token', 'x-session-id', 'x-sessionid',
]);

const SENSITIVE_KEYS = /^(?:cookie|set-cookie|authorization|proxy-authorization|api[-_]?key|x-api-key|x-auth-token|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|token|password|passwd|pwd|secret|client[-_]?secret|session|sessionid|session_id|sid|csrf|xsrf|jwt|bearer)$/i;

const INLINE_SECRET = /((?:cookie|set-cookie|authorization|proxy-authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|password|passwd|secret|sessionid|session_id)\s*[:=]\s*)([^\s,;&]+)/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/=-]+/gi;

function isSensitiveHeader(name) {
  return SENSITIVE_HEADERS.has(String(name || '').toLowerCase());
}

function isSensitiveKey(key) {
  return isSensitiveName(key) || SENSITIVE_KEYS.test(String(key || ''));
}

/** 从运行变量中收集需要在整个日志里替换的值（只收敏感名或明显像凭据的值） */
export function collectSecrets(vars) {
  const out = new Set();
  if (!vars || typeof vars !== 'object') return out;
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    if (!(isSensitiveName(k) || isSensitiveKey(k))) continue;
    for (const s of flattenStrings(v)) addSecret(out, s);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** 收集请求和响应凭据头及会话 Cookie，供整次运行的输出脱敏。 */
export function trackHttpCredentials(secrets, headers, setCookies = []) {
  for (const [name, value] of Object.entries(headers)) {
    if (!isSensitiveHeader(name) && !isSensitiveKey(name)) continue;
    addSecret(secrets, value);
    if (name === 'cookie') {
      for (const pair of String(value).split(';')) trackCookieValue(secrets, pair);
    } else if (name.endsWith('authorization')) {
      addSecret(secrets, String(value).replace(/^\S+\s+/, ''));
    }
  }
  for (const cookie of setCookies) {
    trackCookieValue(secrets, String(cookie).split(';', 1)[0]);
  }
}

/** 将请求参数中的已识别凭据纳入运行输出脱敏。 */
export function trackHttpUrlCredentials(secrets, url) {
  let target;
  try { target = new URL(url); } catch { /* 地址由执行器校验 */ }
  if (target) {
    for (const value of [target.username, target.password]) {
      addSecret(secrets, value);
      try { addSecret(secrets, decodeURIComponent(value)); } catch { /* 保留原编码值 */ }
    }
    trackSensitiveParams(secrets, target.searchParams);
  }
}

/** 跟踪请求或响应体中的敏感字段，接受执行器已解析的 JSON。 */
export function trackHttpBodyCredentials(secrets, body, contentType = '') {
  if (body && typeof body === 'object') {
    trackSensitiveFields(secrets, body);
    return;
  }
  if (typeof body !== 'string' || !body) return;
  const type = contentType.toLowerCase();
  if (type.includes('json') || /^[\[{]/.test(body.trimStart())) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return; }
    trackSensitiveFields(secrets, parsed);
  } else if (type.includes('x-www-form-urlencoded') || /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body)) {
    trackSensitiveParams(secrets, new URLSearchParams(body));
  }
}

function trackSensitiveParams(secrets, params) {
  for (const [name, value] of params) {
    if (isSensitiveKey(name)) addSecret(secrets, value);
  }
}

function trackSensitiveFields(secrets, object, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 8) return;
  for (const [name, value] of Object.entries(object)) {
    if (isSensitiveKey(name)) {
      for (const item of flattenStrings(value)) addSecret(secrets, item);
    } else {
      trackSensitiveFields(secrets, value, depth + 1);
    }
  }
}

function trackCookieValue(secrets, pair) {
  const index = pair.indexOf('=');
  if (index >= 0) addSecret(secrets, pair.slice(index + 1).trim().replace(/^"(.*)"$/, '$1'));
}

function flattenStrings(v, depth = 0) {
  if (depth > 4 || v === null || v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  if (Array.isArray(v)) return v.flatMap((x) => flattenStrings(x, depth + 1));
  if (typeof v === 'object') return Object.values(v).flatMap((x) => flattenStrings(x, depth + 1));
  return [];
}

function addSecret(set, value) {
  const s = String(value || '');
  // 太短的值容易误伤普通文本；cookie/token 实际都远长于 6 位
  if (s.length < 6) return;
  if (set.has(s)) return;
  set.add(s);
  if (/^[\w.*-]+$/.test(s)) return;
  for (const encoded of [encodeURIComponent(s.toWellFormed()), new URLSearchParams({ v: s }).toString().slice(2)]) {
    set.add(encoded);
    set.add(encoded.replace(/%[A-F0-9]{2}/g, (part) => part.toLowerCase()));
  }
}

export function redactKnownValues(text, secrets) {
  for (const secret of secrets || []) {
    if (secret && text.includes(secret)) text = text.split(secret).join(PLACEHOLDER);
  }
  return text;
}

/** 替换已知敏感值，并兜住常见 `cookie=...` / `Bearer ...` 形式 */
export function redactText(value, secrets = []) {
  let s = redactKnownValues(String(value ?? ''), secrets);
  s = s.replace(INLINE_SECRET, `$1${PLACEHOLDER}`);
  s = s.replace(BEARER, `Bearer ${PLACEHOLDER}`);
  return s;
}

/** 模型输入只接受任务描述，发现凭据形态时由调用方拒绝发送。 */
export function hasAiInputCredentials(text, secrets = []) {
  const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  });
  const inputs = decoded === text ? [text] : [text, decoded];
  const isCredentialField = (name) => isSensitiveHeader(name) || isSensitiveKey(name)
    || /^(?:密码|口令|令牌|sig|signature|x-amz-signature|x-goog-signature)$/i.test(name);
  return inputs.some((input) => {
    if (secrets.some((secret) => secret && input.includes(secret))) return true;
    if (/\bBearer\s+[\w.~+/=-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(input)) return true;
    const fields = input.matchAll(/([\w-]+|密码|口令|令牌)["']?\s*[:=：]\s*["']?([^\s"'&,;}]+)/g);
    for (const [, name] of fields) {
      if (isCredentialField(name)) return true;
    }
    for (const [, name] of input.matchAll(/["']name["']\s*:\s*["']([^"']+)["']/gi)) {
      if (isCredentialField(name)) return true;
    }
    if (/\bcurl\b/i.test(input) && /\s(?:-[bu]\S|-[bu]\s+\S|--(?:cookie|user)(?:=|\s+)\S)/i.test(input)) return true;
    for (const [candidate] of input.matchAll(/https?:\/\/[^\s<>"'，。；]+/gi)) {
      try {
        const url = new URL(candidate);
        if (url.username || url.password || [...url.searchParams.keys()].some(isCredentialField)) return true;
      } catch { /* 普通描述可以包含不完整链接 */ }
    }
    return false;
  });
}

/** 脱敏 URL：userinfo、敏感 query 参数、已知变量值 */
export function redactUrl(value, secrets = []) {
  const input = String(value ?? '');
  if (!input) return input;
  try {
    const u = new URL(input);
    if (u.username) u.username = PLACEHOLDER;
    if (u.password) u.password = PLACEHOLDER;
    for (const part of ['pathname', 'hash']) {
      const masked = redactKnownValues(u[part], secrets);
      if (masked !== u[part]) u[part] = masked;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitiveKey(key)) u.searchParams.set(key, PLACEHOLDER);
      else {
        const val = u.searchParams.get(key);
        if (val) u.searchParams.set(key, redactText(val, secrets));
      }
    }
    return u.toString();
  } catch {
    return redactText(input, secrets);
  }
}

export function redactHeaders(headers, secrets) {
  if (!headers || typeof headers !== 'object') return headers;
  if (Array.isArray(headers)) {
    return headers.map((h) => {
      if (!h || typeof h !== 'object') return redactText(h, secrets);
      const out = { ...h };
      const name = String(h.name || '').trim();
      if (isSensitiveHeader(name) || isSensitiveKey(name)) out.value = PLACEHOLDER;
      else if (typeof out.value === 'string') out.value = redactText(out.value, secrets);
      return out;
    });
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveHeader(k) || isSensitiveKey(k)) out[k] = PLACEHOLDER;
    else out[k] = typeof v === 'string' ? redactText(v, secrets) : v;
  }
  return out;
}

/** 脱敏 JSON / 表单 body；解析失败时按文本处理 */
export function redactBody(body, contentType = '', secrets = []) {
  if (body === null || body === undefined) return body;
  if (typeof body !== 'string') return redactDeep(body, secrets);
  const text = body;
  if (!text) return text;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('json') || /^[\[{]/.test(text.trim())) {
    try {
      const parsed = JSON.parse(text);
      return JSON.stringify(redactDeep(parsed, secrets));
    } catch {
      return redactText(text, secrets);
    }
  }
  if (ct.includes('x-www-form-urlencoded') || /^[^=&]+=[^&]*(?:&[^=&]+=[^&]*)*$/.test(text)) {
    try {
      const params = new URLSearchParams(text);
      for (const key of [...params.keys()]) {
        if (isSensitiveKey(key)) params.set(key, PLACEHOLDER);
        else if (params.get(key)) params.set(key, redactText(params.get(key), secrets));
      }
      return params.toString();
    } catch {
      return redactText(text, secrets);
    }
  }
  return redactText(text, secrets);
}

/** 深度脱敏对象；按字段名与已知值双重判断 */
export function redactDeep(value, secrets = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, secrets);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((x) => redactDeep(x, secrets, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveHeader(k) || isSensitiveKey(k)) out[k] = PLACEHOLDER;
    else out[k] = redactDeep(v, secrets, depth + 1);
  }
  return out;
}

/**
 * 脱敏一条 StepLog（返回新对象，不改执行内部状态）。
 * detail 里 URL、请求/响应 headers、body、Set-Cookie、proxy 全部覆盖。
 */
export function redactLogEntry(entry, secrets = [], responseBodyLimit) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if (out.message) out.message = redactText(out.message, secrets);
  if (out.finalMessage) out.finalMessage = redactText(out.finalMessage, secrets);
  if (Array.isArray(out.keywords)) {
    out.keywords = out.keywords.map((kw) => ({
      ...kw,
      values: Array.isArray(kw.values) ? kw.values.map((v) => redactText(v, secrets)) : [],
    }));
  }
  if (Array.isArray(out.asserts)) {
    out.asserts = out.asserts.map((a) => redactDeep(a, secrets));
  }
  if (out.detail && typeof out.detail === 'object') {
    const d = { ...out.detail };
    if (d.url) d.url = redactUrl(d.url, secrets);
    if (d.proxy) d.proxy = redactUrl(d.proxy, secrets);
    if (d.headers) d.headers = redactHeaders(d.headers, secrets);
    if (d.body !== undefined) {
      d.body = redactBody(d.body, d.headers?.['content-type'] || d.contentType || '', secrets);
    }
    if (d.response && typeof d.response === 'object') {
      const r = { ...d.response };
      if (r.headers) r.headers = redactHeaders(r.headers, secrets);
      if (Array.isArray(r.setCookie)) r.setCookie = r.setCookie.map(() => PLACEHOLDER);
      if (r.body !== undefined) {
        const raw = r.body;
        r.body = responseBodyLimit === 0 ? '' : redactBody(raw, r.headers?.['content-type'] || '', secrets);
        if (responseBodyLimit !== undefined && typeof r.body === 'string' && r.body.length > responseBodyLimit) {
          r.body = r.body.slice(0, responseBodyLimit) + `… (${raw.length} bytes)`;
        }
      }
      d.response = r;
    }
    out.detail = d;
  }
  return out;
}

/** 备份/导出时，把 run 只保留审计需要、且不含原始日志详情的字段 */
export function redactRunForExport(run, secrets = []) {
  if (!run || typeof run !== 'object') return run;
  const {
    id, flowId, flowName, trigger, startedAt, finishedAt, durationMs,
    status, finalMessage, summary, attempt, maxAttempts, recovered,
  } = run;
  return {
    id, flowId, trigger, startedAt, finishedAt, durationMs,
    flowName: typeof flowName === 'string' ? redactKnownValues(flowName, secrets) : flowName,
    status,
    finalMessage: finalMessage ? redactText(finalMessage, secrets) : '',
    summary: summary ? redactText(summary, secrets) : '',
    attempt, maxAttempts, recovered,
    logs: (run.logs || []).map((l) => ({
      stepId: l.stepId,
      index: l.index,
      name: typeof l.name === 'string' ? redactKnownValues(l.name, secrets) : l.name,
      type: l.type,
      ok: l.ok !== false,
      message: redactText(l.message || '', secrets),
      ms: l.ms || 0,
    })),
  };
}
