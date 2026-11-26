/**
 * 敏感凭据静态加密（v0.4.3）
 * 借鉴：qiandao（任务 env 用用户密钥 AES 加密入库）、qinglong（明文 DB + 明文 .env，我们做得更严）
 *
 * - 算法：AES-256-GCM（带认证标签，防止密文被篡改后仍被解密）
 * - 密钥：环境变量 CHECKQ_SECRET 优先；否则首次启动生成 data/.secret（权限 600，永不入库/不进备份）
 * - 格式：enc:v1:<base64(iv|tag|cipher)>
 * - 迁移：磁盘上的旧明文值会被识别并原样读出，写回时自动加密（渐进迁移）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSensitiveName } from './sensitive-name.js';
import {
  collectSecrets, redactBody, redactDeep, redactHeaders, redactKnownValues, redactText, redactUrl,
  trackHttpBodyCredentials, trackHttpCredentials, trackHttpUrlCredentials,
} from './redact.js';

export { isSensitiveName };

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const ENCRYPTED_NODE_TYPES = new Set(['http', 'notify']);

/** 取（或生成）数据加密密钥 */
export function secretKey(dataDir) {
  const fromEnv = process.env.CHECKQ_SECRET;
  if (fromEnv && fromEnv.length >= 8) {
    return crypto.createHash('sha256').update(String(fromEnv)).digest();
  }
  const file = path.join(dataDir, '.secret');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('密钥文件必须是 64 位十六进制');
    return Buffer.from(hex, 'hex');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (e) {
    throw new Error(`无法保存 data/.secret，已停止启动以避免重启后凭据丢失：${e.message}`, { cause: e });
  }
  console.log('[CheckQ] 已生成 data/.secret（600 权限）：敏感凭据（cookie/token/密码）静态加密存储');
  return key;
}

export function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

export function encryptValue(key, plain) {
  if (plain === undefined || plain === null) return plain;
  const s = String(plain);
  if (!s || isEncrypted(s)) return s;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, body]).toString('base64');
}

export function decryptValue(key, stored) {
  if (!isEncrypted(stored)) return stored; // 旧明文，渐进迁移
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const body = raw.subarray(IV_LEN + TAG_LEN);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return ''; // 密钥变更/密文损坏：返回空而不是密文，避免泄露
  }
}

/** 值是否长得像凭据（cookie / JWT / 长 base64） */
export function looksSensitiveValue(v) {
  const s = String(v || '');
  if (s.length < 24) return false;
  if (/=(sess|session|token|auth|jwt)/i.test(s)) return true;
  if (/^eyJ[A-Za-z0-9_-]{10,}\./.test(s)) return true;       // JWT
  if (/^[A-Za-z0-9_-]{40,}$/.test(s)) return true;            // 长 base64/hex
  if (/\b(gld|sess|sid|uid|auth)[=:;]/.test(s)) return true; // cookie 串
  return false;
}

/** 渠道里需要加密的字段 */
export const SENSITIVE_CHANNEL_FIELDS = new Set(['token', 'key', 'pass', 'password', 'secret', 'url', 'user', 'chat_id', 'chatid']);

/** 加密一组通知渠道（系统渠道 channels.json 与任务渠道共用） */
export function encryptChannels(key, channels) {
  if (!Array.isArray(channels)) return channels;
  return channels.map((c) => {
    const cc = { ...c };
    for (const [k, v] of Object.entries(cc)) {
      if (SENSITIVE_CHANNEL_FIELDS.has(String(k).toLowerCase()) && typeof v === 'string' && v) {
        cc[k] = encryptValue(key, v);
      }
    }
    return cc;
  });
}

/** 解密一组通知渠道 */
export function decryptChannels(key, channels) {
  if (!Array.isArray(channels)) return channels;
  return channels.map((c) => {
    const cc = { ...c };
    for (const [k, v] of Object.entries(cc)) {
      if (isEncrypted(v)) cc[k] = decryptValue(key, v);
    }
    return cc;
  });
}

/** 脱敏一组通知渠道（备份导出用） */
export function maskChannels(channels) {
  if (!Array.isArray(channels)) return channels;
  return channels.map((c) => {
    const cc = { ...c };
    for (const f of SENSITIVE_CHANNEL_FIELDS) {
      if (cc[f]) cc[f] = '***';
    }
    return cc;
  });
}

/**
 * meta.json 里需要静态加密的凭据：
 * - ai.apiKey：AI 助手的模型密钥
 * - apiKey：旧版单条 API Key（兼容字段，实际值等同管理员令牌）
 */
export function encryptMeta(key, meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = { ...meta };
  if (out.apiKey) out.apiKey = encryptValue(key, out.apiKey);
  if (out.ai && typeof out.ai === 'object' && out.ai.apiKey) {
    out.ai = { ...out.ai, apiKey: encryptValue(key, out.ai.apiKey) };
  }
  return out;
}

export function decryptMeta(key, meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = { ...meta };
  if (isEncrypted(out.apiKey)) out.apiKey = decryptValue(key, out.apiKey);
  if (out.ai && typeof out.ai === 'object' && isEncrypted(out.ai.apiKey)) {
    out.ai = { ...out.ai, apiKey: decryptValue(key, out.ai.apiKey) };
  }
  return out;
}

/** 加密一个 flow/template 的敏感部分（返回新对象，不改原对象） */
export function encryptSecrets(key, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  if (out.vars && typeof out.vars === 'object') {
    const vars = {};
    for (const [k, v] of Object.entries(out.vars)) {
      const sensitive = isSensitiveName(k) || looksSensitiveValue(v);
      vars[k] = sensitive ? encryptValue(key, v) : v;
    }
    out.vars = vars;
  }
  if (out.notify && Array.isArray(out.notify.channels)) {
    out.notify = { ...out.notify, channels: encryptChannels(key, out.notify.channels) };
  }
  if (Array.isArray(out.nodes)) {
    out.nodes = out.nodes.map((node) => {
      if (!ENCRYPTED_NODE_TYPES.has(node?.type) || !node.config || typeof node.config !== 'object') return node;
      if (!hasDefinitionCredentials({ nodes: [node] })) return node;
      return { ...node, config: encryptValue(key, JSON.stringify(node.config)) };
    });
  }
  return out;
}

/** 解密一个 flow/template 的敏感部分 */
export function decryptSecrets(key, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  if (out.vars && typeof out.vars === 'object') {
    const vars = {};
    for (const [k, v] of Object.entries(out.vars)) {
      vars[k] = isEncrypted(v) ? decryptValue(key, v) : v;
    }
    out.vars = vars;
  }
  if (out.notify && Array.isArray(out.notify.channels)) {
    out.notify = { ...out.notify, channels: decryptChannels(key, out.notify.channels) };
  }
  if (Array.isArray(out.nodes)) {
    out.nodes = out.nodes.map((node) => {
      if (!ENCRYPTED_NODE_TYPES.has(node?.type) || !isEncrypted(node.config)) return node;
      try {
        const config = JSON.parse(decryptValue(key, node.config));
        if (config && typeof config === 'object' && !Array.isArray(config)) return { ...node, config };
      } catch { /* 无法还原时保留磁盘上的密文，避免启动后覆盖。 */ }
      const label = node.type === 'http' ? 'HTTP' : '通知';
      throw new Error(`无法解密 ${label} 节点配置。请检查 CHECKQ_SECRET 或数据目录中的 .secret 是否与当前数据匹配。`);
    });
  }
  return out;
}

/** 收集变量和 HTTP 节点的凭据，供定义副本与备份摘要脱敏。 */
export function collectDefinitionSecrets(definition) {
  const inline = new Set();
  for (const node of Array.isArray(definition.nodes) ? definition.nodes : []) {
    if (node?.type !== 'http' || !node.config) continue;
    const { headers, url, proxy, body } = node.config;
    let contentType = '';
    for (const header of Array.isArray(headers) ? headers : []) {
      if (!header?.name) continue;
      const name = String(header.name).trim().toLowerCase();
      if (name === 'content-type') contentType = String(header.value || '');
      trackHttpCredentials(inline, { [name]: header.value });
    }
    trackHttpUrlCredentials(inline, url);
    trackHttpUrlCredentials(inline, proxy?.url ?? proxy);
    trackHttpBodyCredentials(inline, body, contentType);
  }
  // 模板引用保留在普通字段中，解析后的实际变量值仍参与脱敏。
  const literals = [...inline].filter((value) => !/\{\{|%7b%7b/i.test(value));
  return [...new Set([...collectSecrets(definition.vars), ...literals])].sort((a, b) => b.length - a.length);
}

/** 导出/备份时的脱敏（保留结构，敏感值替换为占位） */
export function maskSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  const secrets = collectDefinitionSecrets(obj);
  for (const field of ['name', 'desc', 'note', 'group', 'pausedReason']) {
    if (typeof out[field] === 'string') out[field] = redactKnownValues(out[field], secrets);
  }
  if (out.market) out.market = redactDeep(out.market, secrets);
  if (out.vars && typeof out.vars === 'object') {
    const vars = {};
    for (const [k, v] of Object.entries(out.vars)) {
      vars[k] = isSensitiveName(k) || looksSensitiveValue(v) ? '' : (secrets.length ? redactDeep(v, secrets) : v);
    }
    out.vars = vars;
  }
  if (out.notify && Array.isArray(out.notify.channels)) {
    out.notify = { ...out.notify, channels: maskChannels(out.notify.channels) };
    if (typeof out.notify.template === 'string') out.notify.template = redactKnownValues(out.notify.template, secrets);
  }
  if (Array.isArray(out.nodes)) {
    out.nodes = out.nodes.map((n) => maskNode(n, secrets));
  }
  return out;
}

/** 复用脱敏规则识别已有凭据，忽略 URL 和请求体的格式变化。 */
export function hasDefinitionCredentials(definition) {
  const changedToMask = (original, masked) => {
    if (original === masked || original == null || original === '') return false;
    if (masked && typeof masked === 'object') {
      return Object.keys(masked).some((key) => changedToMask(original[key], masked[key]));
    }
    return typeof masked === 'string' && (masked === '' || masked.includes('***') || /%2A%2A%2A/i.test(masked));
  };
  return changedToMask(definition, maskSecrets(definition));
}

/** 节点内联凭据：URL/代理、Cookie/Authorization 头、body、通知节点密钥 */
function maskNode(node, secrets) {
  if (!node || typeof node !== 'object') return node;
  const out = { ...node };
  if (!out.config || typeof out.config !== 'object') return out;
  const config = redactDeep(out.config, secrets);
  if (Array.isArray(config.headers)) {
    config.headers = redactHeaders(config.headers, secrets);
  }
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const contentType = headers.find((h) => String(h?.name || '').toLowerCase() === 'content-type')?.value || '';
  if (typeof config.url === 'string') config.url = redactUrl(config.url, secrets);
  if (typeof config.proxy === 'string') config.proxy = redactUrl(config.proxy, secrets);
  else if (config.proxy && typeof config.proxy === 'object' && typeof config.proxy.url === 'string') {
    config.proxy = { ...config.proxy, url: redactUrl(config.proxy.url, secrets) };
  }
  for (const field of ['webhookUrl', 'barkUrl']) {
    if (typeof config[field] !== 'string' || !config[field]) continue;
    config[field] = node.type === 'notify' ? '***' : redactUrl(config[field], secrets);
  }
  if (config.body !== undefined) config.body = redactBody(config.body, contentType, secrets);
  if (typeof config.text === 'string') config.text = redactText(config.text, secrets);
  if (Array.isArray(config.channels)) config.channels = maskChannels(config.channels);
  // 兼容旧 notify 节点的单字段目标
  for (const key of ['tgToken', 'tgChat', 'token', 'chatId', 'password', 'secret']) {
    if (config[key]) config[key] = '***';
  }
  out.config = config;
  return out;
}
