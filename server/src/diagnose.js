/**
 * 失败诊断（P0-3「可解释失败」）
 *
 * 纯函数：输入一条运行记录（或单步日志）+ 流程，输出「原因 + 证据 + 下一步动作」。
 * 硬规则（见 docs/ARCHITECTURE.md §5.4、docs/PRD.md §5.3）：
 *   - 不读 store、不调模型、不改流程、不自动重跑；
 *   - 证据只来自可观测结果（状态码、断言值、超时、缺变量、响应特征）；
 *   - 文案只陈述事实，不使用「可能 / 也许 / 大概」这类无法验证的措辞；
 *   - 低置信（证据不足）只给"看这一步"，不给动作按钮。
 *
 * 输出结构：
 *   {
 *     rule,                       // 规则 id，见 RULES
 *     cause,                      // 一句话原因（给人看）
 *     confidence: 'high'|'medium'|'low',
 *     evidence: [{ label, value }],
 *     actions: [{ type, label, stepId?, vars? }],   // 白名单见 ACTIONS
 *     step: { index, name, stepId } | null,
 *   }
 */

export const ACTIONS = {
  'show-response': '看这一步的响应',
  'edit-vars': '改变量',
  'edit-assert': '调整断言',
  'copy-issue': '复制为排障摘要',
};

/** 诊断规则清单（改规则必须同步 server/test/fixtures/diagnose/*.json 与 tools/diagnose-replay.cjs） */
export const RULES = ['missing-var', 'credential', 'risk-control', 'assert', 'network', 'server-error', 'client-error', 'engine', 'unknown'];

const BANNED = ['可能', '也许', '大概', '或许', '估计'];

/** 响应/文本脱敏：抹掉凭据字面值，再截断 */
export function redactText(text, limit = 160) {
  const s = String(text ?? '');
  const masked = s
    .replace(/((?:cookie|authorization|set-cookie|token|secret|password|passwd|api[-_]?key)\s*[:=]\s*)[^\s,;"']+/gi, '$1***')
    .replace(/(qsid|sessionid|sid)=[^\s;]+/gi, '$1=***');
  return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
}

/** URL 脱敏：查询串里的值一律打码（凭据常在 query 里） */
export function redactUrl(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  if (i < 0) return s;
  const q = s.slice(i + 1).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0 ? pair : `${pair.slice(0, eq)}=***`;
  });
  return `${s.slice(0, i)}?${q.join('&')}`;
}

const LOGIN_HINTS = /(请先登录|请登录|登录已过期|登录失效|not\s*logged\s*in|sign\s*in|login\s*required|unauthorized|访问受限|请重新登录)/i;
const LOGIN_PATH = /login|signin|sign-in|passport|auth|sso|account\/login/i;
const RISK_HINTS = /(captcha|cf-challenge|challenge-platform|验证码|人机验证|访问被拒绝|access denied|forbidden|风控|滑动验证|请稍候)/i;

function pickFailLog(run) {
  const logs = Array.isArray(run?.logs) ? run.logs : [];
  // 优先"有请求细节的失败步骤"：它能给出状态码与响应体
  const failed = logs.filter((l) => l && l.ok === false);
  const http = failed.find((l) => l.type === 'http' && l.detail);
  return http || failed[0] || null;
}

function stepOf(log) {
  return log ? { index: log.index, name: log.name, stepId: log.stepId || null, type: log.type } : null;
}

function respOf(log) {
  return log?.detail?.response || null;
}

function bodyOf(log) {
  const r = respOf(log);
  if (!r) return '';
  return typeof r.body === 'string' ? r.body : '';
}

function headerOf(log, name) {
  const h = respOf(log)?.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? String(h[key]) : '';
}

function actionsFor(rule, log) {
  const stepId = log?.stepId || null;
  const base = stepId ? [{ type: 'show-response', label: ACTIONS['show-response'], stepId }] : [];
  switch (rule) {
    case 'missing-var':
      return [{ type: 'edit-vars', label: ACTIONS['edit-vars'], vars: log?.missing || [] }, ...base,
        { type: 'copy-issue', label: ACTIONS['copy-issue'], stepId }];
    case 'credential':
      return [{ type: 'edit-vars', label: ACTIONS['edit-vars'], vars: ['cookie'] }, ...base,
        { type: 'copy-issue', label: ACTIONS['copy-issue'], stepId }];
    case 'assert':
      return [{ type: 'edit-assert', label: ACTIONS['edit-assert'], stepId }, ...base,
        { type: 'copy-issue', label: ACTIONS['copy-issue'], stepId }];
    case 'risk-control':
      return [...base, { type: 'copy-issue', label: ACTIONS['copy-issue'], stepId }];
    default:
      return [...base, { type: 'copy-issue', label: ACTIONS['copy-issue'], stepId }];
  }
}

function networkCause(message) {
  const m = String(message || '');
  if (/\b(abort|aborted|timeout|timed out|ETIMEDOUT|超时)\b/i.test(m)) return { cause: '请求超时：在限定时间内没有拿到响应', hint: '网络慢或站点限流，必要时把超时调大' };
  if (/ENOTFOUND|EAI_AGAIN|DNS|getaddrinfo/i.test(m)) return { cause: '域名解析失败：这台机器找不到该站点', hint: '检查 URL 拼写与本机 DNS' };
  if (/CERT|TLS|SSL|self.signed|UNABLE_TO_VERIFY/i.test(m)) return { cause: 'TLS 证书校验失败：站点证书不被信任', hint: '确认站点证书，或在配置里改用 curl 后端对照' };
  if (/ECONNREFUSED|connection refused/i.test(m)) return { cause: '连接被拒绝：该地址没有服务在监听', hint: '检查端口与站点是否下线' };
  if (/ECONNRESET|socket hang up/i.test(m)) return { cause: '连接被对端中断', hint: '稍后重试；反复出现时降低请求频率' };
  return { cause: '网络请求失败：没有拿到响应', hint: '检查 URL、代理与出站网络' };
}

/**
 * 诊断一次运行。
 * @param {{ run?: object, flow?: object }} input
 * @returns {null | object} 运行成功时返回 null
 */
export function diagnose({ run, flow } = {}) {
  if (!run || run.status !== 'failed') return null;
  const log = pickFailLog(run);
  const step = stepOf(log);
  const noStep = !log;

  // ---- 1) 缺变量：引擎在渲染时收集的 missing ----
  const missing = Array.isArray(log?.missing) ? log.missing.filter(Boolean) : [];
  if (missing.length) {
    return {
      rule: 'missing-var',
      cause: `变量「${missing.join('、')}」没有定义，这一步被按空值发了出去`,
      confidence: 'high',
      evidence: [
        { label: '未定义变量', value: missing.join('、') },
        { label: '步骤', value: log.name || log.type },
        ...(log.message ? [{ label: '步骤输出', value: redactText(log.message) }] : []),
      ],
      actions: actionsFor('missing-var', log),
      step: step || null,
    };
  }

  const resp = respOf(log);
  const status = Number(resp?.status || 0);
  const body = bodyOf(log);
  const location = headerOf(log, 'location');

  // ---- 2) 凭据失效：401 / 跳登录页 / 响应命中登录关键字 ----
  const redirected = status >= 300 && status < 400 && LOGIN_PATH.test(location);
  const hitLogin = LOGIN_HINTS.test(body) || (location && LOGIN_HINTS.test(location));
  if (status === 401 || redirected || hitLogin) {
    const why = status === 401
      ? '站点返回 401：当前凭据不被接受'
      : redirected
        ? `站点把请求跳到了登录页（${status} → ${redactUrl(location).slice(0, 80)}）`
        : '响应里出现了登录提示，说明当前凭据已不生效';
    return {
      rule: 'credential',
      cause: `${why}。凭据已失效`,
      confidence: 'high',
      evidence: [
        { label: '状态码', value: String(status || '—') },
        ...(location ? [{ label: '跳转目标', value: redactUrl(location) }] : []),
        ...(body ? [{ label: '响应特征', value: redactText(body, 120) }] : []),
      ],
      actions: actionsFor('credential', log),
      step: step || null,
    };
  }

  // ---- 3) 风控：403 且响应带挑战特征 ----
  const challenge = RISK_HINTS.test(body) || RISK_HINTS.test(headerOf(log, 'server')) || RISK_HINTS.test(headerOf(log, 'cf-mitigated'));
  if (status === 403 && challenge) {
    return {
      rule: 'risk-control',
      cause: '站点把这次请求判为异常访问（403），并给出了人机校验页',
      confidence: 'medium',
      evidence: [
        { label: '状态码', value: '403' },
        ...(body ? [{ label: '响应特征', value: redactText(body, 120) }] : []),
        { label: '可做的', value: '降低频率、补全更完整的请求头，或改用 curl 后端再试' },
      ],
      actions: actionsFor('risk-control', log),
      step: step || null,
    };
  }

  // ---- 4) 断言不匹配：给出实际值与期望值 ----
  // 状态码本身 ≥400 时，先让"站点拒绝了请求"解释原因（断言只是它的后果）
  const badAssert = (log?.asserts || []).find((a) => a && a.pass === false);
  if (badAssert && !(status >= 400)) {
    const expect = badAssert.expect === undefined ? '真' : JSON.stringify(badAssert.expect);
    const actual = badAssert.error ? `表达式报错：${badAssert.error}` : JSON.stringify(badAssert.actual ?? null);
    const label = badAssert.label || badAssert.expr || '断言';
    return {
      rule: 'assert',
      cause: `断言「${label}」没有通过：实际是 ${actual}，期望 ${expect}`,
      confidence: 'high',
      evidence: [
        { label: '断言', value: label },
        { label: '期望', value: String(expect).slice(0, 120) },
        { label: '实际', value: String(actual).slice(0, 120) },
        ...(status ? [{ label: '状态码', value: String(status) }] : []),
      ],
      actions: actionsFor('assert', log),
      step: step || null,
    };
  }

  // ---- 5) 网络层 ----
  if (log?.errorType === 'network' || /请求失败|fetch failed|network/i.test(log?.message || '')) {
    const n = networkCause(log?.message);
    return {
      rule: 'network',
      cause: n.cause,
      confidence: 'high',
      evidence: [
        { label: '步骤', value: `${log.name || ''}`.trim() || '—' },
        ...(log.detail?.url ? [{ label: '地址', value: redactUrl(log.detail.url) }] : []),
        { label: '原始错误', value: redactText(log.message) },
        { label: '下一步', value: n.hint },
      ],
      actions: actionsFor('network', log),
      step: step || null,
    };
  }

  // ---- 6) 站点侧 5xx / 请求被 4xx 拒绝 ----
  if (status >= 500) {
    return {
      rule: 'server-error',
      cause: `站点服务端出错（${status}），问题不在你这条流程`,
      confidence: 'high',
      evidence: [
        { label: '状态码', value: String(status) },
        ...(body ? [{ label: '响应片段', value: redactText(body, 120) }] : []),
        { label: '下一步', value: '等站点恢复后重跑；连续出现时把这段响应发给站点方' },
      ],
      actions: actionsFor('server-error', log),
      step: step || null,
    };
  }
  if (status >= 400) {
    return {
      rule: 'client-error',
      cause: `站点拒绝了这次请求（${status}），请求本身不合规`,
      confidence: 'high',
      evidence: [
        { label: '状态码', value: String(status) },
        ...(body ? [{ label: '响应片段', value: redactText(body, 120) }] : []),
        { label: '下一步', value: '核对地址、请求头与方法是否与浏览器里的一致' },
      ],
      actions: actionsFor('client-error', log),
      step: step || null,
    };
  }

  // ---- 7) 引擎侧（表达式 / 脚本 / 配置） ----
  if (log && (log.errorType === 'engine' || /\b(expression|表达式|脚本|未知步骤|配置)\b/i.test(log.message || ''))) {
    return {
      rule: 'engine',
      cause: `这一步的配置让引擎无法执行：${redactText(log.message, 100)}`,
      confidence: 'medium',
      evidence: [
        { label: '步骤', value: `${log.name || ''}`.trim() || '—' },
        { label: '原始信息', value: redactText(log.message) },
        { label: '下一步', value: '打开这一步的配置改正字段后重跑' },
      ],
      actions: actionsFor('engine', log),
      step: step || null,
    };
  }

  // ---- 8) 兜底：不猜 ----
  const where = step ? `第 ${step.index} 步「${step.name}」` : '运行结束时';
  return {
    rule: 'unknown',
    cause: `暂时无法判断原因，请展开${where}的响应体`,
    confidence: noStep ? 'low' : 'medium',
    evidence: [
      ...(log?.message ? [{ label: '步骤输出', value: redactText(log.message) }] : []),
      ...(run.finalMessage ? [{ label: '运行结论', value: redactText(run.finalMessage) }] : []),
    ],
    actions: noStep ? [] : [{ type: 'show-response', label: ACTIONS['show-response'], stepId: log.stepId || null }],
    step: step || null,
  };
}

/** 复制给 issue 的纯文本摘要（不含凭据） */
export function diagnosisText(diagnosis, { flow } = {}) {
  if (!diagnosis) return '';
  const lines = [
    `任务：${flow?.name || '—'}`,
    `原因：${diagnosis.cause}`,
    `规则：${diagnosis.rule}（置信度 ${diagnosis.confidence}）`,
  ];
  if (diagnosis.step) lines.push(`步骤：第 ${diagnosis.step.index} 步「${diagnosis.step.name}」`);
  for (const e of diagnosis.evidence || []) lines.push(`${e.label}：${e.value}`);
  return lines.join('\n');
}

/** 护栏用：诊断文案里不得出现无法验证的措辞 */
export function hasBannedWording(diagnosis) {
  const text = [diagnosis?.cause || '', ...(diagnosis?.evidence || []).map((e) => e.value)].join(' ');
  return BANNED.some((w) => text.includes(w));
}
