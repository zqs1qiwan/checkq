#!/usr/bin/env node
/**
 * 生成 GitHub Pages 文档站（wiki）
 *  - 只收录**框架/功能性**文档；不含任何具体签到脚本与账号信息（那是模板市场的事）
 *  - 输入：docs/*.md（仓库文档，自动同步）+ 本文件内的上手页
 *  - 输出：wiki/（纯静态，零依赖）
 *  - 用法：node tools/build-wiki.cjs
 *
 * 产物：
 *   13 个页面 + 404.html + sitemap.xml + robots.txt + search-index.json
 *   assets/style.css  深/浅色 token、排版、卡片、代码块、表格、引用、打印、减少动效
 *   assets/site.js    主题切换、移动端抽屉、本页目录高亮、搜索（combobox）、代码复制
 *   assets/social-preview.png / assets/brand/*  品牌与分享图
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'wiki');
const DOCS = path.join(ROOT, 'docs');
const REPO_OWNER = 'zqs1qiwan';
const REPO_NAME = 'checkq';
const BRANCH = 'main';
const SITE = `https://${REPO_OWNER}.github.io/${REPO_NAME}/`;
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
const BUILT_AT = new Date();
const BUILT_ISO = BUILT_AT.toISOString();
const BUILT_DAY = BUILT_ISO.slice(0, 10);
const BUILT_LABEL = `${BUILT_ISO.slice(0, 16).replace('T', ' ')} UTC`;
const SITE_DESC = 'CheckQ 是开源的可视化 HTTP 自动化流程引擎：积木式流程、调度与失败重试、日志与通知、模板联动、REST API 与 MCP。';

// ---------- 极简 Markdown → HTML ----------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const SENT_RE = /\u0000(\d+)\u0000/g;

// docs/ 源文件 → wiki 页面（用于把文档里的 .md 链接改写成站内链接）
const LINK_MAP = {};

function hrefFor(href) {
  if (/^(https?:|mailto:)/.test(href)) {
    if (href.indexOf(SITE) === 0) return { href, external: false };
    return { href, external: true };
  }
  if (/^\/\//.test(href)) return { href: 'https:' + href, external: true };
  if (href.startsWith('#')) return { href, external: false };
  const md = href.match(/^([A-Za-z0-9._-]+\.md)(#.*)?$/);
  if (md) {
    const target = LINK_MAP[md[1]];
    if (target) return { href: './' + target + (md[2] || ''), external: false };
    return { href: `${REPO_URL}/blob/${BRANCH}/docs/${md[1]}${md[2] || ''}`, external: true };
  }
  return { href, external: false };
}

function emphasis(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(（])\*([^*\n]+)\*(?=[\s)）。，、；：]|$)/g, '$1<em>$2</em>');
}

function inline(raw) {
  const store = [];
  const keep = (html) => { store.push(html); return '\u0000' + (store.length - 1) + '\u0000'; };
  const release = (s) => s.replace(SENT_RE, (_, i) => (store[Number(i)] === undefined ? '' : store[Number(i)]));
  let text = escapeHtml(raw);
  text = text.replace(/`([^`]+)`/g, (_, code) => keep('<code>' + code + '</code>'));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => keep('<img src="' + src + '" alt="' + alt + '" loading="lazy" decoding="async" />'));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const r = hrefFor(href);
    const attrs = r.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return keep('<a href="' + r.href + '"' + attrs + '>' + emphasis(release(label)) + '</a>');
  });
  text = emphasis(text);
  return release(text);
}

const stripInline = (s) => s
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .trim();
// 与 GitHub 的标题锚点算法保持一致：小写、去掉标点符号、空格转连字符。
// 这样 docs/ 里手写的 #anchor 链接在站内也能命中。
const slugify = (s) => s
  .trim()
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s_-]/gu, '')
  .replace(/\s+/g, '-') || 'section';
function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) { id = base + '-' + n; n++; }
  used.add(id);
  return id;
}

const CALLOUTS = {
  NOTE: { cls: 'note', label: '注意' },
  TIP: { cls: 'tip', label: '提示' },
  WARNING: { cls: 'warn', label: '小心' },
  CAUTION: { cls: 'warn', label: '小心' },
  IMPORTANT: { cls: 'important', label: '重要' },
};

function codeBlockHtml(code, lang) {
  const label = lang || 'text';
  const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
  return '<div class="code-block"><div class="code-head"><span class="code-lang">' + escapeHtml(label) + '</span>'
    + '<button class="copy-btn" type="button" data-copy hidden>复制</button></div>'
    + '<pre class="code" tabindex="0"><code' + cls + '>' + escapeHtml(code) + '</code></pre></div>';
}

function headingHtml(level, text, id) {
  const lv = Math.min(Math.max(level, 1), 6);
  return '<h' + lv + ' id="' + id + '">' + inline(text)
    + '<a class="h-anchor" href="#' + id + '" aria-label="本节永久链接">#</a></h' + lv + '>';
}

function renderTable(t) {
  const rows = t.rows.filter((r) => r.trim());
  if (!rows.length) return '';
  const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const sep = rows.length > 1 && rows[1].indexOf('-') >= 0 && /^\|?[\s:|-]+\|?$/.test(rows[1].trim());
  const body = (sep ? rows.slice(2) : rows.slice(1)).map(cells);
  const headHtml = '<thead><tr>' + head.map((h) => '<th>' + inline(h) + '</th>').join('') + '</tr></thead>';
  const bodyHtml = body.length
    ? '<tbody>' + body.map((r) => '<tr>' + head.map((_, i) => '<td>' + inline(r[i] || '') + '</td>').join('') + '</tr>').join('') + '</tbody>'
    : '';
  return '<div class="table-wrap"><table>' + headHtml + bodyHtml + '</table></div>';
}

function renderList(l) {
  return '<' + l.type + '>' + l.items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</' + l.type + '>';
}

function renderQuote(q) {
  const paras = [];
  let cur = [];
  for (const line of q.lines) {
    if (!line.trim()) { if (cur.length) { paras.push(cur.join('\n')); cur = []; } }
    else cur.push(line);
  }
  if (cur.length) paras.push(cur.join('\n'));
  if (!paras.length) return '';
  const firstLines = paras[0].split('\n');
  const tag = firstLines[0].match(/^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*(.*)$/i);
  if (tag) {
    const meta = CALLOUTS[tag[1].toUpperCase()] || CALLOUTS.NOTE;
    const rest = [];
    const inlineTitle = tag[2].trim();
    const remainder = firstLines.slice(1).join('\n').trim();
    if (remainder) rest.push(remainder);
    for (const p of paras.slice(1)) rest.push(p);
    return '<aside class="callout callout-' + meta.cls + '" role="note">'
      + '<p class="callout-title">' + escapeHtml(inlineTitle || meta.label) + '</p>'
      + rest.map((p) => '<p>' + inline(p) + '</p>').join('') + '</aside>';
  }
  return '<blockquote>' + paras.map((p) => '<p>' + inline(p) + '</p>').join('') + '</blockquote>';
}

function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  const headings = [];
  const usedIds = new Set();
  let para = null;
  let table = null;
  let list = null;
  let quote = null;

  const closePara = () => { if (!para) return; out.push('<p>' + inline(para.join('\n')) + '</p>'); para = null; };
  const closeTable = () => { if (!table) return; out.push(renderTable(table)); table = null; };
  const closeList = () => { if (!list) return; out.push(renderList(list)); list = null; };
  const closeQuote = () => { if (!quote) return; out.push(renderQuote(quote)); quote = null; };
  const closeAll = () => { closePara(); closeTable(); closeList(); closeQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      closeAll();
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      out.push(codeBlockHtml(buf.join('\n'), lang));
      continue;
    }

    if (!line.trim()) { closeAll(); continue; }

    if (/^\|/.test(line)) {
      closePara(); closeList(); closeQuote();
      if (!table) table = { rows: [] };
      table.rows.push(line);
      continue;
    }
    closeTable();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeAll();
      const level = h[1].length;
      const text = h[2].trim();
      const id = uniqueId(slugify(stripInline(text)), usedIds);
      if (level === 2 || level === 3) headings.push({ level, id, text: stripInline(text) });
      out.push(headingHtml(level, text, id));
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeAll(); out.push('<hr />'); continue; }

    if (/^>\s?/.test(line)) {
      closePara(); closeTable(); closeList();
      if (!quote) quote = { lines: [] };
      quote.lines.push(line.replace(/^>\s?/, ''));
      continue;
    }
    closeQuote();

    const li = line.match(/^\s*[-*+]\s+(.*)$/);
    const oli = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (li || oli) {
      closePara(); closeTable();
      const want = li ? 'ul' : 'ol';
      if (list && list.type !== want) closeList();
      if (!list) list = { type: want, items: [] };
      list.items.push((li || oli)[1]);
      continue;
    }
    closeList();

    if (!para) para = [];
    para.push(line.trim());
  }
  closeAll();
  return { html: out.join('\n'), headings };
}

const plainText = (md) => md
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[#>*|`~]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ---------- 页面清单（只讲框架功能，不含具体脚本） ----------
const PAGES = [
  {
    file: 'index.md', title: '概览', group: '入门', blurb: 'CheckQ 能做什么', hero: true,
    desc: 'CheckQ 是开源的可视化 HTTP 自动化流程引擎：积木式流程、点选生成逻辑、独立 cron 调度与失败重试、干净日志与 12 种通知、模板联动、REST API 与 MCP。本站只讲框架能力，不含具体签到脚本。',
  },
  {
    file: 'quickstart.md', title: '快速开始', group: '入门', blurb: '3 步跑通第一个任务',
    desc: '三步跑通第一个 CheckQ 任务：建任务、跑一次、定调度与重试；另有通知配置、存为模板与外部 Agent 接入。',
  },
  {
    file: 'tasks.md', title: '任务与流程', group: '使用', blurb: '节点、变量、分组、调度、重试',
    desc: 'CheckQ 任务与流程：节点类型、流程变量与表达式、任务分组与折叠、独立 cron 调度与任务级退避重试、模板自动跟随、编辑器效率与点选生成逻辑。',
  },
  {
    file: 'logs.md', title: '日志与通知', group: '使用', blurb: '运行记录、连续日志、通知渠道',
    desc: 'CheckQ 日志与通知：干净日志与调试模式、连续日志流、失败重试的逐次尝试记录，以及站内通知、Webhook、Bark、Telegram、钉钉、飞书等 12 种通知渠道。',
  },
  {
    file: 'security.md', title: '账号与安全', group: '使用', blurb: '多用户、两步验证、凭据保护',
    desc: 'CheckQ 账号与安全：多用户与角色、TOTP 两步验证与恢复码、会话与 API Key 作用域、IP 允许名单与黑名单、AES-256-GCM 凭据加密与 Web 加固。',
  },
  {
    file: 'deploy.md', title: '部署与备份', group: '使用', blurb: 'Docker、数据目录、备份恢复',
    desc: 'CheckQ 部署与备份：单容器 Docker 部署、数据目录结构与落盘行为、脱敏备份与完整备份、恢复与迁移注意事项。',
  },
  {
    file: 'api.md', title: 'API 与 MCP', group: '参考', blurb: '给外部程序 / Agent 用的接口',
    desc: 'CheckQ 开放接口：REST 认证与常用端点速查、OpenAPI 3.1 机器可读描述，以及零依赖 MCP 服务的 20 个工具与接入配置。',
  },
  {
    file: 'reference-api.md', title: 'API 参考', group: '参考', blurb: '全部端点', src: 'API.md',
    desc: 'CheckQ REST API 完整参考：鉴权、通用字段、任务 / 运行 / 模板 / 系统端点与错误码，面向 Agent 与外部脚本。',
  },
  {
    file: 'reference-mcp.md', title: 'MCP 工具', group: '参考', blurb: '工具清单与接入', src: 'MCP.md',
    desc: 'CheckQ MCP 服务（stdio、零依赖）的 20 个工具清单、参数说明与客户端接入方式。',
  },
  {
    file: 'reference-agent.md', title: 'Agent 接入指南', group: '参考', blurb: '给外部 Agent 什么', src: 'AGENT-ACCESS.md',
    desc: '把 CheckQ 交给外部 Agent：如何生成受限 API Key、MCP 与 REST 两种接入方式对比、权限边界与安全建议。',
  },
  {
    file: 'reference-security.md', title: '安全说明', group: '参考', blurb: '威胁与防护全表', src: 'SECURITY.md',
    desc: 'CheckQ 安全模型与威胁清单：凭据加密、会话、API Key、网络暴露、备份与审计的防护措施与运维建议。',
  },
  {
    file: 'faq.md', title: '常见问题', group: '更多', blurb: '排障速查',
    desc: 'CheckQ 常见问题与处理：找不到入口节点、HTTP 400 与超时、变量未定义、通知太吵、忘记密码或两步验证码、API Key 权限不足。',
  },
  {
    file: 'changelog.md', title: '更新日志', group: '更多', blurb: '新功能与修复', auto: 'changelog',
    desc: 'CheckQ 面向使用者的变更记录：新功能、改进与修复，按版本倒序。',
  },
];

const SOURCES = {
  'index.md': `# CheckQ 概览

## 核心能力

| 能力 | 说明 |
|---|---|
| 积木式流程 | HTTP / 条件 / 赋值 / 提取 / 延迟 / 日志 / 通知 / 脚本 / 遍历 节点，拖拽连线即成流程 |
| 点选生成逻辑 | 运行后点响应里的任意值 → 一键生成提取 / 断言 / 关键字 / 通知 节点 |
| 导入 | 浏览器 HAR、cURL 命令、JSON 模板导入，自动生成流程图 |
| 调度 | 每个任务独立 cron + 时区 + 抖动；支持手动运行与「调试运行」；**失败按退避策略自动重试，跑满次数才判定最终失败** |
| 日志 | 默认只输出人话日志，可开调试模式看每步请求与响应；运行记录含逐次尝试与等待时长 |
| 通知 | 12 种渠道：站内通知、Webhook、Bark、Telegram、Server酱、PushPlus、钉钉、企业微信、飞书、Gotify、ntfy、邮件 SMTP |
| 模板 | 调试好的流程存为模板，一份模板派生多份任务；**模板一改，派生任务的流程图与日志配置立刻跟随，零同步操作**；通知渠道在创建时复制，之后各自维护 |
| 账号安全 | 多用户 + 角色、TOTP 两步验证、会话吊销、凭据静态加密、API Key 作用域与 IP 名单 |
| 开放接口 | REST（OpenAPI 3.1）+ MCP（20 个工具），外部 Agent 可直接操作 |
| 任务分组 | 任务可归属分组，列表按组折叠；组头显示任务数、启用数、今日成功/失败/成功率、下次调度 |

## 本站讲什么

- **框架能力**：流程引擎、节点与变量、调度与重试、日志与通知、模板联动、账号安全、开放接口。
- **操作步骤**：从建任务到部署备份、排障速查。
- **参考手册**：REST API、MCP 工具、安全说明、Agent 接入。

## 本站不讲什么

> [!NOTE] 这里只有框架本身
> 本站**不含任何具体签到脚本、站点规则、模板内容或账号信息**——那些由你在自己的实例里创建、维护与分享。文档里的示例都是通用占位（如 \`http://checkq.local:8888\`、\`cq_xxxx\`），不含真实凭据与私有部署地址。

## 接下来去哪

| 我想… | 去哪 |
|---|---|
| 跑通第一个任务 | [快速开始](quickstart.html) |
| 了解节点、变量、分组 | [任务与流程](tasks.html) |
| 配置日志与通知 | [日志与通知](logs.html) |
| 给外部程序开接口 | [API 与 MCP](api.html) |
| 部署 / 备份 / 迁移 | [部署与备份](deploy.html) |
| 排查问题 | [常见问题](faq.html) |
`,
  'quickstart.md': `# 快速开始

## 1. 建任务

顶栏「+ 新建任务」→ 画布自带「HTTP 请求 → 日志」两个节点 → 点 HTTP 节点填 URL、请求头（需要登录态时带上 cookie）。

## 2. 跑一次

顶栏「运行」。成功时日志只有一行人话；失败时点日志步骤可看响应体。

## 3. 定调度与重试

编辑器顶栏「调度」→ 填 cron（如 \`30 8 * * *\` = 每天 08:30）→ 启用。同一个弹窗里可配置**失败重试**：默认最多 3 次、指数退避 5 秒起、随机抖动；跑满次数仍失败才判定任务失败，逐次尝试与等待时长会写进日志与通知。调试运行不重试。

> [!TIP] 先调试，再定稿
> 「调试运行」记录每步请求 / 响应并展开过程窗口；日常「运行」只输出配置好的日志。任务行「日志」还能把多次运行拍平成一条时间线。

## 4. 收通知

编辑器「更多 → 通知渠道」→ 选类型（站内通知零依赖）→ 填地址 →「测试发送」。

## 5. 变成模板（可选）

编辑器「更多 → 存为模板」→ 之后从模板创建任务时，各自填自己的变量（如 token）。模板一改，已派生任务的流程图与日志配置立刻跟随；通知渠道在创建时复制，之后可在任务里单独调整。

## 6. 自动化（可选）

- **调试运行**：编辑器顶栏「调试运行」记录每步请求/响应并展开过程窗口；日常「运行」只输出配置好的日志。
- **连续日志流**：任务行「日志」→ 多次运行滚动在一起，可上翻历史、导出。
- **外部 Agent**：设置 → API 密钥 → 生成（只读 + 可运行）→ 配合 [API 与 MCP](api.html)。
- **窄屏**：顶栏「+ / ⋯ / 设置」三个图标按钮；主题、站内通知、文档中心、登录身份都在「⋯」里。
`,
  'tasks.md': `# 任务与流程

## 节点类型

| 类型 | 用途 |
|---|---|
| HTTP 请求 | 方法 / URL / 头 / 体 / 断言 / 超时 / 后端(fetch·curl) / 编码 / 代理 / 重试 |
| 条件判断 | jexl 表达式分流（真→true 出口，假→false 出口） |
| 赋值 | 变量或表达式求值 |
| 提取 | 正则 / JSON 路径 / 响应头 / Set-Cookie |
| 延迟 / 随机延迟 | 固定或区间等待（避开整点风控） |
| 日志 | 输出人话日志（默认唯一可见的日志） |
| 通知 | 流程内自定义推送 |
| 脚本 | JS 沙箱（vars/last/steps 只读，1s 超时） |
| 遍历 | 数组逐项循环（上限 50 轮） |

## 变量与表达式

- 流程变量在编辑器「流程变量」面板维护；敏感值（cookie / token / 密码）**落盘加密**，API 返回明文以便编辑。
- 模板语法：\`{{var}}\`、\`{{x|urlencode}}\`、\`{{x|num}}\`、\`{{x|sha256}}\`、\`{{now:%Y-%m-%d}}\`
- 表达式：\`=last.json.code == 0\`（\`vars.xxx\` 取变量，\`last\` 是上一个响应）

## 任务分组 / 折叠

- 每个任务可设置 \`分组\`（≤40 字符；留空=未分组）；批量勾选后「分组…」可一次归入。
- 列表按组折叠：组头显示任务数、启用数、今日成功 / 失败 / 成功率、下次调度；点击组头或「展开/折叠」切换。
- ≥8 个任务的分组默认收起；折叠状态保存在浏览器本地；搜索/筛选时自动展开，避免搜到的任务藏在收起组里。
- 只影响列表展示，不改变调度与执行；今日统计按服务器本地日期实时计算。

## 调度与失败重试

- 每个任务独立 cron + 时区 + 抖动（0-N 分钟）；空 cron = 只手动运行。
- 调度弹窗里可随时启用 / 停用；首页健康条显示「下一次调度」及是哪个任务。
- **任务级失败重试**（默认开启）：最多 3 次尝试、指数退避 5 秒起、随机抖动、单次等待上限 5 分钟；只有最后一次仍失败才判定任务失败。可选线性 / 固定间隔，也可关闭。
- 调试运行不重试；上一次运行或退避尚未结束时，调度会跳过这一拍，避免堆积。
- 节点级重试（http 节点配置）是同一次执行内立刻重发，与任务级重试互补。

## 模板

- 存为模板会带走节点 / 连线 / 变量 / 日志 / 通知。
- 派生任务 = 模板 + 各自参数：**模板的流程图与日志配置一改，所有派生任务立刻跟随，无需任何同步操作**；没有「更新到模板版本」按钮或「待更新」标记。通知渠道在创建时复制，之后各任务独立维护；默认变量只补缺、不覆盖任务已有值。
- 派生任务改了脚本内容（忽略节点坐标）会自动转成独立任务；变量值、通知渠道保留，日志配置随模板。
- 模板删除后，已建任务回退到自己保存的最后一份流程图，不受影响。
- 从模板创建任务时逐个覆盖变量；敏感默认值在模板导出时自动脱敏。
- 模板市场：「模板」页可从 JSON 索引地址批量导入。

> [!IMPORTANT] 模板就是唯一真相
> 模板一改，派生任务的流程图与日志配置立刻跟随；不存在也不需要「同步模板」这类手动操作。

## 编辑器效率

- **撤销 / 重做**：Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y），保留 50 步；「更多」菜单也有按钮。
- **复制 / 粘贴节点**：Ctrl+C / Ctrl+V；复制选中节点与两端都在选区内的连线，粘贴自动偏移 24px。
- **整理布局**：按连线层级从左到右自动排列（「整理」按钮或「更多 → 整理布局」），完成后自动 fitView。
- **MiniMap**：右下角缩略图，可拖拽定位。
- **画布 ↔ 日志联动**：点击日志步骤 → 画布选中并居中；点击画布节点 → 日志抽屉滚到对应步骤并短暂高亮。
- **导出 HAR**：运行抽屉「导出 HAR」，只含本次运行的 HTTP 步骤，敏感值替换为 \`***\`，响应体沿用日志截断长度。

## 点选生成逻辑

在编辑器里运行一次 → 日志里展开响应 → 点任意 JSON 值或划选文字 → 选择用途（存为变量 / 断言成功 / 记录到日志 / 加进通知）→ 自动生成标准节点并接到链尾。
`,
  'logs.md': `# 日志与通知

## 干净日志（默认）

- 记录范围默认「仅 log 节点」：只有你写的日志节点出现；失败步骤始终保留。
- 流程里没有日志节点时自动退回全步骤，避免"成功但没日志"。
- 记录档位 all / failure / summary 控制细节多少；关键字规则把值提取进运行摘要。

## 调试模式

- **任务级**：日志配置里勾「调试模式」→ 每次运行都记录请求 / 响应。
- **单次级**：编辑器日志坞勾「调试」→ 仅当次记录，日常运行不受影响。

## 连续日志流

任务行「日志」→ 多次运行拍平成一条时间线：可「加载更早的记录」，每组可展开调试或导出 .log。
失败重试的运行会在日志里插入「第 N/M 次尝试」分隔行；运行抽屉列出每次尝试的成败与下次等待时长，结论与通知也带尝试次数。

## 通知渠道（12 种）

站内通知 / Webhook / Bark / Telegram / Server酱 / PushPlus / 钉钉（加签）/ 企业微信 / 飞书（加签）/ Gotify / ntfy / 邮件 SMTP。

- 成功 / 失败可分别开启；模板支持 {{flow.name}} {{status}} {{message}} {{duration}} {{time}}。
- **每日汇总推送**（可选，默认关）：设置 → 通知与推送 → 勾选「推送单位」（任务），可定时推送或立即推送今日汇总。
- **界面提示级别**：默认只报错误；可在设置里改为「成功 + 错误」或「全部」。
`,
  'security.md': `# 账号与安全

## 账号与角色

- 多用户：用户名 + 密码；角色 admin（全部）/ operator（不能管账号）/ viewer（只读，写操作 403）。
- 密码 scrypt 加盐哈希存储，明文永不落盘；改用户名需当前密码，改完强制重新登录。

## 两步验证

TOTP（Google Authenticator / Authy / Aegis）：启用后给 10 个一次性恢复码（只显示一次，服务端只存摘要）。
忘记验证器：恢复码登录，或管理员在「用户管理」重置该用户的 2FA。

## 会话与 API Key

- 会话：httpOnly + SameSite=Strict，7 天绝对有效期 + 24 小时空闲失效，可查看 / 吊销 / 退出所有设备。
- API Key：可命名、按作用域发放（只读 / 可运行 / 可修改）、可设回收日期（到期自动回收）、可随时吊销；列表显示调用次数与来源 IP。

## 访问控制

- 每把 Key 可设 **IP 允许名单**（CIDR）。
- 全局 **IP 黑名单**：被拉黑的 IP 登录与 API Key 一并拦截。

## 凭据存储

cookie / token / SMTP 密码等以 AES-256-GCM 加密落盘；密钥在 \`data/.secret\`（600）或环境变量 \`CHECKQ_SECRET\`。
备份默认脱敏；完整备份需再次输入当前密码。

> [!WARNING] 备份别漏掉密钥
> 迁移或重建环境时，\`data/.secret\` 必须与数据一起备份；丢了它，已加密的 cookie / token 无法解密。

## Web 加固

CSP / X-Frame-Options / nosniff / Referrer-Policy；写操作校验 Origin 同源（CSRF）；登录按 IP 与账号双层限流；审计日志记录关键动作。
`,
  'api.md': `# API 与 MCP

## 基础 API

- \`GET /api\` —— 接口索引（免登录）
- \`GET /api/openapi.json\` —— OpenAPI 3.1 机器可读描述（可自动生成客户端）

## 认证

\`x-api-key: <key>\`（推荐，可按作用域发放）或登录会话 Cookie。

## 常用端点

| 需求 | 方法 | 路径 |
|---|---|---|
| 列任务 | GET | /api/flows |
| 任务详情 | GET | /api/flows/:id |
| 跑一次 | POST | /api/flows/:id/run |
| 实时日志（SSE） | POST | /api/flows/:id/run（\`{"stream": true}\`） |
| 连续日志流 | GET | /api/flows/:id/logs?limit=200 |
| 改变量 / 调度 / 重试 | PUT | /api/flows/:id |
| 历史运行（含逐次尝试） | GET | /api/runs?flowId=&limit=30 |
| 模板 | GET | /api/templates |
| 运维统计 | GET | /api/system/stats |

任务对象含 \`retry = { enabled, maxAttempts, backoff, baseDelayMs, maxDelayMs, jitter }\`（默认开启 / 3 次 / 指数 / 5s / 5min / 抖动）；运行对象含 \`attempts[]\`、\`attempt\`、\`maxAttempts\`。完整字段见 [API 参考](reference-api.html)。

> [!TIP] 想少写胶水代码？
> 直接读 \`GET /api/openapi.json\`（OpenAPI 3.1）生成客户端；或让支持 MCP 的 Agent 通过 \`mcp/checkq-mcp.cjs\` 调用现成工具。

## MCP

\`mcp/checkq-mcp.cjs\`（stdio，零依赖）暴露 20 个工具：health、whoami、stats、notifications_list、flows_list、flow_get、flow_run、flow_logs、flow_update_vars、flow_update、flow_toggle、flow_create、flow_delete、flow_notify_test、templates_list、template_get、template_instantiate、import_curl、runs_list、run_get。

配置：

\`\`\`json
{ "mcpServers": { "checkq": { "command": "node",
  "args": ["/path/CheckQ/mcp/checkq-mcp.cjs"],
  "env": { "CHECKQ_URL": "http://checkq.local:18888", "CHECKQ_API_KEY": "cq_xxx" } } } }
\`\`\`

## 给外部 Agent 的东西

只有**基址 + 一把 Key**；建议只勾「只读 + 可运行」，把「可修改」留给人工。详见 [Agent 接入指南](reference-agent.html)。
`,
  'deploy.md': `# 部署与备份

## 部署

单容器（Docker），数据落在 \`data/\`（flows / runs / templates / meta / notifications），JSON 存储 + 原子写 + 立即落盘。

官方镜像来自 Docker Hub：

\`\`\`bash
docker pull zqs1qiwan/checkq:0.6.5
docker run -d --name checkq --restart unless-stopped -p 8888:8888 \\
  -v /path/to/data:/data -e TZ=Asia/Shanghai \\
  -e PORT=8888 -e DATA_DIR=/data \\
  zqs1qiwan/checkq:0.6.5
\`\`\`

\`latest\` 跟随最新稳定版；升级前先备份 \`data/\`（含 \`.secret\`），再 \`docker pull\` 并重建容器。也可以从源码构建：\`docker compose up -d --build\`。

端口可按需映射（例如 \`-p 18888:8888\`）；数据目录务必挂载到宿主机持久化。

## 数据目录

| 文件 | 内容 |
|---|---|
| flows.json | 任务定义（含加密后的敏感变量） |
| runs.json | 运行记录 |
| templates.json | 模板 |
| meta.json | 账号、API Key 摘要、审计、界面偏好 |
| notifications.json | 站内通知 |
| .secret | 凭据加密密钥（600，务必与数据一起备份） |

## 备份与恢复

- 任务页「备份」→ 下载**脱敏**备份（敏感值清空，适合分享与存档）。
- 任务页「完整备份」→ 需再输一次当前密码，含明文凭据，用于自己迁移。
- 恢复：粘贴备份 JSON → 生成带「（恢复）」后缀的停用任务 → 手动启用。

> [!NOTE] 迁移到新机器
> 请把 \`data/.secret\` 一并带走，否则已加密的凭据无法解密。
`,
  'faq.md': `# 常见问题

| 现象 | 处理 |
|---|---|
| 找不到入口节点 | 流程成环，所有节点都有入线 |
| HTTP 400 | 不一定是错误，断言通过即可继续；点日志步骤看响应体 |
| 超时 | HTTP 节点超时填秒（30），不是毫秒 |
| 变量未定义 | 日志配置开启变量快照，或看运行记录里的「未定义变量」 |
| 提示太吵 | 设置 → 通知与推送 → 界面提示 → 仅错误 |
| 日志太啰嗦 | 编辑器「更多 → 日志配置」→ 记录范围「仅 log 节点」 |
| 忘记密码 | 管理员重置；或按安全说明里的容器命令重置 |
| 忘记两步验证码 | 用恢复码；管理员可在「用户管理」重置 2FA |
| 弹窗贴到屏幕左上角 / 打开后背景跟着滚 | 已修复：弹窗用原生 \`<dialog>\` 显式居中，遮罩与弹窗用 \`overscroll-behavior: contain\` 收敛滚动；不再给页面加锁 |
| 弹窗里的下拉菜单点不到 | 已修复：菜单挂到该弹窗内部，避免被模态的 inert 拦住 |
| 窄屏顶栏按钮被挤到换行 | 已修复：小屏只留四个等高控件，其余动作收进「更多」 |
| 任务失败一次就停了 | 默认会按退避策略自动重试（最多 3 次）；在编辑器「调度 → 失败后重试」可关闭或调次数 |
| 怎么知道到底试了几次 | 任务详情显示策略；运行抽屉列出每次尝试与等待；通知结论带「第 N/M 次尝试」 |
| API Key 报权限不足 | 缺哪种能力就补勾哪种作用域（只读 / 可运行 / 可修改） |
`,
};

// ---------- 静态资源 ----------
const CSS = `
:root {
  color-scheme: dark;
  --bg:#0b0e11; --panel:#11151a; --panel2:#171c22; --border:#232a32; --text:#e3e7eb; --muted:#8a949e;
  --accent:#3fa7ad; --accent-soft:rgba(63,167,173,.15); --ok:#3fae7d; --warn:#c99a3f; --danger:#c96a5a;
  --code-bg:#0e1216; --shadow:0 10px 30px rgba(0,0,0,.38);
  --topbar-h:56px; --sidenav-w:278px; --toc-w:236px;
}
html[data-mode='light'] {
  color-scheme: light;
  --bg:#f3f5f6; --panel:#fff; --panel2:#eef1f3; --border:#d9dfe3; --text:#15191d; --muted:#5f6a73;
  --accent:#14707a; --accent-soft:rgba(20,112,122,.10); --ok:#1b7a52; --warn:#8a6116; --danger:#a03b2c;
  --code-bg:#f8fafb; --shadow:0 10px 30px rgba(15,25,32,.12);
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: calc(var(--topbar-h) + 14px); -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.7 "Segoe UI Variable Text", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased; overflow-wrap: break-word;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; }
code, kbd, pre { font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 5px; }
#main:focus, #main:focus-visible { outline: none; }
::selection { background: var(--accent-soft); }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.skip-link {
  position: fixed; left: 12px; top: -60px; z-index: 100;
  padding: 8px 14px; border-radius: 8px; background: var(--accent); color: #04191b;
  font-weight: 600; transition: top .16s ease;
}
html[data-mode='light'] .skip-link { color: #f5ffff; }
.skip-link:focus { top: 10px; text-decoration: none; }

/* ---------- 顶栏 ---------- */
.topbar {
  position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; gap: 10px;
  height: var(--topbar-h); padding: 0 14px;
  background: var(--panel); border-bottom: 1px solid var(--border);
}
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; flex: none; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel2); color: var(--text); cursor: pointer;
}
.icon-btn:hover { border-color: var(--accent); color: var(--accent); }
.icon-btn .ico { display: block; }
.nav-toggle { display: none; }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--text); font-weight: 700; font-size: 16px; letter-spacing: -.02em; }
.brand:hover { text-decoration: none; }
.brand-mark { flex: none; border-radius: 6px; }
.brand-word em { color: var(--accent); font-style: normal; }
.brand-ver {
  font-size: 11.5px; font-weight: 600; color: var(--muted);
  border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px;
}
.topbar-title { color: var(--muted); font-size: 13px; padding-left: 10px; border-left: 1px solid var(--border); }
.topbar-links { margin-left: auto; display: flex; gap: 4px; }
.tb-link { padding: 5px 9px; border-radius: 7px; font-size: 13px; color: var(--text); }
.tb-link:hover { background: var(--panel2); text-decoration: none; color: var(--accent); }
.theme-toggle { margin-left: 2px; }
html[data-mode='dark'] .ico-sun, html[data-mode='light'] .ico-moon { display: none; }

/* ---------- 骨架 ---------- */
.shell {
  display: grid; grid-template-columns: var(--sidenav-w) minmax(0, 1fr) var(--toc-w);
  align-items: start; max-width: 1560px; margin: 0 auto;
}
.sidenav {
  position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h));
  overflow-y: auto; overscroll-behavior: contain;
  border-right: 1px solid var(--border); background: var(--panel); padding: 16px 12px 28px;
}
.sidenav-inner { display: flex; flex-direction: column; gap: 10px; }
.sidenav-nav { display: flex; flex-direction: column; gap: 1px; }
.nav-group {
  margin: 14px 0 5px; padding: 0 10px;
  font-size: 11.5px; letter-spacing: .08em; color: var(--muted);
}
.sidenav-nav a {
  display: block; padding: 7px 10px; border-radius: 8px;
  color: var(--text); font-size: 14px; line-height: 1.4;
}
.sidenav-nav a em { display: block; font-style: normal; color: var(--muted); font-size: 12px; margin-top: 1px; }
.sidenav-nav a:hover { background: var(--panel2); text-decoration: none; }
.sidenav-nav a.is-active {
  background: var(--accent-soft); color: var(--accent); font-weight: 600;
  box-shadow: inset 2px 0 0 var(--accent);
}
.sidenav-foot {
  display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; padding: 12px 10px 0;
  border-top: 1px solid var(--border); font-size: 12.5px;
}
.scrim { display: block; }
.scrim[hidden] { display: none; }
.toc-col {
  position: sticky; top: calc(var(--topbar-h) + 10px);
  max-height: calc(100vh - var(--topbar-h) - 20px); overflow-y: auto;
  padding: 30px 16px 24px 4px; font-size: 12.5px;
}

/* ---------- 搜索 ---------- */
.search { position: relative; }
.search-input {
  width: 100%; height: 34px; padding: 0 30px 0 10px;
  border-radius: 8px; border: 1px solid var(--border);
  background: var(--panel2); color: var(--text); font-size: 13px;
}
.search-input::placeholder { color: var(--muted); }
.search-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search-hint {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  font-size: 11px; color: var(--muted); border: 1px solid var(--border);
  border-radius: 5px; padding: 0 5px; pointer-events: none; background: var(--panel);
}
.search-results {
  position: absolute; z-index: 30; left: 0; right: 0; top: calc(100% + 6px);
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: var(--shadow); overflow-y: auto; max-height: 340px;
}
.search-results[hidden] { display: none; }
.search-results a {
  display: block; padding: 8px 10px; color: var(--text); font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}
.search-results a:last-child { border-bottom: none; }
.search-results a:hover, .search-results a[aria-selected='true'] { background: var(--panel2); text-decoration: none; }
.search-results a[aria-selected='true'] { box-shadow: inset 2px 0 0 var(--accent); }
.search-results em { display: block; font-style: normal; color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.search-empty { margin: 0; padding: 10px; color: var(--muted); font-size: 12.5px; }

/* ---------- 正文 ---------- */
.main { min-width: 0; padding: 24px clamp(16px, 2.4vw, 40px) 64px; }
.doc, .pager, .site-foot, .crumbs, .toc-mobile { max-width: 920px; }
.crumbs { display: flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--muted); margin-bottom: 14px; }
.crumbs a { color: var(--muted); }
.crumbs a:hover { color: var(--accent); }
.crumbs .sep { opacity: .6; }
.doc h1 { font-size: 27px; line-height: 1.3; margin: 0 0 8px; letter-spacing: -.01em; }
.doc h2 {
  font-size: 20px; margin: 30px 0 10px; padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.doc h3 { font-size: 16px; margin: 22px 0 8px; }
.doc h4 { font-size: 14.5px; margin: 18px 0 6px; }
.doc p { margin: 0 0 12px; }
.doc ul, .doc ol { margin: 0 0 14px; padding-left: 22px; }
.doc li { margin: 4px 0; }
.doc li::marker { color: var(--muted); }
.doc hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
.h-anchor { margin-left: 8px; font-size: .68em; color: var(--muted); opacity: 0; text-decoration: none; font-weight: 400; }
h1:hover .h-anchor, h2:hover .h-anchor, h3:hover .h-anchor, .h-anchor:focus-visible { opacity: .9; }
.doc code {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px;
  padding: 1px 5px; font-size: .92em;
}
.doc a > code { border-bottom-color: transparent; }

/* 代码块 */
.code-block { margin: 0 0 16px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--code-bg); }
.code-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 5px 10px; background: var(--panel2); border-bottom: 1px solid var(--border);
  font-size: 11.5px; color: var(--muted);
}
.code-lang { letter-spacing: .04em; }
.copy-btn {
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 6px; font-size: 11.5px; padding: 2px 8px; cursor: pointer;
  transition: color .12s ease, border-color .12s ease;
}
.copy-btn:hover { border-color: var(--accent); color: var(--accent); }
.copy-btn.is-done { border-color: var(--ok); color: var(--ok); }
.copy-btn[hidden] { display: none; }
pre.code { margin: 0; padding: 12px 14px; overflow-x: auto; font-size: 13px; line-height: 1.6; background: var(--code-bg); border: none; }
pre.code code { background: none; border: none; padding: 0; font-size: 13px; }

/* 表格 */
.table-wrap { overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { border-bottom: 1px solid var(--border); padding: 8px 12px; text-align: left; vertical-align: top; }
th { background: var(--panel2); font-weight: 600; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--accent-soft); }

/* 引用与提示块 */
.doc blockquote {
  margin: 0 0 14px; padding: 10px 14px; border-left: 3px solid var(--accent);
  background: var(--panel2); border-radius: 0 8px 8px 0; color: var(--muted);
}
.doc blockquote p:last-child { margin-bottom: 0; }
.callout {
  margin: 0 0 16px; padding: 10px 14px 12px; border-left: 3px solid var(--accent);
  background: var(--panel2); border-radius: 0 10px 10px 0;
}
.callout p { margin: 0 0 8px; }
.callout p:last-child { margin-bottom: 0; }
.callout-title { font-weight: 700; font-size: 13px; color: var(--accent); margin: 0 0 4px; }
.callout-tip { border-left-color: var(--ok); }
.callout-tip .callout-title { color: var(--ok); }
.callout-warn { border-left-color: var(--warn); }
.callout-warn .callout-title { color: var(--warn); }
.callout-important { border-left-color: var(--danger); }
.callout-important .callout-title { color: var(--danger); }

/* 页首元信息 */
.doc-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  margin: 0 0 20px; padding-bottom: 12px; border-bottom: 1px solid var(--border);
  font-size: 12.5px; color: var(--muted);
}
.doc-meta .edit-link { margin-left: auto; font-weight: 600; }

/* 本页目录 */
.toc-nav { display: flex; flex-direction: column; }
.toc-title { margin: 0 0 8px; font-size: 11.5px; letter-spacing: .06em; color: var(--muted); }
.toc-nav a {
  display: block; padding: 4px 8px; border-left: 2px solid var(--border);
  color: var(--muted); line-height: 1.45;
}
.toc-nav a.toc-l3 { padding-left: 20px; font-size: 12px; }
.toc-nav a:hover { color: var(--text); text-decoration: none; }
.toc-nav a.is-active {
  color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft);
}
.toc-mobile { display: none; margin: 0 0 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 10px 14px; }
.toc-mobile summary { cursor: pointer; font-weight: 600; font-size: 13px; }
.toc-mobile .toc-nav { padding-top: 10px; }
.toc-mobile .toc-title { display: none; }

/* 首页 hero */
.hero {
  margin: 0 0 26px; padding: clamp(18px, 3vw, 30px);
  border: 1px solid var(--border); border-radius: 14px;
  background: linear-gradient(180deg, var(--panel2), var(--panel));
}
.hero-kicker {
  display: inline-block; margin: 0 0 10px; padding: 2px 10px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600;
}
.hero h1 { font-size: clamp(26px, 3.6vw, 34px); margin: 0 0 10px; letter-spacing: -.02em; }
.hero-lede { font-size: 15.5px; margin: 0 0 10px; }
.hero-note { font-size: 13.5px; color: var(--muted); margin: 0 0 18px; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--panel); color: var(--text); font-size: 13.5px; font-weight: 600;
}
.btn:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #04191b; }
.btn-primary:hover { color: #04191b; filter: brightness(1.07); }
html[data-mode='light'] .btn-primary { color: #f5ffff; }
html[data-mode='light'] .btn-primary:hover { color: #f5ffff; }
.hero-facts {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 12px;
  margin: 0; padding-top: 16px; border-top: 1px solid var(--border);
}
.hero-facts dt { font-size: 11.5px; color: var(--muted); }
.hero-facts dd { margin: 2px 0 0; font-size: 15px; font-weight: 600; }

/* 翻页 */
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 36px 0 0; }
.pager-link {
  display: block; padding: 10px 14px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--panel); color: var(--text);
}
.pager-link:hover { border-color: var(--accent); text-decoration: none; }
.pager-link .dir { display: block; font-size: 11.5px; color: var(--muted); margin-bottom: 2px; }
.pager-link.next { text-align: right; }
.pager-spacer { display: block; }

/* 页脚 */
.site-foot { margin-top: 48px; padding-top: 22px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12.5px; }
.foot-grid { display: grid; grid-template-columns: minmax(220px, 1.6fr) 1fr 1fr; gap: 22px; }
.foot-logo { display: inline-flex; align-items: center; gap: 8px; color: var(--text); font-weight: 700; font-size: 14px; }
.foot-logo em { color: var(--accent); font-style: normal; }
.foot-about p { margin: 8px 0 0; }
.foot-title { margin: 0 0 8px; font-weight: 600; color: var(--text); font-size: 12.5px; }
.foot-links ul { list-style: none; margin: 0; padding: 0; }
.foot-links li { margin: 4px 0; }
.foot-links a { color: var(--muted); }
.foot-links a:hover { color: var(--accent); }
.foot-meta {
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 18px;
  margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border);
}
.foot-meta p { margin: 0; }
.foot-meta code { background: var(--panel2); border: 1px solid var(--border); border-radius: 5px; padding: 0 4px; font-size: 11.5px; }

/* ---------- 响应式 ---------- */
@media (max-width: 1240px) {
  .shell { grid-template-columns: var(--sidenav-w) minmax(0, 1fr); }
  .toc-col { display: none; }
  .toc-mobile { display: block; }
}
@media (max-width: 900px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .nav-toggle { display: inline-flex; }
  .sidenav {
    position: fixed; left: 0; top: var(--topbar-h); bottom: 0; width: min(86vw, 330px);
    height: auto; z-index: 60; border-right: 1px solid var(--border);
    box-shadow: var(--shadow); transform: translateX(-104%);
    transition: transform .22s ease;
  }
  body.nav-open .sidenav { transform: none; }
  body.nav-open { overflow: hidden; }
  .scrim { position: fixed; inset: var(--topbar-h) 0 0; background: rgba(0,0,0,.52); z-index: 55; }
  /* 无 JS 时抽屉退化成常规区块，导航依然可用 */
  html:not(.js) .sidenav {
    position: static; width: auto; height: auto; transform: none;
    border-right: none; border-bottom: 1px solid var(--border); box-shadow: none;
  }
  html:not(.js) .nav-toggle, html:not(.js) .scrim { display: none; }
  .topbar-links { display: none; }
  .topbar-title { display: none; }
  .main { padding: 20px 16px 56px; }
  .doc h1 { font-size: 23px; }
  .doc h2 { font-size: 18px; }
  .pager { grid-template-columns: 1fr; }
  .pager-link.next { text-align: left; }
  .foot-grid { grid-template-columns: 1fr 1fr; }
  .foot-about { grid-column: 1 / -1; }
}
@media (hover: none) {
  .h-anchor { opacity: .55; }
}
@media print {
  :root { color-scheme: light; }
  html, body { background: #fff !important; color: #111 !important; }
  .topbar, .sidenav, .toc-col, .toc-mobile, .pager, .skip-link, .scrim, .copy-btn,
  .code-head, .site-foot .foot-grid, .crumbs, .doc-meta .edit-link { display: none !important; }
  .shell { display: block; }
  .main { padding: 0; }
  .doc, .pager, .site-foot, .crumbs { max-width: none; }
  .doc h1 { font-size: 22pt; }
  .doc h2 { font-size: 15pt; }
  .doc h3 { font-size: 12.5pt; }
  .doc h1, .doc h2, .doc h3 { break-after: avoid; }
  pre.code, .table-wrap, .callout, blockquote { break-inside: avoid; }
  pre.code, .table-wrap, .callout, blockquote, .doc code { border: 1px solid #bbb; }
  pre.code, .callout, blockquote, .doc code, .code-block { background: #f7f7f7 !important; }
  .doc a { color: #0b4f57; text-decoration: underline; }
  .doc-meta { border-bottom: 1px solid #bbb; }
  @page { margin: 14mm; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important; scroll-behavior: auto !important;
  }
}
`;

// 首屏主题初始化（避免闪烁）；同时标记 js 可用
const THEME_JS = `(function(){try{var k='checkq-wiki-theme';var s=window.localStorage.getItem(k);var m=(s==='light'||s==='dark')?s:((window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark');document.documentElement.setAttribute('data-mode',m);}catch(e){}document.documentElement.classList.add('js');})();`;

const SITE_JS = `(function () {
  'use strict';
  var doc = document;
  var root = doc.documentElement;
  var base = root.getAttribute('data-base') || './';
  var THEME_KEY = 'checkq-wiki-theme';

  function mode() { return root.getAttribute('data-mode') === 'light' ? 'light' : 'dark'; }

  /* ---------- 主题切换 ---------- */
  var themeBtn = doc.getElementById('theme-toggle');
  function syncTheme() {
    if (!themeBtn) return;
    var light = mode() === 'light';
    var label = light ? '切换到深色主题' : '切换到浅色主题';
    themeBtn.setAttribute('aria-pressed', light ? 'true' : 'false');
    themeBtn.setAttribute('title', label);
    themeBtn.setAttribute('aria-label', label);
  }
  if (themeBtn) {
    syncTheme();
    themeBtn.addEventListener('click', function () {
      var next = mode() === 'light' ? 'dark' : 'light';
      root.setAttribute('data-mode', next);
      try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
      syncTheme();
    });
  }

  /* ---------- 移动端抽屉 ---------- */
  var navBtn = doc.getElementById('nav-toggle');
  var nav = doc.getElementById('sidenav');
  var scrim = doc.getElementById('scrim');
  function closeNav() {
    if (!doc.body.classList.contains('nav-open')) return;
    var inside = !!(nav && nav.contains(doc.activeElement));
    doc.body.classList.remove('nav-open');
    if (navBtn) navBtn.setAttribute('aria-expanded', 'false');
    if (scrim) scrim.hidden = true;
    if (inside && navBtn) navBtn.focus();
  }
  function openNav() {
    if (!nav || !navBtn) return;
    doc.body.classList.add('nav-open');
    navBtn.setAttribute('aria-expanded', 'true');
    if (scrim) scrim.hidden = false;
    var first = nav.querySelector('a, input');
    if (first) first.focus();
  }
  if (navBtn && nav) {
    navBtn.addEventListener('click', function () {
      if (doc.body.classList.contains('nav-open')) closeNav(); else openNav();
    });
    if (scrim) scrim.addEventListener('click', closeNav);
    nav.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el !== nav) {
        if (el.tagName === 'A') { closeNav(); return; }
        el = el.parentNode;
      }
    });
  }
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && doc.body.classList.contains('nav-open')) closeNav();
  });

  /* ---------- 搜索（combobox / listbox） ---------- */
  var input = doc.getElementById('search');
  var box = doc.getElementById('results');
  var statusEl = doc.getElementById('search-status');
  var entries = null;
  var hits = [];
  var activeIndex = -1;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      if (c === '&') return '&amp;';
      if (c === '<') return '&lt;';
      if (c === '>') return '&gt;';
      return '&quot;';
    });
  }
  function loadIndex() {
    if (entries) return Promise.resolve(entries);
    if (!window.fetch) return Promise.reject(new Error('fetch unavailable'));
    return fetch(base + 'search-index.json', { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .then(function (data) { entries = data; return data; });
  }
  function hasHeading(item, q) {
    var hs = item.headings || [];
    for (var i = 0; i < hs.length; i++) {
      if (String(hs[i].text || '').toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
  }
  function snippetOf(item, q) {
    var text = String(item.text || '');
    var pos = text.toLowerCase().indexOf(q);
    if (pos < 0) return item.desc || '';
    var start = pos > 40 ? pos - 40 : 0;
    return (start > 0 ? '…' : '') + text.slice(start, start + 120) + '…';
  }
  function hideResults() {
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
    if (statusEl) statusEl.textContent = '';
  }
  function setActive(next) {
    var links = box.querySelectorAll('a[role="option"]');
    if (!links.length) return;
    if (next < 0) next = links.length - 1;
    if (next >= links.length) next = 0;
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('aria-selected', i === next ? 'true' : 'false');
    }
    activeIndex = next;
    input.setAttribute('aria-activedescendant', 'sr-' + next);
    if (links[next].scrollIntoView) links[next].scrollIntoView({ block: 'nearest' });
  }
  function render(q) {
    if (!hits.length) {
      box.innerHTML = '<p class="search-empty">没有匹配的页面</p>';
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (statusEl) statusEl.textContent = '没有匹配结果';
      return;
    }
    var html = '';
    for (var i = 0; i < hits.length; i++) {
      html += '<a id="sr-' + i + '" role="option" aria-selected="false" href="' + base + hits[i].file + '">'
        + esc(hits[i].title) + '<em>' + esc(snippetOf(hits[i], q)) + '</em></a>';
    }
    box.innerHTML = html;
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (statusEl) statusEl.textContent = hits.length + ' 个结果';
  }
  function runSearch() {
    if (!input || !box) return;
    var q = String(input.value || '').trim().toLowerCase();
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    if (!q) { hideResults(); return; }
    loadIndex().then(function (data) {
      var found = [];
      for (var i = 0; i < data.length; i++) {
        var it = data[i];
        var score = 0;
        if (String(it.title || '').toLowerCase().indexOf(q) >= 0) score += 100;
        if (String(it.desc || '').toLowerCase().indexOf(q) >= 0) score += 50;
        if (hasHeading(it, q)) score += 30;
        if (String(it.text || '').toLowerCase().indexOf(q) >= 0) score += 10;
        if (score > 0) found.push({ item: it, score: score });
      }
      found.sort(function (a, b) { return b.score - a.score; });
      hits = found.slice(0, 8).map(function (x) { return x.item; });
      render(q);
    }).catch(function () {
      box.innerHTML = '<p class="search-empty">搜索索引未加载，可直接使用左侧导航</p>';
      box.hidden = false;
    });
  }
  if (input && box) {
    input.addEventListener('input', runSearch);
    input.addEventListener('focus', function () { if (String(input.value).trim()) runSearch(); });
    input.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Escape') {
        if (!box.hidden) { hideResults(); input.blur(); } else { input.value = ''; }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); return; }
      if (k === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); return; }
      if (k === 'Enter' && activeIndex >= 0) {
        var link = box.querySelector('#sr-' + activeIndex);
        if (link) { e.preventDefault(); window.location.href = link.getAttribute('href'); }
      }
    });
    doc.addEventListener('click', function (e) {
      if (!box.hidden && e.target !== input && !box.contains(e.target)) hideResults();
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      var tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      e.preventDefault();
      input.focus();
    });
  }

  /* ---------- 代码复制（渐进增强） ---------- */
  function copyText(text, done) {
    if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
      window.navigator.clipboard.writeText(text).then(function () { done(true); }, function () { legacyCopy(text, done); });
      return;
    }
    legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    var ok = false;
    try { ta.select(); ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    done(ok);
  }
  var blocks = doc.querySelectorAll('.code-block');
  for (var b = 0; b < blocks.length; b++) {
    (function (block) {
      var btn = block.querySelector('[data-copy]');
      var code = block.querySelector('pre code');
      if (!btn || !code) return;
      btn.hidden = false;
      btn.addEventListener('click', function () {
        copyText(code.textContent || '', function (ok) {
          btn.textContent = ok ? '已复制' : '复制失败';
          btn.classList.toggle('is-done', ok);
          window.setTimeout(function () { btn.textContent = '复制'; btn.classList.remove('is-done'); }, 1600);
        });
      });
    })(blocks[b]);
  }

  /* ---------- 本页目录滚动高亮 ---------- */
  var tocLinks = doc.querySelectorAll('.toc-nav a');
  if (tocLinks.length) {
    var targets = [];
    var seen = {};
    for (var t = 0; t < tocLinks.length; t++) {
      var href = tocLinks[t].getAttribute('href') || '';
      if (href.charAt(0) !== '#') continue;
      var id = href.slice(1);
      if (seen[id]) continue;
      seen[id] = true;
      var el = doc.getElementById(id);
      if (el) targets.push(el);
    }
    var current = '';
    function markActive(id) {
      if (id === current) return;
      current = id;
      for (var i = 0; i < tocLinks.length; i++) {
        var h = tocLinks[i].getAttribute('href') || '';
        var on = h === '#' + id;
        tocLinks[i].classList.toggle('is-active', on);
        if (on) tocLinks[i].setAttribute('aria-current', 'location');
        else tocLinks[i].removeAttribute('aria-current');
      }
    }
    function update() {
      var top = null;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top <= 96) top = targets[i];
      }
      if (top) markActive(top.id);
    }
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      var raf = window.requestAnimationFrame || function (fn) { return window.setTimeout(fn, 16); };
      raf(function () { ticking = false; update(); });
    }, { passive: true });
    update();
  }
})();
`;

// ---------- 模板 ----------
function heroHtml(B) {
  return `<section class="hero" aria-labelledby="hero-title">
  <p class="hero-kicker">开源 · 零依赖 · Docker 单容器</p>
  <h1 id="hero-title">CheckQ 文档</h1>
  <p class="hero-lede">CheckQ 是一个<strong>可视化 HTTP 自动化流程引擎</strong>：把每天要做的签到、监控、定时请求，做成可编辑、可复用、可被外部程序驱动的流程。</p>
  <p class="hero-note">本站只讲<strong>框架能力</strong>与用法，<strong>不含任何具体签到脚本、站点规则、模板内容或账号信息</strong>。</p>
  <div class="hero-actions">
    <a class="btn btn-primary" href="${B}quickstart.html">快速开始</a>
    <a class="btn" href="${B}tasks.html">任务与流程</a>
    <a class="btn" href="${B}api.html">API 与 MCP</a>
    <a class="btn" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>
  </div>
  <dl class="hero-facts">
    <div><dt>当前版本</dt><dd>v${VERSION}</dd></div>
    <div><dt>通知渠道</dt><dd>12 种</dd></div>
    <div><dt>MCP 工具</dt><dd>20 个</dd></div>
    <div><dt>许可证</dt><dd>MIT</dd></div>
  </dl>
</section>`;
}

function navHtml(current, base) {
  const groups = [];
  for (const p of PAGES) {
    const name = p.group || '文档';
    if (!groups.length || groups[groups.length - 1].name !== name) groups.push({ name, items: [] });
    groups[groups.length - 1].items.push(p);
  }
  return groups.map((g) => '<p class="nav-group">' + escapeHtml(g.name) + '</p>'
    + g.items.map((p) => {
      const href = p.file.replace(/\.md$/, '.html');
      const active = href === current;
      return '<a class="nav-link' + (active ? ' is-active' : '') + '" href="' + base + href + '"'
        + (active ? ' aria-current="page"' : '') + '>' + escapeHtml(p.title)
        + '<em>' + escapeHtml(p.blurb || p.desc) + '</em></a>';
    }).join('\n')).join('\n');
}

function tocHtml(headings, variant) {
  const items = headings.filter((h) => h.level === 2 || h.level === 3);
  if (!items.length) return '';
  const links = items.map((h) => '<a class="toc-l' + h.level + '" href="#' + h.id + '">' + escapeHtml(h.text) + '</a>').join('\n');
  const cls = variant === 'mobile' ? 'toc-nav toc-nav-mobile' : 'toc-nav';
  return '<nav class="' + cls + '" aria-label="本页目录"><p class="toc-title">本页目录</p>\n' + links + '\n</nav>';
}

function pagerHtml(current, base) {
  const idx = PAGES.findIndex((p) => p.file.replace(/\.md$/, '.html') === current);
  if (idx < 0) return '';
  const prev = idx > 0 ? PAGES[idx - 1] : null;
  const next = idx < PAGES.length - 1 ? PAGES[idx + 1] : null;
  if (!prev && !next) return '';
  const card = (p, dir, cls, rel) => p
    ? '<a class="pager-link ' + cls + '" href="' + base + p.file.replace(/\.md$/, '.html') + '" rel="' + rel + '">'
      + '<span class="dir">' + dir + '</span><span class="ttl">' + escapeHtml(p.title) + '</span></a>'
    : '<span class="pager-spacer" aria-hidden="true"></span>';
  return '<nav class="pager" aria-label="页面翻页">\n' + card(prev, '← 上一页', 'prev', 'prev')
    + card(next, '下一页 →', 'next', 'next') + '\n</nav>';
}

function editHref(p) {
  if (p.src) return `${REPO_URL}/edit/${BRANCH}/docs/${p.src}`;
  if (p.auto === 'changelog') return `${REPO_URL}/edit/${BRANCH}/docs/CHANGELOG.md`;
  return `${REPO_URL}/edit/${BRANCH}/tools/build-wiki.cjs`;
}

function jsonLd(opts) {
  const url = opts.canonical;
  const graph = [{
    '@type': 'WebSite',
    '@id': SITE + '#website',
    url: SITE,
    name: 'CheckQ 文档',
    inLanguage: 'zh-CN',
    description: SITE_DESC,
    publisher: {
      '@type': 'Organization',
      name: 'CheckQ',
      url: REPO_URL,
      logo: { '@type': 'ImageObject', url: SITE + 'assets/brand/checkq-mark.svg', width: 120, height: 120 },
    },
  }];
  if (opts.article) {
    graph.push({
      '@type': 'TechArticle',
      '@id': url + '#article',
      headline: opts.title,
      name: opts.title,
      description: opts.description,
      url,
      mainEntityOfPage: url,
      inLanguage: 'zh-CN',
      dateModified: BUILT_DAY,
      isPartOf: { '@id': SITE + '#website' },
      image: SITE + 'assets/social-preview.png',
      publisher: { '@type': 'Organization', name: 'CheckQ', url: REPO_URL },
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

function page(opts) {
  const B = opts.absolute ? SITE : './';
  const file = opts.file || 'index.html';
  const isHome = file === 'index.html';
  const title = opts.title || '文档';
  const description = opts.description || SITE_DESC;
  const canonical = isHome ? SITE : SITE + file;
  const headings = opts.headings || [];
  const showToc = opts.toc !== false && headings.some((h) => h.level === 2 || h.level === 3);
  const mobileToc = showToc ? tocHtml(headings, 'mobile') : '';
  const asideToc = showToc ? tocHtml(headings, 'desktop') : '';
  const crumbs = (opts.crumbs === false || isHome || file === '404.html') ? ''
    : '<nav class="crumbs" aria-label="面包屑"><a href="' + B + 'index.html">文档</a><span class="sep" aria-hidden="true">/</span>'
      + '<span aria-current="page">' + escapeHtml(title) + '</span></nav>';
  const hero = opts.hero || '';
  const edit = opts.edit || '';
  const metaLine = edit
    ? '<p class="doc-meta"><span>v' + VERSION + '</span><span>更新于 ' + BUILT_DAY + '</span>'
      + '<a class="edit-link" href="' + edit + '" target="_blank" rel="noopener noreferrer">在 GitHub 编辑此页 ↗</a></p>'
    : '';
  let body = opts.body || '';
  if (hero) body = hero + metaLine + body;
  else if (metaLine) body = body.indexOf('</h1>') >= 0 ? body.replace('</h1>', '</h1>\n' + metaLine) : metaLine + body;

  const ogType = opts.article ? 'article' : 'website';
  const robots = opts.noindex ? 'noindex, follow' : 'index, follow';
  const docTitle = isHome ? 'CheckQ 文档 · 开源可视化 HTTP 自动化流程引擎' : title + ' · CheckQ 文档';
  const socialTitle = isHome ? 'CheckQ 文档' : title + ' · CheckQ 文档';
  const articleTitle = isHome ? 'CheckQ 文档' : title;
  const canonicalTag = opts.noindex ? '' : '<link rel="canonical" href="' + canonical + '" />';
  const ogUrl = opts.noindex ? '' : '<meta property="og:url" content="' + canonical + '" />';
  const structured = opts.noindex ? '' : '<script type="application/ld+json">' + jsonLd({ canonical, title: articleTitle, description, article: !!opts.article }) + '</script>';

  return `<!doctype html>
<html lang="zh-CN" data-mode="dark" data-base="${B}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="theme-color" content="#0b0e11" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#f3f5f6" media="(prefers-color-scheme: light)" />
<title>${escapeHtml(docTitle)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="robots" content="${robots}" />
${canonicalTag}
<meta property="og:type" content="${ogType}" />
<meta property="og:site_name" content="CheckQ 文档" />
<meta property="og:locale" content="zh_CN" />
<meta property="og:title" content="${escapeHtml(socialTitle)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
${ogUrl}
<meta property="og:image" content="${SITE}assets/social-preview.png" />
<meta property="og:image:width" content="1280" />
<meta property="og:image:height" content="640" />
<meta property="og:image:alt" content="CheckQ 文档：开源的可视化 HTTP 自动化流程引擎" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(socialTitle)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${SITE}assets/social-preview.png" />
<link rel="icon" href="${B}assets/brand/checkq-mark.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="${B}assets/brand/apple-touch-icon.png" />
<link rel="stylesheet" href="${B}assets/style.css" />
<link rel="sitemap" type="application/xml" href="${SITE}sitemap.xml" />
${structured}
<script>${THEME_JS}</script>
<noscript><style>.copy-btn,.search{display:none !important}</style></noscript>
</head>
<body id="top">
<a class="skip-link" href="#main">跳到正文</a>
<header class="topbar">
  <button class="icon-btn nav-toggle" id="nav-toggle" type="button" aria-controls="sidenav" aria-expanded="false" aria-label="打开文档导航">
    <svg class="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
  </button>
  <a class="brand" href="${B}index.html">
    <img class="brand-mark" src="${B}assets/brand/checkq-mark.svg" width="26" height="26" alt="" />
    <span class="brand-word">Check<em>Q</em></span>
    <span class="brand-ver">v${VERSION}</span>
  </a>
  <span class="topbar-title">文档</span>
  <div class="topbar-links">
    <a class="tb-link" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>
    <a class="tb-link" href="${REPO_URL}/issues" target="_blank" rel="noopener noreferrer">Issues</a>
  </div>
  <button class="icon-btn theme-toggle" id="theme-toggle" type="button" aria-pressed="false" aria-label="切换深色 / 浅色主题" title="切换深色 / 浅色主题">
    <svg class="ico ico-moon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
    <svg class="ico ico-sun" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
  </button>
</header>
<div class="shell">
  <aside class="sidenav" id="sidenav" aria-label="文档导航">
    <div class="sidenav-inner">
      <div class="search">
        <label class="sr-only" for="search">搜索文档</label>
        <input id="search" class="search-input" type="search" placeholder="搜索文档…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="results" aria-autocomplete="list" aria-haspopup="listbox" />
        <kbd class="search-hint" aria-hidden="true">/</kbd>
        <div class="search-results" id="results" role="listbox" aria-label="搜索结果" hidden></div>
        <p class="sr-only" id="search-status" role="status" aria-live="polite"></p>
      </div>
      <nav class="sidenav-nav" aria-label="文档页面">
${navHtml(file, B)}
      </nav>
      <div class="sidenav-foot">
        <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>
        <a href="${REPO_URL}/issues" target="_blank" rel="noopener noreferrer">反馈问题</a>
      </div>
    </div>
  </aside>
  <div class="scrim" id="scrim" hidden></div>
  <main class="main" id="main" tabindex="-1">
    ${crumbs}
    ${mobileToc ? '<details class="toc-mobile">\n<summary>本页目录</summary>\n' + mobileToc + '\n</details>' : ''}
    <article class="doc">
${body}
    </article>
${opts.pager === false ? '' : pagerHtml(file, B)}
    <footer class="site-foot" role="contentinfo">
      <div class="foot-grid">
        <div class="foot-about">
          <a class="foot-logo" href="${B}index.html"><img src="${B}assets/brand/checkq-mark.svg" width="22" height="22" alt="" /><span>Check<em>Q</em></span></a>
          <p>开源的可视化 HTTP 自动化流程引擎。本站只讲框架能力，不含具体签到脚本、站点规则或账号信息。</p>
        </div>
        <div class="foot-links">
          <p class="foot-title">项目</p>
          <ul>
            <li><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a></li>
            <li><a href="${REPO_URL}/issues" target="_blank" rel="noopener noreferrer">Issues</a></li>
            <li><a href="${REPO_URL}/releases" target="_blank" rel="noopener noreferrer">版本发布</a></li>
            <li><a href="${REPO_URL}/blob/${BRANCH}/docs/SECURITY.md" target="_blank" rel="noopener noreferrer">安全说明</a></li>
            <li><a href="${REPO_URL}/blob/${BRANCH}/LICENSE" target="_blank" rel="noopener noreferrer">MIT 许可证</a></li>
          </ul>
        </div>
        <div class="foot-links">
          <p class="foot-title">文档</p>
          <ul>
            <li><a href="${B}quickstart.html">快速开始</a></li>
            <li><a href="${B}reference-api.html">API 参考</a></li>
            <li><a href="${B}reference-mcp.html">MCP 工具</a></li>
            <li><a href="${B}faq.html">常见问题</a></li>
            <li><a href="${B}changelog.html">更新日志</a></li>
          </ul>
        </div>
      </div>
      <div class="foot-meta">
        <p>v${VERSION} · 生成于 ${BUILT_LABEL} · 由 <code>tools/build-wiki.cjs</code> 从 <code>docs/</code> 与内置页面生成</p>
        <p><a class="to-top" href="#top">↑ 返回顶部</a></p>
      </div>
    </footer>
  </main>
  ${asideToc ? '<aside class="toc-col" aria-label="本页目录">\n' + asideToc + '\n</aside>' : '<div class="toc-col" aria-hidden="true"></div>'}
</div>
<script src="${B}assets/site.js" defer></script>
</body>
</html>
`;
}

// 读取 docs/ 源文件（去掉 BOM，否则首行标题会被当成正文）
function readDoc(file) {
  return fs.readFileSync(path.join(DOCS, file), 'utf8').replace(/^\uFEFF/, '');
}

// 更新日志（从 docs/CHANGELOG.md 生成）
function changelogMd() {
  // 只收录面向用户的更新说明（docs/CHANGELOG.md），不展示内部提交记录
  try {
    const md = readDoc('CHANGELOG.md');
    if (md.trim()) return md;
  } catch { /* 没有文件时给占位 */ }
  return `# 更新日志

暂无记录。
`;
}

// ---------- 生成 ----------
for (const p of PAGES) {
  if (p.src) LINK_MAP[p.src] = p.file.replace(/\.md$/, '.html');
  if (p.auto === 'changelog') LINK_MAP['CHANGELOG.md'] = 'changelog.html';
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets', 'brand'), { recursive: true });

const copyAsset = (from, to) => {
  try {
    fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));
    return true;
  } catch {
    console.log('MISS asset:', from);
    return false;
  }
};
copyAsset('web/public/brand/checkq-mark.svg', 'assets/brand/checkq-mark.svg');
copyAsset('web/public/apple-touch-icon.png', 'assets/brand/apple-touch-icon.png');
copyAsset('docs/assets/social-preview.png', 'assets/social-preview.png');
fs.writeFileSync(path.join(OUT, 'assets', 'style.css'), CSS, 'utf8');
fs.writeFileSync(path.join(OUT, 'assets', 'site.js'), SITE_JS, 'utf8');

const searchIndex = [];
for (const p of PAGES) {
  let md = '';
  if (p.auto === 'changelog') md = changelogMd();
  else if (p.src) {
    const docFile = path.join(DOCS, p.src);
    if (!fs.existsSync(docFile)) { console.log('MISS doc source:', p.src); continue; }
    md = readDoc(p.src);
  } else {
    const src = SOURCES[p.file];
    if (!src) { console.log('MISS source:', p.file); continue; }
    md = src;
  }
  if (p.hero) md = md.replace(/^#\s+[^\n]*\r?\n+/, '');

  const { html, headings } = mdToHtml(md);
  const file = p.file.replace(/\.md$/, '.html');
  const out = page({
    file,
    title: p.title,
    description: p.desc,
    body: html,
    headings,
    hero: p.hero ? heroHtml('./') : '',
    edit: editHref(p),
    article: true,
  });
  fs.writeFileSync(path.join(OUT, file), out.replace(/[ \t]+$/gm, ''), 'utf8');
  searchIndex.push({
    file,
    title: p.title,
    desc: p.desc,
    blurb: p.blurb || '',
    headings: headings.filter((h) => h.level === 2 || h.level === 3).map((h) => ({ id: h.id, text: h.text })),
    text: plainText(md).slice(0, 5000),
  });
  console.log('generated', p.file, `(${headings.length} headings)`);
}

// sitemap.xml
const sitemapEntries = PAGES.map((p) => ({
  file: p.file === 'index.md' ? '' : p.file.replace(/\.md$/, '.html'),
  pri: p.file === 'index.md' ? '1.0' : '0.7',
}));
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries
    .map((u) => `  <url>
    <loc>${SITE}${u.file}</loc>
    <lastmod>${BUILT_DAY}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u.pri}</priority>
  </url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), sitemap, 'utf8');

// robots.txt
fs.writeFileSync(
  path.join(OUT, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`,
  'utf8'
);

// 404.html（绝对路径，任意深度的坏链接都能正确取到资源）
const NOT_FOUND_MD = `# 404 — 页面不存在

这个地址在 CheckQ 文档站里没有对应页面。可能是链接过期、文件名大小写不同，或者页面已经改名。

## 可以试试

- [返回文档首页](${SITE}index.html)
- [快速开始](${SITE}quickstart.html)
- [API 参考](${SITE}reference-api.html)
- [常见问题](${SITE}faq.html)

> [!TIP] 用导航或搜索
> 所有页面都能从左上角导航进入，也可以按 \`/\` 聚焦搜索框。页面地址区分大小写，例如 \`reference-api.html\`。
`;
const notFound = mdToHtml(NOT_FOUND_MD);
fs.writeFileSync(
  path.join(OUT, '404.html'),
  page({
    file: '404.html',
    title: '404 — 页面不存在',
    description: '这个地址在 CheckQ 文档站里不存在。可以从文档首页、快速开始或 API 参考重新进入。',
    body: notFound.html,
    headings: notFound.headings,
    absolute: true,
    noindex: true,
    toc: false,
    crumbs: false,
    pager: false,
    article: false,
  }).replace(/[ \t]+$/gm, ''),
  'utf8'
);

fs.writeFileSync(path.join(OUT, 'search-index.json'), JSON.stringify(searchIndex), 'utf8');
console.log('generated 404.html');
console.log('wiki built →', path.relative(ROOT, OUT), `(${PAGES.length} 页 + 404 / v${VERSION})`);
