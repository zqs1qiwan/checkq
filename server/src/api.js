/**
 * CheckQ API server — Fastify
 * 认证: cookie session + 可选 X-API-Key（自动化）
 * run 接口: 同步返回完整结果（流程通常 < 60s）
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Store, hashPwd, verifyPwd } from './store.js';
import { checkPassword, checkUsername, ROLES, PASSWORD_MIN, hashApiKey, newApiKey } from './auth.js';
import { generateSecret, verifyTotpStep, generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode, otpauthUri } from './totp.js';
import { buildOpenApi } from './openapi.js';
import { ipAllowed, isTrustedProxyPeer, normalizeIp } from './iprange.js';
import { Engine, redactVars } from './engine.js';
import { collectSecrets, hasAiInputCredentials, maskStoredRun, redactKnownValues, redactLogEntry, redactRunForExport, redactText } from './redact.js';
import { collectDefinitionSecrets, hasDefinitionCredentials, maskSecrets } from './secret.js';
import { validateFlow, validateHttpOrigins } from './model.js';
import { importHar } from './har-import.js';
import { parseCurl } from './curl-import.js';
import { Scheduler } from './scheduler.js';
import { runWithRetry, normalizeRetry, attemptLabel } from './retry.js';
import { runToHar } from './har-export.js';
import { VERSION } from './version.js';
import { analyzeStructure } from './structure.js';
import { diagnose } from './diagnose.js';
import { shouldAutoPause, applyAutoPause } from './auto-pause.js';
import { normalizeRecovery, afterProbeFailure, afterProbeSuccess, nextProbeTime } from './recovery.js';
import { isDemoEnabled, demoProfile, demoCheckin, demoItems, demoReset, ensureDemoFlow, originOf } from './demo.js';
import { computeMetrics, bumpEvents, EVENT_NAMES } from './metrics.js';
import { sendToChannels as sendChannelsCore, SUMMARY_CHANNEL_TYPES } from './notify.js';
import { createLimiter } from './concurrency.js';
import { parseIndex, resolveEntry, previewOf, fetchJson, MARKET_LIMITS } from './market.js';
import { MCP_TOOLS, executeMcpTool } from './mcp-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** POSIX shell 单引号包裹（curl 生成用） */
function shellQuote(s) {
  if (s === '' || s === undefined || s === null) return "''";
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function buildServer({ dataDir, port }) {
  const store = new Store(dataDir);
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  // 进程退出（SIGTERM/SIGINT）由 startServer 统一处理：停调度器 + 落盘
  const sessions = new Map(); // qsid -> { userId, createdAt, lastSeenAt, ip, ua, expiresAt }
  const SESSION_TTL = 7 * 24 * 3600e3;   // 绝对有效期 7 天
  const SESSION_IDLE = 24 * 3600e3;       // 空闲 24 小时失效
  const CSRF_SAFE = new Set(['/api/login', '/api/logout', '/api/health', '/api/system/bootstrap']);
  // 登录防爆破（PRD §4.10）：同一 IP 10 分钟内失败 5 次 → 429 锁定
  const loginFails = new Map(); // ip -> { count, firstAt }
  const LOGIN_FAIL_LIMIT = 5;
  const LOGIN_FAIL_WINDOW = 10 * 60 * 1000;
  const API_KEY_SCOPES = ['read', 'run', 'write', 'secrets'];

  /**
   * API Key 的「任务范围」：flowIds 和 groups 都为空表示不限制，否则按两者的并集匹配。
   * 浏览器会话与旧版单 Key 不受范围限制。
   */
  const keyAllowsFlow = (req, flow) => {
    if (!req.apiKey || req.legacyApiKey || !flow) return true;
    const ids = Array.isArray(req.apiKey.flowIds) ? req.apiKey.flowIds : [];
    const groups = Array.isArray(req.apiKey.groups) ? req.apiKey.groups : [];
    if (!ids.length && !groups.length) return true;
    if (ids.includes(flow.id)) return true;
    return !!flow.group && groups.includes(flow.group);
  };
  /** 受限 Key 不能创建新任务/模板（新对象不在绑定范围内）；无绑定的 Key 仍可创建。 */
  const keyHasFullFlowScope = (req) => {
    if (!req.apiKey || req.legacyApiKey) return true;
    const ids = Array.isArray(req.apiKey.flowIds) ? req.apiKey.flowIds : [];
    const groups = Array.isArray(req.apiKey.groups) ? req.apiKey.groups : [];
    return !ids.length && !groups.length;
  };
  // 缺少现存任务时无法验证原有绑定，仅允许全任务范围访问运行记录。
  const keyAllowsRun = (req, flow) => flow ? keyAllowsFlow(req, flow) : keyHasFullFlowScope(req);
  const keyHasScope = (req, scope) => {
    if (req.legacyApiKey) return false;
    if (!req.apiKey) return true;
    return (req.apiKeyScopes || []).includes(scope);
  };
  /** API Key 的任务和模板回包使用同一凭据可见性规则。 */
  const visibleDefinition = (req, definition) => (keyHasScope(req, 'secrets') ? definition : maskSecrets(definition));
  const keyScopeDenied = (reply, message = '该 API Key 的任务范围不包含此任务') => reply.code(403).send({ error: message });
  const modifiesExecution = (patch) => ['nodes', 'edges', 'vars', 'varNames', 'notify', 'log', 'tplId'].some((field) => Object.hasOwn(patch, field));
  const hasOriginBinding = (definition) => (definition.nodes || []).some((node) => node.type === 'http' && node.config?.allowedOrigin);
  const hasProtectedExecution = (definition) => hasOriginBinding(definition) || hasDefinitionCredentials(definition);
  const templateHasProtectedExecution = (template) => hasProtectedExecution(template)
    || store.flows.some((flow) => flow.tplId === template.id && hasProtectedExecution(flow));
  const rejectCredentialEdit = (reply) => keyScopeDenied(reply, '此配置涉及任务凭据或允许请求源，请在 CheckQ 内修改执行配置');
  const loginLocked = (ip) => {
    const rec = loginFails.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.firstAt > LOGIN_FAIL_WINDOW) { loginFails.delete(ip); return false; }
    return rec.count >= LOGIN_FAIL_LIMIT;
  };
  const noteLoginFail = (ip) => {
    const rec = loginFails.get(ip);
    if (rec && Date.now() - rec.firstAt <= LOGIN_FAIL_WINDOW) rec.count++;
    else loginFails.set(ip, { count: 1, firstAt: Date.now() });
  };
  const ACCOUNT_FAIL_LIMIT = 8;          // 单账号连续失败上限
  const ACCOUNT_FAIL_WINDOW = 15 * 60e3; // 单账号锁定窗口

  /**
   * 取客户端真实 IP。
   * - 默认只信任「本机/私有网段」来源的 X-Forwarded-For（Docker 网关、局域网反代）；
   * - 公网客户端自填 XFF 不采用，避免伪造 IP 绕过黑名单/限流；
   * - CHECKQ_TRUST_PROXY=1 信任全部来源；=0 不信任任何 XFF；也可填 CIDR 列表。
   */
  function connectionIp(req) {
    return normalizeIp(req.socket?.remoteAddress || req.raw?.socket?.remoteAddress || req.ip || '');
  }

  function trustForwarded(peer) {
    const raw = String(process.env.CHECKQ_TRUST_PROXY || '').trim();
    if (raw === '1' || raw.toLowerCase() === 'true') return true;
    if (raw === '0' || raw.toLowerCase() === 'false') return false;
    if (raw) return ipAllowed(peer, raw.split(/[\s,;]+/));
    return isTrustedProxyPeer(peer);
  }

  function clientIp(req) {
    const peer = connectionIp(req);
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return normalizeIp((trustForwarded(peer) && xff) ? xff : (peer || req.ip || ''));
  }

  /** 当前会话（过期即清理） */
  function currentSession(req) {
    const qsid = req.cookies?.qsid;
    if (!qsid) return null;
    const s = sessions.get(qsid);
    if (!s) return null;
    if (s.expiresAt < Date.now() || Date.now() - s.lastSeenAt > SESSION_IDLE) {
      sessions.delete(qsid);
      return null;
    }
    s.lastSeenAt = Date.now();
    return { qsid, ...s };
  }

  /** 某用户的全部会话 id */
  function sessionsOf(userId) {
    return [...sessions.entries()].filter(([, s]) => s.userId === userId).map(([id]) => id);
  }

  const runningFlows = new Set();
  const activeRuns = new Map(); // runId -> { run, controller, flowId, reason }
  const RUN_TIMEOUT_MS = Math.min(24 * 3600e3, Math.max(60e3, Number(process.env.CHECKQ_RUN_TIMEOUT_MS) || 30 * 60e3));
  const manualInFlight = new Set(); // 手动触发的在途请求（同步占位，避免并发点击跑两遍）
  const flowLimiters = new Map();
  const queueByFlow = new Map(); // flowId -> 等待中的 runId 集合
  const leaveQueue = ({ id, flowId }) => {
    const queued = queueByFlow.get(flowId);
    if (queued?.delete(id) && queued.size === 0) queueByFlow.delete(flowId);
  };
  const enqueueRun = async (flowId, signal, fn) => {
    let limiter = flowLimiters.get(flowId);
    if (!limiter) {
      limiter = createLimiter(1);
      flowLimiters.set(flowId, limiter);
    }
    const acquired = await limiter.acquire(signal);
    try {
      if (acquired && !signal.aborted) return await fn();
    } finally {
      if (acquired) limiter.release();
      if (limiter.active === 0 && flowLimiters.get(flowId) === limiter) flowLimiters.delete(flowId);
    }
  };
  const runLimiter = createLimiter(process.env.CHECKQ_MAX_CONCURRENCY || 4);
  const runner = {
    async runFlow(flow, trigger, { debugStopId, onLog, debug, notify = true, onQueued, onStart, timeoutMs } = {}) {
      const runId = crypto.randomUUID();
      const limitMs = Math.min(24 * 3600e3, Math.max(60e3, Number(timeoutMs) || RUN_TIMEOUT_MS));
      const run = {
        id: runId, flowId: flow.id, flowName: flow.name, trigger,
        queuedAt: Date.now(), startedAt: Date.now(), status: 'queued', logs: [], vars: {}, finalMessage: '',
        attempts: [],
      };
      const controller = new AbortController();
      const record = { run, controller, flowId: flow.id, reason: '' };
      activeRuns.set(runId, record);
      // 在途记录先落库：排队/运行中的任务在运行历史里可见，不会因为进程重启凭空消失
      store.addRun(run);
      let runTimer = null;
      if (!queueByFlow.has(flow.id)) queueByFlow.set(flow.id, new Set());
      queueByFlow.get(flow.id).add(runId);
      try {
        onQueued?.(run);
        const result = await enqueueRun(flow.id, controller.signal, async () => {
          if (!(await runLimiter.acquire(controller.signal))) return run;
          try {
            if (controller.signal.aborted) return run;
            runningFlows.add(flow.id);
            leaveQueue(run);
            run.status = 'running';
            run.startedAt = Date.now();
            store.addRun(run);
            onStart?.(run);
            runTimer = setTimeout(() => {
              record.reason = 'timeout';
              controller.abort();
            }, limitMs);
          // 任务级重试：调试运行不重试（要看到断点处的真实失败）；恢复探测也不重试，
          // 否则一次探测会连续打多次请求，绕过“最多探测 N 次”的风控上限。
          const cfg = normalizeRetry(flow.retry);
          if (debugStopId || debug === true || trigger === 'probe') cfg.enabled = false;
          const maxAttempts = cfg.enabled ? cfg.maxAttempts : 1;
          let lastMessage = '';
          try {
            const outcome = await runWithRetry({
              retry: cfg,
              signal: controller.signal,
              shouldStop: () => controller.signal.aborted,
              runOnce: async (attempt) => {
                if (attempt > 1) {
                  const marker = {
                    stepId: null, index: run.logs.length + 1, name: '重试', type: 'system', ok: true,
                    message: `${attemptLabel(attempt, maxAttempts)}：上一次失败（${lastMessage}）`,
                    detail: null, ms: 0,
                  };
                  run.logs.push(marker);
                  onLog?.(marker);
                }
                const engine = new Engine(flow);
                let result;
                try {
                  result = await engine.run({
                    trigger, runId, debugStopId, debug: debug === true,
                    signal: controller.signal,
                    logSink: (entry) => onLog?.(entry),
                  });
                } catch (err) {
                  const cancelled = !!err?.cancelled || err?.name === 'AbortError' || controller.signal.aborted;
                  result = {
                    ok: false,
                    cancelled,
                    logs: [{
                      stepId: null, index: 1, name: '引擎', type: 'error', ok: false,
                      message: cancelled ? '运行已取消' : `引擎异常: ${err.message}`, detail: null, ms: 0,
                      cancelled: cancelled || undefined,
                    }],
                    vars: {},
                    finalMessage: cancelled ? '运行已取消' : `引擎异常: ${err.message}`,
                  };
                }
                lastMessage = result.finalMessage || '执行失败';
                run.logs.push(...(result.logs || []));
                return result;
              },
              onAttempt: (rec) => {
                run.attempts.push(rec);
                run.attempt = rec.attempt;
                run.maxAttempts = maxAttempts;
              },
            });
            if (controller.signal.aborted || outcome.cancelled) {
              const timedOut = record.reason === 'timeout';
              run.status = timedOut ? 'failed' : 'cancelled';
              run.finalMessage = timedOut ? `运行超时（超过 ${Math.round(limitMs / 1000)} 秒）` : '运行已取消';
              run.cancelled = !timedOut;
              run.timedOut = timedOut;
            } else {
              run.status = outcome.ok ? 'success' : 'failed';
              run.finalMessage = outcome.finalMessage || (outcome.ok ? '' : '执行失败');
            }
            run.summary = outcome.summary || '';
            run.vars = outcome.redactedVars ?? redactVars(outcome.vars || {});
          } catch (err) {
            if (controller.signal.aborted) {
              const timedOut = record.reason === 'timeout';
              run.status = timedOut ? 'failed' : 'cancelled';
              run.finalMessage = timedOut ? `运行超时（超过 ${Math.round(limitMs / 1000)} 秒）` : '运行已取消';
              run.cancelled = !timedOut;
              run.timedOut = timedOut;
            } else {
              run.status = 'failed';
              run.finalMessage = `引擎异常: ${err.message}`;
            }
          }
          if (!run.logs.length && run.finalMessage) {
            run.logs = [{
              stepId: null, index: 1, name: '引擎', type: 'error', ok: false,
              message: run.finalMessage, detail: null, ms: 0,
            }];
          }
          run.durationMs = Date.now() - run.startedAt;
          // 重试过的运行：把尝试次数写进结论，列表/通知/日志都能看到
          if (run.attempts.length > 1 && run.status !== 'cancelled') {
            run.finalMessage = `${run.finalMessage || (run.status === 'success' ? '执行成功' : '执行失败')}（第 ${run.attempts.length}/${maxAttempts} 次尝试）`;
          }
          // 可解释失败（P0-3）：失败运行带一份诊断（纯函数、不重跑、只给证据与动作）
          if (run.status === 'failed') {
            try { run.diagnosis = diagnose({ run, flow }); } catch { run.diagnosis = null; }
          }
          // 恢复探测（v0.6.1）：探测失败不改变调度，只累计次数；成功才重新启用
          if (trigger === 'probe') {
            try {
              const rec = normalizeRecovery(flow.recovery);
              if (run.status === 'success') {
                const next = afterProbeSuccess(rec);
                store.updateFlow(flow.id, { enabled: true, pausedAt: null, pausedReason: '', recovery: next });
                scheduler.rebuild();
                run.recovered = true;
                run.recovery = { attempt: rec.attempts + 1, maxAttempts: rec.maxAttempts, outcome: 'success' };
                store.addNotification({
                  title: '任务已自动恢复',
                  content: `任务「${flow.name}」恢复探测成功，调度已重新启用。`,
                  level: 'success',
                  flowId: flow.id,
                  flowName: flow.name,
                });
              } else {
                const next = afterProbeFailure(rec);
                store.updateFlow(flow.id, { recovery: next });
                run.recovery = { attempt: next.attempts, maxAttempts: next.maxAttempts, outcome: 'failed', exhausted: next.exhausted };
                if (next.exhausted) {
                  store.addNotification({
                    title: '自动恢复已停止',
                    content: `任务「${flow.name}」连续 ${next.attempts} 次恢复探测失败，已停止自动探测；请手动检查账号或站点。`,
                    level: 'fail',
                    flowId: flow.id,
                    flowName: flow.name,
                  });
                }
              }
            } catch { /* 探测状态写入失败不影响本次运行记录 */ }
          } else if (!run.cancelled && shouldAutoPause(trigger, run)) {
            // 连续失败自动停用（只针对调度触发）：凭据失效或风控时不自动恢复探测
            const skipRecovery = run.diagnosis?.rule === 'credential' || run.diagnosis?.rule === 'risk-control';
            try {
              if (applyAutoPause({ store, scheduler, flowId: flow.id, reason: run.finalMessage, skipRecovery })) {
                run.paused = true;
                run.finalMessage = `${run.finalMessage || '执行失败'}（已自动停用调度）`;
              }
            } catch { /* 停用失败不影响本次运行的记录 */ }
          }
          store.addRun(run);
          // 恢复探测是静默诊断：不写任务通知、不碰外部渠道，避免反复失败触发站点风控。
          if (notify !== false && trigger !== 'probe' && !run.cancelled) {
            const notifyResults = await sendNotify(flow, run);
            if (Array.isArray(notifyResults) && notifyResults.length) {
              const failed = notifyResults.filter((r) => !r.ok).map((r) => ({ type: r.type, error: String(r.error || '').slice(0, 80) }));
              run.notify = { total: notifyResults.length, ok: notifyResults.length - failed.length, failed };
              store.flushRuns();
              // 外部渠道全部失败时补一条站内告警：通知本身也不能静默失败
              const external = notifyResults.filter((r) => r.type !== 'inbox');
              if (external.length && external.every((r) => !r.ok)) {
                store.addNotification({
                  title: '任务通知失败',
                  content: `任务「${flow.name}」的 ${external.length} 个外部渠道全部发送失败：${failed.filter((f) => f.type !== 'inbox').map((f) => `${f.type}: ${f.error}`).join('；')}`,
                  level: 'fail',
                  flowId: flow.id,
                  flowName: flow.name,
                });
              }
            }
          }
          return run;
          } finally {
            if (runTimer) clearTimeout(runTimer);
            runningFlows.delete(flow.id);
            runLimiter.release();
          }
        });
        return result ?? run;
      } finally {
        activeRuns.delete(runId);
        leaveQueue(run);
      }
    },
    /** 取消一次运行（排队中也能取消）；返回最新 run 记录 */
    cancel(runId, reason = 'cancelled') {
      const rec = activeRuns.get(runId);
      if (!rec) {
        const run = store.getRun(runId);
        if (run && ['queued', 'running'].includes(run.status)) {
          run.status = reason === 'timeout' ? 'failed' : 'cancelled';
          run.finalMessage = reason === 'timeout' ? '运行超时' : '运行已取消';
          run.cancelled = reason !== 'timeout';
          run.timedOut = reason === 'timeout';
          store.addRun(run);
          return run;
        }
        return null;
      }
      rec.reason = reason;
      rec.controller.abort();
      if (rec.run.status === 'queued') {
        rec.run.status = reason === 'timeout' ? 'failed' : 'cancelled';
        rec.run.cancelled = reason !== 'timeout';
        rec.run.timedOut = reason === 'timeout';
        rec.run.finalMessage = reason === 'timeout' ? '运行超时' : '运行已取消';
        rec.run.durationMs = Date.now() - rec.run.startedAt;
        leaveQueue(rec.run);
        store.addRun(rec.run);
      } else {
        rec.run.cancelling = true;
      }
      return rec.run;
    },
    active(runId) {
      return activeRuns.get(runId) || null;
    },
    /** 调度器用：上一次运行（含重试等待）还没结束就跳过这一拍，避免堆积 */
    isBusy(flowId) {
      return runningFlows.has(flowId) || queueByFlow.has(flowId) || manualInFlight.has(flowId);
    },
    /**
     * 手动运行的同步占位（P0-4）：同一任务并发点击只产生一次运行。
     * 必须在第一个 await 之前调用，才能挡住同一拍的两个请求。
     */
    claimManual(flowId) {
      if (this.isBusy(flowId) || manualInFlight.has(flowId)) return false;
      manualInFlight.add(flowId);
      return true;
    },
    releaseManual(flowId) {
      manualInFlight.delete(flowId);
    },
  };

  // 统一通知出口：站内通知在 notify.js 里通过注入的 inbox 回调落库
  const sendToChannels = (channels, text, ctx = {}) => sendChannelsCore(channels, text, ctx, {
    inbox: (payload) => store.addNotification(payload),
  });

  async function sendNotify(flow, run) {
    const n = flow.notify || {};
    const fire = (run.status === 'success' && n.onSuccess) || (run.status === 'failed' && n.onFailure);
    if (!fire || !n.channels?.length) return;
    try {
      const text = renderNotifyTemplate(n, flow, run);
      return await sendToChannels(n.channels, text, { flowId: flow.id, flowName: flow.name, status: run.status });
    } catch (e) {
      return [{ type: 'render', ok: false, error: `通知模板渲染失败: ${e.message}` }];
    }
  }

  // ---- 每日汇总（v0.5.3：独立系统通知，不再借用任务渠道） ----
  const pad2 = (n) => String(n).padStart(2, '0');
  const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function dayWindow(dateStr) {
    let d;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) {
      d = new Date(`${dateStr}T00:00:00`);
    } else {
      const now = new Date();
      d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    }
    const startMs = d.getTime();
    const endMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
    return { date: localDateStr(d), startMs, endMs };
  }

  function dailyConfig() {
    const cfg = store.meta.dailySummary || {};
    return {
      enabled: cfg.enabled === true,
      time: /^\d{2}:\d{2}$/.test(String(cfg.time || '')) ? cfg.time : '08:00',
      timezone: cfg.timezone || 'Asia/Shanghai',
      skipEmpty: cfg.skipEmpty !== false,
      include: {
        failures: cfg.include?.failures !== false,
        paused: cfg.include?.paused !== false,
        successCount: cfg.include?.successCount !== false,
      },
      lastSentDate: cfg.lastSentDate || null,
      lastSentAt: cfg.lastSentAt || null,
      lastResult: cfg.lastResult || null,
      targetFlowIds: Array.isArray(cfg.targetFlowIds) ? cfg.targetFlowIds : (cfg.targetFlowId ? [cfg.targetFlowId] : []),
      migratedFrom: cfg.migratedFrom || null,
      migratedAt: cfg.migratedAt || null,
    };
  }

  const shortTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

  /** 每日汇总正文（纯函数，预览与发送共用；总长 ≤2000） */
  function buildDailySummaryText(s, { catchup = false, include } = {}) {
    const cfg = dailyConfig();
    const inc = { ...cfg.include, ...(include || {}) };
    const d = new Date(s.window.startMs);
    const label = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const lines = [`每日汇总 · ${label}${catchup ? '（补发）' : ''}`];

    if (s.empty) {
      lines.push('昨日无任务运行');
    } else {
      const rate = inc.successCount && s.rate !== null ? `（成功率 ${s.rate}%）` : '';
      lines.push(`${s.enabledFlows} 个启用任务，运行 ${s.runs} 次：成功 ${s.success} / 失败 ${s.failed}${rate}`);
    }

    const failLines = [];
    let extraFailures = 0;
    if (!s.empty && inc.failures) {
      if (!s.failures.length) {
        failLines.push('今天没有失败任务');
      } else {
        failLines.push('', '需要你看一眼');
        for (const f of s.failures.slice(0, 5)) {
          const consec = f.consecutive > 1 ? `，连续失败 ${f.consecutive} 次` : '';
          failLines.push(`· ${f.flowName}：${f.message || '运行失败'}（${shortTime(f.at)}${consec}）`);
        }
        extraFailures = Math.max(0, s.failures.length - 5);
        if (extraFailures) failLines.push(`另有 ${extraFailures} 个任务失败`);
      }
    }

    const pauseLines = [];
    if (inc.paused && s.paused.length) {
      pauseLines.push('', '已自动停用');
      for (const p of s.paused.slice(0, 5)) {
        pauseLines.push(`· ${p.flowName}（${shortTime(p.at)}）${p.reason ? `：${String(p.reason).split('\n')[0].slice(0, 80)}` : ''}`);
      }
      if (s.paused.length > 5) pauseLines.push(`另 ${s.paused.length - 5} 个任务已停用`);
    }

    const rest = s.empty ? 0 : Math.max(0, s.enabledFlows - s.failures.length - s.paused.length);
    const restLine = rest > 0 ? `其余 ${rest} 个任务正常` : null;
    const nextLine = s.next?.at ? `下次调度：${s.next.flowName || '任务'} ${shortTime(s.next.at)}` : null;

    const full = [...lines, ...failLines, ...pauseLines, ...(restLine ? [restLine] : []), ...(nextLine ? [nextLine] : [])];
    let text = full.join('\n');
    if (text.length <= 2000) return text;

    // 截断顺序：「其余…正常」→「下次调度」→ 失败条目保留前 3 条
    const withoutRest = [...lines, ...failLines, ...pauseLines, ...(nextLine ? [nextLine] : [])];
    text = withoutRest.join('\n');
    if (text.length <= 2000) return text;
    const withoutNext = [...lines, ...failLines, ...pauseLines];
    text = withoutNext.join('\n');
    if (text.length <= 2000) return text;

    if (s.failures.length > 3) {
      const shortFails = ['', '需要你看一眼', ...s.failures.slice(0, 3).map((f) => {
        const consec = f.consecutive > 1 ? `，连续失败 ${f.consecutive} 次` : '';
        return `· ${f.flowName}：${f.message || '运行失败'}（${shortTime(f.at)}${consec}）`;
      }), `另有 ${s.failures.length - 3} 个任务失败（已省略）`];
      text = [...lines, ...shortFails, ...pauseLines].join('\n');
    }
    return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
  }

  /** 旧「每日汇总」正文：只服务于旧端点 /api/system/daily-summary?flowIds=（兼容一版） */
  async function pushLegacySummary(targets) {
    const s = store.stats();
    const text = `每日汇总：今日 ${s.todayRuns} 次（成功 ${s.todaySuccess} / 失败 ${s.todayFailed}，成功率 ${s.successRate ?? '—'}%）；任务 ${s.flows}，调度中 ${s.enabledScheduled}，下次 ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('zh-CN') : '—'}`;
    const groups = [];
    for (const target of targets) {
      const results = await sendToChannels(target.notify.channels, text, { title: '每日汇总', flowId: null, flowName: '', status: 'success' });
      groups.push({ flowId: target.id, flowName: target.name, results });
    }
    return { text, results: groups.flatMap((g) => g.results), groups };
  }

  let summaryInFlight = false;

  async function sendDailySummary(mode = 'cron', opts = {}) {
    const cfg = dailyConfig();
    const win = dayWindow(opts.date);
    if (mode !== 'manual' && cfg.lastSentDate === win.date) {
      return { ok: true, skipped: 'duplicate', window: win, date: win.date };
    }
    if (summaryInFlight) return { ok: true, skipped: 'in-flight', window: win, date: win.date };
    summaryInFlight = true;
    try {
      const stats = store.statsForRange(win.startMs, win.endMs);
      if (stats.empty && cfg.skipEmpty && mode !== 'manual') {
        console.log(`[CheckQ] dailySummary 跳过：${win.date} 没有任务运行`);
        return { ok: true, skipped: 'empty', window: win, date: win.date, counts: { runs: 0, success: 0, failed: 0 } };
      }
      const text = buildDailySummaryText(stats, { catchup: mode === 'catchup' });
      const level = (stats.failed || stats.paused.length) ? 'fail' : (stats.empty ? 'info' : 'success');
      const ctx = { title: '每日汇总', flowId: null, flowName: '', status: level === 'fail' ? 'failed' : 'success', level };
      const channels = store.getSystemChannels();
      const results = await sendToChannels(channels, text, ctx);
      const failed = results.filter((r) => !r.ok).map((r) => ({ type: r.type, error: String(r.error || '').slice(0, 60) }));
      const external = results.filter((r) => r.type !== 'inbox');
      const externalFailed = external.filter((r) => !r.ok);

      if (external.length && externalFailed.length === external.length) {
        store.addNotification({
          title: '汇总推送失败',
          content: `渠道 ${external.length} 个，成功 ${external.length - externalFailed.length}；${externalFailed.map((r) => `${r.type}: ${r.error}`).join('；')}`,
          level: 'fail', flowId: null, flowName: '',
        });
      }

      const lastResult = { ok: failed.length === 0, total: results.length, failed };
      const daily = store.meta.dailySummary || {};
      if (mode !== 'manual') {
        daily.lastSentDate = win.date;
        daily.lastSentAt = Date.now();
      }
      daily.lastResult = lastResult;
      store.meta.dailySummary = daily;
      store.flush();
      store.audit('notify.daily', `${mode} ${win.date}：${results.length - failed.length}/${results.length} 成功`, 'system');
      console.log(`[CheckQ] dailySummary ${mode} ${win.date} 已发送 ${results.length - failed.length}/${results.length}`);
      return { ok: failed.length === 0, skipped: null, window: win, date: win.date, text, results, lastResult, counts: { runs: stats.runs, success: stats.success, failed: stats.failed } };
    } catch (e) {
      console.error('[CheckQ] dailySummary 失败:', e.message);
      return { ok: false, error: e.message, window: win, date: win.date };
    } finally {
      summaryInFlight = false;
    }
  }

  function previewDailySummary(dateStr) {
    const win = dayWindow(dateStr);
    const stats = store.statsForRange(win.startMs, win.endMs);
    const cfg = dailyConfig();
    const skipped = stats.empty && cfg.skipEmpty ? 'empty' : null;
    return {
      text: buildDailySummaryText(stats, {}),
      window: win,
      counts: { enabledFlows: stats.enabledFlows, runs: stats.runs, success: stats.success, failed: stats.failed, failures: stats.failures.length, paused: stats.paused.length },
      skipped,
    };
  }

  runner.sendDailySummary = (mode = 'cron', opts = {}) => sendDailySummary(mode, opts);
  runner.previewDailySummary = (dateStr) => previewDailySummary(dateStr);
  runner.catchUpDailySummary = async () => {
    const cfg = dailyConfig();
    if (!cfg.enabled) return { ok: true, skipped: 'disabled' };
    const win = dayWindow();
    if (cfg.lastSentDate && cfg.lastSentDate >= win.date) return { ok: true, skipped: 'sent' };
    return sendDailySummary('catchup');
  };

  function renderNotifyTemplate(n, flow, run) {
    const tpl = (n.template || '[CheckQ] {{flow.name}} {{status}}\n{{message}}');
    const text = tpl
      .replace(/\{\{\s*flow\.name\s*\}\}/g, flow.name || '')
      .replace(/\{\{\s*status\s*\}\}/g, run.status === 'success' ? '成功 ✅' : '失败 ❌')
      .replace(/\{\{\s*message\s*\}\}/g, run.finalMessage || (run.logs?.at(-1)?.message || ''))
      .replace(/\{\{\s*duration\s*\}\}/g, `${((run.durationMs || 0) / 1000).toFixed(1)}s`)
      .replace(/\{\{\s*time\s*\}\}/g, new Date(run.startedAt || Date.now()).toLocaleString('zh-CN'));
    return redactText(text, collectSecrets(flow.vars));
  }

  // Cookie 一键回填（统一浏览器登录的备用路径）：把 document.cookie POST 到这里写入任务变量。
  // 注意：会话 cookie 是 SameSite=Strict，跨站书签脚本不会携带 qsid，且同源校验会拦跨站 Origin；
  // 因此该端点只在同域调用下可用。跨域场景请用「打开登录页 → 自动抓 Cookie」或手动粘贴。
  app.options('/api/cookie-capture', async (req, reply) => reply.code(204).send());
  app.post('/api/cookie-capture', async (req, reply) => {
    const { flowId, cookie, varName } = req.body || {};
    if (!flowId || !cookie) return reply.code(400).send({ error: '缺少 flowId/cookie' });
    const f = store.getFlow(flowId);
    if (!f) return reply.code(404).send({ error: '任务不存在' });
    if (!keyAllowsFlow(req, f)) return keyScopeDenied(reply);
    const name = /^[A-Za-z_][\w]*$/.test(varName || 'cookie') ? (varName || 'cookie') : 'cookie';
    store.updateFlow(flowId, { vars: { ...(f.vars || {}), [name]: String(cookie).trim() } });
    store.flush();
    return { ok: true, flowId, varName: name };
  });

  // 统一浏览器登录（Camofox 自动回填）：服务端开签到站登录页，用户在同一窗口登录后点「已登录，自动抓」
  // 原理：CheckQ 调 Camofox 新建 tab → navigate 到登录页 → 前端用户自行在该浏览器里操作（noVNC/镜像可见）→ 后端 evaluate 读 document.cookie 写回变量
  const camoBase = process.env.CAMOFOX_URL || 'http://checkq.local:9377';
  async function camo(method, path, body) {
    const res = await fetch(`${camoBase}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`camofox ${res.status}: ${String(text).slice(0, 200)}`);
    return data;
  }
  app.post('/api/browser-login/start', async (req, reply) => {
    const { flowId, url } = req.body || {};
    const f = flowId ? store.getFlow(flowId) : null;
    if (f && !keyAllowsFlow(req, f)) return keyScopeDenied(reply);
    if (!f && !keyHasFullFlowScope(req)) return keyScopeDenied(reply);
    if (!url || !/^https?:\/\//i.test(String(url))) return reply.code(400).send({ error: '缺少合法 url' });
    const userId = `checkq-${f?.id || 'anon'}`;
    try {
      const tab = await camo('POST', '/tabs', { userId, sessionKey: 'login', url });
      return { ok: true, tabId: tab.tabId || tab.id || tab, url };
    } catch (e) {
      return reply.code(502).send({ error: `统一浏览器打不开：${e.message}` });
    }
  });
  app.post('/api/browser-login/capture', async (req, reply) => {
    const { flowId, tabId, varName } = req.body || {};
    const f = flowId ? store.getFlow(flowId) : null;
    if (!f || !tabId) return reply.code(400).send({ error: '缺少 flowId/tabId' });
    if (!keyAllowsFlow(req, f)) return keyScopeDenied(reply);
    const userId = `checkq-${f.id}`;
    try {
      const ev = await camo('POST', `/tabs/${tabId}/evaluate`, { userId, expression: 'document.cookie' });
      const cookie = String(ev.result || '').trim();
      if (!cookie) return reply.code(400).send({ error: '当前页面还没有 cookie（可能未登录）' });
      const name = /^[A-Za-z_][\w]*$/.test(varName || 'cookie') ? (varName || 'cookie') : 'cookie';
      store.updateFlow(flowId, { vars: { ...(f.vars || {}), [name]: cookie } });
      store.flush();
      return { ok: true, flowId, varName: name, length: cookie.length };
    } catch (e) {
      return reply.code(502).send({ error: `抓取失败：${e.message}` });
    }
  });

  const scheduler = new Scheduler(store, runner);
  scheduler.start();

  app.register(cookie);
  app.register(multipart);

  // ---- 安全响应头 + 同源校验（防 CSRF / 点击劫持 / MIME 嗅探）----
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // COOP/COEP 只在 HTTPS（或 localhost）下有意义：明文 HTTP 属于「不可信来源」，
    // 浏览器会直接忽略这些头并在控制台报错（每开一页都报一次）。按协议条件发送。
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim();
    const secure = proto === 'https' || (req.headers.host || '').split(':')[0] === 'localhost';
    if (secure) reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  // 写操作必须同源（浏览器会带 Origin；跨站表单/图片不会带同源 Origin）
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (CSRF_SAFE.has(req.url.split('?')[0])) return;
    if (req.headers['x-api-key'] && !req.cookies?.qsid) return;
    const origin = req.headers.origin;
    if (!origin) return; // 非浏览器客户端（脚本/MCP/测试）不拦
    let host = '';
    try { host = new URL(origin).host; } catch { host = ''; }
    const self = req.headers.host;
    if (host && self && host !== self) {
      return reply.code(403).send({ error: '跨站请求被拒绝（CSRF 防护）' });
    }
  });

  // ---- auth ----
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];

    // 0) 全局 IP 黑名单（登录与 API Key 都拦）
    const ip = clientIp(req);
    if (ip && store.listBlockedIps().some((rule) => ipAllowed(ip, [rule]))) {
      store.audit('ip.blocked', `IP=${ip}`, '');
      return reply.code(403).send({ error: `IP ${ip} 已被列入黑名单` });
    }

    // 1) API Key（外部 Agent / 脚本）：先识别，再按作用域判定
    const auth = req.headers['x-api-key'];
    if (auth) {
      const key = store.findApiKeyByHash(hashApiKey(auth), ip);
      if (key) {
        // 3) Key 级 IP 允许名单（空 = 不限制）
        if (Array.isArray(key.allowedIps) && key.allowedIps.length && !ipAllowed(ip, key.allowedIps)) {
          store.audit('apikey.ip-denied', `名称=${key.name} IP=${ip}`, '');
          return reply.code(403).send({ error: `IP ${ip} 不在该 API Key 的允许名单内` });
        }
        // 到期回收：过期 Key 直接失效并从库里清掉
        if (key.expiresAt && key.expiresAt < Date.now()) {
          store.revokeApiKey(key.id);
          store.audit('apikey.expired', `名称=${key.name}`, '');
          return reply.code(401).send({ error: `API Key 已过期并被回收（${key.name}）`, expired: true });
        }
        // 作用域：read=查看 / run=运行任务 / write=增删改配置 / secrets=读取明文凭据
        const scopes = Array.isArray(key.scopes) ? key.scopes : ['read', 'run', 'write'];
        const isRun = /^\/api\/flows\/[^/]+\/run$/.test(path) || /^\/api\/runs\/[^/]+\/cancel$/.test(path);
        const scopeOk = path === '/api/mcp'
          ? scopes.length > 0
          : ['GET', 'HEAD'].includes(req.method)
            ? scopes.includes('read')
            : path === '/api/flows/validate'
              ? (scopes.includes('read') || scopes.includes('write'))
              : path === '/api/flows/batch'
                ? (scopes.includes('run') || scopes.includes('write'))
                : isRun ? scopes.includes('run') : scopes.includes('write');
        if (!scopeOk) {
          const need = ['GET', 'HEAD'].includes(req.method) ? 'read' : (isRun ? 'run' : 'write');
          return reply.code(403).send({ error: `API Key 权限不足：需要 ${need}，当前仅 ${scopes.join('/') || '无'}` });
        }
        req.apiKey = key;
        req.apiKeyScopes = scopes;
        // 任务范围：路径里出现 flow id 时先拦（/api/flows/batch 与 validate 由处理器处理）
        const fm = path.match(/^\/api\/flows\/([^/]+)(?:\/|$)/);
        if (fm && fm[1] !== 'batch' && fm[1] !== 'validate') {
          const target = store.getFlowRaw(fm[1]);
          if (target && !keyAllowsFlow(req, target)) return keyScopeDenied(reply);
        }
        return;
      }
      // 兼容旧的单条 meta.apiKey（全权限）
      if (store.meta.apiKey && auth === store.meta.apiKey) { req.legacyApiKey = true; return; }
    }

    // 2) 浏览器会话
    const sess = currentSession(req);
    if (sess) {
      const user = store.getUser(sess.userId);
      if (!user || user.disabled) { sessions.delete(sess.qsid); return reply.code(401).send({ error: '账号不可用' }); }
      req.user = user;
      req.session = sess;
      // 只读角色：禁止一切写操作
      if (user.role === 'viewer' && !['GET', 'HEAD'].includes(req.method)) {
        return reply.code(403).send({ error: '只读账号不能执行写操作' });
      }
      return;
    }

    // 3) 公开接口（演练端点必须免登录：任务自己是靠本机 fetch 打它们的）
    const pub = path === '/api/login' || path === '/api/health' || path === '/api/system/bootstrap' || path === '/api/me'
      || path === '/api' || path === '/api/openapi.json' || !path.startsWith('/api/')
      || path === '/api/demo/profile' || path === '/api/demo/checkin' || path === '/api/demo/items';
    if (pub) return;
    return reply.code(401).send({ error: '未登录' });
  });

  /** 需要管理员 */
  const requireAdmin = (req, reply) => {
    if (req.user && req.user.role === 'admin') return true;
    reply.code(403).send({ error: '需要管理员权限' });
    return false;
  };

  app.post('/api/login', async (req, reply) => {
    // 与全局 IP 黑名单同口径：优先 X-Forwarded-For（反代场景下 req.ip 全是网关地址）
    const ip = clientIp(req) || 'unknown';
    if (loginLocked(ip)) {
      return reply.code(429).send({ error: '登录失败次数过多，请 10 分钟后再试' });
    }
    const { username, password, code } = req.body || {};
    // 未给用户名时：只有一个账号就用它，否则默认 admin
    const name = String(username || (store.meta.users.length === 1 ? store.meta.users[0].username : 'admin')).trim();
    const user = store.getUserByName(name);

    const fail = (msg, code2 = 401) => {
      noteLoginFail(ip);
      if (user) {
        user.failedLogins = (user.failedLogins || 0) + 1;
        if (user.failedLogins >= ACCOUNT_FAIL_LIMIT) user.lockedUntil = Date.now() + ACCOUNT_FAIL_WINDOW;
        store.flush();
      }
      if (loginLocked(ip)) return reply.code(429).send({ error: '登录失败次数过多，请 10 分钟后再试' });
      return reply.code(code2).send({ error: msg });
    };

    if (user && user.lockedUntil && user.lockedUntil > Date.now()) {
      const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      return reply.code(429).send({ error: `账号已锁定，请 ${mins} 分钟后重试` });
    }

    // 用户不存在也要走一次 scrypt，避免用户名枚举（时序一致）
    const dummy = '00:' + crypto.createHash('sha256').update('dummy').digest('hex');
    const okPwd = verifyPwd(password || '', user ? user.passwordHash : dummy);
    if (!user || user.disabled || !okPwd) {
      store.audit('login.fail', `用户名=${name}`, '');
      return fail('用户名或密码错误');
    }

    // 两步验证
    if (user.totp?.enabled) {
      if (!code) {
        return reply.code(401).send({ error: '需要两步验证码', needTotp: true });
      }
      const input = String(code).trim();
      const matchedStep = verifyTotpStep(user.totp.secret, input, 1, user.totp.lastLoginStep ?? null);
      let ok2fa = false;
      if (matchedStep !== null) {
        user.totp.lastLoginStep = matchedStep;
        store.flush();
        ok2fa = true;
      } else {
        // 恢复码（一次性）
        const idx = (user.recoveryCodes || []).findIndex((h) => verifyRecoveryCode(input, h));
        if (idx >= 0) {
          user.recoveryCodes.splice(idx, 1);
          store.flush();
          ok2fa = true;
        }
      }
      if (!ok2fa) {
        store.audit('login.2fa-fail', `用户名=${name}`, name);
        return fail('两步验证码错误');
      }
    }

    loginFails.delete(ip);
    user.failedLogins = 0;
    user.lockedUntil = null;
    user.lastLoginAt = Date.now();
    store.flush();

    const qsid = crypto.randomBytes(24).toString('base64url');
    sessions.set(qsid, {
      userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now(),
      ip, ua: String(req.headers['user-agent'] || '').slice(0, 120), expiresAt: Date.now() + SESSION_TTL,
    });
    reply.setCookie('qsid', qsid, { path: '/', httpOnly: true, sameSite: 'strict', maxAge: 7 * 86400 });
    store.audit('login.ok', `用户名=${name}`, user.username);
    return { ok: true, user: { username: user.username, displayName: user.displayName, role: user.role, totpEnabled: !!user.totp?.enabled } };
  });

  app.post('/api/logout', async (req, reply) => {
    const qsid = req.cookies?.qsid;
    if (qsid) sessions.delete(qsid);
    reply.clearCookie('qsid', { path: '/' });
    return { ok: true };
  });

  // 当前登录信息（供前端显示用户名/角色）
  app.get('/api/me', async (req) => {
    // API Key 调用方（外部 Agent）：返回 key 身份与权限范围
    if (req.apiKey) {
      return {
        authenticated: true,
        via: 'api-key',
        apiKey: {
          prefix: req.apiKey.prefix, name: req.apiKey.name, scopes: req.apiKeyScopes || [],
          flowIds: req.apiKey.flowIds || [], groups: req.apiKey.groups || [],
        },
        permissions: {
          read: true,
          run: (req.apiKeyScopes || []).includes('run'),
          write: (req.apiKeyScopes || []).includes('write'),
          secrets: (req.apiKeyScopes || []).includes('secrets'),
          scope: (req.apiKey.flowIds || []).length || (req.apiKey.groups || []).length ? 'limited' : 'all',
        },
      };
    }
    const sess = currentSession(req);
    if (!sess) return { authenticated: false };
    const user = store.getUser(sess.userId);
    if (!user) return { authenticated: false };
    return {
      authenticated: true,
      user: {
        id: user.id, username: user.username, displayName: user.displayName || user.username,
        role: user.role, totpEnabled: !!user.totp?.enabled,
        recoveryCodesLeft: (user.recoveryCodes || []).length,
        lastLoginAt: user.lastLoginAt || null, passwordUpdatedAt: user.passwordUpdatedAt || null,
      },
      session: { createdAt: sess.createdAt, ip: sess.ip, ua: sess.ua },
    };
  });

  // ---- 我的会话 ----
  app.get('/api/system/sessions', async (req) => {
    const me = req.user;
    if (!me) return { sessions: [] };
    const current = req.cookies?.qsid;
    return {
      sessions: sessionsOf(me.id).map((id) => {
        const s = sessions.get(id);
        return { id, current: id === current, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, ua: s.ua };
      }).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    };
  });

  app.delete('/api/system/sessions/:id', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    const s = sessions.get(req.params.id);
    if (!s || s.userId !== me.id) return reply.code(404).send({ error: '会话不存在' });
    sessions.delete(req.params.id);
    store.audit('session.revoke', `会话=${req.params.id.slice(0, 8)}`, me.username);
    return { ok: true };
  });

  app.post('/api/system/logout-all', async (req) => {
    const me = req.user;
    if (!me) return { ok: false };
    for (const id of sessionsOf(me.id)) sessions.delete(id);
    store.audit('logout.all', '', me.username);
    return { ok: true };
  });

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  // ---- 基础 API：索引与机器可读描述（外部 Agent 自助发现）----
  app.get('/api', async () => ({
    name: 'CheckQ API',
    version: VERSION,
    description: 'CheckQ 自动化签到引擎的对外 REST 接口',
    auth: {
      apiKey: { header: 'x-api-key', where: '设置 → API Key 生成（可设作用域与回收日期）', scopes: ['read', 'run', 'write'] },
      session: { cookie: 'qsid', where: 'POST /api/login 登录后自动携带' },
    },
    openapi: '/api/openapi.json',
    docs: 'docs/AGENT-ACCESS.md · docs/API.md',
    agentGuide: '/api/openapi.json',
    mcp: '/api/mcp',
    endpoints: {
      flows: ['GET /api/flows', 'POST /api/flows', 'POST /api/flows/validate', 'GET /api/flows/:id', 'PUT /api/flows/:id', 'PATCH /api/flows/:id/vars', 'DELETE /api/flows/:id', 'POST /api/flows/:id/run', 'GET /api/flows/:id/logs', 'POST /api/flows/batch'],
      runs: ['GET /api/runs?flowId=', 'GET /api/runs/:id', 'POST /api/runs/:id/cancel', 'GET /api/runs/:id/har'],
      templates: ['GET /api/templates', 'GET /api/templates/:id', 'POST /api/templates/:id/instantiate'],
      meta: ['GET /api/health', 'GET /api/me', 'GET /api/system/stats', 'GET /api/system/push-targets', 'GET /api/notifications', 'POST /api/mcp'],
      keys: ['GET /api/system/apikeys', 'POST /api/system/apikeys', 'PUT /api/system/apikeys/:id', 'DELETE /api/system/apikeys/:id'],
    },
  }));

  // OpenAPI 3.1（机器可读，供 Agent 自动生成客户端）
  app.get('/api/openapi.json', async () => buildOpenApi());

  // Streamable HTTP MCP (JSON-RPC 2.0) —— 沿用当前请求的 API Key / 会话作用域与 IP ACL
  app.post('/api/mcp', async (req, reply) => {
    const msg = req.body;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined && msg.id !== null;
    const id = msg.id ?? null;
    try {
      if (msg.method === 'initialize') {
        if (!hasId) return reply.code(204).send();
        return {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'checkq-mcp', version: VERSION } },
        };
      }
      if (msg.method === 'notifications/initialized') {
        return hasId ? { jsonrpc: '2.0', id, result: {} } : reply.code(204).send();
      }
      if (!hasId) return reply.code(204).send();
      if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (msg.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      if (msg.method === 'tools/call') {
        const callApi = async (method, url, body) => {
          const headers = {};
          if (req.headers.cookie) headers.cookie = req.headers.cookie;
          if (req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'];
          if (req.headers['x-forwarded-for']) headers['x-forwarded-for'] = req.headers['x-forwarded-for'];
          if (body !== undefined) headers['content-type'] = 'application/json';
          const res = await app.inject({
            method,
            url,
            headers,
            ...(body !== undefined ? { payload: body } : {}),
          });
          let data;
          try { data = res.json(); } catch { data = res.body; }
          if (res.statusCode >= 400) {
            throw new Error((data && data.error) || `HTTP ${res.statusCode}`);
          }
          return data;
        };
        try {
          const res = await executeMcpTool(msg.params?.name, msg.params?.arguments, callApi);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] },
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: err.message }], isError: true },
          };
        }
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } };
    }
  });

  // 首次启动：还没有任何账号时，引导创建管理员（用户名 + 密码）
  app.get('/api/system/bootstrap', async () => ({
    needsSetup: store.meta.users.length === 0,
    username: store.meta.users[0]?.username || 'admin',
    hasUsers: store.meta.users.length > 0,
  }));
  app.post('/api/system/bootstrap', async (req, reply) => {
    if (store.meta.users.length) return reply.code(400).send({ error: '账号已存在，无需初始化' });
    const { username = 'admin', password } = req.body || {};
    const nameErr = checkUsername(username);
    if (nameErr) return reply.code(400).send({ error: nameErr });
    const pwdErr = checkPassword(password, username);
    if (pwdErr) return reply.code(400).send({ error: pwdErr });
    store.createUser({ username, password, role: 'admin', displayName: '管理员' });
    store.audit('bootstrap', `创建管理员 ${username}`, username);
    for (const id of [...sessions.keys()]) sessions.delete(id);
    return { ok: true };
  });


  // ---- 两步验证（TOTP）----
  // 1) 开始绑定：生成密钥（此时未启用）
  app.post('/api/system/2fa/enroll', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    const { password } = req.body || {};
    if (!verifyPwd(password || '', me.passwordHash)) return reply.code(401).send({ error: '密码不正确' });
    if (me.totp?.enabled) return reply.code(400).send({ error: '已启用两步验证，请先关闭' });
    const secret = generateSecret();
    me.totp = { enabled: false, secret, createdAt: Date.now() };
    store.flush();
    store.audit('2fa.enroll-start', `用户=${me.username}`, me.username);
    return { ok: true, secret, uri: otpauthUri({ secret, account: me.username }), digits: 6, period: 30 };
  });

  const twoFaFails = new Map();
  const twoFaLocked = (uid) => {
    const rec = twoFaFails.get(uid);
    if (!rec) return false;
    if (Date.now() - rec.firstAt > LOGIN_FAIL_WINDOW) { twoFaFails.delete(uid); return false; }
    return rec.count >= LOGIN_FAIL_LIMIT;
  };
  const noteTwoFaFail = (uid) => {
    const now = Date.now();
    const rec = twoFaFails.get(uid);
    if (!rec || now - rec.firstAt > LOGIN_FAIL_WINDOW) twoFaFails.set(uid, { count: 1, firstAt: now });
    else rec.count++;
  };

  // 2) 确认绑定：校验一次验证码 → 启用 + 生成恢复码（明文只返回这一次）
  app.post('/api/system/2fa/confirm', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    if (twoFaLocked(me.id)) return reply.code(429).send({ error: '验证失败次数过多，请 10 分钟后再试' });
    const { code } = req.body || {};
    if (!me.totp?.secret) return reply.code(400).send({ error: '尚未开始绑定' });
    if (verifyTotpStep(me.totp.secret, code, 1) === null) {
      noteTwoFaFail(me.id);
      return reply.code(400).send({ error: '验证码错误' });
    }
    twoFaFails.delete(me.id);
    const codes = generateRecoveryCodes(10);
    me.totp = { ...me.totp, enabled: true, confirmedAt: Date.now() };
    me.recoveryCodes = codes.map(hashRecoveryCode);
    store.flush();
    store.audit('2fa.enable', `用户=${me.username}`, me.username);
    return { ok: true, recoveryCodes: codes };
  });

  // 3) 关闭两步验证（需密码 + 当前验证码）
  app.post('/api/system/2fa/disable', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    if (twoFaLocked(me.id)) return reply.code(429).send({ error: '验证失败次数过多，请 10 分钟后再试' });
    const { password, code } = req.body || {};
    if (!verifyPwd(password || '', me.passwordHash)) { noteTwoFaFail(me.id); return reply.code(401).send({ error: '密码不正确' }); }
    if (!me.totp?.enabled) return reply.code(400).send({ error: '未启用两步验证' });
    if (verifyTotpStep(me.totp.secret, code, 1) === null) { noteTwoFaFail(me.id); return reply.code(400).send({ error: '验证码错误' }); }
    twoFaFails.delete(me.id);
    me.totp = null;
    me.recoveryCodes = [];
    store.flush();
    store.audit('2fa.disable', `用户=${me.username}`, me.username);
    return { ok: true };
  });

  // 4) 重新生成恢复码
  app.post('/api/system/2fa/recovery-codes', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    if (twoFaLocked(me.id)) return reply.code(429).send({ error: '验证失败次数过多，请 10 分钟后再试' });
    const { password, code } = req.body || {};
    if (!verifyPwd(password || '', me.passwordHash)) { noteTwoFaFail(me.id); return reply.code(401).send({ error: '密码不正确' }); }
    if (!me.totp?.enabled) return reply.code(400).send({ error: '未启用两步验证' });
    if (verifyTotpStep(me.totp.secret, code, 1) === null) { noteTwoFaFail(me.id); return reply.code(400).send({ error: '验证码错误' }); }
    twoFaFails.delete(me.id);
    const codes = generateRecoveryCodes(10);
    me.recoveryCodes = codes.map(hashRecoveryCode);
    store.flush();
    store.audit('2fa.recovery-codes', `用户=${me.username}`, me.username);
    return { ok: true, recoveryCodes: codes };
  });

  // ---- 用户管理（仅管理员）----
  app.get('/api/system/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { users: store.listUsers(), roles: ROLES, passwordMin: PASSWORD_MIN };
  });

  app.post('/api/system/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { username, password, role = 'operator', displayName } = req.body || {};
    const nameErr = checkUsername(username);
    if (nameErr) return reply.code(400).send({ error: nameErr });
    if (store.getUserByName(username)) return reply.code(400).send({ error: '用户名已存在' });
    if (!ROLES.includes(role)) return reply.code(400).send({ error: '角色无效' });
    const pwdErr = checkPassword(password, username);
    if (pwdErr) return reply.code(400).send({ error: pwdErr });
    const u = store.createUser({ username, password, role, displayName });
    store.audit('user.create', `用户=${u.username} 角色=${role}`, req.user.username);
    return { ok: true, user: store.listUsers().find((x) => x.id === u.id) };
  });

  app.put('/api/system/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = store.getUser(req.params.id);
    if (!u) return reply.code(404).send({ error: '用户不存在' });
    const { role, disabled, displayName, username } = req.body || {};
    if (role !== undefined) {
      if (!ROLES.includes(role)) return reply.code(400).send({ error: '角色无效' });
      if (u.id === req.user.id && role !== 'admin') return reply.code(400).send({ error: '不能降低自己的管理员权限' });
      if (u.role === 'admin' && role !== 'admin') {
        const admins = store.meta.users.filter((x) => x.role === 'admin' && !x.disabled).length;
        if (admins <= 1) return reply.code(400).send({ error: '至少保留一个管理员' });
      }
    }
    if (disabled !== undefined && u.id === req.user.id && disabled) {
      return reply.code(400).send({ error: '不能停用自己的账号' });
    }
    if (username !== undefined) {
      const nameErr = checkUsername(username);
      if (nameErr) return reply.code(400).send({ error: nameErr });
      if (store.getUserByName(username) && store.getUserByName(username).id !== u.id) {
        return reply.code(400).send({ error: '用户名已存在' });
      }
    }
    const patch = {};
    if (role !== undefined) patch.role = role;
    if (disabled !== undefined) patch.disabled = !!disabled;
    if (displayName !== undefined) patch.displayName = displayName;
    if (username !== undefined) patch.username = username;
    store.updateUser(u.id, patch);
    if (patch.disabled) for (const id of sessionsOf(u.id)) sessions.delete(id);
    store.audit('user.update', `用户=${u.username}`, req.user.username);
    return { ok: true, user: store.listUsers().find((x) => x.id === u.id) };
  });

  // 管理员重置他人密码（强制该用户下次登录改密由管理员分配新密码）
  app.post('/api/system/users/:id/password', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = store.getUser(req.params.id);
    if (!u) return reply.code(404).send({ error: '用户不存在' });
    const { password } = req.body || {};
    const pwdErr = checkPassword(password, u.username);
    if (pwdErr) return reply.code(400).send({ error: pwdErr });
    store.updateUser(u.id, { passwordHash: hashPwd(String(password)) });
    for (const id of sessionsOf(u.id)) sessions.delete(id);
    store.audit('user.reset-password', `用户=${u.username}`, req.user.username);
    return { ok: true };
  });

  // 管理员重置他人 2FA（用户丢失验证器时用）
  app.post('/api/system/users/:id/2fa/reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = store.getUser(req.params.id);
    if (!u) return reply.code(404).send({ error: '用户不存在' });
    store.updateUser(u.id, { totp: null, recoveryCodes: [] });
    for (const id of sessionsOf(u.id)) sessions.delete(id);
    store.audit('user.2fa-reset', `用户=${u.username}`, req.user.username);
    return { ok: true };
  });

  app.delete('/api/system/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = store.getUser(req.params.id);
    if (!u) return reply.code(404).send({ error: '用户不存在' });
    if (u.id === req.user.id) return reply.code(400).send({ error: '不能删除自己的账号' });
    if (u.role === 'admin' && store.meta.users.filter((x) => x.role === 'admin' && !x.disabled).length <= 1) {
      return reply.code(400).send({ error: '至少保留一个管理员' });
    }
    for (const id of sessionsOf(u.id)) sessions.delete(id);
    store.deleteUser(u.id);
    store.audit('user.delete', `用户=${u.username}`, req.user.username);
    return { ok: true };
  });

  // 审计日志（仅管理员）
  app.get('/api/system/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { entries: store.listAudit(Number(req.query?.limit) || 100) };
  });

  // 设置：改密 / API Key（单用户）
  app.get('/api/system/settings', async (req) => ({
    hasApiKey: !!store.meta.apiKey || store.meta.apiKeys.length > 0,
    apiKey: store.meta.apiKey ? store.meta.apiKey.slice(0, 8) + '…' : null,
    apiKeys: req.user?.role === 'admin' ? store.listApiKeys() : [],
    userCount: store.meta.users.length,
  }));
  // 修改自己的用户名 / 显示名
  // 对齐 qinglong「安全设置 → 修改用户名密码」：改用户名后强制重新登录（吊销全部会话）
  app.put('/api/system/account', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    const { username, displayName, currentPassword } = req.body || {};
    const patch = {};
    let reauth = false;

    if (username !== undefined && String(username).trim() !== me.username) {
      const name = String(username).trim();
      const nameErr = checkUsername(name);
      if (nameErr) return reply.code(400).send({ error: nameErr });
      const exist = store.getUserByName(name);
      if (exist && exist.id !== me.id) return reply.code(400).send({ error: '用户名已存在' });
      if (!verifyPwd(currentPassword || '', me.passwordHash)) {
        store.audit('account.username-fail', `用户=${me.username}`, me.username);
        return reply.code(401).send({ error: '当前密码不正确' });
      }
      patch.username = name;
      reauth = true;
    }
    if (displayName !== undefined) patch.displayName = String(displayName).trim().slice(0, 40) || patch.username || me.username;

    if (!Object.keys(patch).length) return { ok: true, reauth: false };
    store.updateUser(me.id, patch);
    store.audit(reauth ? 'account.username' : 'account.displayName', `用户=${me.username} → ${patch.username || me.username}`, me.username);

    if (reauth) {
      // 用户名变更 → 所有会话失效（需用新用户名重新登录）
      for (const id of sessionsOf(me.id)) sessions.delete(id);
      reply.clearCookie('qsid', { path: '/' });
    }
    return { ok: true, reauth, user: { username: patch.username || me.username, displayName: patch.displayName || me.displayName } };
  });

  // 修改自己的密码（需校验旧密码；改密后其他会话失效）
  app.post('/api/system/password', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    const { oldPassword, newPassword } = req.body || {};
    if (!verifyPwd(oldPassword || '', me.passwordHash)) {
      store.audit('password.fail', `用户=${me.username}`, me.username);
      return reply.code(401).send({ error: '当前密码不正确' });
    }
    const err = checkPassword(newPassword, me.username);
    if (err) return reply.code(400).send({ error: err });
    if (verifyPwd(newPassword || '', me.passwordHash)) return reply.code(400).send({ error: '新密码不能与当前密码相同' });
    store.updateUser(me.id, { passwordHash: hashPwd(String(newPassword)) });
    store.audit('password.change', `用户=${me.username}`, me.username);
    const current = req.cookies?.qsid;
    for (const id of sessionsOf(me.id)) if (id !== current) sessions.delete(id);
    return { ok: true };
  });
  // API Key：明文只在创建时返回一次，服务端只存 sha256 摘要
  app.get('/api/system/apikeys', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { keys: store.listApiKeys() };
  });
  app.post('/api/system/apikeys', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name, scopes } = req.body || {};
    const wanted = Array.isArray(scopes) ? scopes.filter((s) => API_KEY_SCOPES.includes(s)) : [];
    const useScopes = Array.isArray(scopes) ? wanted : ['read', 'run', 'write'];
    // 任务范围：flowIds / groups 为空 = 全部任务；填了则只允许这些任务或分组
    const flowIds = Array.isArray(req.body?.flowIds)
      ? [...new Set(req.body.flowIds.map(String).filter(Boolean))]
      : [];
    const missing = flowIds.filter((id) => !store.getFlowRaw(id));
    if (missing.length) return reply.code(400).send({ error: `任务不存在：${missing.slice(0, 3).join(', ')}` });
    const groups = Array.isArray(req.body?.groups)
      ? [...new Set(req.body.groups.map((g) => String(g || '').trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean))]
      : [];
    // 回收日期：expiresAt（毫秒时间戳）；null = 永不过期
    let expiresAt = null;
    if (req.body && req.body.expiresAt) {
      const d = new Date(req.body.expiresAt);
      if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: '回收日期格式无效（用 YYYY-MM-DD）' });
      if (d.getTime() <= Date.now()) return reply.code(400).send({ error: '回收日期必须晚于现在' });
      expiresAt = d.getTime();
    }
    const allowedIps = Array.isArray(req.body?.allowedIps)
      ? req.body.allowedIps.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const { key, hash, prefix } = newApiKey();
    const k = store.addApiKey({
      name: String(name || 'API Key').slice(0, 40), hash, prefix, userId: req.user?.id || null,
      scopes: useScopes, expiresAt, allowedIps, flowIds, groups,
    });
    const scopeText = flowIds.length || groups.length ? ` 范围=${flowIds.length ? flowIds.length + ' 个任务' : ''}${flowIds.length && groups.length ? '+' : ''}${groups.length ? groups.length + ' 个分组' : ''}` : ' 范围=全部';
    store.audit('apikey.create', `名称=${k.name} 权限=${useScopes.join('/')}${scopeText}${expiresAt ? ' 到期=' + new Date(expiresAt).toISOString().slice(0, 10) : ''}`, req.user?.username || '');
    return { ok: true, apiKey: key, key: { id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, scopes: useScopes, expiresAt, allowedIps, flowIds, groups } };
  });
  app.put('/api/system/apikeys/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const patch = {};
    const b = req.body || {};
    if (Array.isArray(b.scopes)) patch.scopes = b.scopes.filter((s) => API_KEY_SCOPES.includes(s));
    if (Array.isArray(b.allowedIps)) patch.allowedIps = b.allowedIps.map((x) => String(x || '').trim()).filter(Boolean);
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 40);
    if (Array.isArray(b.flowIds)) {
      const flowIds = [...new Set(b.flowIds.map(String).filter(Boolean))];
      const missing = flowIds.filter((id) => !store.getFlowRaw(id));
      if (missing.length) return reply.code(400).send({ error: `任务不存在：${missing.slice(0, 3).join(', ')}` });
      patch.flowIds = flowIds;
    }
    if (Array.isArray(b.groups)) {
      patch.groups = [...new Set(b.groups.map((g) => String(g || '').trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean))];
    }
    if (b.expiresAt !== undefined) {
      if (!b.expiresAt) patch.expiresAt = null;
      else {
        const d = new Date(b.expiresAt);
        if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: '回收日期格式无效' });
        patch.expiresAt = d.getTime();
      }
    }
    const k = store.updateApiKey(req.params.id, patch);
    if (!k) return reply.code(404).send({ error: '不存在' });
    store.audit('apikey.update', `名称=${k.name}`, req.user?.username || '');
    return { ok: true, key: store.listApiKeys().find((x) => x.id === k.id) };
  });

  // ---- IP 黑名单（全局）----
  app.get('/api/system/ip-blocklist', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ips: store.listBlockedIps() };
  });
  app.put('/api/system/ip-blocklist', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ip = String((req.body || {}).ip || '').trim();
    if (!ip) return reply.code(400).send({ error: 'IP 不能为空' });
    store.blockIp(ip);
    store.audit('ip.block', `IP=${ip}`, req.user?.username || '');
    return { ok: true, ips: store.listBlockedIps() };
  });
  app.delete('/api/system/ip-blocklist/:ip', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    store.unblockIp(req.params.ip);
    store.audit('ip.unblock', `IP=${req.params.ip}`, req.user?.username || '');
    return { ok: true, ips: store.listBlockedIps() };
  });

  app.delete('/api/system/apikeys/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ok = store.revokeApiKey(req.params.id);
    if (!ok) return reply.code(404).send({ error: '不存在' });
    store.audit('apikey.revoke', `id=${req.params.id.slice(0, 8)}`, req.user?.username || '');
    return { ok: true };
  });
  // 兼容旧接口（单 key）
  app.post('/api/system/apikey', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { key, hash, prefix } = newApiKey();
    store.meta.apiKey = key; // 兼容旧字段（明文仅此一次由管理员自行保管）
    store.addApiKey({ name: '默认 Key', hash, prefix, userId: req.user?.id || null });
    store.audit('apikey.create', '默认 Key', req.user?.username || '');
    return { apiKey: key };
  });

  // ---- AI 助手（快速组装 LLM）：OpenAI 兼容接口 ----
  // 安全边界：Key 只存 meta（落盘加密）、读取只回显前缀；写配置/测试连接仅 admin；
  // generate 需登录（API Key 需 write 作用域）；所有调用统一超时、错误脱敏、审计（不记 Key 与完整 prompt）。
  const AI_TIMEOUT_MIN = 5;
  const AI_TIMEOUT_MAX = 120;
  const AI_TIMEOUT_DEFAULT = 60;
  const AI_MAXTOKENS_MIN = 1;
  const AI_MAXTOKENS_MAX = 4096;
  const AI_MAXTOKENS_DEFAULT = 1024;
  const AI_MAX_NODES = 6;
  const AI_MAX_EDGES = 8;
  const AI_NODE_TYPES = new Set(['http', 'log', 'set', 'delay', 'extract', 'condition', 'random-delay']);
  const AI_BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const AI_RATE_LIMIT = 30;             // 每账号/Key 每分钟最多 30 次 AI 调用（generate + test）
  const AI_RATE_WINDOW = 60e3;
  const aiHits = new Map(); // `${actor}:${action}` -> { count, firstAt }

  const aiActor = (req) => req.user?.username || (req.apiKey ? `key:${req.apiKey.prefix}` : '') || clientIp(req);
  const aiInt = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const aiConfig = () => {
    const a = store.meta.ai || {};
    return {
      baseUrl: String(a.baseUrl || ''),
      apiKey: String(a.apiKey || ''),
      model: String(a.model || ''),
      timeoutSec: aiInt(a.timeoutSec, AI_TIMEOUT_MIN, AI_TIMEOUT_MAX, AI_TIMEOUT_DEFAULT),
      maxTokens: aiInt(a.maxTokens, AI_MAXTOKENS_MIN, AI_MAXTOKENS_MAX, AI_MAXTOKENS_DEFAULT),
    };
  };
  const maskAiKey = (key) => {
    const s = String(key || '');
    if (!s) return '';
    // 短 Key 不暴露任何字符；长 Key 只留 4 位前缀，避免「打码」泄露过多
    return s.length <= 12 ? '***…' : s.slice(0, 4) + '…';
  };
  /** 错误/审计文案脱敏：去掉 Key、Authorization 头，截断长度 */
  const aiSafeText = (text, key = '') => {
    let s = String(text || '');
    if (key) s = s.split(String(key)).join('***');
    s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
    s = s.replace(/sk-[A-Za-z0-9._\-]{6,}/g, 'sk-***');
    return s.slice(0, 300);
  };
  /** baseUrl 归一化：只接受 http(s)，去尾部 /，兼容 .../v1/chat/completions 并保留查询参数（如 Azure api-version） */
  const normalizeAiBaseUrl = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return { url: '' };
    let u;
    try { u = new URL(s); } catch { return { error: 'Base URL 不是合法地址（例：https://api.deepseek.com/v1）' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Base URL 只支持 http(s)' };
    if (u.username || u.password) return { error: 'Base URL 不能包含账号密码' };
    u.hash = '';
    const cleanPath = u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    return { url: `${u.origin}${cleanPath}${u.search}` };
  };
  const extractAiContent = (msg) => {
    const c = msg?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((p) => (typeof p === 'string' ? p : String(p?.text || p?.content || ''))).join('');
    }
    return '';
  };
  const stripAiThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  class AiError extends Error {
    constructor(message, status = 502) { super(message); this.status = status; }
  }
  /** 限制成功响应的读取量。 */
  const aiReadText = async (res, limit) => {
    if (!res.body || typeof res.body.getReader !== 'function') return '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let out = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
        if (out.length >= limit) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
      }
      out += dec.decode();
    } catch { /* 读取中断时保留已读内容 */ }
    return out.slice(0, limit);
  };
  /** 调 OpenAI 兼容 /chat/completions：统一超时、中文错误与 Key 脱敏 */
  const aiChat = async (cfg, { messages, maxTokens, timeoutMs, temperature = 0.2 }) => {
    const u = new URL(cfg.baseUrl);
    u.pathname = u.pathname.replace(/\/+$/, '') + '/chat/completions';
    const url = u.toString();
    const started = Date.now();
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({ model: cfg.model, temperature, max_tokens: maxTokens, messages }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = String(e?.name || '');
      if (name === 'TimeoutError' || name === 'AbortError' || e?.code === 'ABORT_ERR' || e?.code === 'UND_ERR_HEADERS_TIMEOUT') {
        throw new AiError(`AI 接口超时（${Math.round(timeoutMs / 1000)} 秒未响应）`, 504);
      }
      throw new AiError('无法连接 AI 接口，请检查 Base URL 和网络连接', 502);
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      if (r.status >= 300 && r.status < 400) {
        throw new AiError(`AI 接口返回重定向（HTTP ${r.status}），请配置最终 Base URL`, 502);
      }
      const hint = r.status === 401 ? '（API Key 无效或未授权）'
        : r.status === 404 ? '（接口地址不存在，请确认 Base URL 是否指向 OpenAI 兼容的 /v1）'
          : r.status === 429 ? '（已被上游限流，请稍后再试）'
            : r.status === 400 ? '（请求被上游拒绝，请检查模型名/参数）' : '';
      throw new AiError(`LLM 接口错误 ${r.status}${hint}`, 502);
    }
    const raw = await aiReadText(r, 1_000_000);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new AiError('LLM 返回的不是 JSON（请检查 Base URL 是否指向 OpenAI 兼容接口）', 502);
    }
    return { data, latencyMs: Date.now() - started };
  };
  const aiRateLimited = (req, action) => {
    const who = `${aiActor(req) || 'anon'}:${action}`;
    const now = Date.now();
    // 顺手清掉过期窗口，避免 Map 随账号/Key 数量无限增长
    if (aiHits.size > 500) {
      for (const [k, v] of aiHits) if (now - v.firstAt > AI_RATE_WINDOW) aiHits.delete(k);
    }
    const rec = aiHits.get(who);
    if (!rec || now - rec.firstAt > AI_RATE_WINDOW) { aiHits.set(who, { count: 1, firstAt: now }); return false; }
    rec.count++;
    return rec.count > AI_RATE_LIMIT;
  };
  const aiKeyValues = (key) => new Set([...collectSecrets({ apiKey: key }), key]);
  const containsAiSecret = (value, secrets) => {
    if (typeof value === 'string') return redactKnownValues(value, secrets) !== value;
    return value !== null && typeof value === 'object' && Object.entries(value)
      .some(([name, item]) => redactKnownValues(name, secrets) !== name || containsAiSecret(item, secrets));
  };
  const aiUsage = (usage) => {
    const counts = {};
    for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      const count = usage?.[field];
      if (Number.isSafeInteger(count) && count >= 0) counts[field] = count;
    }
    return Object.keys(counts).length ? counts : null;
  };
  /** 去掉危险键（防原型污染）并限制深度/数组长度 */
  const sanitizeAiJson = (value, depth = 0) => {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 6) return null;
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeAiJson(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (AI_BAD_KEYS.has(k)) continue;
      out[k] = sanitizeAiJson(v, depth + 1);
    }
    return out;
  };
  /** 草稿结构收敛：≤6 节点、id 唯一、edges 只引用存在节点且去重、cron 仅 5 段 */
  const normalizeAiDraft = (raw) => {
    const nodes = [];
    const usedIds = new Set();
    for (const n of (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, AI_MAX_NODES)) {
      if (!n || typeof n !== 'object') continue;
      let id = String(n.id || `n${nodes.length}`).slice(0, 32);
      if (!id || AI_BAD_KEYS.has(id) || usedIds.has(id)) id = `n${nodes.length}`;
      let dedupe = 0;
      while (usedIds.has(id)) { dedupe++; id = `n${nodes.length}_${dedupe}`; }
      usedIds.add(id);
      const type = AI_NODE_TYPES.has(n.type) ? n.type : 'log';
      const rawConfig = n.config && typeof n.config === 'object' ? n.config : {};
      const config = sanitizeAiJson(rawConfig);
      nodes.push({
        id,
        type,
        name: String(n.name || type || '节点').slice(0, 60),
        x: Number(n.x) || 80 + nodes.length * 280,
        y: Number(n.y) || 60,
        config: config && typeof config === 'object' && !Array.isArray(config) ? config : {},
      });
    }
    const ids = new Set(nodes.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = [];
    const seen = new Set();
    for (const e of (Array.isArray(raw.edges) ? raw.edges : []).slice(0, 50)) {
      if (!e || typeof e !== 'object') continue;
      const source = String(e.source || '');
      const target = String(e.target || '');
      if (!ids.has(source) || !ids.has(target) || source === target) continue;
      const type = byId.get(source)?.type;
      const handleRaw = String(e.sourceHandle || '').slice(0, 20);
      // http 只有 success/failed、condition 有 true/false；其余节点统一 next（与 FlowEditor 默认出口一致）
      const sourceHandle = type === 'http'
        ? (['success', 'failed'].includes(handleRaw) ? handleRaw : 'success')
        : type === 'condition'
          ? (['true', 'false'].includes(handleRaw) ? handleRaw : 'true')
          : 'next';
      const key = `${source}|${sourceHandle}|${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: `e${edges.length}`, source, sourceHandle, target });
      if (edges.length >= AI_MAX_EDGES) break;
    }
    return { nodes, edges };
  };
  const normalizeAiCron = (raw) => {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().replace(/\s+/g, ' ');
    if (!s) return '';
    return s.split(' ').length === 5 ? s.slice(0, 40) : '';
  };
  /** 草稿里必须有一个 http 节点，且 URL 是绝对 http(s) */
  const aiDraftHttpUrlOk = (nodes) => {
    const first = nodes.find((n) => n.type === 'http');
    return /^https?:\/\//i.test(String(first?.config?.url || ''));
  };

  // 读取：任意登录用户；只返回 configured/baseUrl/model/打码 Key 与可选参数
  app.get('/api/system/ai', async () => {
    const a = aiConfig();
    return {
      configured: !!(a.baseUrl && a.apiKey && a.model),
      baseUrl: a.baseUrl,
      model: a.model,
      apiKey: maskAiKey(a.apiKey),
      hasKey: !!a.apiKey,
      timeoutSec: a.timeoutSec,
      maxTokens: a.maxTokens,
    };
  });
  // 保存：仅管理员
  app.put('/api/system/ai', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = req.body || {};
    const prev = store.meta.ai || {};
    const rawBase = String(body.baseUrl ?? '').trim();
    const rawKey = String(body.apiKey ?? '').trim();
    const model = String(body.model ?? '').trim();
    // 三个字段都为空 = 清空配置（保留超时/最大 tokens 偏好）
    if (!rawBase && !rawKey && !model) {
      store.meta.ai = {
        baseUrl: '',
        apiKey: '',
        model: '',
        timeoutSec: aiInt(prev.timeoutSec, AI_TIMEOUT_MIN, AI_TIMEOUT_MAX, AI_TIMEOUT_DEFAULT),
        maxTokens: aiInt(prev.maxTokens, AI_MAXTOKENS_MIN, AI_MAXTOKENS_MAX, AI_MAXTOKENS_DEFAULT),
      };
      store.flush();
      store.audit('ai.config.save', '已清空 AI 配置', aiActor(req));
      return { ok: true, cleared: true, configured: false, timeoutSec: store.meta.ai.timeoutSec, maxTokens: store.meta.ai.maxTokens };
    }
    const base = normalizeAiBaseUrl(rawBase);
    if (base.error) return reply.code(400).send({ error: base.error });
    if (!base.url) return reply.code(400).send({ error: '请填写 Base URL（OpenAI 兼容接口，例：https://api.deepseek.com/v1）' });
    if (!model) return reply.code(400).send({ error: '请填写模型名称（例：deepseek-chat / gpt-4o-mini）' });
    if (model.length > 100) return reply.code(400).send({ error: '模型名称过长（最多 100 字）' });
    // 打码占位 / 空 = 保留旧 Key；否则替换
    const keepKey = !rawKey || rawKey.endsWith('…') || rawKey === '***';
    const apiKey = keepKey ? String(prev.apiKey || '') : rawKey;
    if (!apiKey) return reply.code(400).send({ error: '请填写 API Key（本地 Ollama 可填任意占位符，如 ollama）' });
    let timeoutSec = aiInt(prev.timeoutSec, AI_TIMEOUT_MIN, AI_TIMEOUT_MAX, AI_TIMEOUT_DEFAULT);
    if (body.timeoutSec !== undefined && body.timeoutSec !== null && body.timeoutSec !== '') {
      const n = Number(body.timeoutSec);
      if (!Number.isFinite(n) || n < AI_TIMEOUT_MIN || n > AI_TIMEOUT_MAX) {
        return reply.code(400).send({ error: `超时需在 ${AI_TIMEOUT_MIN}-${AI_TIMEOUT_MAX} 秒之间` });
      }
      timeoutSec = Math.round(n);
    }
    let maxTokens = aiInt(prev.maxTokens, AI_MAXTOKENS_MIN, AI_MAXTOKENS_MAX, AI_MAXTOKENS_DEFAULT);
    if (body.maxTokens !== undefined && body.maxTokens !== null && body.maxTokens !== '') {
      const n = Number(body.maxTokens);
      if (!Number.isFinite(n) || n < AI_MAXTOKENS_MIN || n > AI_MAXTOKENS_MAX) {
        return reply.code(400).send({ error: `最大输出 tokens 需在 ${AI_MAXTOKENS_MIN}-${AI_MAXTOKENS_MAX} 之间` });
      }
      maxTokens = Math.round(n);
    }
    store.meta.ai = { baseUrl: base.url, apiKey, model: model.slice(0, 100), timeoutSec, maxTokens };
    store.flush();
    store.audit('ai.config.save', `baseUrl=${base.url} 模型=${model.slice(0, 100)} Key=${keepKey ? '保留' : '更新'} 超时=${timeoutSec}s 最大tokens=${maxTokens}`, aiActor(req));
    return { ok: true, configured: true, baseUrl: base.url, model: model.slice(0, 100), timeoutSec, maxTokens, apiKey: maskAiKey(apiKey) };
  });
  // 连接测试：仅管理员；用已保存配置发一条最小请求（可选 timeoutSec 即时覆盖 1-120 秒）
  app.post('/api/ai/test', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const cfg = aiConfig();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      return reply.code(400).send({ error: '未配置 AI：请先填写 Base URL / API Key / 模型并保存' });
    }
    if (aiRateLimited(req, 'test')) return reply.code(429).send({ error: `AI 调用过于频繁（每分钟最多 ${AI_RATE_LIMIT} 次），请稍后再试` });
    const override = Number((req.body || {}).timeoutSec);
    const timeoutSec = Number.isFinite(override) && override > 0 ? Math.min(120, Math.max(1, Math.round(override))) : cfg.timeoutSec;
    try {
      let { data, latencyMs } = await aiChat(cfg, {
        messages: [{ role: 'user', content: '只回复 ok' }],
        maxTokens: 16,
        timeoutMs: timeoutSec * 1000,
        temperature: 0,
      });
      let content = stripAiThink(extractAiContent(data.choices?.[0]?.message));
      if (!content && data.choices?.[0]?.finish_reason === 'length') {
        const retry = await aiChat(cfg, {
          messages: [{ role: 'user', content: '只回复 ok' }],
          maxTokens: 128,
          timeoutMs: timeoutSec * 1000,
          temperature: 0,
        });
        data = retry.data;
        latencyMs += retry.latencyMs;
        content = stripAiThink(extractAiContent(data.choices?.[0]?.message));
      }
      if (!content) throw new AiError('LLM 返回空内容（可能模型不支持或 token 上限过低）', 502);
      const sample = redactText(content, aiKeyValues(cfg.apiKey)).slice(0, 120);
      store.audit('ai.test', `模型=${cfg.model} 结果=ok 耗时=${latencyMs}ms`, aiActor(req));
      return { ok: true, latencyMs, model: cfg.model, sample, usage: aiUsage(data.usage) };
    } catch (e) {
      const msg = aiSafeText(e?.message || e, cfg.apiKey);
      store.audit('ai.test', `模型=${cfg.model} 结果=fail 原因=${msg.slice(0, 160)}`, aiActor(req));
      return reply.code(e instanceof AiError ? e.status : 502).send({ ok: false, error: msg });
    }
  });
  // 生成草稿：登录用户即可（API Key 需 write 作用域，由全局鉴权钩子保证）
  app.post('/api/ai/generate', async (req, reply) => {
    const cfg = aiConfig();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      return reply.code(400).send({ error: '未配置 AI：请到「设置 → AI 助手」填 Base URL / API Key / 模型' });
    }
    const sentence = String((req.body || {}).sentence || '').trim();
    if (!sentence) return reply.code(400).send({ error: '请先输入一句话描述' });
    if (sentence.length > 500) return reply.code(400).send({ error: '描述太长（最多 500 字）' });
    if (aiRateLimited(req, 'generate')) return reply.code(429).send({ error: `AI 调用过于频繁（每分钟最多 ${AI_RATE_LIMIT} 次），请稍后再试` });
    const knownSecrets = new Set([cfg.apiKey]);
    for (const definitions of [store.flows, store.templates]) {
      for (const definition of definitions) {
        for (const value of collectDefinitionSecrets(definition)) knownSecrets.add(value);
      }
    }
    if (hasAiInputCredentials(sentence, [...knownSecrets])) {
      return reply.code(400).send({ error: '描述中包含疑似凭据，未发送给模型。请移除敏感值后重试。' });
    }
    const sys = 'You generate CheckQ automation flow JSON. Output ONLY compact JSON, no markdown fences. Shape: '
      + '{"name":"<short task name>","cron":"<5-field cron e.g. 0 8 * * *>","nodes":[{"id":"n0","type":"http","name":"<short>","x":80,"y":60,"config":{"method":"GET","url":"<absolute https url from user text>","headers":[{"name":"user-agent","value":"Mozilla/5.0","enabled":true}],"body":"","asserts":[]}},{"id":"n1","type":"log","name":"记录结果","x":360,"y":60,"config":{"text":"完成：{{last.status}}"}}],"edges":[{"id":"e0","source":"n0","sourceHandle":"success","target":"n1"}]} '
      + 'Rules: only node types http,log,set,delay,extract,condition,random-delay; first node must be http with a real absolute url from the user text; node ids must be unique; edges may only reference existing node ids (sourceHandle success/failed for http, true/false for condition, next for others); cron must be a 5-field cron or empty string; if user says 看到X算成功 set asserts:[{"res":["X"],"from":"content"}]; <=5 nodes; JSON only.';
    try {
      const { data } = await aiChat(cfg, {
        messages: [{ role: 'system', content: sys }, { role: 'user', content: sentence }],
        maxTokens: cfg.maxTokens,
        timeoutMs: cfg.timeoutSec * 1000,
        temperature: 0.2,
      });
      let text = stripAiThink(extractAiContent(data.choices?.[0]?.message));
      text = text.replace(/^```(json)?/i, '').replace(/```\s*$/, '').trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) throw new AiError('LLM 未返回 JSON', 502);
      let parsed;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        throw new AiError('LLM 返回的 JSON 无法解析', 502);
      }
      const clean = sanitizeAiJson(parsed);
      if (containsAiSecret(clean, [...knownSecrets, ...aiKeyValues(cfg.apiKey)])) {
        throw new AiError('LLM 草稿包含疑似凭据，已拒绝生成', 502);
      }
      if (!clean || !Array.isArray(clean.nodes) || !clean.nodes.length) throw new AiError('LLM JSON 缺少 nodes', 502);
      const { nodes, edges } = normalizeAiDraft(clean);
      if (!nodes.length) throw new AiError('LLM JSON 缺少 nodes', 502);
      if (!aiDraftHttpUrlOk(nodes)) throw new AiError('LLM 未给出有效 HTTP 节点/URL（需要绝对 http(s) 地址）', 502);
      const draft = {
        name: String(clean.name || 'AI 生成任务').slice(0, 60),
        cron: normalizeAiCron(clean.cron),
        timezone: 'Asia/Shanghai',
        enabled: false,
        vars: {},
        nodes,
        edges,
      };
      store.audit('ai.generate', `模型=${cfg.model} 输入=${sentence.length}字 结果=ok 节点=${nodes.length} 连线=${edges.length} 超时=${cfg.timeoutSec}s`, aiActor(req));
      return { draft };
    } catch (e) {
      const msg = aiSafeText(e?.message || e, cfg.apiKey);
      store.audit('ai.generate', `模型=${cfg.model} 输入=${sentence.length}字 结果=fail 原因=${msg.slice(0, 160)}`, aiActor(req));
      return reply.code(e instanceof AiError ? e.status : 502).send({ error: e instanceof AiError ? msg : 'LLM 调用失败: ' + msg });
    }
  });

  // 通知测试：向指定 flow 的渠道发一条测试消息（PRD §4.8 P2）
  app.post('/api/flows/:id/notify-test', async (req, reply) => {
    const f = store.getFlow(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const n = f.notify || {};
    if (!n.channels?.length) return reply.code(400).send({ error: '该任务未配置通知渠道' });
    const testRun = { status: 'success', finalMessage: '测试通知（CheckQ）', durationMs: 0, startedAt: Date.now(), logs: [] };
    const text = renderNotifyTemplate({ ...n, template: n.template || '测试通知：[CheckQ] {{flow.name}} {{status}}' }, f, testRun);
    const results = await sendToChannels(n.channels, text, { flowId: f.id, flowName: f.name, status: 'success' });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) return reply.code(502).send({ error: `部分渠道失败：${failed.map((x) => `${x.type}:${x.error}`).join('；')}`, results });
    return { ok: true, results, text };
  });

  // 每日汇总（v0.5.3）：旧端点兼容一版。带 flowIds/flowId 时按老逻辑借任务渠道，否则走系统渠道。
  app.post('/api/system/daily-summary', async (req, reply) => {
    const body = req.body || {};
    const ids = Array.isArray(body.flowIds) && body.flowIds.length ? body.flowIds : (body.flowId ? [body.flowId] : null);
    if (ids) {
      const targets = ids.map((id) => store.getFlow(id)).filter(Boolean);
      if (!targets.length) return reply.code(404).send({ error: '任务不存在' });
      const withChannels = targets.filter((t) => t.notify?.channels?.length);
      if (!withChannels.length) return reply.code(400).send({ error: '所选任务都没有通知渠道' });
      const out = await pushLegacySummary(withChannels);
      return { ok: out.results.every((r) => r.ok), text: out.text, results: out.results, groups: out.groups };
    }
    return sendDailySummary('manual');
  });

  /** 系统渠道结构校验：返回错误文案（null = 通过） */
  function validateSystemChannels(list) {
    if (!Array.isArray(list)) return 'channels 必须是数组';
    const external = list.filter((c) => c && c.type !== 'inbox');
    if (external.length > 10) return '外部渠道最多 10 条';
    if (list.filter((c) => c?.type === 'inbox').length > 1) return '站内通知只能有一条';
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || !SUMMARY_CHANNEL_TYPES.has(c.type)) return `第 ${i + 1} 条渠道类型不支持`;
      if (c.type === 'inbox') continue;
      const need = {
        webhook: ['url'], bark: ['url'], telegram: ['token', 'chat'], serverchan: ['key'],
        pushplus: ['token'], dingtalk: ['url'], wecom: ['url'], feishu: ['url'],
        gotify: ['url', 'token'], ntfy: ['topic'], email: ['host', 'to'],
      }[c.type] || [];
      const miss = need.find((k) => !String(c[k] || '').trim());
      if (miss) return `第 ${i + 1} 条渠道缺少 ${miss}`;
    }
    return null;
  }

  function currentNotifyView() {
    const cfg = dailyConfig();
    return {
      daily: {
        enabled: cfg.enabled, time: cfg.time, timezone: cfg.timezone, skipEmpty: cfg.skipEmpty,
        include: cfg.include, lastSentDate: cfg.lastSentDate, lastSentAt: cfg.lastSentAt,
      },
      channels: store.getSystemChannels(),
      migratedFrom: cfg.migratedFrom,
      migratedFromName: cfg.migratedFrom ? (store.getFlow(cfg.migratedFrom)?.name || '原任务') : null,
      migratedAt: cfg.migratedAt,
      lastResult: cfg.lastResult,
    };
  }

  app.get('/api/system/notify', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: '未登录' });
    return currentNotifyView();
  });

  app.put('/api/system/notify', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = req.body || {};
    const daily = body.daily || {};
    const time = String(daily.time ?? store.meta.dailySummary?.time ?? '08:00');
    if (!/^\d{1,2}:\d{2}$/.test(time) || Number(time.split(':')[0]) > 23 || Number(time.split(':')[1]) > 59) {
      return reply.code(400).send({ error: '时间格式必须是 HH:MM' });
    }
    if (body.channels !== undefined) {
      const err = validateSystemChannels(body.channels);
      if (err) return reply.code(400).send({ error: err });
    }
    const prev = store.meta.dailySummary || {};
    store.meta.dailySummary = {
      ...prev,
      enabled: daily.enabled === true,
      time: time.padStart(5, '0'),
      timezone: String(daily.timezone || prev.timezone || 'Asia/Shanghai').slice(0, 64),
      skipEmpty: daily.skipEmpty !== false,
      include: {
        failures: daily.include?.failures !== false,
        paused: daily.include?.paused !== false,
        successCount: daily.include?.successCount !== false,
      },
    };
    if (body.channels !== undefined) {
      const normalized = body.channels.map((c) => ({ ...c, id: c.id || `ch_${crypto.randomUUID()}` }));
      store.setSystemChannels(normalized);
    }
    store.flush();
    scheduler.rebuild();
    return currentNotifyView();
  });

  app.post('/api/system/notify/preview', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: '未登录' });
    return previewDailySummary((req.body || {}).date);
  });

  app.post('/api/system/notify/test', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = req.body || {};
    const all = store.getSystemChannels();
    const channels = body.channelId ? all.filter((c) => c.id === body.channelId) : all;
    if (!channels.length) return reply.code(404).send({ error: '渠道不存在' });
    const text = `（测试）${previewDailySummary().text}`;
    const results = await sendToChannels(channels, text, { title: '每日汇总', flowId: null, flowName: '', status: 'success' });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) return reply.code(502).send({ error: failed.map((r) => `${r.type}: ${r.error}`).join('；'), results, text });
    return { ok: true, results, text };
  });

  app.post('/api/system/notify/send', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = req.body || {};
    if (body.dryRun) return previewDailySummary(body.date);
    return sendDailySummary('manual', { date: body.date });
  });

  // ---- flows ----
  app.get('/api/flows', async (req) => {
    const flows = keyHasFullFlowScope(req) ? store.flows : store.flows.filter((flow) => keyAllowsFlow(req, flow));
    return store.listFlows(flows, { maskCredentials: !keyHasScope(req, 'secrets') });
  });

  // ---- templates (user-created, stored in DB) ----
  // 从现有流程"另存为模板"
  app.post('/api/templates/from-flow/:flowId', async (req, reply) => {
    const f = store.getFlow(req.params.flowId);
    if (!f) return reply.code(404).send({ error: '流程不存在' });
    if (!keyAllowsFlow(req, f)) return keyScopeDenied(reply);
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能创建模板');
    const { name, desc } = req.body || {};
    const tpl = store.createTemplate({
      name: name || f.name.replace(/\s*·\s*\d+$/, '') + ' 模板',
      desc: desc || `来自流程「${f.name}」`,
      vars: f.vars || {},
      nodes: f.nodes,
      edges: f.edges,
      log: f.log,
      notify: f.notify || {},
    }, 'flow');
    return { id: tpl.id, name: tpl.name };
  });

  app.get('/api/templates', async (req) => store.listTemplates({ maskCredentials: !keyHasScope(req, 'secrets') }));

  app.post('/api/templates', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能创建模板');
    const { name, desc, vars, varNames, nodes, edges, log, notify } = req.body || {};
    const errors = validateFlow({ name, nodes, edges, vars });
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const tpl = store.createTemplate({ name, desc, vars, varNames, nodes, edges, log, notify }, 'import');
    return { id: tpl.id, name: tpl.name };
  });

  app.put('/api/templates/:id', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能修改模板');
    const template = store.getTemplate(req.params.id);
    if (!template) return reply.code(404).send({ error: 'not found' });
    const patch = req.body || {};
    if (!keyHasScope(req, 'secrets') && modifiesExecution(patch) && templateHasProtectedExecution(template)) {
      return rejectCredentialEdit(reply);
    }
    const errors = validateHttpOrigins(patch.nodes);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    return visibleDefinition(req, store.updateTemplate(template.id, patch));
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能删除模板');
    const ok = store.deleteTemplate(req.params.id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // 模板 → 生成任务实例（变量差异化）
  app.post('/api/templates/:id/instantiate', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能创建任务');
    const { name, vars, note } = req.body || {};
    const flow = store.instantiateTemplate(req.params.id, { name, vars, note });
    if (!flow) return reply.code(404).send({ error: '模板不存在' });
    return visibleDefinition(req, flow);
  });

  // 模板联动：派生任务始终跟随模板（这里无需任何同步操作，模板一改任务立刻变）
  // （旧的 POST /api/templates/:id/sync 与 /api/flows/:id/sync-template 已移除）

  // 模板详情（编辑用）
  app.get('/api/templates/:id', async (req, reply) => {
    const t = store.getTemplate(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return visibleDefinition(req, t);
  });

  // 模板导出（4.3）：脱敏 —— 敏感变量默认值置空，样本不导出
  app.get('/api/templates/:id/export', async (req, reply) => {
    const t = store.getTemplate(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const safe = maskSecrets(t);
    const safeVars = {};
    for (const [k, v] of Object.entries(safe.vars || {})) {
      safeVars[k] = /cookie|token|password|secret|key/i.test(k) ? '' : v;
    }
    return {
      name: safe.name, desc: safe.desc,
      varNames: safe.varNames || Object.keys(safeVars),
      vars: safeVars,
      nodes: safe.nodes, edges: safe.edges,
      log: safe.log || null,
      samplesIncluded: false,
    };
  });

  // CSV 批量建任务（4.3）
  app.post('/api/templates/:id/instantiate-csv', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能创建任务');
    const { csv } = req.body || {};
    if (!csv || typeof csv !== 'string') return reply.code(400).send({ error: '缺少 csv 内容' });
    const tpl = store.getTemplate(req.params.id);
    if (!tpl) return reply.code(404).send({ error: '模板不存在' });

    // 极简 CSV 解析（支持双引号转义）
    const parseCsvLine = (line) => {
      const cells = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; }
            else inQ = false;
          } else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { cells.push(cur); cur = ''; }
        else cur += ch;
      }
      cells.push(cur);
      return cells.map((c) => c.trim());
    };

    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return reply.code(400).send({ error: 'CSV 需要表头行 + 至少一行数据' });
    const header = parseCsvLine(lines[0]).map((h) => h.trim());
    const varNames = new Set(tpl.varNames && tpl.varNames.length ? tpl.varNames : Object.keys(tpl.vars || {}));
    const unknownCols = header.filter((h) => h !== 'name' && h !== 'note' && !varNames.has(h));
    if (unknownCols.length) return reply.code(400).send({ error: `未知列: ${unknownCols.join(', ')}（可用列: name, note, ${[...varNames].join(', ')}）` });

    const created = [];
    const skipped = [];
    const defaults = tpl.vars || {};
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const row = {};
      header.forEach((h, j) => { row[h] = cells[j] ?? ''; });
      const name = (row.name || '').trim();
      if (row._skip === '1') { skipped.push(i); continue; }
      if (!name && !Object.keys(row).some((k) => varNames.has(k) && row[k])) { skipped.push(i); continue; }
      const vars = {};
      for (const vn of varNames) {
        const v = (row[vn] ?? '').trim();
        vars[vn] = v || defaults[vn] || '';
      }
      try {
        const flow = store.instantiateTemplate(tpl.id, {
          name: name || undefined,
          vars,
          note: (row.note || '').trim() || undefined,
        });
        created.push({ id: flow.id, name: flow.name });
      } catch (err) {
        skipped.push(i);
      }
    }
    return { created, skipped: skipped.length, total: lines.length - 1 };
  });

  // cURL 导入（4.9）：静态解析，返回 http 节点 config
  app.post('/api/import/curl', async (req, reply) => {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') return reply.code(400).send({ error: '缺少 command' });
    try {
      const config = parseCurl(command);
      return { config };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/flows', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能创建任务');
    const flow = req.body || {};
    const errors = validateFlow(flow);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    return visibleDefinition(req, store.createFlow(flow));
  });

  app.get('/api/flows/:id', async (req, reply) => {
    const f = store.getFlow(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    // structure = 结构事实（P0-2）：缺线出口 / 孤立步骤 / 起点 / 循环体范围，画布与检查清单共用
    const structure = analyzeStructure(f);
    return { ...visibleDefinition(req, f), template: store.templateInfo(f, undefined, !keyHasScope(req, 'secrets')), structure };
  });

  app.put('/api/flows/:id', async (req, reply) => {
    const patch = req.body || {};
    const f0 = store.getFlow(req.params.id);
    if (!f0) return reply.code(404).send({ error: 'not found' });
    // 乐观并发：带 baseRev 的写入必须基于同一版本；不带 baseRev 的旧客户端/脚本仍可写。
    if (patch.baseRev !== undefined) {
      const base = Number(patch.baseRev);
      delete patch.baseRev;
      if (!Number.isFinite(base) || base !== (Number(f0.rev) || 0)) {
        return reply.code(409).send({
          error: '任务已被其他窗口或 Agent 修改，请刷新后再保存', conflict: true, rev: Number(f0.rev) || 0,
        });
      }
    }
    if (!keyHasScope(req, 'secrets') && modifiesExecution(patch)) {
      const targetTemplate = patch.tplId && store.getTemplate(patch.tplId);
      if (hasProtectedExecution(f0) || (f0.tplId && hasProtectedExecution(store.getFlowRaw(f0.id)))
          || (targetTemplate && hasProtectedExecution(targetTemplate))) {
        return rejectCredentialEdit(reply);
      }
    }
    const errors = validateFlow({ ...f0, ...patch });
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const f = store.updateFlow(req.params.id, patch);
    if (!f) return reply.code(404).send({ error: 'not found' });
    scheduler.rebuild();
    // 派生任务改了脚本内容 → 自动转为独立任务（前端提示一次）
    const detached = f && f.detached ? f.detached : null;
    return { ...visibleDefinition(req, f), template: store.templateInfo(f, undefined, !keyHasScope(req, 'secrets')), detached };
  });

  app.post('/api/flows/validate', async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const errors = validateFlow({ name: body.name || '未命名流程', ...body }, { allowEmptyDraft: body.allowEmptyDraft === true });
    return { ok: errors.length === 0, errors };
  });

  app.patch('/api/flows/:id/vars', async (req, reply) => {
    const f = store.getFlow(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const body = req.body || {};
    const raw = body.vars && typeof body.vars === 'object' && !Array.isArray(body.vars)
      ? body.vars
      : (typeof body === 'object' && !Array.isArray(body) && !Object.hasOwn(body, 'vars') ? body : null);
    if (!raw) return reply.code(400).send({ error: '缺少 vars 对象' });
    const BAD = new Set(['__proto__', 'constructor', 'prototype']);
    const nextVars = { ...(f.vars || {}) };
    const updatedKeys = [];
    for (const [k, v] of Object.entries(raw)) {
      if (!k || BAD.has(k)) continue;
      if (v === null) {
        delete nextVars[k];
        updatedKeys.push(k);
      } else if (v !== undefined) {
        nextVars[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        updatedKeys.push(k);
      }
    }
    const updated = store.updateFlow(f.id, { vars: nextVars });
    return { ok: true, id: updated.id, varsCount: Object.keys(updated.vars || {}).length, updatedKeys };
  });

  app.delete('/api/flows/:id', async (req, reply) => {
    const ok = store.deleteFlow(req.params.id);
    scheduler.rebuild();
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/flows/:id/run', async (req, reply) => {
    const f = store.getFlow(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const body = req.body || {};
    const debugStopId = body.debugStopId || null;
    const stream = body.stream === true;
    // 手动运行去重（P0-4）：运行中再次触发 → 提示已排队，不产生第二次运行
    if (body.dedupe === true && !runner.claimManual(f.id)) {
      return { ok: true, deduped: true, queued: true, flowId: f.id, message: '已在运行，本次未重复提交' };
    }
    const claimed = body.dedupe === true;
    const maskCredentials = !keyHasScope(req, 'secrets');
    const secrets = maskCredentials ? collectDefinitionSecrets(f) : [];
    const visibleRun = (run) => maskCredentials ? maskStoredRun(run, secrets) : run;
    if (body.wait === false && !stream) {
      let queued;
      const execution = runner.runFlow(f, debugStopId ? 'debug' : 'manual', {
        debugStopId, debug: body.debug === true, timeoutMs: body.timeoutMs,
        onQueued: (run) => { queued = run; },
      });
      if (!queued) {
        try {
          return visibleRun(await execution);
        } finally {
          if (claimed) runner.releaseManual(f.id);
        }
      }
      execution
        .catch((error) => app.log.error({ err: error, runId: queued.id }, 'Background run failed'))
        .finally(() => { if (claimed) runner.releaseManual(f.id); });
      return reply.code(202).send({ ok: true, id: queued.id, runId: queued.id, flowId: f.id, status: 'queued' });
    }
    try {
      // SSE 模式（PRD §4.7.3 实时推送）：边执行边推送日志，结束事件携带完整 run
      if (stream) {
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const push = (event, data) => {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const run = await runner.runFlow(f, debugStopId ? 'debug' : 'manual', {
          debugStopId,
          debug: body.debug === true,
          timeoutMs: body.timeoutMs,
          onStart: (r) => push('start', { flowId: f.id, flowName: redactKnownValues(f.name, secrets), runId: r.id, queued: false, startedAt: r.startedAt }),
          onLog: (log) => push('log', maskCredentials ? redactLogEntry(log, secrets) : log),
        });
        push('done', visibleRun(run));
        reply.raw.end();
        return reply;
      }

      const run = await runner.runFlow(f, debugStopId ? 'debug' : 'manual', {
        debugStopId, debug: body.debug === true, timeoutMs: body.timeoutMs,
      });
      return visibleRun(run);
    } finally {
      if (claimed) runner.releaseManual(f.id);
    }
  });

  // 克隆任务：复制为新任务（PRD §4.4）
  app.post('/api/flows/:id/clone', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能克隆任务');
    const f = store.getFlow(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const seq = store.flows.filter((x) => x.name.startsWith(f.name)).length + 1;
    const clone = store.createFlow({
      name: `${f.name} · 副本${seq > 1 ? ' ' + seq : ''}`,
      note: f.note,
      group: f.group,
      cron: f.cron,
      timezone: f.timezone,
      enabled: false, // 克隆任务默认暂停，避免立即重复执行
      jitterMinutes: f.jitterMinutes || 0,
      vars: f.vars,
      nodes: f.nodes,
      edges: f.edges,
      notify: f.notify,
      log: f.log,
      retry: f.retry,       // 克隆必须带上失败重试配置，否则副本会回到默认策略
      recovery: f.recovery, // 恢复探测配置也随副本复制；是否启用由用户再确认
      tplId: f.tplId || null,
    });
    return visibleDefinition(req, clone);
  });

  // 复制为 curl（PRD §4.7.2）：从节点配置生成等价 curl 命令
  app.post('/api/flows/:id/curl', async (req, reply) => {
    const f = store.getFlow(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const { nodeId, vars } = req.body || {};
    const node = (visibleDefinition(req, f).nodes || []).find((n) => n.id === nodeId);
    if (!node || node.type !== 'http') return reply.code(400).send({ error: 'node not found or not http' });
    const c = node.config || {};
    const method = (c.method || 'GET').toUpperCase();
    const url = (c.url || '').replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, p) => {
      const v = (vars || {})[p];
      return v === undefined ? `{{${p}}}` : String(v);
    });
    const parts = [`curl -X ${method}`];
    for (const h of c.headers || []) {
      if (h.enabled === false) continue;
      const value = String(h.value || '').replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, p) => {
        const v = (vars || {})[p];
        return v === undefined ? `{{${p}}}` : String(v);
      });
      parts.push(`-H ${shellQuote(`${h.name}: ${value}`)}`);
    }
    if (c.body) parts.push(`--data ${shellQuote(String(c.body))}`);
    parts.push(shellQuote(url));
    return { curl: parts.join(' \\\n  ') };
  });

  // ---- runs ----
  // 旧「可推送任务」端点（兼容一版）：v0.5.3 起每日汇总用独立系统渠道，这里改为返回系统渠道摘要
  app.get('/api/system/push-targets', async () => store.getSystemChannels()
    .map((c) => ({ id: c.id, type: c.type, title: c.title || '', enabled: true })));

  app.get('/api/system/stats', async () => {
    const s = store.stats();
    return {
      ...s,
      queuedFlows: [...new Set([...runningFlows, ...queueByFlow.keys()])],
      queuedFlowIds: [...queueByFlow.keys()],
      runningFlowIds: [...runningFlows],
      queueCount: queueByFlow.size,
      runningCount: runningFlows.size,
      maxConcurrency: runLimiter.limit,
      globalWaiting: runLimiter.waiting,
      dailySummary: store.meta.dailySummary || null,
      unreadNotifications: store.listNotifications(1).unread,
    };
  });

  // 站内通知（inbox 渠道）：列表 / 已读 / 清空
  app.get('/api/notifications', async (req) => {
    const limit = (req.query || {}).limit;
    if (keyHasFullFlowScope(req)) return store.listNotifications(limit);
    const allowed = store.notifications.filter((n) => n.flowId && keyAllowsFlow(req, store.getFlowRaw(n.flowId)));
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    return {
      items: allowed.slice(0, lim),
      unread: allowed.filter((n) => !n.read).length,
      total: allowed.length,
    };
  });
  app.post('/api/notifications/read', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能修改全局通知状态');
    const body = req.body === undefined ? {} : req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: '请求体必须是 JSON 对象' });
    }
    const { ids } = body;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim()))) {
      return reply.code(400).send({ error: '通知 ID 必须是非空字符串数组' });
    }
    try {
      return { ok: true, updated: store.markNotificationsRead(ids) };
    } catch (error) {
      console.error('[CheckQ] failed to mark notifications as read:', error.message);
      return reply.code(500).send({ error: '无法保存通知状态，请重试' });
    }
  });
  app.delete('/api/notifications', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能清空全局通知');
    return { ok: true, cleared: store.clearNotifications() };
  });

  app.get('/api/system/daily-summary-config', async () => {
    const cfg = store.meta.dailySummary || {};
    const targetFlowIds = Array.isArray(cfg.targetFlowIds) ? cfg.targetFlowIds : (cfg.targetFlowId ? [cfg.targetFlowId] : []);
    return {
      enabled: !!cfg.enabled, time: cfg.time || '08:00', timezone: cfg.timezone || 'Asia/Shanghai',
      skipEmpty: cfg.skipEmpty !== false, include: dailyConfig().include,
      targetFlowId: cfg.targetFlowId || null, targetFlowIds,
      migratedFrom: cfg.migratedFrom || null, migratedAt: cfg.migratedAt || null,
      lastSentDate: cfg.lastSentDate || null, lastSentAt: cfg.lastSentAt || null, lastResult: cfg.lastResult || null,
    };
  });
  app.put('/api/system/daily-summary-config', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const cfg = req.body || {};
    const time = String(cfg.time || store.meta.dailySummary?.time || '08:00');
    if (!/^\d{1,2}:\d{2}$/.test(time) || Number(time.split(':')[0]) > 23 || Number(time.split(':')[1]) > 59) {
      return reply.code(400).send({ error: 'time must be HH:MM' });
    }
    // 兼容一版：旧字段 targetFlowIds 只读，不再写入（汇总已与任务解耦）
    const prev = store.meta.dailySummary || {};
    store.meta.dailySummary = {
      ...prev,
      enabled: !!cfg.enabled,
      time: time.padStart(5, '0'),
      timezone: cfg.timezone || prev.timezone || 'Asia/Shanghai',
      skipEmpty: cfg.skipEmpty !== false,
      include: cfg.include || prev.include || { failures: true, paused: true, successCount: true },
    };
    store.flush();
    scheduler.rebuild();
    return store.meta.dailySummary;
  });

  // 模板市场索引导入（规范见 docs/TEMPLATE-MARKET.md）：从 URL 拉取 {name,desc,vars,nodes,edges,log} 建模板
  app.post('/api/templates/from-url', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能创建模板');
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(String(url))) return reply.code(400).send({ error: '缺少合法 url' });
    let data;
    try {
      data = await fetchJson(String(url), { maxBytes: MARKET_LIMITS.templateBytes, timeoutMs: 10000 });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
    if (!data?.name || !Array.isArray(data.nodes)) return reply.code(400).send({ error: '索引 JSON 不合法（需 name + nodes[]）' });
    const errs = validateFlow({ name: data.name, nodes: data.nodes, edges: data.edges || [], vars: data.vars || {} });
    if (errs.length) return reply.code(400).send({ error: errs.join('; ') });
    const tpl = store.createTemplate({ name: data.name, desc: data.desc || `来自 ${url}`, vars: data.vars || {}, varNames: data.varNames, nodes: data.nodes, edges: data.edges || [], log: data.log || null }, 'market');
    return { id: tpl.id, name: tpl.name };
  });

  // 批量操作（青龙/千岛对标：多选批量运行/启停/删除）
  app.post('/api/flows/batch', async (req, reply) => {
    const { ids, action, wait } = req.body || {};
    const background = action === 'run' && wait === false;
    if (!Array.isArray(ids) || !ids.length) return reply.code(400).send({ error: '缺少 ids' });
    if (!['run', 'enable', 'disable', 'delete', 'set-group'].includes(action)) return reply.code(400).send({ error: '不支持的 action' });
    const group = String((req.body || {}).group || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (ids.length > 200) return reply.code(400).send({ error: '单次最多 200 个' });
    if (req.apiKey && !req.legacyApiKey) {
      const needScope = action === 'run' ? 'run' : 'write';
      if (!keyHasScope(req, needScope)) {
        return reply.code(403).send({ error: `API Key 权限不足：需要 ${needScope}` });
      }
      if (action === 'set-group' && !keyHasFullFlowScope(req)) {
        return keyScopeDenied(reply, '受限 API Key 不能修改任务分组');
      }
      const outOfScope = ids.map((id) => store.getFlowRaw(id)).filter((f) => f && !keyAllowsFlow(req, f));
      if (outOfScope.length) return keyScopeDenied(reply, `有 ${outOfScope.length} 个任务不在该 API Key 的任务范围内`);
    }
    const results = [];
    let changed = false;
    for (const id of ids) {
      const f = store.getFlow(id);
      if (!f) { results.push({ id, ok: false, error: 'not found' }); continue; }
      try {
        if (action === 'enable') { store.updateFlow(id, { enabled: true }); changed = true; results.push({ id, ok: true }); }
        else if (action === 'disable') { store.updateFlow(id, { enabled: false }); changed = true; results.push({ id, ok: true }); }
        else if (action === 'delete') { store.deleteFlow(id); changed = true; results.push({ id, ok: true }); }
        else if (action === 'set-group') { store.updateFlow(id, { group }); changed = true; results.push({ id, ok: true }); }
        else if (action === 'run') {
          if (background) {
            let queued;
            const execution = runner.runFlow(f, 'manual', { onQueued: (run) => { queued = run; } });
            if (!queued) await execution;
            else {
              execution.catch((error) => app.log.error({ err: error, runId: queued.id }, 'Background batch run failed'));
              results.push({ id, ok: true, runId: queued.id, status: 'queued' });
            }
          } else {
            const run = await runner.runFlow(f, 'manual');
            results.push({ id, ok: run.status === 'success', runId: run.id, status: run.status });
          }
        }
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    if (changed) scheduler.rebuild();
    const okCount = results.filter((r) => r.ok).length;
    if (background && okCount) reply.code(202);
    return { action, total: ids.length, ok: okCount, failed: ids.length - okCount, results };
  });

  // 备份/恢复：导出 flows/runs/templates（meta 密码不导出）；恢复以新 ID 导入避免覆盖
  // 备份（默认脱敏：cookie/token/密码等一律清空，适合分享与存档）
  app.get('/api/system/backup', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能导出全量备份');
    const secretsByFlow = new Map(store.flows.map((f) => [f.id, collectDefinitionSecrets(store.resolveFlow(f))]));
    return {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      masked: true,
      note: '敏感凭据已脱敏；runs 仅保留审计摘要，恢复时不导入；如需完整迁移请用 POST /api/system/backup（需当前密码）',
      flows: store.flows.map((f) => store.maskedFlow(f)),
      runs: store.runs.map((r) => redactRunForExport(r, secretsByFlow.get(r.flowId) || [])),
      templates: store.templates.map((t) => store.maskedTemplate(t)),
      channels: store.maskedSystemChannels(),
    };
  });

  // 完整备份（含凭据）：需要再次输入当前密码，防止误下载/误分享
  app.post('/api/system/backup', async (req, reply) => {
    const me = req.user;
    if (!me) return reply.code(401).send({ error: '未登录' });
    const { password } = req.body || {};
    if (!verifyPwd(password || '', me.passwordHash)) return reply.code(401).send({ error: '当前密码不正确' });
    store.audit('backup.full', '导出含凭据的完整备份', me.username);
    return {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      masked: false,
      note: '包含明文凭据，请妥善保管；runs 仅供审计，恢复时不导入',
      flows: store.flows,
      runs: store.runs,
      templates: store.templates,
      channels: store.getSystemChannels(),
    };
  });

  // 恢复只重建 flows/templates（默认停用、新 ID）：runs 是历史运行记录，
  // 导出来仅供离线审计，导入会把旧 startedAt / flowId 混进新任务的今日统计。
  app.post('/api/system/restore', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能恢复全量备份');
    const b = req.body || {};
    if (!Array.isArray(b.flows)) return reply.code(400).send({ error: '备份文件无效：缺少 flows 数组' });
    const createdFlows = [];
    const createdTemplates = [];
    store.batch(() => {
      for (const f of b.flows) {
        if (!f?.name) continue;
        if (validateFlow({ name: f.name, nodes: f.nodes || [], edges: f.edges || [] }, { allowEmptyDraft: true }).length) continue;
        const nf = store.createFlow({
          name: `${f.name}（恢复）`,
          note: f.note || '从备份恢复',
          group: f.group,
          cron: f.cron || '', timezone: f.timezone, jitterMinutes: f.jitterMinutes || 0,
          vars: f.vars || {}, nodes: f.nodes || [], edges: f.edges || [],
          notify: f.notify || {}, log: f.log || null, tplId: null,
          retry: f.retry,
          recovery: f.recovery ? { enabled: f.recovery.enabled, intervalMinutes: f.recovery.intervalMinutes, maxAttempts: f.recovery.maxAttempts } : undefined,
        });
        nf.enabled = false;
        createdFlows.push({ id: nf.id, name: nf.name });
      }
      if (Array.isArray(b.templates)) {
        for (const t of b.templates) {
          if (!t?.name) continue;
          if (validateFlow({ name: t.name, nodes: t.nodes || [], edges: t.edges || [] }, { allowEmptyDraft: true }).length) continue;
          const nt = store.createTemplate({ name: `${t.name}（恢复）`, desc: t.desc, vars: t.vars || {}, varNames: t.varNames, nodes: t.nodes || [], edges: t.edges || [], log: t.log || null, notify: t.notify || {} });
          createdTemplates.push({ id: nt.id, name: nt.name });
        }
      }
    });
    scheduler.rebuild();
    return { createdFlows, createdTemplates, channelsIgnored: true };
  });


  app.get('/api/runs', async (req, reply) => {
    const { flowId, limit } = req.query;
    if (flowId && !keyAllowsRun(req, store.getFlowRaw(flowId))) return keyScopeDenied(reply);
    const maxRuns = Math.max(1, Math.min(200, Math.floor(Number(limit) || 30)));
    const allowedFlowIds = !flowId && !keyHasFullFlowScope(req)
      ? new Set(store.flows.filter((flow) => keyAllowsFlow(req, flow)).map((flow) => flow.id))
      : undefined;
    const runs = store.listRuns(flowId, maxRuns, allowedFlowIds);
    if (keyHasScope(req, 'secrets')) return runs;
    const secretsByFlow = new Map();
    return runs.map((run) => {
      if (!secretsByFlow.has(run.flowId)) {
        const flow = store.getFlow(run.flowId);
        secretsByFlow.set(run.flowId, flow ? collectDefinitionSecrets(flow) : []);
      }
      return maskStoredRun(run, secretsByFlow.get(run.flowId));
    });
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const r = store.getRun(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    const f = store.getFlow(r.flowId);
    if (!keyAllowsRun(req, f)) return keyScopeDenied(reply);
    return keyHasScope(req, 'secrets') ? r : maskStoredRun(r, f ? collectDefinitionSecrets(f) : []);
  });

  // 取消排队中/运行中的一次运行：中断 fetch/curl、delay、节点重试与任务级退避
  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const r = store.getRun(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    const f = store.getFlowRaw(r.flowId);
    if (!keyAllowsRun(req, f)) return keyScopeDenied(reply);
    if (!['queued', 'running'].includes(r.status)) {
      return reply.code(409).send({ error: '这次运行已经结束', status: r.status });
    }
    const updated = runner.cancel(r.id, 'cancelled');
    const run = updated || r;
    const flow = store.resolveFlow(f);
    return { ok: true, cancelling: true, run: keyHasScope(req, 'secrets') ? run : maskStoredRun(run, flow ? collectDefinitionSecrets(flow) : []) };
  });

  // 单次运行导出 HAR（默认脱敏；响应体沿用日志截断）
  app.get('/api/runs/:id/har', async (req, reply) => {
    const r = store.getRun(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    const flow = store.getFlow(r.flowId);
    if (!keyAllowsRun(req, flow)) return keyScopeDenied(reply);
    const har = runToHar(maskStoredRun(r, flow ? collectDefinitionSecrets(flow) : []), flow);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="checkq-run-${String(r.id).replace(/[^\w-]/g, '')}.har"`);
    return har;
  });

  /**
   * 连续日志流（qinglong 面板风格）：把该任务多次运行的日志拍平成一条可滚动的时间线。
   * query: limit=总行数（默认 200，最大 2000），before=上一页的 nextBefore（兼容 runId）。
   * 普通运行整组返回，超长运行由后向前分段，同一段内保持步骤顺序。
   */
  app.get('/api/flows/:id/logs', async (req, reply) => {
    const f = store.getFlow(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const q = req.query || {};
    const limit = Math.floor(Math.min(Math.max(Number(q.limit) || 200, 20), 2000));
    const before = q.before ? String(q.before) : null;
    let runs = store.iterateFlowRuns(f.id, 500);
    let skipUntil = before;
    let resumeEnd = null;
    const segment = before && /^(.+):(\d+)$/.exec(before);
    if (segment) {
      // 旧记录的完整 ID 可能形似分段游标，优先匹配完整 ID。
      const history = [...runs];
      const exact = history.findIndex((run) => run.id === before);
      const index = exact >= 0 ? exact + 1 : history.findIndex((run) => run.id === segment[1]);
      if (exact < 0) resumeEnd = Number(segment[2]);
      if (index < 0 || (resumeEnd !== null && (!Number.isSafeInteger(resumeEnd) || resumeEnd < 1))) {
        return { entries: [], runs: [], hasMore: false, nextBefore: null };
      }
      runs = history.slice(index);
      skipUntil = null;
    }

    const entries = [];
    const summaries = [];
    const maskCredentials = !keyHasScope(req, 'secrets');
    const secrets = maskCredentials ? collectDefinitionSecrets(f) : [];
    let nextBefore = null;
    let hasMore = false;
    for (const r of runs) {
      if (skipUntil) {
        if (r.id === skipUntil) skipUntil = null;
        continue;
      }
      if (summaries.length >= 60 || entries.length >= limit) {
        hasMore = true;
        break;
      }
      const logs = r.logs || [];
      const end = Math.min(resumeEnd ?? logs.length, logs.length);
      if (entries.length && entries.length + end > limit) {
        hasMore = true;
        break;
      }
      const start = Math.max(0, end - limit);
      const split = start > 0 || resumeEnd !== null;
      const page = logs.slice(start, end);
      const visible = maskCredentials ? maskStoredRun(r, secrets, page) : r;
      const visiblePage = maskCredentials ? visible.logs : page;
      entries.push(...visiblePage.map((l, i) => ({
        runId: r.id,
        ...(split ? { position: start + i } : {}),
        startedAt: r.startedAt,
        status: r.status,
        interrupted: r.interrupted,
        timedOut: r.timedOut,
        index: l.index,
        name: l.name,
        message: l.message || '',
        type: l.type,
        ok: l.ok !== false,
        ms: l.ms || 0,
        summary: visible.summary || '',
        finalMessage: visible.finalMessage || '',
        diagnosis: visible.diagnosis || null,
      })));
      summaries.push({
        id: r.id, startedAt: r.startedAt, status: r.status, count: logs.length,
        interrupted: r.interrupted, timedOut: r.timedOut,
        summary: visible.summary || '', finalMessage: visible.finalMessage || '', diagnosis: visible.diagnosis || null,
      });
      nextBefore = start > 0 ? `${r.id}:${start}` : r.id;
      if (start > 0) {
        hasMore = true;
        break;
      }
      resumeEnd = null;
    }
    return { entries, runs: summaries, hasMore, nextBefore };
  });

  // 界面偏好（提示级别等）：全局设置
  app.get('/api/system/ui', async () => ({ toastLevel: store.meta.ui?.toastLevel || 'error' }));
  app.put('/api/system/ui', async (req) => {
    const level = String((req.body || {}).toastLevel || 'error');
    const allowed = ['error', 'success', 'all'];
    store.meta.ui = { ...(store.meta.ui || {}), toastLevel: allowed.includes(level) ? level : 'error' };
    store.flush();
    return store.meta.ui;
  });

  // ---- import ----
  app.post('/api/import/har', async (req, reply) => {
    let text;
    if (req.headers['content-type']?.includes('multipart/form-data')) {
      const f = await req.file();
      text = (await f.toBuffer()).toString('utf8');
    } else {
      text = JSON.stringify(req.body);
    }
    try {
      const flow = importHar(text);
      return { flow };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---- 演练场（P0-1）：内置演示端点 + 一条演练任务，全部本机、零外部依赖 ----
  app.get('/api/system/features', async () => ({ demo: isDemoEnabled(), version: VERSION }));

  app.get('/api/demo/profile', demoProfile);
  app.post('/api/demo/checkin', demoCheckin);
  app.get('/api/demo/items', demoItems);
  app.post('/api/demo/reset', demoReset);

  // 创建（或复用）演练任务：任务里只有本机演示地址，用户随时可改成自己的站点
  app.post('/api/demo/flow', async (req) => {
    const origin = originOf(req, (req.body || {}).origin);
    const { flow, created } = ensureDemoFlow(store, origin);
    scheduler.rebuild();
    return { id: flow.id, name: flow.name, created, origin };
  });

  // ---- 度量（P0-6）：只算本机数据，不外传 ----
  app.get('/api/system/metrics', async (req) => {
    const full = keyHasFullFlowScope(req);
    const flows = full ? store.flows : store.flows.filter((flow) => keyAllowsFlow(req, flow));
    const allowedIds = full ? null : new Set(flows.map((f) => f.id));
    const runs = full ? store.runs : store.runs.filter((r) => allowedIds.has(r.flowId));
    return computeMetrics({
      flows,
      runs,
      templates: store.templates,
      days: Number((req.query || {}).days) || 7,
    });
  });

  // 界面本地事件（白名单、只落 meta、不随备份导出）
  app.get('/api/system/events', async () => ({ events: store.meta.events || {} }));
  app.post('/api/system/events', async (req, reply) => {
    const name = String((req.body || {}).name || '');
    if (!EVENT_NAMES.includes(name)) return reply.code(400).send({ error: `不支持的事件：${name}` });
    store.meta.events = bumpEvents(store.meta.events, name);
    store.flush();
    return { ok: true, events: store.meta.events };
  });

  // ---- 模板市场 v1（P0-5）：索引解析 / 预览 / 哈希校验 / 导入 / 订阅 ----
  const marketSubs = () => (store.meta.market && Array.isArray(store.meta.market.subs) ? store.meta.market.subs : []);
  const saveSubs = (subs) => {
    store.meta.market = { ...(store.meta.market || {}), subs };
    store.flush();
  };

  app.get('/api/market/subscriptions', async () => ({ items: marketSubs() }));

  app.get('/api/market/index', async (req, reply) => {
    const url = String((req.query || {}).url || '').trim();
    if (!url) return reply.code(400).send({ error: '缺少索引地址' });
    let data;
    try {
      data = await fetchJson(url, { maxBytes: MARKET_LIMITS.indexBytes });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
    const parsed = parseIndex(data, url);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.errors.slice(0, 5).join('；'), errors: parsed.errors });
    const sub = marketSubs().find((s) => s.url === url);
    const newCount = sub ? Math.max(0, parsed.entries.length - (sub.seenCount || 0)) : 0;
    return {
      url,
      name: parsed.name,
      updatedAt: parsed.updatedAt,
      entries: parsed.entries.map(previewOf),
      newCount,
      subscribed: !!sub,
      localTemplates: store.listTemplates({ maskCredentials: !keyHasScope(req, 'secrets') }).map((t) => ({ id: t.id, name: t.name, sourceId: t.market?.sourceId || null })),
    };
  });

  app.post('/api/market/preview', async (req, reply) => {
    const { url, id } = req.body || {};
    if (!url || !id) return reply.code(400).send({ error: '缺少 url/id' });
    let data;
    try { data = await fetchJson(url, { maxBytes: MARKET_LIMITS.indexBytes }); } catch (e) { return reply.code(502).send({ error: e.message }); }
    const parsed = parseIndex(data, url);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.errors.slice(0, 5).join('；') });
    const entry = parsed.entries.find((e) => e.id === id);
    if (!entry) return reply.code(404).send({ error: '索引里没有这个条目' });
    const resolved = await resolveEntry(entry);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.errors.join('；') });
    return { entry: previewOf(entry), template: resolved.template, varsCleared: resolved.varsCleared, hashOk: true, sha256: resolved.sha256, hasScript: !!resolved.hasScript };
  });

  app.post('/api/market/import', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能创建模板');
    const { url, id, mode } = req.body || {};
    if (!url || !id) return reply.code(400).send({ error: '缺少 url/id' });
    let data;
    try { data = await fetchJson(url, { maxBytes: MARKET_LIMITS.indexBytes }); } catch (e) { return reply.code(502).send({ error: e.message }); }
    const parsed = parseIndex(data, url);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.errors.slice(0, 5).join('；') });
    const entry = parsed.entries.find((e) => e.id === id);
    if (!entry) return reply.code(404).send({ error: '索引里没有这个条目' });
    const resolved = await resolveEntry(entry);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.errors.join('；') });

    const existing = store.templates.find((t) => t.market && t.market.sourceId === id && t.market.sourceUrl === url);
    if (existing && mode !== 'overwrite' && mode !== 'copy') {
      return reply.code(409).send({ error: `已经导入过「${existing.name}」`, conflict: { templateId: existing.id, name: existing.name } });
    }
    const market = { sourceId: id, sourceUrl: url, templateUrl: entry.templateUrl, sha256: resolved.sha256, importedAt: Date.now(), entryName: entry.name };
    const name = existing && mode === 'copy' ? `${resolved.template.name}（副本）` : resolved.template.name;
    let tpl;
    if (existing && mode === 'overwrite') {
      if (!keyHasScope(req, 'secrets') && templateHasProtectedExecution(existing)) return rejectCredentialEdit(reply);
      tpl = store.updateTemplate(existing.id, { ...resolved.template, name, market });
    } else {
      tpl = store.createTemplate({ ...resolved.template, name, market }, 'market');
    }
    const missingVars = (entry.vars || [])
      .filter((v) => v.required && !String((tpl.vars || {})[v.name] || '').trim())
      .map((v) => v.name);
    return { id: tpl.id, name: tpl.name, replaced: !!(existing && mode === 'overwrite'), missingVars, varsCleared: resolved.varsCleared, hasScript: resolved.template.hasScript };
  });

  app.post('/api/market/subscribe', async (req, reply) => {
    if (!keyHasFullFlowScope(req)) return keyScopeDenied(reply, '受限 API Key 不能修改市场订阅');
    const url = String((req.body || {}).url || '').trim();
    if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ error: '索引地址必须是 http/https' });
    let data;
    try { data = await fetchJson(url, { maxBytes: MARKET_LIMITS.indexBytes }); } catch (e) { return reply.code(502).send({ error: e.message }); }
    const parsed = parseIndex(data, url);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.errors.slice(0, 3).join('；') });
    const subs = marketSubs().filter((s) => s.url !== url);
    subs.push({ url, name: parsed.name || url, addedAt: Date.now(), lastCheckedAt: Date.now(), seenCount: parsed.entries.length, count: parsed.entries.length });
    saveSubs(subs);
    return { ok: true, items: marketSubs() };
  });

  app.delete('/api/market/subscribe', async (req) => {
    const url = String((req.query || {}).url || '');
    saveSubs(marketSubs().filter((s) => s.url !== url));
    return { ok: true, items: marketSubs() };
  });

  // 用户「看到了新条目」：把已见数量对齐，之后不再重复提示
  app.post('/api/market/ack', async (req) => {
    const url = String((req.body || {}).url || '');
    const count = Number((req.body || {}).count) || 0;
    saveSubs(marketSubs().map((s) => (s.url === url ? { ...s, seenCount: count, lastCheckedAt: Date.now() } : s)));
    return { ok: true, items: marketSubs() };
  });

  // ---- 静态前端 ----
  const pubDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(pubDir)) {
    app.register(fastifyStatic, { root: pubDir, prefix: '/' });
    app.setNotFoundHandler(async (req, reply) => {
      if (!req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return { app, store, scheduler, runner };
}

export function startServer({ dataDir, port }) {
  const { app, store, scheduler, runner } = buildServer({ dataDir, port });
  const shutdown = (sig) => {
    try { scheduler.stop(); store.flush(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    console.log(`[CheckQ] listening on :${port}`);
    // 启动补发：停机错过触发时刻时，昨日汇总补发一次（幂等，30 秒后检查）
    const timer = setTimeout(() => {
      runner.catchUpDailySummary().catch((e) => console.error('[CheckQ] 汇总补发检查失败:', e.message));
    }, 30000);
    timer.unref?.();
  }).catch((err) => {
    console.error('[CheckQ] failed to start:', err);
    process.exit(1);
  });
}
