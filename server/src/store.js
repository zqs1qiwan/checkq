/**
 * JSON 文件存储: flows / runs / meta(密码 hash)
 * 立即原子写（tmp+rename），runs 保留最近 500 条/flow
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Cron } from 'croner';
import { hashPwd, checkPassword, hashApiKey } from './auth.js';
import { secretKey, encryptSecrets, decryptSecrets, maskSecrets, encryptChannels, decryptChannels, maskChannels, encryptMeta, decryptMeta } from './secret.js';
import { normalizeRetry, DEFAULT_RETRY } from './retry.js';
import { normalizeRecovery, nextProbeTime } from './recovery.js';

/**
 * 稳定序列化（对象键排序）：比较流程图时忽略 JSON 键顺序，避免「同内容不同顺序」被误判为改动
 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/** 分组名：去空白、压缩连续空格、限长；空串 = 未分组 */
function normalizeGroup(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function localDayBounds() {
  const day = new Date();
  const start = day.setHours(0, 0, 0, 0);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return { start, end };
}

function runStartTime(startedAt) {
  if (typeof startedAt === 'number') return startedAt;
  if (typeof startedAt === 'string' && startedAt.trim()) {
    const numeric = Number(startedAt);
    return Number.isFinite(numeric) ? numeric : Date.parse(startedAt);
  }
  return NaN;
}

function completedInRange(run, start, end) {
  if (run.status !== 'success' && run.status !== 'failed' && run.status !== 'cancelled') return false;
  const time = runStartTime(run.startedAt);
  return time >= start && time < end;
}

/**
 * 比较两份流程图的「脚本内容」是否相同（忽略节点坐标 x/y）：
 * 派生任务只挪了节点位置 → 仍算没改脚本（继续跟随模板）；
 * 改了节点配置 / 增删节点 / 改了连线 → 算改了脚本（转为独立任务）。
 */
function sameLogic(nodesA, edgesA, nodesB, edgesB) {
  const norm = (nodes, edges) => stable({
    nodes: (nodes || [])
      .map((n) => ({
        id: n.id, type: n.type, name: n.name,
        config: n.config || {},
        genBy: n.genBy || null,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    edges: (edges || [])
      .map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
  return norm(nodesA, edgesA) === norm(nodesB, edgesB);
}

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.flowsFile = path.join(dataDir, 'flows.json');
    this.runsFile = path.join(dataDir, 'runs.json');
    this.metaFile = path.join(dataDir, 'meta.json');
    this.templatesFile = path.join(dataDir, 'templates.json');
    this.notificationsFile = path.join(dataDir, 'notifications.json');
    this.channelsFile = path.join(dataDir, 'channels.json');
    // 敏感凭据静态加密密钥（CHECKQ_SECRET 或 data/.secret）
    this.secretKey = secretKey(dataDir);
    // 磁盘上可能是密文（旧版本是明文），读入时统一解密到内存
    this.flows = this.#load(this.flowsFile, []).map((f) => decryptSecrets(this.secretKey, f));
    this.runs = this.#load(this.runsFile, []);
    this.templates = this.#load(this.templatesFile, []).map((x) => decryptSecrets(this.secretKey, x));
    this.notifications = this.#load(this.notificationsFile, []);
    this.meta = decryptMeta(this.secretKey, this.#load(this.metaFile, {}));

    // ---- 系统通知渠道（v0.5.3）：channels.json 与 flows 同加密策略 ----
    const hasChannelsFile = fs.existsSync(this.channelsFile);
    if (hasChannelsFile) {
      const raw = this.#load(this.channelsFile, { version: 1, system: [] });
      this.channels = { version: 1, system: this.#normalizeChannels(decryptChannels(this.secretKey, raw.system || [])) };
    } else {
      this.channels = { version: 1, system: [] };
      this.#migrateChannelsFromLegacy();
    }

    // ---- 账号体系（v0.4.3）：多用户 + 角色 + 2FA + 审计 ----
    this.meta.users = Array.isArray(this.meta.users) ? this.meta.users : [];
    this.meta.apiKeys = Array.isArray(this.meta.apiKeys) ? this.meta.apiKeys : [];
    this.meta.ipBlocklist = Array.isArray(this.meta.ipBlocklist) ? this.meta.ipBlocklist : [];
    this.meta.audit = Array.isArray(this.meta.audit) ? this.meta.audit : [];

    // 迁移：老数据里的「模板版本标记」已不需要（派生任务现在始终跟随模板），清掉
    let tplCleaned = 0;
    for (const f of this.flows) {
      if (f.tplUpdatedAt !== undefined) { delete f.tplUpdatedAt; tplCleaned++; }
      // 迁移：老任务没有重试配置 → 补默认值（默认开启，失败后自动退避重试）
      if (f.retry === undefined) f.retry = { ...DEFAULT_RETRY };
      else f.retry = normalizeRetry(f.retry);
    }
    for (const t of this.templates) {
      if (t.updatedAt === undefined) t.updatedAt = t.createdAt || Date.now();
    }
    if (tplCleaned) console.log(`[CheckQ] 已清理 ${tplCleaned} 个任务的旧模板版本标记`);

    // 迁移：旧版单密码 meta.passwordHash → admin 用户；并删除明文密码提示
    if (!this.meta.users.length && this.meta.passwordHash) {      this.meta.users.push({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: '管理员',
        role: 'admin',
        passwordHash: this.meta.passwordHash,
        passwordUpdatedAt: Date.now(),
        disabled: false,
        totp: null,
        recoveryCodes: [],
        createdAt: Date.now(),
        lastLoginAt: null,
      });
      console.log('[CheckQ] 已把旧单密码迁移为用户 admin（可稍后在「账号安全」改名/加密码）');
    }
    delete this.meta.passwordHash;   // 不再保留旧字段
    delete this.meta.plainHint;      // 明文密码绝不落盘
    delete this.meta.generatedPassword;

    if (!this.meta.users.length) {
      const pwd = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
      this.meta.users.push({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: '管理员',
        role: 'admin',
        passwordHash: hashPwd(pwd),
        passwordUpdatedAt: Date.now(),
        disabled: false,
        totp: null,
        recoveryCodes: [],
        createdAt: Date.now(),
        lastLoginAt: null,
      });
      // 初始密码只打印一次，绝不写入 meta（日志本身就是唯一交付渠道）
      this.#save(this.metaFile, encryptMeta(this.secretKey, this.meta));
      console.log(`[CheckQ] 初始账号 admin，初始密码: ${pwd}（仅显示一次，请立即登录后修改）`);
    } else {
      delete this.meta.firstRunPassword;
      this.#save(this.metaFile, encryptMeta(this.secretKey, this.meta));
    }
    this.#reconcileInterruptedRuns();
  }

  #reconcileInterruptedRuns() {
    const message = '服务重启，运行中断';
    let changed = false;
    for (const run of this.runs) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      run.status = 'failed';
      run.interrupted = true;
      run.finalMessage = message;
      delete run.cancelling;
      run.logs ??= [];
      run.logs.push({
        stepId: null, index: run.logs.length + 1, name: '服务重启', type: 'system',
        ok: false, message, detail: null, ms: 0,
      });
      changed = true;
    }
    if (changed) this.#save(this.runsFile, this.runs);
  }

  #load(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw new Error(`无法读取存储文件 ${path.basename(file)}，请检查文件或从备份恢复：${err.message}`, { cause: err });
    }
  }

  #save(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  #flushFile(file, data) {
    try {
      this.#save(file, data);
    } catch (err) {
      console.error(`[CheckQ] flush ${path.basename(file)} failed:`, err.message);
    }
  }

  /** 导出/备份用：脱敏后的 flow（敏感值替换为 *** / 空） */
  maskedFlow(f) {
    return maskSecrets(f);
  }

  maskedTemplate(t) {
    return maskSecrets(t);
  }

  /** 系统通知渠道：内存为明文，落盘时加密；inbox 恒有且排第一 */
  #normalizeChannels(list) {
    const arr = Array.isArray(list) ? list : [];
    const existingInbox = arr.find((c) => c && c.type === 'inbox');
    const inbox = { id: existingInbox?.id || 'ch_inbox', type: 'inbox', title: '每日汇总' };
    const external = arr
      .filter((c) => c && typeof c === 'object' && c.type && c.type !== 'inbox')
      .slice(0, 10)
      .map((c) => ({ ...c, id: c.id || `ch_${crypto.randomUUID()}` }));
    return [inbox, ...external];
  }

  /** 首次启动：把旧「推送单位」中第一个仍启用任务的渠道复制成系统渠道（只做一次） */
  #migrateChannelsFromLegacy() {
    const cfg = this.meta.dailySummary || {};
    // 迁移只执行一次：channels.json 被删但 migratedAt 还在时，不再从任务复制
    if (cfg.migratedAt) {
      this.channels = { version: 1, system: this.#normalizeChannels([]) };
      this.#save(this.channelsFile, { version: 1, system: encryptChannels(this.secretKey, this.channels.system) });
      return;
    }
    const ids = Array.isArray(cfg.targetFlowIds) && cfg.targetFlowIds.length
      ? cfg.targetFlowIds
      : (cfg.targetFlowId ? [cfg.targetFlowId] : []);
    let source = null;
    for (const id of ids) {
      const f = this.flows.find((x) => x.id === id);
      if (f && f.enabled && f.notify?.channels?.length) { source = f; break; }
    }
    const external = source
      ? source.notify.channels.filter((c) => c && c.type !== 'inbox').slice(0, 10).map((c) => ({ ...c, id: c.id || `ch_${crypto.randomUUID()}` }))
      : [];
    this.channels = { version: 1, system: this.#normalizeChannels(external) };
    if (source) {
      this.meta.dailySummary = { ...cfg, migratedFrom: source.id, migratedAt: Date.now() };
      console.log(`[CheckQ] 系统通知渠道已从任务「${source.name}」迁移（${external.length} 条外部渠道 + 站内通知）`);
    }
    this.#save(this.channelsFile, { version: 1, system: encryptChannels(this.secretKey, this.channels.system) });
  }

  getSystemChannels() {
    return this.channels.system.map((c) => ({ ...c }));
  }

  setSystemChannels(list) {
    this.channels = { version: 1, system: this.#normalizeChannels(list) };
    this.flush();
    return this.getSystemChannels();
  }

  maskedSystemChannels() {
    return maskChannels(this.channels.system);
  }

  /** 配置更新与进程退出时持久化完整存储。 */
  flush() {
    try {
      this.#save(this.flowsFile, this.flows.map((flow) => encryptSecrets(this.secretKey, flow)));
      this.#save(this.runsFile, this.runs);
      this.#save(this.templatesFile, this.templates.map((template) => encryptSecrets(this.secretKey, template)));
      this.#save(this.notificationsFile, this.notifications);
      this.#save(this.channelsFile, { version: 1, system: encryptChannels(this.secretKey, this.channels.system) });
      this.#save(this.metaFile, encryptMeta(this.secretKey, this.meta));
    } catch (err) {
      console.error('[CheckQ] flush failed:', err.message);
    }
  }

  // ---- flows ----
  /**
   * 下次运行时间：同一个 cron + 时区的所有任务，下次运行时刻相同。
   * 缓存结果（到期自动重算），避免每次列任务都为每个任务新建一个 Cron 对象。
   */
  #nextRunCache = new Map();

  nextRunAt(flow) {
    if (!flow.enabled || !flow.cron) return null;
    const key = `${flow.cron}|${flow.timezone || 'Asia/Shanghai'}`;
    const hit = this.#nextRunCache.get(key);
    const now = Date.now();
    if (hit && hit.at > now) return hit.at;
    try {
      const job = new Cron(flow.cron, { timezone: flow.timezone || 'Asia/Shanghai' });
      const next = job.nextRun();
      const at = next ? next.getTime() : null;
      job.stop();
      this.#nextRunCache.set(key, { at: at || 0 });
      return at;
    } catch {
      this.#nextRunCache.set(key, { at: 0 });
      return null;   // 无效 cron 不显示
    }
  }

  listFlows() {
    // 预聚合「今日」运行统计（按服务器本地日期），避免每个任务都扫一遍 runs
    const { start, end } = localDayBounds();
    const todayByFlow = new Map();
    const lastByFlow = new Map();
    for (const r of this.runs) {
      if (!lastByFlow.has(r.flowId)) lastByFlow.set(r.flowId, r);
      if (!completedInRange(r, start, end)) continue;
      const rec = todayByFlow.get(r.flowId) || { runs: 0, success: 0, failed: 0 };
      rec.runs++;
      if (r.status === 'success') rec.success++;
      else if (r.status === 'failed') rec.failed++;
      todayByFlow.set(r.flowId, rec);
    }
    const templatesById = new Map();
    for (const template of this.templates) {
      if (!templatesById.has(template.id)) templatesById.set(template.id, template);
    }
    return this.flows.map((f) => {
      const last = lastByFlow.get(f.id) || null;
      const lastRun = last ? {
        id: last.id, status: last.status, startedAt: last.startedAt, finalMessage: last.finalMessage,
        interrupted: last.interrupted, timedOut: last.timedOut,
      } : null;
      const t = todayByFlow.get(f.id) || { runs: 0, success: 0, failed: 0 };
      const today = {
        runs: t.runs, success: t.success, failed: t.failed,
        rate: t.runs ? Math.round((t.success / t.runs) * 100) : null,
      };
      // 下次运行时间（croner nextRun，仅启用调度的任务）
      const nextRunAt = this.nextRunAt(f);
      const template = f.tplId ? templatesById.get(f.tplId) ?? null : null;
      const nodes = template ? template.nodes : f.nodes;
      return {
        id: f.id, name: f.name, note: f.note, cron: f.cron, timezone: f.timezone,
        enabled: f.enabled, jitterMinutes: f.jitterMinutes || 0, varsCount: Object.keys(f.vars || {}).length,
        group: f.group || '',                  // 分组名（空 = 未分组）
        retry: normalizeRetry(f.retry),       // 失败重试策略（列表/详情展示用）
        recovery: normalizeRecovery(f.recovery), // 自动恢复探测配置与运行态
        isDemo: f.isDemo === true,            // 内置演练任务（P0-1）：界面标记「演示」，不参与导出
        pausedAt: f.pausedAt || null,          // 连续失败自动停用的时间
        pausedReason: f.pausedReason || '',    // 自动停用的原因（最后一次失败结论）
        nodesCount: (nodes || []).length, tplId: f.tplId || null,
        template: this.templateInfo(f, template),
        lastRun,
        today,
        nextRunAt,
      };
    });
  }

  /** 原始存储的任务（不做模板解析）—— 写路径用 */
  getFlowRaw(id) {
    return this.flows.find((f) => f.id === id) || null;
  }

  /**
   * 派生任务 = 模板 + 各自的参数：流程图始终用模板当前版本。
   * 模板还在 → 用模板的节点/连线/日志配置（模板一改，任务立刻跟着变）；
   * 模板被删 → 用自己存的那份（保证「删模板不影响已建任务」）。
   */
  resolveFlow(f) {
    if (!f) return f;
    if (!f.tplId) return { ...f };
    const tpl = this.getTemplate(f.tplId);
    if (!tpl) return { ...f };
    return {
      ...f,
      nodes: tpl.nodes || [],
      edges: tpl.edges || [],
      log: tpl.log || null,
    };
  }

  getFlow(id) {
    const f = this.getFlowRaw(id);
    return f ? this.resolveFlow(f) : null;
  }

  createFlow(data) {
    const jitterMinutes = Math.min(30, Math.max(0, Number(data.jitterMinutes) || 0));
    const cron = (data.cron || '').trim();
    const flow = {
      id: crypto.randomUUID(),
      name: data.name || '未命名流程',
      note: data.note || '',
      cron,
      timezone: data.timezone || 'Asia/Shanghai',
      // 默认不调度；但调用方显式传 enabled:true 且给了 cron 时按请求启用
      // （没有 cron 就没有调度意义，强制关闭）
      enabled: data.enabled === true && !!cron,
      jitterMinutes,
      group: normalizeGroup(data.group),
      vars: data.vars || {},
      nodes: data.nodes || [],
      edges: data.edges || [],
      notify: data.notify || {},
      log: data.log || null,
      // 任务级失败重试：默认开启（3 次、指数退避），用户可在「调度」里关闭
      retry: normalizeRetry(data.retry),
      // 自动停用后的恢复探测：默认关闭；开启后由 scheduler 按间隔静默探测
      recovery: normalizeRecovery(data.recovery),
      isDemo: data.isDemo === true,
      pausedAt: data.pausedAt || null,
      pausedReason: data.pausedReason || '',
      tplId: data.tplId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rev: 0,
    };
    this.flows.push(flow);
    this.flush();
    return flow;
  }

  updateFlow(id, patch) {
    const f = this.getFlowRaw(id);
    if (!f) return null;
    const allowed = ['name', 'note', 'cron', 'timezone', 'enabled', 'vars', 'nodes', 'edges', 'notify', 'log', 'jitterMinutes', 'retry', 'recovery', 'group', 'tplId', 'isDemo', 'pausedAt', 'pausedReason'];
    // 派生任务改了「脚本内容」→ 自动转成独立任务（否则模板下次更新会把用户的改动覆盖掉）
    let detached = null;
    if (f.tplId && (patch.nodes !== undefined || patch.edges !== undefined)) {
      const tpl = this.getTemplate(f.tplId);
      if (tpl && !sameLogic(patch.nodes ?? f.nodes, patch.edges ?? f.edges, tpl.nodes, tpl.edges)) {
        detached = tpl.name;
        f.tplId = null;
      }
    }
    for (const k of allowed) {
      if (patch[k] !== undefined && k !== 'recovery') f[k] = patch[k];
    }
    // 分组名始终收敛成合法值（去空白 / 限长）
    if (patch.group !== undefined) f.group = normalizeGroup(patch.group);
    // 重试配置始终收敛成合法值（手写 API / 旧前端都不会把引擎搞崩）
    if (patch.retry !== undefined) f.retry = normalizeRetry(patch.retry);
    // 恢复探测配置与运行态一起收敛；前端只传 enabled/interval/maxAttempts 时保留已有时刻
    if (patch.recovery !== undefined) {
      const merged = normalizeRecovery({ ...(f.recovery || {}), ...patch.recovery });
      // 刚给一个已暂停任务打开探测：从「现在 + 间隔」开始，不立刻打站点
      if (merged.enabled && f.pausedAt && !merged.nextProbeAt && !merged.exhausted) {
        merged.nextProbeAt = nextProbeTime(merged);
      }
      f.recovery = merged;
    }
    // 重新启用即视为用户主动恢复：清掉自动停用的标记
    if (patch.enabled === true) {
      f.pausedAt = null;
      f.pausedReason = '';
      const rec = normalizeRecovery(f.recovery);
      // 手动重新启用保留「上次探测结果」；探测成功则带上 success 结果一起落库
      f.recovery = {
        ...rec,
        attempts: 0,
        nextProbeAt: null,
        exhausted: false,
        lastProbeAt: rec.lastProbeAt,
        lastResult: rec.lastResult,
      };
    }
    // 兜底：任何写入路径（包括手写 API）让「已暂停 + 已开启探测」但没有下一次时间时补齐
    if (f.recovery?.enabled && f.pausedAt && !f.recovery.nextProbeAt && !f.recovery.exhausted) {
      f.recovery.nextProbeAt = nextProbeTime(f.recovery);
    }
    f.updatedAt = Date.now();
    f.rev = (Number(f.rev) || 0) + 1;
    this.flush();
    const out = this.resolveFlow(f);
    if (detached) out.detached = detached;   // 只在返回值里提示一次，不落盘
    return out;
  }

  deleteFlow(id) {
    const i = this.flows.findIndex((f) => f.id === id);
    if (i >= 0) {
      this.flows.splice(i, 1);
      this.runs = this.runs.filter((r) => r.flowId !== id);
      this.flush();
      return true;
    }
    return false;
  }

  // ---- templates ----
  listTemplates() {
    if (!this.templates.length) return [];
    const taskCounts = new Map();
    for (const { tplId } of this.flows) {
      if (tplId) taskCounts.set(tplId, (taskCounts.get(tplId) || 0) + 1);
    }
    return this.templates.map((t) => ({
      id: t.id, name: t.name, desc: t.desc, source: t.source,
      varNames: t.varNames || [],
      nodesCount: (t.nodes || []).length,
      taskCount: taskCounts.get(t.id) || 0,
      updatedAt: t.updatedAt || t.createdAt || 0,
      market: t.market || null,   // 市场来源 { sourceId, sourceUrl, sha256, importedAt }
    }));
  }

  getTemplate(id) {
    return this.templates.find((t) => t.id === id) || null;
  }

  createTemplate(data, source = 'flow') {
    const now = Date.now();
    const tpl = {
      id: crypto.randomUUID(),
      name: data.name || '未命名模板',
      desc: data.desc || '',
      source,
      varNames: data.varNames || Object.keys(data.vars || {}),
      vars: data.vars || {},      // 默认变量值（生成任务时预填）
      nodes: data.nodes || [],
      edges: data.edges || [],
      // 模板携带日志配置（PRD §4.3.1）：level/include/resBodyLimit/keywords 随模板复制
      log: data.log || null,
      // 模板携带通知渠道（带通知的模板实例自动带上通知）：flow.notify 经模板边界不丢失
      notify: data.notify || {},
      market: data.market || null,   // 模板市场来源（导入时写入，用于重复导入判定）
      createdAt: now,
      updatedAt: now,
    };
    this.templates.push(tpl);
    this.flush();
    return tpl;
  }

  updateTemplate(id, patch) {
    const t = this.getTemplate(id);
    if (!t) return null;
    for (const k of ['name', 'desc', 'vars', 'varNames', 'log', 'nodes', 'edges', 'notify', 'market']) {
      if (patch[k] !== undefined) t[k] = patch[k];
    }
    // varNames 与 vars 保持一致：显式传 varNames 时以它为准补齐 vars；只改 vars 时同步 varNames
    if (patch.varNames !== undefined) {
      for (const vn of patch.varNames) if (t.vars[vn] === undefined) t.vars[vn] = '';
    } else if (patch.vars !== undefined) {
      t.varNames = Object.keys(t.vars);
    }
    t.updatedAt = Date.now();
    // 派生任务立刻跟随：把新版本写进它们各自的副本（模板被删时任务仍能用最后这份）
    this.refreshDerived(t);
    this.flush();
    return t;
  }

  /** 模板内容变化 → 派生任务的本地副本同步刷新（读取时本来就用模板当前版本，这里只是保底） */
  refreshDerived(tpl) {
    for (const f of this.flows) {
      if (f.tplId !== tpl.id) continue;
      f.nodes = JSON.parse(JSON.stringify(tpl.nodes || []));
      f.edges = JSON.parse(JSON.stringify(tpl.edges || []));
      f.log = tpl.log ? JSON.parse(JSON.stringify(tpl.log)) : null;
      const vars = { ...(f.vars || {}) };
      for (const vn of tpl.varNames || []) if (vars[vn] === undefined) vars[vn] = '';
      f.vars = vars;
      f.updatedAt = Date.now();
    }
  }

  /** 模板信息（派生任务用：来源模板名） */
  templateInfo(flow, tpl = flow?.tplId ? this.getTemplate(flow.tplId) : null) {
    if (!flow?.tplId) return null;
    if (!tpl) return { id: flow.tplId, name: '(模板已删除)', missing: true };
    return { id: tpl.id, name: tpl.name, missing: false };
  }

  deleteTemplate(id) {
    const i = this.templates.findIndex((t) => t.id === id);
    if (i < 0) return false;
    // 模板删了：派生任务保留最后一份流程图（resolveFlow 找不到模板就用本地副本），照常能跑
    this.templates.splice(i, 1);
    this.flush();
    return true;
  }

  /** 从模板生成任务实例：任务 = 模板 + 自己的变量（流程图始终跟随模板） */
  instantiateTemplate(tplId, { name, vars, note } = {}) {
    const tpl = this.getTemplate(tplId);
    if (!tpl) return null;
    const mergedVars = { ...(tpl.vars || {}), ...(vars || {}) };
    const seq = this.flows.filter((f) => f.tplId === tplId).length + 1;
    return this.createFlow({
      name: name || `${tpl.name} · ${seq}`,
      note: note !== undefined ? note : `来自模板「${tpl.name}」`,
      vars: mergedVars,
      nodes: tpl.nodes,
      edges: tpl.edges,
      log: tpl.log,
      notify: tpl.notify || {},
      tplId,
    });
  }

  // ---- runs ----
  addRun(run) {
    // 幂等：同 id 覆盖（避免重复入列）
    const i = this.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) {
      this.runs[i] = run;
    } else {
      this.runs.unshift(run);
    }
    // 每 flow 保留最近 500
    const per = new Map();
    this.runs = this.runs.filter((r) => {
      const n = (per.get(r.flowId) || 0) + 1;
      per.set(r.flowId, n);
      return n <= 500;
    });
    this.flushRuns();
  }

  /** 持久化运行状态及已写入记录的通知结果。 */
  flushRuns() {
    this.#flushFile(this.runsFile, this.runs);
  }

  listRuns(flowId, limit = 30) {
    if (!flowId) return this.runs.slice(0, limit);
    if (!Number.isInteger(limit) || limit < 0) {
      return this.runs.filter((run) => run.flowId === flowId).slice(0, limit);
    }
    const matches = [];
    for (const run of this.runs) {
      if (matches.length === limit) break;
      if (run.flowId === flowId) matches.push(run);
    }
    return matches;
  }

  getRun(id) {
    return this.runs.find((r) => r.id === id) || null;
  }

  // ---- notifications（站内通知，qinglong 风格“应用内消息”） ----
  addNotification({ title, content, level = 'info', flowId = null, flowName = '' }) {
    const n = {
      id: crypto.randomUUID(),
      title: String(title || 'CheckQ 通知').slice(0, 200),
      content: String(content || '').slice(0, 8000),
      level: ['info', 'success', 'fail'].includes(level) ? level : 'info',
      flowId, flowName,
      read: false,
      createdAt: Date.now(),
    };
    this.notifications.unshift(n);
    if (this.notifications.length > 200) this.notifications = this.notifications.slice(0, 200);
    this.#flushFile(this.notificationsFile, this.notifications);
    return n;
  }

  listNotifications(limit = 50) {
    return {
      items: this.notifications.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))),
      unread: this.notifications.filter((n) => !n.read).length,
      total: this.notifications.length,
    };
  }

  markNotificationsRead(ids) {
    if (ids?.length === 0) return 0;
    const selected = ids === undefined ? null : new Set(ids);
    let updated = 0;
    const notifications = this.notifications.map((item) => {
      if (item.read || (selected && !selected.has(item.id))) return item;
      updated++;
      return { ...item, read: true };
    });
    if (updated) {
      this.#save(this.notificationsFile, notifications);
      this.notifications = notifications;
    }
    return updated;
  }

  clearNotifications() {
    const n = this.notifications.length;
    this.notifications = [];
    this.#flushFile(this.notificationsFile, this.notifications);
    return n;
  }

  /** 运维统计（首页健康条）：任务/调度/今日运行/成功率/下次触发 */

  // ---- users ----
  listUsers() {
    return this.meta.users.map((u) => this.#publicUser(u));
  }

  #publicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      role: u.role || 'operator',
      disabled: !!u.disabled,
      totpEnabled: !!(u.totp && u.totp.enabled),
      recoveryCodesLeft: Array.isArray(u.recoveryCodes) ? u.recoveryCodes.length : 0,
      createdAt: u.createdAt || null,
      lastLoginAt: u.lastLoginAt || null,
      passwordUpdatedAt: u.passwordUpdatedAt || null,
      failedLogins: u.failedLogins || 0,
      lockedUntil: u.lockedUntil || null,
    };
  }

  getUser(id) {
    return this.meta.users.find((u) => u.id === id) || null;
  }

  getUserByName(username) {
    const name = String(username || '').trim().toLowerCase();
    return this.meta.users.find((u) => String(u.username).toLowerCase() === name) || null;
  }

  createUser({ username, password, role = 'operator', displayName }) {
    const user = {
      id: crypto.randomUUID(),
      username: String(username).trim(),
      displayName: String(displayName || username).trim(),
      role,
      passwordHash: hashPwd(password),
      passwordUpdatedAt: Date.now(),
      disabled: false,
      totp: null,
      recoveryCodes: [],
      createdAt: Date.now(),
      lastLoginAt: null,
      failedLogins: 0,
      lockedUntil: null,
    };
    this.meta.users.push(user);
    this.flush();
    return user;
  }

  updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) return null;
    if (patch.username !== undefined) u.username = String(patch.username).trim();
    if (patch.displayName !== undefined) u.displayName = String(patch.displayName).trim();
    if (patch.role !== undefined) u.role = patch.role;
    if (patch.disabled !== undefined) u.disabled = !!patch.disabled;
    if (patch.passwordHash !== undefined) {
      u.passwordHash = patch.passwordHash;
      u.passwordUpdatedAt = Date.now();
    }
    if (patch.totp !== undefined) u.totp = patch.totp;
    if (patch.recoveryCodes !== undefined) u.recoveryCodes = patch.recoveryCodes;
    if (patch.failedLogins !== undefined) u.failedLogins = patch.failedLogins;
    if (patch.lockedUntil !== undefined) u.lockedUntil = patch.lockedUntil;
    this.flush();
    return u;
  }

  deleteUser(id) {
    const i = this.meta.users.findIndex((u) => u.id === id);
    if (i === -1) return false;
    this.meta.users.splice(i, 1);
    this.flush();
    return true;
  }

  // ---- api keys ----
  listApiKeys() {
    return this.meta.apiKeys.map((k) => ({
      id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt || null, userId: k.userId || null, disabled: !!k.disabled,
      scopes: Array.isArray(k.scopes) ? k.scopes : ['read', 'run', 'write'],
      flowIds: Array.isArray(k.flowIds) ? k.flowIds : [],
      groups: Array.isArray(k.groups) ? k.groups : [],
      expiresAt: k.expiresAt || null,
      expired: !!(k.expiresAt && k.expiresAt < Date.now()),
      daysLeft: k.expiresAt ? Math.ceil((k.expiresAt - Date.now()) / 86400e3) : null,
      expiresSoon: !!(k.expiresAt && k.expiresAt > Date.now() && k.expiresAt - Date.now() <= 7 * 86400e3),
      allowedIps: Array.isArray(k.allowedIps) ? k.allowedIps : [],
      useCount: k.useCount || 0,
      lastUsedIp: k.lastUsedIp || null,
    }));
  }

  addApiKey({ name, hash, prefix, userId, scopes, expiresAt, allowedIps, flowIds, groups }) {
    const k = {
      id: crypto.randomUUID(), name: name || 'API Key', hash, prefix, userId: userId || null,
      createdAt: Date.now(), lastUsedAt: null, disabled: false,
      scopes: Array.isArray(scopes) ? scopes : ['read', 'run', 'write'],
      flowIds: Array.isArray(flowIds) ? flowIds.map(String).filter(Boolean) : [],
      groups: Array.isArray(groups) ? groups.map((g) => normalizeGroup(g)).filter(Boolean) : [],
      expiresAt: expiresAt || null,
      allowedIps: Array.isArray(allowedIps) ? allowedIps.filter(Boolean) : [],
    };
    this.meta.apiKeys.push(k);
    this.flush();
    return k;
  }

  revokeApiKey(id) {
    const i = this.meta.apiKeys.findIndex((k) => k.id === id);
    if (i === -1) return false;
    if (this.meta.apiKey && hashApiKey(this.meta.apiKey) === this.meta.apiKeys[i].hash) delete this.meta.apiKey;
    this.meta.apiKeys.splice(i, 1);
    this.flush();
    return true;
  }

  findApiKeyByHash(hash, ip = '') {
    const k = this.meta.apiKeys.find((x) => x.hash === hash && !x.disabled);
    if (k) {
      const firstUse = !k.useCount;
      k.lastUsedAt = Date.now();
      k.useCount = (k.useCount || 0) + 1;
      if (ip) k.lastUsedIp = String(ip).slice(0, 64);
      this.flush();
      if (firstUse) this.audit('apikey.first-use', `名称=${k.name}`, '');
    }
    return k || null;
  }

  // 更新 API Key（作用域 / 允许 IP / 名称）
  updateApiKey(id, patch) {
    const k = this.meta.apiKeys.find((x) => x.id === id);
    if (!k) return null;
    if (patch.name !== undefined) k.name = String(patch.name).slice(0, 40);
    if (patch.scopes !== undefined && Array.isArray(patch.scopes)) {
      k.scopes = patch.scopes.filter((s) => ['read', 'run', 'write', 'secrets'].includes(s));
    }
    if (patch.flowIds !== undefined && Array.isArray(patch.flowIds)) {
      k.flowIds = patch.flowIds.map(String).filter(Boolean);
    }
    if (patch.groups !== undefined && Array.isArray(patch.groups)) {
      k.groups = patch.groups.map((g) => normalizeGroup(g)).filter(Boolean);
    }
    if (patch.allowedIps !== undefined && Array.isArray(patch.allowedIps)) {
      k.allowedIps = patch.allowedIps.map((x) => String(x || '').trim()).filter(Boolean);
    }
    if (patch.expiresAt !== undefined) k.expiresAt = patch.expiresAt || null;
    this.flush();
    return k;
  }

  // ---- IP 黑名单 ----
  listBlockedIps() {
    return [...new Set(this.meta.ipBlocklist.map((x) => String(x).trim()).filter(Boolean))];
  }

  blockIp(ip) {
    const v = String(ip || '').trim();
    if (!v) return this.listBlockedIps();
    if (!this.meta.ipBlocklist.includes(v)) this.meta.ipBlocklist.push(v);
    this.flush();
    return this.listBlockedIps();
  }

  unblockIp(ip) {
    const v = String(ip || '').trim();
    this.meta.ipBlocklist = this.meta.ipBlocklist.filter((x) => String(x).trim() !== v);
    this.flush();
    return this.listBlockedIps();
  }

  // ---- audit ----
  audit(action, detail = '', actor = '') {
    this.meta.audit.unshift({ at: Date.now(), action, detail: String(detail || '').slice(0, 300), actor: actor || '' });
    if (this.meta.audit.length > 500) this.meta.audit.length = 500;
    this.flush();
  }

  listAudit(limit = 100) {
    return this.meta.audit.slice(0, Math.min(Math.max(1, limit), 500));
  }

  /** 指定时间窗内的运行统计（每日汇总用；窗口按服务器本地自然日） */
  statsForRange(startMs, endMs) {
    let runs = 0;
    let success = 0;
    let failed = 0;
    const latestSuccess = new Map();
    const latestFailure = new Map();
    for (let i = 0; i < this.runs.length; i++) {
      const run = this.runs[i];
      const { status, flowId } = run;
      if (status !== 'success' && status !== 'failed' && status !== 'cancelled') continue;
      const at = runStartTime(run.startedAt);
      if (!(at <= endMs)) continue;
      if (status === 'success') {
        const previous = latestSuccess.get(flowId);
        if (!previous || at > previous.at) latestSuccess.set(flowId, { at, index: i });
      }
      if (at < startMs) continue;
      runs++;
      if (status === 'success') success++;
      if (status === 'failed') {
        failed++;
        const previous = latestFailure.get(flowId);
        if (!previous || at > previous.at) latestFailure.set(flowId, { run, at, consecutive: 0 });
      }
    }

    // 成功中断连续失败。同一毫秒内沿用历史顺序，取消和在途记录不影响计数。
    if (latestFailure.size) {
      for (let i = 0; i < this.runs.length; i++) {
        const run = this.runs[i];
        if (run.status !== 'failed') continue;
        const failure = latestFailure.get(run.flowId);
        if (!failure) continue;
        const at = runStartTime(run.startedAt);
        if (!(at <= endMs)) continue;
        const lastOk = latestSuccess.get(run.flowId);
        if (!lastOk || at > lastOk.at || (at === lastOk.at && i < lastOk.index)) failure.consecutive++;
      }
    }
    const names = new Map(this.flows.map((flow) => [flow.id, flow.name]));
    const failures = [...latestFailure].map(([flowId, { run, at, consecutive }]) => ({
      flowName: names.get(flowId) || run.flowName || '已删除任务',
      at,
      message: String(run.finalMessage || run.summary || '').split('\n')[0].slice(0, 160),
      consecutive,
    }));

    const paused = this.flows
      .filter((f) => f.pausedAt && f.pausedAt >= startMs && f.pausedAt <= endMs)
      .map((f) => ({ flowName: f.name || '', at: f.pausedAt, reason: f.pausedReason || '' }));

    const { nextFlowName, nextRunAt } = this.#scheduleSummary();
    return {
      window: { startMs, endMs },
      enabledFlows: this.flows.filter((f) => f.enabled).length,
      runs,
      success,
      failed,
      rate: runs ? Math.round((success / runs) * 100) : null,
      failures,
      paused,
      next: { flowName: nextFlowName || '', at: nextRunAt },
      empty: runs === 0,
    };
  }

  #scheduleSummary() {
    let enabledScheduled = 0;
    let nextRunAt = null;
    let nextFlowName = null;
    for (const f of this.flows) {
      if (!f.enabled || !f.cron) continue;
      enabledScheduled++;
      // 复用 nextRunAt 的 cron|时区缓存，避免每次统计都为每个任务新建 Cron 对象
      const next = this.nextRunAt(f);
      if (next && (nextRunAt === null || next < nextRunAt)) {
        nextRunAt = next;
        nextFlowName = f.name || '';
      }
    }
    return { enabledScheduled, nextRunAt, nextFlowName };
  }

  stats() {
    const { start, end } = localDayBounds();
    let todayRuns = 0;
    let todaySuccess = 0;
    let todayFailed = 0;
    for (const run of this.runs) {
      if (!completedInRange(run, start, end)) continue;
      todayRuns++;
      if (run.status === 'success') todaySuccess++;
      else if (run.status === 'failed') todayFailed++;
    }
    return {
      flows: this.flows.length,
      templates: this.templates.length,
      todayRuns,
      todaySuccess,
      todayFailed,
      successRate: todayRuns ? Math.round((todaySuccess / todayRuns) * 100) : null,
      ...this.#scheduleSummary(),
    };
  }
}

// 密码哈希已抽到 server/src/auth.js（scrypt N=16384 + 随机盐 + 常量时间比较）
export { hashPwd, verifyPwd, checkPassword, checkUsername, hashApiKey, newApiKey, ROLES, PASSWORD_MIN } from './auth.js';
