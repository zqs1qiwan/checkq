/**
 * 通知渠道统一出口（v0.6.0）
 *
 * 之前 api.js 与 engine.js 各有一套渠道发送逻辑：engine 的 notify 节点只有
 * webhook/telegram/bark，且 fetch 没有超时；api 的渠道清单更全但串行发送。
 * 这里收敛成一处，所有渠道统一 15s 超时、统一 {type, ok, error} 返回结构。
 * 新增渠道类型只改这一个文件。
 */
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export const SUMMARY_CHANNEL_TYPES = new Set([
  'inbox', 'webhook', 'bark', 'telegram', 'serverchan', 'pushplus',
  'dingtalk', 'wecom', 'feishu', 'gotify', 'ntfy', 'email',
]);

const TIMEOUT_MS = 15000;

async function fetchNotification(url, options) {
  const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} 重定向，请配置最终投递地址`);
  }
  return response;
}

function providerError(status, code) {
  const hasCode = Number.isSafeInteger(code) && Math.abs(code) <= 9999999;
  return new Error(`HTTP ${status}${hasCode ? ` code=${code}` : ''}`);
}

/** 钉钉/飞书机器人签名：timestamp + "\n" + secret 做 HMAC-SHA256，base64 后拼到 URL */
export function signBotUrl(ch) {
  const url = String(ch.url || '');
  if (!ch.secret) return url;
  const ts = Date.now();
  const sign = encodeURIComponent(crypto.createHmac('sha256', ch.secret).update(`${ts}\n${ch.secret}`).digest('base64'));
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}timestamp=${ts}&sign=${sign}`;
}

/**
 * 单渠道发送。永不抛异常，返回 { type, ok, error }；
 * inbox 需要 deps.inbox(payload) 注入（由 api 层接 store.addNotification）。
 */
export async function sendChannel(ch, text, ctx = {}, deps = {}) {
  const type = ch?.type || 'unknown';
  const title = ctx.title || ch?.title;
  try {
    if (type === 'webhook') {
      let isJson = false;
      if (/^\s*[\[{]/.test(text)) {
        try { JSON.parse(text); isJson = true; } catch {}
      }
      const res = await fetchNotification(ch.url, {
        method: 'POST', headers: { 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8' },
        body: text,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (type === 'inbox') {
      if (typeof deps.inbox !== 'function') throw new Error('站内通知不可用');
      deps.inbox({
        title: title || `${ctx.flowName || 'CheckQ'} ${ctx.status === 'failed' ? '失败' : '通知'}`,
        content: text, level: ctx.level || (ctx.status === 'failed' ? 'fail' : 'success'),
        flowId: ctx.flowId || null, flowName: ctx.flowName || '',
      });
    } else if (type === 'pushplus') {
      const res = await fetchNotification('https://www.pushplus.plus/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: String(ch.token || '').trim(), title: title || 'CheckQ 通知', content: text, template: ch.template || 'txt' }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || (j.code !== undefined && j.code !== 200)) throw providerError(res.status, j.code);
    } else if (type === 'gotify') {
      const base = String(ch.url || '').replace(/\/+$/, '');
      const res = await fetchNotification(`${base}/message?token=${encodeURIComponent(ch.token || '')}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title || 'CheckQ', message: text, priority: Number(ch.priority) || 5 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (type === 'ntfy') {
      const base = String(ch.url || 'https://ntfy.sh').replace(/\/+$/, '');
      const topic = String(ch.topic || '').trim();
      if (!topic) throw new Error('缺少 topic');
      const res = await fetchNotification(`${base}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', Title: title || 'CheckQ', Priority: String(ch.priority || 'default') },
        body: text,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (type === 'email') {
      await smtpSend(ch, ch.subject || title || '[CheckQ] 通知', text);
    } else if (type === 'telegram') {
      const res = await fetchNotification(`https://api.telegram.org/bot${ch.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: ch.chat, text, disable_web_page_preview: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw providerError(res.status, j.error_code);
    } else if (type === 'bark') {
      const u = (ch.url || '').replace(/\/+$/, '');
      const title2 = encodeURIComponent(title || 'CheckQ');
      const body = encodeURIComponent(text);
      const res = await fetchNotification(`${u}/${title2}/${body}${ch.group ? '?group=' + encodeURIComponent(ch.group) : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (type === 'serverchan') {
      const key = String(ch.key || '').trim();
      const res = await fetchNotification(`https://sctapi.ftqq.com/${key}.send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title || 'CheckQ 通知', desp: text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || (j.code !== undefined && j.code !== 0)) throw providerError(res.status, j.code);
    } else if (type === 'dingtalk') {
      const url = signBotUrl(ch);
      const res = await fetchNotification(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: title || 'CheckQ 通知', text } }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.errcode !== 0) throw providerError(res.status, j.errcode);
    } else if (type === 'wecom') {
      const res = await fetchNotification(ch.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: text } }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.errcode !== 0) throw providerError(res.status, j.errcode);
    } else if (type === 'feishu') {
      const url = signBotUrl(ch);
      const res = await fetchNotification(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.code !== 0) throw providerError(res.status, j.code);
    } else {
      throw new Error('未知通知类型: ' + type);
    }
    return { type, ok: true };
  } catch (err) {
    const message = String(err?.message || err || '发送失败');
    console.error(`[CheckQ] notify ${type} failed:`, message);
    return { type, ok: false, error: message };
  }
}

/** 并行发送一组渠道；结果顺序与输入一致。 */
export async function sendToChannels(channels, text, ctx = {}, deps = {}) {
  const list = Array.isArray(channels) ? channels : [];
  return Promise.all(list.map((ch) => sendChannel(ch, text, ctx, deps)));
}

/**
 * 极简 SMTP 发信（零依赖）：支持 465 隐式 TLS / 587 STARTTLS / AUTH LOGIN。
 * ch: { host, port, secure, user, pass, from, to }
 */
export function smtpSend(ch, subject, text) {
  const stripCrlf = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const host = stripCrlf(ch.host);
  const port = Number(ch.port) || 465;
  const from = stripCrlf(ch.from || ch.user);
  const to = stripCrlf(ch.to);
  const cleanSubject = stripCrlf(subject);
  if (!host || !from || !to) return Promise.reject(new Error('缺少 host/from/to'));
  const implicitTLS = ch.secure === true || (ch.secure !== false && port === 465);

  return new Promise((resolve, reject) => {
    let socket = implicitTLS
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    let buf = '';
    let collect = [];
    const waiters = [];
    let settled = false;

    const fail = (err) => { if (settled) return; settled = true; try { socket.destroy(); } catch {} reject(err); };
    const done = (val) => { if (settled) return; settled = true; try { socket.end(); } catch {} resolve(val); };

    const attach = (s) => {
      s.setEncoding('utf8');
      s.setTimeout(20000, () => fail(new Error('SMTP 超时')));
      s.on('data', (d) => {
        buf += d;
        if (buf.length > 65536) return fail(new Error('SMTP 响应过长'));
        pump();
      });
      s.on('error', fail);
    };
    const pump = () => {
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^\d{3}-/.test(line)) { collect.push(line); continue; }
        const full = [...collect, line].join('\n');
        collect = [];
        const w = waiters.shift();
        if (w) w(null, full);
      }
    };
    const read = () => new Promise((res, rej) => {
      let fn;
      const timer = setTimeout(() => {
        const i = waiters.indexOf(fn);
        if (i !== -1) {
          waiters.splice(i, 1);
          if (!settled) rej(new Error('SMTP 响应超时'));
        }
      }, 20000);
      fn = (e, v) => { clearTimeout(timer); e ? rej(e) : res(v); };
      waiters.push(fn);
    });
    const cmd = async (line) => { socket.write(line + '\r\n'); return read(); };
    const expect = (resp, code, what) => {
      const actual = /^(\d{3})(?:[ -]|$)/.exec(resp?.split('\n').at(-1) || '')?.[1];
      if (actual !== String(code)) throw new Error(`${what}失败（${actual ? `SMTP ${actual}` : 'SMTP 响应无效'}）`);
      return resp;
    };

    attach(socket);
    (async () => {
      expect(await read(), 220, '连接');
      let ehlo = await cmd('EHLO checkq.local');
      if (!implicitTLS && /STARTTLS/i.test(ehlo)) {
        expect(await cmd('STARTTLS'), 220, 'STARTTLS');
        const plain = socket;
        plain.removeAllListeners('data');
        plain.removeAllListeners('error');
        plain.setTimeout(0);
        socket = tls.connect({ socket: plain, servername: host });
        attach(socket);
        ehlo = await cmd('EHLO checkq.local');
      }
      if (ch.user) {
        expect(await cmd('AUTH LOGIN'), 334, 'AUTH LOGIN');
        expect(await cmd(Buffer.from(String(ch.user)).toString('base64')), 334, 'AUTH 用户名');
        expect(await cmd(Buffer.from(String(ch.pass || '')).toString('base64')), 235, 'AUTH 密码');
      }
      expect(await cmd(`MAIL FROM:<${from}>`), 250, 'MAIL FROM');
      for (const rcpt of to.split(/[,;]\s*/).filter(Boolean)) expect(await cmd(`RCPT TO:<${rcpt}>`), 250, 'RCPT TO');
      expect(await cmd('DATA'), 354, 'DATA');
      const bodyB64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
      const msg = [
        `From: <${from}>`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${Buffer.from(cleanSubject, 'utf8').toString('base64')}?=`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        bodyB64,
        '.',
      ].join('\r\n');
      socket.write(msg + '\r\n');
      expect(await read(), 250, '发送正文');
      await cmd('QUIT').catch(() => '');
      done('sent');
    })().catch(fail);
  });
}
