/**
 * DAG 执行器
 * 从入口沿 edges 走，每步产生 StepLog：请求/响应/断言/耗时/错误全量记录。
 * 防环: maxSteps 500。
 */

import { renderTemplate, resolvePath, evalExpr } from './render.js';
import { CookieJar, mergeCookieHeader } from './cookiejar.js';
import { sendToChannels } from './notify.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProxyAgent } from 'undici';
import { fileURLToPath } from 'node:url';
import { collectSecrets, redactDeep, redactLogEntry, redactText, trackHttpBodyCredentials, trackHttpCredentials, trackHttpUrlCredentials } from './redact.js';
import { isSensitiveName } from './sensitive-name.js';
import { parseAllowedOrigin } from './model.js';

const MAX_STEPS = 500;
const HTTP_TIMEOUT = 30000;
const MAX_RESP_BYTES = 2 * 1024 * 1024; // 执行阶段响应体硬上限，超限直接失败（与日志截断是两件事）
const MIN_RESP_BYTES = 64 * 1024;
const MAX_RESP_BYTES_CAP = 8 * 1024 * 1024;

function cancelError() {
  const e = new Error('运行已取消');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelError();
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelError());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

class ResponseLimitError extends Error {
  constructor(limit) {
    super(`响应体超过上限 ${limit} 字节`);
    this.code = 'RESP_TOO_LARGE';
  }
}

/** 流式读取响应体，超过字节上限立即取消读取，避免把超大响应读进内存。 */
async function readBodyWithLimit(resp, limit) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > limit) throw new ResponseLimitError(limit);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new ResponseLimitError(limit);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total);
}

const proxyAgents = new Map(); // proxyUrl -> ProxyAgent（复用连接池）
function getProxyAgent(proxyUrl) {
  let a = proxyAgents.get(proxyUrl);
  if (!a) {
    a = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, a);
  }
  return a;
}

const SCRIPT_RUNNER = fileURLToPath(new URL('./script-runner.cjs', import.meta.url));

/** 在独立、受限的子进程中执行 script 节点；只传 JSON 快照，不注入宿主对象。 */
function runScriptProcess(code, snapshot, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, cancelled: true, error: '运行已取消' });
    const payload = JSON.stringify({
      code,
      vars: snapshot.vars || {},
      last: snapshot.last || null,
      steps: snapshot.steps || {},
      timeoutMs: 1000,
    });
    const env = {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || '',
      TMPDIR: os.tmpdir(),
    };
    let child;
    try {
      child = spawn(process.execPath, [
        '--max-old-space-size=64',
        '--permission',
        `--allow-fs-read=${SCRIPT_RUNNER}`,
        SCRIPT_RUNNER,
      ], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: `脚本运行器启动失败: ${err.message}` });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
      done({ ok: false, cancelled: true, error: '运行已取消' });
    };
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done({ ok: false, error: '脚本执行超时（运行器未响应）' });
    }, 7000);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
    child.on('error', (err) => done({ ok: false, error: `脚本运行器启动失败: ${err.message}` }));
    child.on('close', () => {
      const text = stdout.trim();
      if (!text) {
        return done({ ok: false, error: `脚本运行器无输出${stderr ? `（${stderr.trim().slice(0, 200)}）` : ''}` });
      }
      try {
        const result = JSON.parse(text);
        done(result && typeof result === 'object' ? result : { ok: false, error: '脚本运行器返回格式无效' });
      } catch {
        done({ ok: false, error: '脚本运行器返回格式无效' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

export class Engine {
  constructor(flow) {
    this.flow = flow;
    this.nodeById = new Map((flow.nodes || []).map((n) => [n.id, n]));
    this.edgeBy = new Map();
    for (const e of flow.edges || []) {
      const k = `${e.source}:${e.sourceHandle ?? ''}`;
      if (!this.edgeBy.has(k)) this.edgeBy.set(k, []);
      this.edgeBy.get(k).push(e);
    }
  }

  nextNodeId(fromId, handle) {
    // 同一出口下匹配多条边：优先精确 handle，其次空 handle 边（UI 拖线未带 handle 时）
    const exact = this.edgeBy.get(`${fromId}:${handle}`) || [];
    const blank = this.edgeBy.get(`${fromId}:`) || [];
    const list = exact.length ? exact : (handle === 'failed' ? [] : blank);
    return list.length ? list[0].target : null;
  }

  /** 执行流程。debugStopId: 调试模式，跑到该节点（含）即止。returns { ok, logs, vars, finalMessage } */
  async run({ trigger = 'manual', runId, logSink, debugStopId, debug, signal } = {}) {
    const flow = this.flow;
    const vars = { ...(flow.vars || {}) };
    const credentials = new Set(collectSecrets(vars));
    const currentSecrets = () => {
      for (const secret of collectSecrets(vars)) credentials.add(secret);
      return [...credentials].sort((a, b) => b.length - a.length);
    };
    const state = { vars, last: null, steps: {}, cookieJar: new CookieJar(), signal, credentials, currentSecrets };
    const emit = logSink && ((entry) => logSink(redactLogEntry(entry, currentSecrets(), this.resBodyLimit)));
    const logs = [];
    const missing = new Set();

    // 日志配置（PRD §4.7.4）：level 三档 + include 开关 + resBodyLimit + keywords 关键字规则
    // 低档位（failure/summary）强制忽略 include（见 run 末尾裁剪），include 只在 level=all 生效
    const logCfg = (flow.log && typeof flow.log === 'object') ? flow.log : null;
    const logLevel = logCfg?.level || 'all';
    // 记录范围默认 clean：只留 log 节点（人话）+ 失败步骤；'all' 保留全部步骤
    const logRecord = logCfg?.record || 'log';
    // 流程里根本没有 log 节点时，clean 模式会一条不剩 → 自动退回全步骤（避免"日志空白"）
    const hasLogNode = (flow.nodes || []).some((n) => n && n.type === 'log');
    const effectiveRecord = (logRecord === 'log' || logRecord === 'log-final') && !hasLogNode ? 'all' : logRecord;
    // 调试模式：保留每步请求/响应细节（日常不用，出问题时在日志配置里打开；也可单次运行临时开启）
    const debugMode = logCfg?.debug === true || debug === true;
    const shouldDisplay = (sl) => {
      if (debugMode) return true;
      if (effectiveRecord === 'all') return true;
      if (!sl.ok) return true; // 失败步骤永远保留
      return sl.type === 'log';
    };
    const logInclude = (logCfg?.include && typeof logCfg.include === 'object') ? logCfg.include : {};
    this.logInclude = {
      reqHeaders: logInclude.reqHeaders !== false,
      reqBody: logInclude.reqBody !== false,
      resBody: logInclude.resBody !== false,
      varsSnapshot: logInclude.varsSnapshot !== false,
    };
    const rawLimit = logCfg?.resBodyLimit;
    this.resBodyLimit = rawLimit === undefined || rawLimit === null
      ? 2000
      : Math.min(100000, Math.max(0, Number(rawLimit) || 0));
    const keywords = Array.isArray(logCfg?.keywords) ? logCfg.keywords.filter((k) => k && k.regex) : [];
    const keywordResults = []; // {name, values[]} 汇总

    const entry = this.findEntryNode();
    if (!entry) {
      const empty = (flow.nodes || []).length === 0;
      const msg = empty ? '流程为空：请先在画布上加至少一个节点（如 HTTP 请求）再运行' : '找不到入口节点（可能成环：所有节点都有入线）';
      logs.push({ stepId: null, index: 1, name: '流程', type: 'error', ok: false, message: msg, detail: null, ms: 0 });
      return { ok: false, logs, vars: this.logInclude.varsSnapshot ? vars : {}, finalMessage: msg };
    }

    if (signal?.aborted) {
      const msg = '运行已取消';
      logs.push({ stepId: null, index: 1, name: '流程', type: 'system', ok: false, message: msg, detail: null, ms: 0, cancelled: true });
      return { ok: false, cancelled: true, logs, vars: this.logInclude.varsSnapshot ? vars : {}, finalMessage: msg };
    }

    let node = entry;
    let stepCount = 0;
    let failed = false;
    let finalMessage = '';

    while (node && stepCount < MAX_STEPS) {
      if (signal?.aborted) {
        failed = true;
        finalMessage = '运行已取消';
        const lastLog = {
          stepId: node.id, index: stepCount + 1, name: '运行取消', type: 'system', ok: false,
          message: finalMessage, detail: null, ms: 0, cancelled: true,
        };
        logs.push(lastLog);
        emit?.(lastLog);
        break;
      }
      stepCount++;
      const started = Date.now();
      const stepLog = {
        stepId: node.id,
        index: stepCount,
        name: node.name || node.type,
        type: node.type,
        ok: true,
        message: '',
        detail: null,
        ms: 0,
      };
      try {
        const outcome = await this.execNode(node, state, stepLog, missing, logs, emit);
        stepLog.ms = Date.now() - started;
        logs.push(stepLog);
        if (emit && shouldDisplay(stepLog)) emit(stepLog);
        if (missing.size) {
          stepLog.missing = [...missing];
          missing.clear();
        }

        // 关键字规则提取（PRD §4.7.4）：对每步 HTTP 响应尝试 keywords
        if (keywords.length && stepLog.type === 'http' && state.last) {
          for (const kw of keywords) {
            if (kw.stepId && kw.stepId !== node.id) continue;
            try {
              const source = kw.from === 'headers'
                ? JSON.stringify(state.last.headers || {})
                : kw.from === 'status'
                  ? String(state.last.status ?? '')
                  : String(state.last.text ?? '');
              const re = new RegExp(kw.regex, 'g');
              const values = [];
              let m;
              while ((m = re.exec(source)) !== null) {
                values.push(m.length > 1 ? m[1] : m[0]);
                if (values.length >= 20) break; // 防失控
                if (m.index === re.lastIndex) re.lastIndex++;
              }
              if (values.length) {
                stepLog.keywords = stepLog.keywords || [];
                stepLog.keywords.push({ name: kw.name, values });
                const agg = keywordResults.find((r) => r.name === kw.name);
                if (agg) agg.values.push(...values);
                else keywordResults.push({ name: kw.name, values });
              }
            } catch { /* 非法正则：跳过（编辑器已即时校验） */ }
          }
        }

        // level 三档：运行结束后统一裁剪（在 run 末尾处理，此处保留完整数据供提取）

        // 调试模式：到达指定节点（含）即停
        if (debugStopId && node.id === debugStopId) {
          finalMessage = finalMessage || `调试运行：已执行到「${stepLog.name}」，共 ${stepCount} 步`;
          break;
        }
        if (!outcome) {
          failed = true;
          finalMessage = stepLog.message || '步骤失败';
          break;
        }
        const handle = outcome.handle;
        const nextId = this.nextNodeId(node.id, handle);
        if (nextId) {
          node = this.nodeById.get(nextId);
        } else if (handle === 'failed') {
          failed = true;
          finalMessage = stepLog.message || '步骤失败';
          break;
        } else {
          // 出口未连线：链路结束，正常完成
          break;
        }
      } catch (err) {
        const cancelled = err?.cancelled || err?.name === 'AbortError' || signal?.aborted;
        stepLog.ok = false;
        stepLog.cancelled = !!cancelled;
        stepLog.message = cancelled ? '运行已取消' : `步骤异常: ${err.message}`;
        stepLog.ms = Date.now() - started;
        logs.push(stepLog);
        if (emit && shouldDisplay(stepLog)) emit(stepLog);
        failed = true;
        finalMessage = stepLog.message;
        break;
      }
    }

    if (stepCount >= MAX_STEPS) {
      failed = true;
      finalMessage = `流程超过 ${MAX_STEPS} 步，疑似成环`;
    }

    // 日志记录范围（PRD §4.7.4 扩展）：
    //   all       = 所有步骤（默认，调试）
    //   log       = 仅 log 节点 + 失败步骤（qinglong/qiandao 风格，用户只看调教好的干净日志）
    //   log-final = 合并所有 log 节点为一条汇总日志 + 失败步骤
    const secrets = currentSecrets();
    let trimmedLogs = logs;
    if (!debugMode && (effectiveRecord === 'log' || effectiveRecord === 'log-final')) {
      const displayed = logs.filter((l) => shouldDisplay(l));
      if (effectiveRecord === 'log-final') {
        const logLines = logs.filter((l) => l.type === 'log' && l.ok).map((l) => (l.message || '').trim()).filter(Boolean);
        const merged = logLines.join('； ');
        const finalEntry = { stepId: null, index: 1, name: '汇总', type: 'log', ok: !failed, message: merged || (finalMessage || '流程执行完成'), detail: null, ms: 0 };
        const failedOnes = logs.filter((l) => !l.ok);
        trimmedLogs = failedOnes.length ? [...failedOnes, finalEntry] : [finalEntry];
      } else {
        trimmedLogs = displayed;
      }
    } else if (logLevel !== 'all') {
      trimmedLogs = logs.map((l) => {
        const keepFull = logLevel === 'failure' ? !l.ok : false;
        if (keepFull) return l;
        // 只保留标题信息
        return {
          stepId: l.stepId, index: l.index, name: l.name, type: l.type,
          ok: l.ok, message: l.message, ms: l.ms,
          keywords: l.keywords, // 关键字提取结果永远保留
          asserts: l.asserts,
        };
      });
    }

    // 非调试模式：成功步骤不落请求/响应细节（保留失败步骤详情便于排障）
    // 注：clean 模式下 http 步骤本就不入日志，故此处无需再裁剪。
    trimmedLogs = trimmedLogs.map((l) => redactLogEntry(l, secrets, this.resBodyLimit));
    finalMessage = redactText(finalMessage, secrets);

    // 运行摘要：关键字提取结果汇总（PRD：每次运行关心什么值，一眼可见）
    const summary = keywordResults.length
      ? redactText(keywordResults.map((r) => `${r.name}: ${r.values.join(', ')}`).join('； '), secrets)
      : '';

    // include.varsSnapshot=false：不记录运行级变量快照（PRD §4.7.4）
    const snapshot = this.logInclude.varsSnapshot ? vars : {};
    return { ok: !failed, cancelled: finalMessage === '运行已取消', logs: trimmedLogs, vars: snapshot,
      redactedVars: redactVars(snapshot, secrets), finalMessage, summary };
  }

  findEntryNode() {
    const nodes = this.flow.nodes || [];
    const edges = this.flow.edges || [];
    const noIn = nodes.filter((n) => !edges.some((e) => e.target === n.id));
    if (!noIn.length) return null;
    return noIn.sort((a, b) => a.x - b.x)[0];
  }

  /** HTTP 节点执行体（由 execNode 的重试循环调用）。返回 {ok, errorKind, message} */
  async execHttp(node, c, state, stepLog, missing, attempt) {
    const vars = state.vars;
    let url = renderTemplate(c.url, vars, missing);
    const hasAllowedOrigin = c.allowedOrigin !== undefined && c.allowedOrigin !== '';
    if (hasAllowedOrigin) {
      const allowed = parseAllowedOrigin(c.allowedOrigin);
      if (!allowed) return { ok: false, errorKind: 'configuration', message: '允许请求源配置无效' };
      let target;
      try { target = new URL(url); } catch { /* 下方统一处理无效目标 */ }
      if (!target || !['http:', 'https:'].includes(target.protocol) || target.origin !== allowed) {
        return { ok: false, errorKind: 'configuration', message: '已阻止请求：实际地址与允许请求源不一致' };
      }
      url = target.href;
    }
    const method = (c.method || 'GET').toUpperCase();
    const headers = {};
    for (const h of c.headers || []) {
      if (h && h.enabled !== false && h.name) {
        // QD 模板常见尾部换行残留，一律 trim（cookie 值带 \n 直接被判无效）
        const v = renderTemplate(h.value, vars, missing);
        headers[String(h.name).trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
      }
    }
    // run 级 cookie 罐（QD 兼容 GAP-C1）：罐内 cookie 自动补入请求头，显式 cookie 同名键优先
    const useJar = c.cookieJar !== false;
    let jarUsed = 0;
    if (useJar && state.cookieJar) {
      const jarLine = state.cookieJar.headerFor(url);
      if (jarLine) {
        const before = headers.cookie || '';
        headers.cookie = mergeCookieHeader(jarLine, headers.cookie);
        if (headers.cookie !== before) jarUsed = 1;
      }
    }
    trackHttpCredentials(state.credentials, headers);
    let body = null;
    if (c.body && method !== 'GET' && method !== 'HEAD') {
      const b = renderTemplate(c.body, vars, missing);
      body = typeof b === 'string' ? b.trim() : b;
    }
    // 代理（4.2）：值支持 {{proxyVar}}，运行时渲染
    let proxyUrl = '';
    if (c.proxy && c.proxy.url) {
      proxyUrl = String(renderTemplate(c.proxy.url, vars, missing)).trim();
    }
    trackHttpUrlCredentials(state.credentials, url);
    trackHttpBodyCredentials(state.credentials, body, String(headers['content-type'] || ''));
    if (proxyUrl) trackHttpUrlCredentials(state.credentials, proxyUrl);
    stepLog.detail = { method, url, headers, body, attempt, proxy: proxyUrl || undefined, jar: jarUsed || undefined };
    // include 开关（level=all 时生效；failure/summary 的裁剪在 run 末尾统一处理）
    const include = this.logInclude || { reqHeaders: true, reqBody: true, resBody: true };
    if (!include.reqHeaders) delete stepLog.detail.headers;
    if (!include.reqBody) delete stepLog.detail.body;

    const t0 = Date.now();
    const signal = state.signal;
    throwIfAborted(signal);
    let status, statusText, text, respHeaders, setCookies;
    let responseUrl = url;
    const maxBytes = Math.min(
      MAX_RESP_BYTES_CAP,
      Math.max(MIN_RESP_BYTES, Number(c.maxRespBytes) || MAX_RESP_BYTES),
    );
    try {
      const redirect = c.redirect || 'follow';
      const timeoutMs = c.timeout ? Math.max(1000, Number(c.timeout) * 1000) : HTTP_TIMEOUT;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
      const initialUrl = new URL(url);
      const hasRequestData = body != null || Object.keys(headers).length > 0 || initialUrl.search
        || initialUrl.username || initialUrl.password || c.url !== url
        || [...collectSecrets(vars)].some((value) => url.includes(value));
      const protectRedirect = redirect === 'follow' && (hasAllowedOrigin || hasRequestData);
      const redirectMode = protectRedirect ? 'manual' : redirect;
      const viaCurl = (c.backend || 'fetch') === 'curl';
      const dispatcher = !viaCurl && proxyUrl ? getProxyAgent(proxyUrl) : undefined;
      const deadline = Date.now() + timeoutMs;
      let requestMethod = method;
      let requestBody = body;
      let requestHeaders = headers;
      for (let redirects = 0; ; redirects++) {
        let resp;
        if (viaCurl) {
          ({ status, statusText, headers: respHeaders, text, setCookies } = await httpViaCurl(
            responseUrl, requestMethod, requestHeaders, requestBody, Math.max(1, deadline - Date.now()), redirectMode === 'follow', proxyUrl, maxBytes, requestSignal));
        } else {
          resp = await fetch(responseUrl, { method: requestMethod, headers: requestHeaders, body: requestBody, redirect: redirectMode, signal: requestSignal, dispatcher });
          status = resp.status;
          statusText = resp.statusText || '';
          respHeaders = Object.fromEntries(resp.headers.entries());
          setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
        }
        trackHttpCredentials(state.credentials, respHeaders, setCookies);
        const location = respHeaders.location;
        if (location && [301, 302, 303, 307, 308].includes(status) && (protectRedirect || redirectMode === 'error')) {
          await resp?.body?.cancel();
          if (redirectMode === 'error') throw new Error('节点配置禁止 HTTP 重定向');
          const next = new URL(location, responseUrl);
          if (next.origin !== initialUrl.origin || next.username || next.password) {
            throw new Error('已阻止携带请求数据的跨源重定向');
          }
          if (redirects >= 20) throw new Error('HTTP 重定向次数超过上限');
          if ((status === 303 && requestMethod !== 'HEAD') || ((status === 301 || status === 302) && requestMethod === 'POST')) {
            requestMethod = 'GET';
            requestBody = null;
            requestHeaders = { ...requestHeaders };
            for (const header of ['content-length', 'content-type', 'content-encoding', 'content-language', 'content-location', 'transfer-encoding']) {
              delete requestHeaders[header];
            }
          }
          responseUrl = next.href;
          trackHttpUrlCredentials(state.credentials, responseUrl);
          continue;
        }
        if (!resp) break;
        responseUrl = resp.url || responseUrl;
        // charset（4.2）：默认按响应 content-type；强制 c.charset 覆盖
        const ctype = resp.headers.get('content-type') || '';
        let encoding = (ctype.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
        if (c.charset && c.charset !== 'auto') encoding = c.charset;
        const buf = await readBodyWithLimit(resp, maxBytes);
        text = /utf-?8/i.test(encoding)
          ? buf.toString('utf8')
          : (() => {
              try {
                return new TextDecoder(encoding).decode(buf);
              } catch {
                return buf.toString('utf8'); // 不认识的编码回退 utf-8
              }
            })();
        break;
      }
    } catch (err) {
      if (signal?.aborted) throw cancelError();
      if (err && err.code === 'RESP_TOO_LARGE') {
        return { ok: false, errorKind: 'network', message: err.message };
      }
      return { ok: false, errorKind: 'network', message: `请求失败: ${err.message}${err.cause ? ` (${err.cause.code || err.cause.message || ''})` : ''}` };
    }

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    trackHttpBodyCredentials(state.credentials, json && typeof json === 'object' ? json : text, respHeaders['content-type']);

    // 响应 Set-Cookie 入罐（后续同域请求自动携带）
    if (useJar && state.cookieJar) state.cookieJar.setFrom(responseUrl, setCookies);

    const duration = Date.now() - t0;
    state.last = { status, statusText, headers: respHeaders, text, json, ms: duration, setCookies: setCookies || [] };
    state.steps[node.id] = state.last;
    // 日志出口统一先脱敏，再按 resBodyLimit 截断。
    stepLog.detail.response = {
      status,
      headers: respHeaders,
      setCookie: (setCookies || []).length ? setCookies : undefined,
      body: include.resBody ? text : undefined,
      ms: duration,
    };

    // 断言两种形态:
    //   {expr, expect}  jexl 表达式
    //   {res: [regex], from: 'content'|'status', negate}  QD 原生正则（任一命中）
    let assertOk = true;
    const assertResults = [];
    const ctx = { vars, last: state.last, steps: state.steps };
    for (const a of c.asserts || []) {
      if (Array.isArray(a.res)) {
        const text0 = a.from === 'status' ? String(state.last.status) : String(state.last.text ?? '');
        let hit = false;
        for (const re of a.res) {
          try {
            if (new RegExp(re).test(text0)) { hit = true; break; }
          } catch {}
        }
        const pass = a.negate ? !hit : hit;
        assertResults.push({ label: `${a.negate ? '不含' : '含'} /${a.res.join('|')}/ (${a.from || 'content'})`, pass });
        if (!pass) assertOk = false;
      } else {
        try {
          const v = await evalExpr(a.expr, ctx);
          const pass = a.expect === undefined ? Boolean(v) : String(v) === String(a.expect);
          assertResults.push({ expr: a.expr, expect: a.expect, actual: v, pass });
          if (!pass) assertOk = false;
        } catch (err) {
          assertResults.push({ expr: a.expr, expect: a.expect, error: err.message, pass: false });
          assertOk = false;
        }
      }
    }
    if (assertResults.length) stepLog.asserts = assertResults;
    if (!assertOk) {
      const failedOnes = assertResults.filter((r) => !r.pass);
      return { ok: false, errorKind: 'assert', message: `断言失败: ${failedOnes
        .map((r) => r.label || `${r.expr} → ${JSON.stringify(r.actual ?? r.error)} (期望 ${JSON.stringify(r.expect)})`)
        .join('; ')}` };
    }
    stepLog.message = `${status} ${statusText} (${duration}ms)`.trim() + (attempt > 0 ? ` · 第${attempt + 1}次` : '');
    return { ok: true };
  }

  /** 写入原值供后续步骤使用，日志预览先脱敏再截断。 */
  setVariable(state, stepLog, name, value, showEllipsis = false) {
    state.vars[name] = value;
    const secrets = state.currentSecrets();
    const preview = isSensitiveName(name) ? '***' : redactText(value, secrets);
    stepLog.message = `${name} = ${preview.slice(0, 120)}${showEllipsis && preview.length > 120 ? '…' : ''}`;
  }

  /** 执行单个节点。returns { handle } 或 null(失败) */
  async execNode(node, state, stepLog, missing, logs, logSink) {
    const vars = state.vars;
    switch (node.type) {
      case 'http': {
        const c = node.config || {};
        // 每节点重试（4.2）：网络错误/超时，或断言失败且 retryOn 含 assert
        const retry = c.retry && c.retry.times > 0 ? { times: c.retry.times, backoffMs: Math.max(500, c.retry.backoffMs || 1000), retryOn: c.retry.retryOn || 'error' } : null;
        let attempt = 0;
        let result = null;
        for (;;) {
          throwIfAborted(state.signal);
          result = await this.execHttp(node, c, state, stepLog, missing, attempt);
          if (result.ok) break;
          const isNetworkError = result.errorKind === 'network';
          const isAssertFail = result.errorKind === 'assert';
          if (retry && attempt < retry.times && (isNetworkError || (isAssertFail && retry.retryOn !== 'error'))) {
            attempt++;
            const wait = retry.backoffMs * attempt; // 线性退避
            stepLog.message = `${result.message} → 重试 ${attempt}/${retry.times}（${wait}ms 后）`;
            logs.push({ ...stepLog, ok: true }); // 重试过程记录为中间日志
            logSink?.(logs[logs.length - 1]);
            await sleep(wait, state.signal);
            continue;
          }
          stepLog.ok = false;
          stepLog.message = result.message;
          stepLog.errorType = result.errorKind === 'network' ? 'network' : result.errorKind === 'assert' ? 'assert' : 'engine';
          // 有 failed 出口时交给主循环继续走；未接时主循环按「失败」收尾
          return { handle: 'failed' };
        }
        return { handle: 'success' };
      }

      case 'condition': {
        const c = node.config || {};
        let v = false;
        try {
          v = await evalExpr(c.expr, { vars, last: state.last, steps: state.steps });
        } catch (err) {
          stepLog.ok = false;
          stepLog.message = `表达式异常: ${err.message}`;
          stepLog.errorType = 'engine';
          return null;
        }
        stepLog.message = `${c.expr} → ${JSON.stringify(v)}`;
        return { handle: v ? 'true' : 'false' };
      }

      case 'set': {
        const c = node.config || {};
        const raw = c.value ?? '';
        let rendered;
        if (typeof raw === 'string' && raw.startsWith('=')) {
          rendered = String(await evalExpr(raw.slice(1), { vars, last: state.last, steps: state.steps }));
        } else {
          rendered = renderTemplate(String(raw), vars, missing);
        }
        this.setVariable(state, stepLog, c.name, rendered);
        return { handle: 'next' };
      }

      case 'extract': {
        const c = node.config || {};
        // 提取模式（4.1）：mode=json 按点路径取值；mode=header/setCookie 取响应头（4.2 Set-Cookie 捕获）
        if (c.mode === 'json') {
          const pathStr = String(c.path || '').trim();
          let cur = state.last && state.last.json;
          for (const key of pathStr ? pathStr.split('.') : []) {
            cur = cur == null ? undefined : cur[key];
          }
          if (cur === undefined || cur === null) {
            stepLog.message = `JSON 路径未命中: ${pathStr || '(空)'}`;
            if (c.optional === false) { stepLog.ok = false; return null; }
          } else {
            const val = typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
            this.setVariable(state, stepLog, c.name, val);
          }
          return { handle: 'next' };
        }
        if (c.mode === 'header' || c.mode === 'setCookie') {
          const h = (state.last && state.last.headers) || {};
          let val = '';
          if (c.mode === 'setCookie') {
            // 优先用引擎保存的多值 Set-Cookie 数组，缺省时回落 headers['set-cookie']
            const list = (state.last && state.last.setCookies && state.last.setCookies.length)
              ? state.last.setCookies
              : (h['set-cookie'] ? (Array.isArray(h['set-cookie']) ? h['set-cookie'] : [h['set-cookie']]) : []);
            let pairs = list.map((sc) => sc.split(';')[0].trim()).filter(Boolean);
            if (c.cookieFilter) {
              try {
                const re = new RegExp(c.cookieFilter);
                pairs = pairs.filter((p) => re.test(p.split('=')[0]));
              } catch (err) {
                stepLog.ok = false;
                stepLog.message = `cookie 过滤正则错误: ${err.message}`;
                return null;
              }
            }
            val = pairs.join('; ');
          } else {
            const hn = String(c.headerName || '').trim().toLowerCase();
            val = hn ? String(h[hn] ?? '') : '';
          }
          if (val) {
            this.setVariable(state, stepLog, c.name, val, true);
          } else {
            stepLog.message = c.mode === 'setCookie' ? '响应无 Set-Cookie' : `响应头未命中: ${c.headerName}`;
            if (c.optional === false) { stepLog.ok = false; return null; }
          }
          return { handle: 'next' };
        }
        // 默认正则模式（原有）
        const src = resolvePath(state, c.from, missing);
        const text = src === undefined || src === null ? '' : typeof src === 'object' ? JSON.stringify(src) : String(src);
        let m = null;
        try {
          m = new RegExp(c.re, c.flags || '').exec(text);
        } catch (err) {
          stepLog.ok = false;
          stepLog.message = `正则错误: ${err.message}`;
          return null;
        }
        if (m) {
          const val = m.length > 1 ? m[1] : m[0];
          this.setVariable(state, stepLog, c.name, val);
        } else {
          stepLog.message = `提取未命中: /${c.re}/ ← ${c.from}`;
          if (c.optional === false) {
            stepLog.ok = false;
            return null; // QD 语义：必填提取未命中 → 流程失败
          }
        }
        return { handle: 'next' };
      }

      case 'random-delay': {
        // 反风控核心件（4.1）：在 [min,max] 秒间随机等待
        const c = node.config || {};
        const min = Number(c.min ?? 1) || 0;
        const max = Number(c.max ?? 5) || 0;
        const lo = Math.min(min, max);
        const hi = Math.max(min, max);
        const sec = lo + Math.random() * (hi - lo);
        await sleep(Math.min(sec, 300) * 1000, state.signal);
        stepLog.message = `随机等待 ${sec.toFixed(1)}s (${lo}-${hi}s)`;
        return { handle: 'next' };
      }

      case 'delay': {
        const c = node.config || {};
        const sec = Number(renderTemplate(String(c.seconds ?? 1), vars, missing)) || 0;
        await sleep(Math.min(sec, 300) * 1000, state.signal);
        stepLog.message = `等待 ${sec}s`;
        return { handle: 'next' };
      }

      case 'log': {
        const c = node.config || {};
        // 日志模板支持 {{last.status}} / {{steps.n1.json...}}（与 http/set 节点同语义）
        const scope = { ...vars, last: state.last || {}, steps: state.steps || {} };
        stepLog.message = renderTemplate(String(c.text ?? ''), scope, missing) || '(空日志)';
        return { handle: 'next' };
      }

      case 'script': {
        // 隔离子进程执行：只传 JSON 快照；子进程无 fs/child_process/worker 权限，vm 不注入宿主对象。
        const c = node.config || {};
        const code = String(c.code || '');
        if (!code.trim()) {
          stepLog.ok = false;
          stepLog.message = '脚本为空';
          return null;
        }
        // 先按模板渲染，允许 {{var}} 占位
        const rendered = renderTemplate(code, vars, missing);
        const snapshot = JSON.parse(JSON.stringify({ vars, last: state.last, steps: state.steps }));
        const result = await runScriptProcess(rendered, snapshot, state.signal);
        if (!result.ok) {
          stepLog.ok = false;
          stepLog.message = result.error || '脚本执行失败';
          return null;
        }
        const out = result.out;
        if (out && typeof out === 'object' && !Array.isArray(out)) {
          for (const [k, v] of Object.entries(out)) vars[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
          stepLog.message = `脚本返回 ${Object.keys(out).length} 个变量：${Object.keys(out).join(', ')}`;
        } else {
          stepLog.message = '脚本完成（无返回值）';
        }
        return { handle: 'next' };
      }

      case 'foreach': {
        // 遍历（PRD §4.1）：source 求值为数组；each 出口为循环体（单链到链尾），next 为完工后继。
        // 执行模型：每项设 itemVar/index，沿循环体默认出口走完一轮，再下一轮；上限 50 轮，任一步失败则整体失败。
        const c = node.config || {};
        const sourceExpr = String(c.source || '').trim();
        let arr;
        try {
          if (/^(last|vars|steps)\./.test(sourceExpr)) {
            arr = resolvePath({ vars, last: state.last, steps: state.steps }, sourceExpr, null);
          } else {
            arr = await evalExpr(sourceExpr, { vars, last: state.last, steps: state.steps });
          }
        } catch (err) {
          stepLog.ok = false;
          stepLog.message = `遍历源表达式异常: ${err.message}`;
          return null;
        }
        if (typeof arr === 'string' && arr.trim().startsWith('[')) {
          // extract/script 把数组存成 JSON 字符串，这里兼容解析
          try { arr = JSON.parse(arr); } catch { /* 保持原字符串，走下面的类型错误提示 */ }
        }
        if (!Array.isArray(arr)) {
          stepLog.ok = false;
          stepLog.message = `遍历源不是数组: ${sourceExpr} → ${arr === undefined ? 'undefined' : typeof arr}`;
          return null;
        }
        const itemVar = String(c.itemVar || 'item').trim() || 'item';
        const indexVar = String(c.indexVar || 'index').trim() || 'index';
        const bodyTargetId = this.nextNodeId(node.id, 'each');
        if (!bodyTargetId) {
          stepLog.ok = false;
          stepLog.message = 'foreach 未连线循环体（each 出口）';
          return null;
        }
        const maxIter = Math.min(50, arr.length);
        let doneCount = 0;
        for (let i = 0; i < maxIter; i++) {
          throwIfAborted(state.signal);
          vars[itemVar] = arr[i];
          vars[indexVar] = String(i);
          let cursor = this.nodeById.get(bodyTargetId);
          let guard = 0;
          while (cursor && guard < 100) {
            guard++;
            throwIfAborted(state.signal);
            const started = Date.now();
            const bodyLog = { stepId: cursor.id, index: logs.length + 1, name: `${cursor.name || cursor.type} #${i + 1}`, type: cursor.type, ok: true, message: '', detail: null, ms: 0 };
            let outcome;
            try {
              outcome = await this.execNode(cursor, state, bodyLog, missing, logs, logSink);
            } catch (err) {
              if (err?.cancelled || state.signal?.aborted) throw cancelError();
              bodyLog.ok = false;
              bodyLog.message = `步骤异常: ${err.message}`;
              bodyLog.ms = Date.now() - started;
              logs.push(bodyLog);
              if (logSink) logSink(bodyLog);
              stepLog.ok = false;
              stepLog.message = `遍历第 ${i + 1} 轮失败: ${bodyLog.message}`;
              return null;
            }
            bodyLog.ms = Date.now() - started;
            logs.push(bodyLog);
            if (logSink) logSink(bodyLog);
            if (state.signal?.aborted) throw cancelError();
            if (!outcome) {
              stepLog.ok = false;
              stepLog.message = `遍历第 ${i + 1} 轮失败: ${bodyLog.message}`;
              return null;
            }
            const nxt = this.nextNodeId(cursor.id, outcome.handle);
            if (!nxt) break;
            // 循环体到达 next 的后继时停止本轮（避免与主流程 nxt 重叠执行）
            if (this.nextNodeId(node.id, 'next') === nxt) break;
            cursor = this.nodeById.get(nxt);
          }
          doneCount++;
        }
        stepLog.message = `遍历完成 ${doneCount}/${arr.length} 项（上限 50）`;
        return { handle: 'next' };
      }

      case 'notify': {
        const c = node.config || {};
        const rendered = renderTemplate(String(c.text ?? ''), vars, missing);
        const targets = [];
        if (c.webhookUrl) targets.push({ type: 'webhook', url: renderTemplate(c.webhookUrl, vars, missing) });
        if (c.tgToken && c.tgChat) targets.push({ type: 'telegram', token: c.tgToken, chat: c.tgChat });
        if (c.barkUrl) targets.push({ type: 'bark', url: renderTemplate(c.barkUrl, vars, missing) });
        if (!targets.length) {
          stepLog.message = '未配置通知渠道，跳过';
          return { handle: 'next' };
        }
        for (const target of targets) {
          if (target.url) trackHttpUrlCredentials(state.credentials, target.url);
          if (target.token) trackHttpCredentials(state.credentials, { token: target.token });
        }
        const text = redactText(rendered, state.currentSecrets());
        const results = await sendToChannels(targets, text, { flowName: '通知节点' });
        const errors = results.filter((r) => !r.ok).map((r) => `${r.type}: ${r.error}`);
        const sent = results.some((r) => r.ok);
        stepLog.message = errors.length
          ? (sent ? `通知部分失败: ${errors.join('; ')}` : `通知失败: ${errors.join('; ')}`)
          : `已推送: ${text.slice(0, 100)}`;
        if (!sent && errors.length) {
          stepLog.ok = false;
          return null;
        }
        return { handle: 'next' };
      }

      default:
        stepLog.ok = false;
        stepLog.message = `未知步骤类型: ${node.type}`;
        return null;
    }
  }
}

/**
 * curl 后端：出站 TLS 指纹为 curl 而非 Node fetch(undici)。
 * 用途: 目标站对 undici 指纹做风控时切换（节点 config.backend = 'curl'）。
 * 支持 proxyUrl（http/https/socks5h → --proxy）。
 * 返回与 fetch 路径同构: { status, statusText, headers, text, setCookies }
 */
async function httpViaCurl(url, method, headers, body, timeoutMs, follow, proxyUrl, maxBytes = MAX_RESP_BYTES, signal) {
  throwIfAborted(signal);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkq-'));
  const hdrFile = path.join(tmp, 'h.txt');
  const bodyFile = path.join(tmp, 'b.txt');
  const args = ['-q', '--globoff', '-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--max-filesize', String(maxBytes), '-X', method, '-D', hdrFile, '-o', bodyFile];
  if (follow) args.push('-L');
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push(url);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body && method !== 'GET' && method !== 'HEAD') args.push('--data-binary', body);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('curl', args, { timeout: timeoutMs + 5000 });
      let stderr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        try { child.kill('SIGKILL'); } catch {}
        finish(reject, cancelError());
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      child.stderr.on('data', (d) => { stderr = String(d).slice(0, 300); });
      child.on('error', (err) => finish(reject, signal?.aborted ? cancelError() : err));
      child.on('close', (code) => {
        if (code === 0) return finish(resolve);
        if (signal?.aborted) return finish(reject, cancelError());
        const err = new Error(stderr.trim() || (code === 63 ? `响应体超过上限 ${maxBytes} 字节` : `curl exit ${code}`));
        if (code === 63) err.code = 'RESP_TOO_LARGE';
        finish(reject, err);
      });
    });
    throwIfAborted(signal);
    const hdrRaw = fs.readFileSync(hdrFile, 'utf8');
    const bodyStat = fs.statSync(bodyFile);
    if (bodyStat.size > maxBytes) throw new ResponseLimitError(maxBytes);
    const text = fs.readFileSync(bodyFile, 'utf8');
    const blocks = hdrRaw.split(/\r?\n\r?\n/).filter((b) => b.trim());
    const lines = (blocks[blocks.length - 1] || '').split(/\r?\n/);
    const m = (lines[0] || '').match(/^HTTP\/[\d.]+\s+(\d+)/);
    const respHeaders = {};
    const setCookies = [];
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) {
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === 'set-cookie') setCookies.push(v);
        else respHeaders[k] = v;
      }
    }
    return { status: m ? Number(m[1]) : 0, statusText: '', headers: respHeaders, text, setCookies };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** 头部脱敏：cookie/authorization 只留前 12 字符（日志展示用） */
/** 通用脱敏（PRD §4.7.3 扩展）：变量快照等场景，敏感名变量的值整体打码 */
export function redactVars(vars, secrets = []) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    out[k] = isSensitiveName(k) ? '***' : redactDeep(v, secrets);
  }
  return out;
}
