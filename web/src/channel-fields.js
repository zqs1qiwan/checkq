/**
 * 通知渠道字段表（任务通知与系统通知共用）
 * 类型清单仍在 util.js 的 CHANNEL_TYPE_OPTIONS；这里只维护「每种类型要填哪些字段」。
 */
export const CHANNEL_FIELDS = {
  inbox: [['title', '标题（可选）']],
  webhook: [['url', 'URL']],
  bark: [['url', '服务器 URL'], ['title', '标题'], ['group', '分组（可选）']],
  telegram: [['token', 'Bot Token'], ['chat', 'Chat ID']],
  serverchan: [['key', 'SendKey'], ['title', '标题']],
  pushplus: [['token', 'PushPlus Token'], ['title', '标题']],
  dingtalk: [['url', 'Webhook URL'], ['secret', '加签密钥（可选）'], ['title', '标题']],
  wecom: [['url', 'Webhook URL']],
  feishu: [['url', 'Webhook URL'], ['secret', '签名密钥（可选）']],
  gotify: [['url', '服务器地址（如 https://gotify.example.com）'], ['token', 'App Token'], ['priority', '优先级（1-10）']],
  ntfy: [['url', '服务器（默认 https://ntfy.sh）'], ['topic', 'Topic'], ['priority', '优先级（min/low/default/high/urgent）']],
  email: [['host', 'SMTP 服务器'], ['port', '端口（465/587）'], ['user', '用户名'], ['pass', '密码/授权码'], ['from', '发件人'], ['to', '收件人（多个用逗号）'], ['subject', '主题']],
};

export function fieldsOf(type) {
  return CHANNEL_FIELDS[type || 'webhook'] || CHANNEL_FIELDS.webhook;
}

export function blankChannel(type = 'webhook') {
  const c = { type };
  for (const [k] of fieldsOf(type)) c[k] = '';
  return c;
}

/** 渠道的一句话摘要（列表用，不展示敏感值） */
export function channelSummary(c) {
  if (c.type === 'inbox') return '内置，不可移除';
  if (c.type === 'email') return c.to || c.host || '';
  if (c.type === 'ntfy') return c.topic || c.url || '';
  if (c.type === 'telegram') return c.chat ? `Chat ${c.chat}` : '';
  if (c.type === 'serverchan' || c.type === 'pushplus' || c.type === 'gotify') return c.url || '';
  return c.url || '';
}
