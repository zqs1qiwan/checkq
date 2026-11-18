/**
 * Run 级 Cookie 罐（QD 兼容层 GAP-C1）
 * 一次运行内所有 http 节点共享：响应 Set-Cookie 自动入罐，后续请求按域名/路径/协议自动携带。
 * 节点显式配置的 cookie 头同名键优先（用户手工值 > 罐内值）。
 * 节点配置 cookieJar:false 可完全退出罐（不读不写）。
 *
 * 语义按浏览器 Cookie 的基础规则处理：
 * - 没有 Domain 属性 = host-only，只回发给同一主机；
 * - Domain 必须是当前主机的后缀，拒绝 `Domain=com` 这类跨站范围；
 * - Path 前缀匹配；Secure 只回发给 https；
 * - Max-Age / Expires 到期即失效，空值或删除标记立即移除。
 */
export class CookieJar {
  constructor() {
    this.store = new Map(); // key -> { name, value, domain, path, hostOnly, secure, expires }
  }

  /** 从响应 Set-Cookie 数组入罐。返回新增/覆盖的条数。 */
  setFrom(urlStr, setCookies) {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return 0;
    }
    const host = u.hostname.toLowerCase();
    const now = Date.now();
    let n = 0;
    for (const sc of setCookies || []) {
      const [pair, ...attrs] = String(sc).split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;

      let domain = host;
      let hostOnly = true;
      let path = '/';
      let secure = false;
      let expires = null;
      for (const a of attrs) {
        const raw = a.trim();
        const m = raw.match(/^domain=(.+)$/i);
        if (m) {
          const d = m[1].replace(/^\./, '').toLowerCase();
          // 只接受当前主机本身或它的父域；拒绝 `com` / `co.uk` 这类公共后缀式范围
          if (d && (host === d || host.endsWith(`.${d}`)) && (d.includes('.') || d === 'localhost')) {
            domain = d;
            hostOnly = false;
          }
          continue;
        }
        const p = raw.match(/^path=(.+)$/i);
        if (p) { path = p[1].trim() || '/'; continue; }
        if (/^secure$/i.test(raw)) { secure = true; continue; }
        const ma = raw.match(/^max-age=(-?\d+)$/i);
        if (ma) {
          const sec = Number(ma[1]);
          expires = sec <= 0 ? now - 1 : now + sec * 1000;
          continue;
        }
        const ex = raw.match(/^expires=(.+)$/i);
        if (ex) {
          const ts = Date.parse(ex[1]);
          if (Number.isFinite(ts)) expires = ts;
        }
      }

      const key = `${hostOnly ? 'H' : 'D'}:${domain}|${path}|${name}`;
      if (value === '' || /^(deleted|null)$/i.test(value) || (expires !== null && expires <= now)) {
        this.store.delete(key);
        continue;
      }
      this.store.set(key, { name, value, domain, path, hostOnly, secure, expires });
      n++;
    }
    return n;
  }

  /** 生成该 URL 应携带的 Cookie 头值。 */
  headerFor(urlStr) {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return '';
    }
    const host = u.hostname.toLowerCase();
    const reqPath = u.pathname || '/';
    const isSecure = u.protocol === 'https:';
    const now = Date.now();
    const parts = [];
    const candidates = [];
    for (const c of this.store.values()) {
      if (c.expires !== null && c.expires <= now) continue;
      if (c.secure && !isSecure) continue;
      const domainOk = c.hostOnly ? host === c.domain : (host === c.domain || host.endsWith(`.${c.domain}`));
      if (!domainOk) continue;
      if (!pathMatches(reqPath, c.path)) continue;
      candidates.push(c);
    }
    // 更具体的 Path 先发，和浏览器一致；同 Path 保持入罐顺序
    candidates.sort((a, b) => b.path.length - a.path.length);
    for (const c of candidates) parts.push(`${c.name}=${c.value}`);
    return parts.join('; ');
  }

  get size() {
    return this.store.size;
  }
}

function pathMatches(reqPath, cookiePath) {
  if (cookiePath === '/' || cookiePath === '') return true;
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

/** 合并 cookie 头：explicit 行同名键优先，jar 行补充缺失键。 */
export function mergeCookieHeader(jarLine, explicitLine) {
  if (!jarLine) return explicitLine || '';
  if (!explicitLine) return jarLine;
  const explicitKeys = new Set(
    explicitLine.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean)
  );
  const extras = jarLine
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !explicitKeys.has(p.split('=')[0].trim()));
  return extras.length ? `${explicitLine}; ${extras.join('; ')}` : explicitLine;
}
