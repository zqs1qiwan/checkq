/**
 * 演练场（P0-1「先演练一遍」）
 *
 * 三件事，全部本机实现、零外部依赖、零真实站点：
 *   1) 三个演示端点：/api/demo/profile（发 Cookie）、/api/demo/checkin（可切三态）、/api/demo/items（给循环用）
 *   2) 一条内置演练任务（三步：取 Cookie → 签到 → 记日志），重复创建复用同一条
 *   3) 演示数据只存内存、1 小时后失效；限速 60 次/分钟/IP
 *
 * 关闭：环境变量 CHECKQ_DEMO=0 → 所有 /api/demo/* 返回 404，「先演练一遍」入口隐藏。
 */

const DEMO_TTL_MS = 60 * 60 * 1000;      // 演示数据 1 小时后失效
const DEMO_RATE = { windowMs: 60 * 1000, max: 60 };

/** 演示环境是否开启（默认开启；生产可用 CHECKQ_DEMO=0 关掉） */
export function isDemoEnabled() {
  return String(process.env.CHECKQ_DEMO ?? '1') !== '0';
}

/** 内存态：按 IP 存演示会话 + 请求计数 */
const sessions = new Map();
const hits = new Map();

function now() { return Date.now(); }

function purge() {
  const t = now();
  for (const [k, v] of sessions) if (t - v.at > DEMO_TTL_MS) sessions.delete(k);
  for (const [k, v] of hits) if (t - v.start > DEMO_RATE.windowMs) hits.delete(k);
}

import { isTrustedProxyPeer } from './iprange.js';

function ipOf(req) {
  const peer = req.raw?.socket?.remoteAddress || req.ip || 'local';
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (isTrustedProxyPeer(peer) && xff) ? xff : peer;
}

/** 限速：60 次/分钟/IP（演示端点不是攻击面，但也不该被拿来打） */
function rateLimit(req) {
  const ip = ipOf(req);
  const t = now();
  const rec = hits.get(ip);
  if (!rec || t - rec.start > DEMO_RATE.windowMs) {
    hits.set(ip, { start: t, n: 1 });
    return true;
  }
  rec.n++;
  return rec.n <= DEMO_RATE.max;
}

function session(req) {
  const ip = ipOf(req);
  let s = sessions.get(ip);
  if (!s || now() - s.at > DEMO_TTL_MS) {
    s = { at: now(), sid: `demo-${Math.random().toString(36).slice(2, 10)}`, checkins: 0, lastCheckin: null };
    sessions.set(ip, s);
  }
  s.at = now();
  return s;
}

/** 演示数据不做真实校验，只按 mode 决定"回什么" */
function modeOf(req) {
  const m = String((req.query || {}).mode || req.headers['x-demo-mode'] || 'ok').toLowerCase();
  return ['ok', 'login', 'risk', 'slow'].includes(m) ? m : 'ok';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guard(req, reply) {
  if (!isDemoEnabled()) {
    reply.code(404).send({ error: '演练场已关闭（CHECKQ_DEMO=0）' });
    return { stopped: true };
  }
  purge();
  if (!rateLimit(req)) {
    reply.code(429).send({ code: 429, error: '演示请求太频繁，请稍后再试' });
    return { stopped: true };
  }
  return null;
}

/** GET /api/demo/profile：发一个演示会话 Cookie，返回用户信息 */
export async function demoProfile(req, reply) {
  const g = guard(req, reply);
  if (g) return reply;
  const mode = modeOf(req);
  if (mode === 'risk') {
    reply.code(403).header('content-type', 'text/html; charset=utf-8');
    return '<title>请稍候…</title><div id="challenge-platform">正在校验您的浏览器</div>';
  }
  if (mode === 'login') {
    reply.code(200).type('application/json');
    return { code: 401, msg: '请先登录' };
  }
  if (mode === 'slow') await sleep(3000);
  const s = session(req);
  reply.header('set-cookie', `demo_sid=${s.sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
  reply.type('application/json');
  return { code: 0, user: { name: 'demo', level: 3, since: '2026-01-01' }, serverAt: new Date().toISOString() };
}

/** POST /api/demo/checkin：三态可切（ok / login / risk） */
export async function demoCheckin(req, reply) {
  const g = guard(req, reply);
  if (g) return reply;
  const mode = modeOf(req);
  if (mode === 'slow') await sleep(3000);
  if (mode === 'login') {
    reply.type('application/json');
    return { code: 401, msg: '请先登录' };
  }
  if (mode === 'risk') {
    reply.code(403).header('content-type', 'text/html; charset=utf-8');
    return '<title>请稍候…</title><div id="challenge-platform">正在校验您的浏览器</div>';
  }
  const s = session(req);
  const cookie = String(req.headers.cookie || '');
  if (!/demo_sid=/.test(cookie)) {
    reply.type('application/json');
    return { code: 401, msg: '请先登录' };
  }
  s.checkins++;
  s.lastCheckin = new Date().toISOString();
  reply.type('application/json');
  return { code: 0, msg: '签到成功', total: s.checkins, at: s.lastCheckin };
}

/** GET /api/demo/items?count=5：给「遍历」节点用的演示列表 */
export async function demoItems(req, reply) {
  const g = guard(req, reply);
  if (g) return reply;
  const n = Math.min(50, Math.max(1, Number((req.query || {}).count) || 5));
  reply.type('application/json');
  return { code: 0, count: n, items: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `演示项 ${i + 1}` })) };
}

/** POST /api/demo/reset：清掉本机演示数据（重复演练时用） */
export async function demoReset(req, reply) {
  const g = guard(req, reply);
  if (g) return reply;
  sessions.clear();
  hits.clear();
  return { ok: true };
}

/** 内置演练任务的流程内容（自带演示端点，不出现任何真实站点） */
export function buildDemoFlow(origin) {
  const base = String(origin || 'http://localhost:8888').replace(/\/+$/, '');
  return {
    name: '演练任务 · 演示数据',
    note: '内置演练：三个演示端点，可以随时改成你自己的站点',
    group: '演练',
    cron: '',
    enabled: false,
    isDemo: true,
    vars: { baseUrl: base, demoUser: 'demo' },
    nodes: [
      {
        id: 'demo-1', type: 'http', name: '打开演练站点', x: 0, y: 0,
        config: {
          method: 'GET', url: `${base}/api/demo/profile`, headers: [], body: '', timeout: 10,
          cookieJar: true, asserts: [{ expr: 'last.status', expect: 200 }],
        },
      },
      {
        id: 'demo-2', type: 'http', name: '发起签到', x: 0, y: 160,
        config: {
          method: 'POST', url: `${base}/api/demo/checkin`, headers: [{ name: 'content-type', value: 'application/json', enabled: true }],
          body: '{"user":"{{demoUser}}"}', timeout: 10,
          asserts: [{ expr: 'last.json.code', expect: 0 }],
        },
      },
      {
        id: 'demo-3', type: 'log', name: '记一笔', x: 0, y: 320,
        config: { text: '签到完成：{{last.json.msg}}（累计 {{last.json.total}} 次）' },
      },
    ],
    edges: [
      { id: 'demo-e1', source: 'demo-1', sourceHandle: 'success', target: 'demo-2' },
      { id: 'demo-e2', source: 'demo-2', sourceHandle: 'success', target: 'demo-3' },
    ],
    log: { level: 'all', keywords: [] },
  };
}

/**
 * 确保存在一条演练任务：已存在就复用（并把它指向当前站点地址），没有才创建。
 * @returns {{ flow: object, created: boolean }}
 */
export function ensureDemoFlow(store, origin) {
  const existing = store.flows.find((f) => f.isDemo === true);
  const base = String(origin || '').replace(/\/+$/, '');
  if (existing) {
    if (base && existing.vars && existing.vars.baseUrl !== base) {
      const nodes = (existing.nodes || []).map((n) => {
        const c = n.config || {};
        const swap = (u) => (typeof u === 'string' ? u.replace(/^https?:\/\/[^/]+/i, base) : u);
        return { ...n, config: { ...c, url: swap(c.url) } };
      });
      store.updateFlow(existing.id, { vars: { ...(existing.vars || {}), baseUrl: base }, nodes });
    }
    return { flow: store.getFlow(existing.id), created: false };
  }
  const flow = store.createFlow(buildDemoFlow(base || 'http://localhost:8888'));
  return { flow, created: true };
}

/** 从请求里推导本站地址（只接受与请求同 host 的 origin，避免变成任意主机代理） */
export function originOf(req, input) {
  const host = String(req.headers.host || '');
  if (input) {
    try {
      const u = new URL(String(input));
      if (u.host === host) return u.origin;
    } catch { /* 非法 URL 忽略 */ }
  }
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${host || 'localhost:8888'}`;
}
