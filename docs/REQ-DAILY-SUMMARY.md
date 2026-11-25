# 每日汇总（系统通知）需求文档 v1

> 面向对象：实施本需求的开发 Agent。读完本文应当能直接开工，不需要再猜产品意图。
> 状态：**已实施**（T1–T9 已完成；AC-1～AC-12 见 `server/test/system-notify.test.js`）
> 产品口径以 `docs/PRD.md` 为准（§4 操作逻辑、§9 路线）；本文只覆盖"每日汇总 + 系统通知"这一块。
> 建议随下一次发布交付（暂称 v0.5.3）；版本号以发布时三处 `package.json` 为准，本文不写死。

---

## 1. 问题与根因

### 1.1 现象

- 两个任务已停用，08:10 的每日汇总仍在推送，站内通知标题仍沿用某个任务的签到名称。
- 用户认知与产品行为不一致：用户认为"每日汇总是汇报当天任务运行情况的渠道"，产品实际把它做成了"某个任务的附属推送"。

### 1.2 根因（不是文案问题）

| 层 | 现状 | 后果 |
|---|---|---|
| 概念 | 汇总的"推送单位"是**任务**（`summaryTargets()`，`server/src/api.js:244`），借任务自己的 `notify.channels` | 汇总的存在依赖任务；任务删了/停用，汇总就消失或改名 |
| 身份 | `sendToChannels()` 的站内通知标题取 `ch.title`（`server/src/api.js:365`） | 标题沿用任务渠道名，看起来像该任务在发言 |
| 调度 | `runner.sendDailySummary` 只过滤 `enabled`（`api.js:266`） | 全部停用即静默跳过：任务开关决定了系统日报的生死 |

0.5.2 已修的三点（标题固定、跳过停用单位、设置页标注已停用）是**止血**，概念错误仍在。

### 1.3 本需求要解决的判断

> 每日汇总是**实例级系统通知**，不属于任何任务；它的渠道、开关、收件人由系统自己维护。

---

## 2. 目标与非目标

**目标**

1. 汇总与任务完全解耦：删除或停用任何任务，汇总照常发送。
2. 身份干净：标题恒为「每日汇总」，站内通知不挂任何 `flowId/flowName`。
3. 内容可行动：看见这条消息，能判断"今天有没有需要我处理的事"。
4. 可预期：一天一次、窗口明确、失败可见、不重复轰炸。

**非目标（本期不做，别顺手加）**

- 不做周报/月报，不做趋势图。
- 不做按角色分发不同内容（先只有管理员收件）。
- 不做外部渠道重试队列、不做汇总发送的失败重试（只兜底提示一次）。
- 不改任务通知（`flow.notify`）的任何行为。
- 不引入新的第三方推送服务，渠道复用现有 12 类。

---

## 3. 产品决定（已定，实施时不要改）

| # | 决定 | 理由 |
|---|---|---|
| D1 | 通知分两类：**任务通知**（挂任务）与**系统通知**（挂实例）。每日汇总属系统通知 | 任务与系统各有生命周期，混在一起必然出现"任务停了汇总还在" |
| D2 | 系统渠道独立存放，不复用任务渠道 | 复用即耦合；且用户在设置页看不出"这条消息是谁发的" |
| D3 | 系统渠道放进新文件 `channels.json`，与 `flows` 同加密策略（AES-256-GCM） | `meta.json` 是**明文落盘**（`store.js:159`），SMTP 密码/Token 不能进去 |
| D4 | 站内通知是**内置通道，不可移除**；外部渠道是"额外投递" | 保证任何配置下汇总都有一条可达的落点，也让"全渠道失败"有地方告诉你 |
| D5 | 统计窗口 = **服务器本地自然日**（昨日 00:00–23:59），与首页"今日"同一口径；`timezone` 只控制触发时刻 | 避免两套口径（首页说 19 次、日报说 21 次） |
| D6 | 一天一次，按窗口日期幂等；停机错过则启动后补发一次，并标注「补发」 | 漏发比重复发更糟，但重复发同样不可接受 |
| D7 | 空日（窗口内 0 次运行）默认**不发**，设置项 `skipEmpty` 可关 | 无事发生的日子不该产生通知 |
| D8 | 配置写入限 `admin`（`requireAdmin`）；读取所有已登录用户可取摘要 | 系统渠道含凭据、影响全实例，不能由 operator 代配 |
| D9 | 旧字段 `meta.dailySummary.targetFlowIds` 只读兼容一个版本，页面不再展示 | 不制造"两处配置都能改"的双源 |

---

## 4. 概念模型

```
任务通知：flow.notify.channels  →  sendToChannels()  →  成功/失败即时消息
系统通知：channels.json.system[] →  sendToChannels()  →  每日汇总 / 系统告警
                                    ↑
                    内置 inbox（不可移除，服务端直接写库）
```

- 两类渠道**结构相同**（同一套 12 种类型与字段），因此发送逻辑可完全复用，只是数据来源不同。
- 系统通知的 `ctx` 固定：`{ title: '每日汇总', flowId: null, flowName: '' }`。
- 系统通知的发送**不读任何任务的 `enabled` / `notify`**——这是本需求的核心断言。

---

## 5. 数据模型

### 5.1 `channels.json`（新文件，加密落盘）

```json
{
  "version": 1,
  "system": [
    { "id": "ch_xxx", "type": "inbox", "title": "每日汇总" },
    { "id": "ch_yyy", "type": "email", "host": "smtp.example.com", "port": 465,
      "user": "bot@example.com", "pass": "<明文>", "from": "bot@example.com",
      "to": "ops@example.com", "subject": "每日汇总" }
  ]
}
```

约束：

| 项 | 规则 |
|---|---|
| 文件位置 | `<DATA_DIR>/channels.json`，与 `flows.json` 同级 |
| 写盘 | 复用 `#save()` 的 tmp+rename 原子写 |
| 加密 | 复用 `secret.js`：落盘前对 `token/key/pass/password/secret/url/user/chat_id/chatid` 加密；内存保持明文，API 返回明文（与 `flows` 现状一致） |
| 数量 | 外部渠道 ≤ 10 条（含重复类型），与任务渠道上限一致 |
| inbox | 恒有且仅有一条；`PUT` 时若未提供，服务端自动补回；尝试删除返回 400 |
| 校验 | `type` 必须在 12 类白名单内；`email` 必须有 `host/port/to`；`telegram` 必须有 `token/chat`；其余有 `url` 的必须有 `url` 或对应必填字段（沿用编辑器 `FIELDS` 表） |

### 5.2 `meta.dailySummary`（沿用现有键，扩展字段）

```json
{
  "enabled": true,
  "time": "08:10",
  "timezone": "Asia/Shanghai",
  "skipEmpty": true,
  "include": { "failures": true, "paused": true, "successCount": true },
  "lastSentDate": "2026-11-15",
  "lastSentAt": 1763200000000,
  "lastResult": { "ok": 2, "total": 3, "failed": [{ "type": "telegram", "error": "HTTP 401" }] }
}
```

- 保留 `targetFlowIds/targetFlowId` 字段用于迁移读取，**不再写入**。
- `lastSentDate` 为**统计窗口日**（`YYYY-MM-DD`），用于幂等；`lastSentAt` 用于设置页展示。
- `lastResult` 只保留摘要，失败原因截断到 60 字符；不落完整响应。

### 5.3 迁移（启动时执行，幂等）

1. `channels.json` 不存在 → 创建，`system` 从旧 `targetFlowIds` 中**第一个仍启用的任务**复制其 `notify.channels`；若没有可用任务，则只有 `inbox`。
2. 复制后写 `meta.dailySummary.migratedFrom = '<flowId>'` 与 `migratedAt`，供设置页展示一次性提示「汇总已从任务「X」独立」。
3. 迁移**不改** `enabled/time`；若旧配置里 `enabled=false`，保持关闭。
4. 迁移只执行一次；`migratedAt` 已存在则跳过。

---

## 6. 统计与内容

### 6.1 统计口径（新增 `store.statsForRange(startMs, endMs)`）

| 字段 | 定义 |
|---|---|
| `window` | `[昨日 00:00:00, 昨日 23:59:59.999]`，服务器本地时区 |
| `enabledFlows` | 当前 `enabled===true` 的任务数（不要求有 cron） |
| `runs` | 开始时间落在窗口内的已结束运行，包含已取消。兼容毫秒时间戳与 ISO 时间。 |
| `success / failed` | 按最终状态统计成功和失败。 |
| `rate` | 成功率取整，0 次时为 `null`。 |
| `failures[]` | 每个失败任务取窗口内开始时间最晚的一条。`message` 取结论首行，`consecutive` 统计截至窗口末、最近一次成功之后的失败，或尚无成功时的全部保留失败。取消和在途记录不影响连续失败计数。 |
| `paused[]` | `pausedAt` 落在窗口内的任务，返回 `{ flowName, at, reason }`。 |
| `next` | 最早的下次调度，返回 `{ flowName, at }`，与首页共用调度缓存。 |

**已知限制（写进文档，不要当成 bug 修）**：`runs` 每任务只保留最近 500 条（`store.js:481`），超高频率任务在窗口内的历史可能被裁剪，汇总数字是"基于本地保留记录的近似值"。UI 不因此加免责声明，但本文件与 `ARCHITECTURE.md` 的数据模型一节要保持一致。

### 6.2 文案模板（纯文本，正文 ≤ 2000 字符）

```
每日汇总 · {MM-DD}（补发？）
{启用任务数} 个启用任务，运行 {X} 次：成功 {a} / 失败 {b}（{rate}%）

需要你看一眼
· {任务名}：{原因}（{HH:MM}）—— 连续失败 {n} 次
· 已自动停用：{任务名}（{HH:MM}，{原因}）

其余 {k} 个任务正常
下次调度：{任务名} {明天 HH:MM | MM-DD HH:MM}

打开面板查看：{baseUrl}
```

渲染规则：

| 规则 | 说明 |
|---|---|
| 标题 | 恒为 `每日汇总`；`ctx.title` 覆盖渠道自身标题（沿用 0.5.2 机制） |
| 失败行 | 最多 5 条；超出输出「另有 N 个任务失败」；无失败时整段替换为「今天没有失败任务」 |
| 暂停行 | 最多 5 条；无暂停不出现该段 |
| 成功 | 只给数量（`include.successCount=false` 时省略该句）；不逐条列成功任务 |
| 空日 | `skipEmpty=true` 时不发送；`false` 时发「昨日无任务运行」+ 下次调度 |
| 补发 | 消息首行追加「（补发）」，并在此后不重复发送 |
| 面板链接 | `meta.publicBaseUrl` 存在则用之，否则省略该行（不猜 IP） |
| 截断 | 总长超 2000 字符时按顺序裁掉「其余 N 个任务正常」→「下次调度」→ 失败条目（保留前 3 条） |
| 渠道格式 | 统一纯文本；钉钉/企业微信/飞书用现有 `markdown/text` 分支，邮件为正文纯文本 |

### 6.3 站内通知落点

| 场景 | 写入 | `title` | `level` | `flowId` |
|---|---|---|---|---|
| 正常汇总 | `addNotification` | `每日汇总` | 有失败或有暂停 → `fail`，否则 `success` | `null` |
| 空日且 `skipEmpty=false` | 同上 | `每日汇总` | `info` | `null` |
| 外部渠道全部失败 | `addNotification` | `汇总推送失败` | `fail` | `null` |

`content` 直接放渲染后的正文；失败兜底的 `content` 为「渠道 3 个，成功 0；telegram: HTTP 401」。

---

## 7. 发送流程

### 7.1 触发

| 触发源 | 行为 |
|---|---|
| 定时（`scheduler.#syncDailySummary`，`scheduler.js:71`） | 按 `time` + `timezone` 建 `__summary__` cron；到点调 `runner.sendDailySummary()` |
| 启动补发 | 服务启动后 30 秒检查：`enabled && lastSentDate < 昨日窗口日` → 发送并标「补发」 |
| 手动「立即发送」 | 设置页按钮 → `POST /api/system/notify/send`，跳过 `skipEmpty` 与幂等检查，**不写** `lastSentDate` |
| 预览 | `POST /api/system/notify/preview`，只渲染不发送 |

### 7.2 时序与守卫

```
sendDailySummary(mode):
  1. 计算 window（昨日）；若 mode=cron 且 lastSentDate === window.date → return { skipped: 'duplicate' }
  2. 若 summaryInFlight → return { skipped: 'in-flight' }（进程内布尔锁）
  3. statsForRange(window)
  4. 若 runs===0 且 skipEmpty 且 mode!=='manual' → return { skipped: 'empty' }
  5. 渲染正文
  6. channels = [inbox, ...channels.json.system 中的外部渠道]
  7. 逐个 sendToChannels；记录 { ok, total, failed[] }
  8. 写 lastSentDate / lastSentAt / lastResult（manual 模式只写 lastResult）
  9. 外部渠道存在失败 → addNotification('汇总推送失败')
 10. 审计：store.addAudit('notify.daily', `${ok}/${total}，渠道 ${n}`)
```

- 单次发送总耗时上限 60 秒（外部渠道现有 15 秒超时 × 最多 10 条 → 串行会超；改为**并行** `Promise.allSettled`，整体上限 30 秒）。
- 发送期间不得阻塞任务调度；异常全部 catch，绝不抛到 cron 回调外。
- 同一进程只允许一个汇总在飞，避免补发与定时重叠。

### 7.3 幂等键

`window.date`（`YYYY-MM-DD`）写入 `meta.dailySummary.lastSentDate`。跨天重启、时区未变时行为稳定；用户改 `time` 不影响已发送状态。

---

## 8. API 契约

新增端点（`/api/system/notify` 系列）。旧端点在 §8.3 兼容处理。

### 8.1 新增

| 方法 | 路径 | 权限 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `/api/system/notify` | 任意已登录 | — | `{ daily, channels, migratedFrom, lastResult }`（`channels` 为明文，含内置 inbox） |
| PUT | `/api/system/notify` | admin | `{ daily?, channels? }` | 同 GET；`time` 非 `HH:MM` → 400；渠道非法 → 400 并指出第几条 |
| POST | `/api/system/notify/preview` | 任意已登录 | `{ date?: 'YYYY-MM-DD' }` | `{ text, window, counts, skipped? }`，不发送、不写 last* |
| POST | `/api/system/notify/test` | admin | `{ channelId? }` | `{ ok, results: [{ type, ok, error? }], text }`（文本前缀「（测试）」） |
| POST | `/api/system/notify/send` | admin | `{ date?, dryRun? }` | `{ ok, skipped?, text, results, groups }`；`dryRun` 等价 preview |

错误码沿用全局约定：`400` 参数、`403` 权限、`404`、`502` 渠道失败（`test` 部分失败返回 502 + `results`）。

### 8.2 响应示例

```json
{
  "daily": {
    "enabled": true, "time": "08:10", "timezone": "Asia/Shanghai", "skipEmpty": true,
    "include": { "failures": true, "paused": true, "successCount": true },
    "lastSentDate": "2026-11-15", "lastSentAt": 1763200000000,
    "lastResult": { "ok": 1, "total": 2, "failed": [{ "type": "telegram", "error": "HTTP 401" }] }
  },
  "channels": [{ "id": "ch_1", "type": "inbox", "title": "每日汇总" }],
  "migratedFrom": "flow_123"
}
```

### 8.3 旧端点兼容（保留一个版本，v0.6 删除）

| 旧端点 | 兼容行为 |
|---|---|
| `GET/PUT /api/system/daily-summary-config` | 读写 `meta.dailySummary`（`enabled/time/timezone`），忽略 `targetFlowIds` 写入；响应保留字段以免旧前端崩 |
| `GET /api/system/push-targets` | 改为返回系统渠道摘要 `[{ id, type }]`（字段名保留 `id/name/enabled/channels` 会误导，允许直接改结构，因为前端同步改） |
| `POST /api/system/daily-summary` | `{ flowIds }` 时按旧逻辑借任务渠道发一次（兼容期保留），无 body 时走新逻辑发送 |

`api-surface.test.js` 对旧端点仍要有断言，避免静默 404。

---

## 9. 界面规格

位置：设置 → **通知与推送** 页签，改成上下两块。

### 9.1 系统通知（新）

| 区块 | 控件 | 行为 |
|---|---|---|
| 开关 | checkbox「每日汇总」 | 关闭后不建 cron；页面显示「已关闭」 |
| 时间 | `input[type=time]` + 时区下拉（`Asia/Shanghai`、`UTC`、`Asia/Tokyo` 等常用项 + 自定义） | 保存后 `scheduler.rebuild()` |
| 空日 | checkbox「没有运行也发一条」 | 对应 `skipEmpty=false` |
| 渠道 | 复用渠道编辑器（抽共享字段表），列表顶部固定一条「站内通知（内置）」不可删 | 新增/删除/编辑，最多 10 条外部渠道 |
| 上次结果 | 只读行：「上次：11-15 08:10，1/2 成功」+ 失败渠道悬停看原因 | 无记录显示「尚未发送」 |
| 操作 | 「保存」「测试发送」「预览今天」「立即发送」 | 立即发送不改 `lastSentDate`（不串明日定时） |

### 9.2 任务通知（原「每日汇总推送」移除）

原勾选"推送单位"的整块 UI **删除**，替换为一句只读说明位：`任务通知在编辑器「更多 → 通知渠道」里配置。`
界面提示级别（`toastLevel`）三条选项保留原位，移到本页签「界面提示」小块。

### 9.3 文案与禁用态

| 状态 | 文案 |
|---|---|
| 渠道只有 inbox | 无提示（正常态不解释） |
| 关闭 | 「已关闭」 |
| 上次外部渠道失败 | 「上次：{ok}/{total} 成功」+ 悬停原因 |
| 迁移后首次进入 | 一次性提示「汇总已从任务「{name}」独立」 |
| 保存成功 | `已保存`（toast） |

遵守 `docs/UI-STANDARDS.md`：无常驻说明段、解释进悬停、状态用「小圆点 + 文字」、`copy-audit` 会拦注释式文案。渠道编辑器复用 `Modal` + 原生 `<dialog>` 契约，窄屏（≤640px）表单单列。

---

## 10. 边界与异常

| # | 场景 | 期望行为 |
|---|---|---|
| 1 | 所有任务停用 | 汇总照常发送（核心回归） |
| 2 | 删除所有任务 | 同上；正文显示 0 个启用任务、昨日仍按记录统计 |
| 3 | 渠道全部失败（含 inbox 写入异常） | 记录 `lastResult`；不影响任务运行；不在同一天重复兜底 |
| 4 | 服务在 08:10 停机，09:30 启动 | 启动补发一次，首行含「（补发）」 |
| 5 | 同一天重启 3 次 | 只发一次（`lastSentDate` 守卫） |
| 6 | 用户把时间从 08:10 改到 23:50 | 当天已发过则不再发，次日按新时间 |
| 7 | 跨时区改 `timezone` | 触发时刻跟随新时区；窗口仍按服务器本地日 |
| 8 | 渠道配置里有未知 `type` | 保存时 400；已存在脏数据则发送时跳过该条并计入失败 |
| 9 | 超过 2000 字符 | 按 §6.2 顺序截断，不报错 |
| 10 | 手动「立即发送」与定时同一分钟 | 进程内锁让后到者返回 `skipped: 'in-flight'` |
| 11 | 汇总发送中进程被杀 | 不写 `lastSentDate`（先发后写），重启后补发；宁可重发不丢 |
| 12 | `publicBaseUrl` 未配置 | 正文省略面板链接行，不猜地址 |
| 13 | 渠道含脚本/未知字段 | 只加密白名单字段，其余原样；不执行任何表达式 |
| 14 | 备份/恢复 | **脱敏备份**含 `channels.json` 但敏感值置 `***`；**完整备份**含明文；**恢复不导入系统渠道**（恢复后需重配，页面提示一次） |

---

## 11. 验收标准

每条都要能在本地跑：`node --test "server/test/*.test.js"` + 手工或 `verify-round`。

**AC-1 解耦（必过）** 给定所有任务 `enabled=false`，当 `sendDailySummary()` 被调用，则返回 `ok=true` 且站内新增一条 `title=每日汇总`。

**AC-2 删除无影响** 给定删除迁移来源任务，当触发汇总，则发送成功且不抛错。

**AC-3 身份** 给定任意渠道配置，当汇总发送，则站内通知 `flowId===null && flowName===''`，`title==='每日汇总'`，正文不含来源任务名。

**AC-4 窗口** 给定昨日 23:58 与今日 00:02 各一次运行，当汇总发送，则正文只统计昨日那次（`runs` 计数与 `statsForRange` 一致）。

**AC-5 幂等** 给定 `lastSentDate=昨日`，当定时再次触发，则返回 `skipped:'duplicate'` 且无新增通知。

**AC-6 补发** 给定 `lastSentDate=前日`、服务启动，则 30 秒内发送一次，正文含「（补发）」，`lastSentDate` 更新为昨日。

**AC-7 空日** 给定昨日 0 次运行且 `skipEmpty=true`，则返回 `skipped:'empty'` 且无通知；`skipEmpty=false` 时发送「昨日无任务运行」。

**AC-8 失败兜底** 给定外部渠道返回 401，则 `lastResult.failed` 含该渠道，站内出现 `title=汇总推送失败`，任务调度不受影响（下一拍仍执行）。

**AC-9 加密** 给定 `channels.json` 含 SMTP 密码，则文件内容中 `pass` 以 `enc:v1:` 开头；`GET /api/system/notify` 返回明文；脱敏备份中为 `***`。

**AC-10 权限** 给定 operator 调用 `PUT /api/system/notify`，则 403；`GET` 返回 200。

**AC-11 旧端点** 给定调用 `GET /api/system/daily-summary-config`，则 200 且字段完整（兼容期）。

**AC-12 截断** 给定 20 个失败任务，则正文 ≤2000 字符，失败条目 ≤5 且含「另有 15 个任务失败」。

---

## 12. 实施任务（按依赖排序）

| # | 任务 | 文件 | 规模 |
|---|---|---|---|
| T1 | 抽渠道加解密：`encryptChannels / decryptChannels / maskChannels`，`encryptSecrets` 内部改调它们（行为不变） | `server/src/secret.js` | S |
| T2 | `channels.json` 读写：`channelsFile`、启动加载、`getSystemChannels/setSystemChannels`、`#flushNow` 加一行加密写、`statsForRange()`、`addAudit` 调用点 | `server/src/store.js` | M |
| T3 | 迁移：读旧 `targetFlowIds` → 复制首个启用任务的渠道 → 写 `migratedFrom/migratedAt`，幂等 | `server/src/store.js` | S |
| T4 | 发送核心：`buildDailySummaryText(stats)`、`sendDailySummary(mode)`（并行发送、锁、幂等、兜底、审计）；`POST /api/system/notify/preview` 复用渲染 | `server/src/api.js` | L |
| T5 | 路由：`GET/PUT /api/system/notify`、`test`、`send`；旧端点兼容转发（`requireAdmin` 只加在写） | `server/src/api.js` | M |
| T6 | 调度：`#syncDailySummary` 保持（读同一 key），启动补发钩子 | `server/src/scheduler.js` | S |
| T7 | 前端：抽 `web/src/channel-fields.js`；新增 `web/src/components/flow-list/system-notify.jsx`；`settings.jsx` 改两块；`web/src/api.js` 加 5 个方法 | `web/src/**` | L |
| T8 | 测试：`server/test/system-notify.test.js`（AC-1～AC-12 至少 12 项）、`push-units.test.js` 迁移、`api-surface.test.js` 加新端点 | `server/test/**` | M |
| T9 | 文档：`docs/API.md` 增补新端点（实施后）、`docs/CHANGELOG.md`、`docs/ARCHITECTURE.md` §2 补 `channels.json`、本文状态改「已实施」 | `docs/**` | S |

顺序：T1 → T2 → T3 →（T4 → T5 可并行）→ T6 → T7 → T8 → T9。T7 必须在 T5 之后（接口形态先定）。

---

## 13. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 迁移把错误任务的渠道复制过来 | 只复制"首个启用"的；设置页一次性提示来源，用户可一键清空外部渠道 |
| 并行发送导致第三方限流 | 最多 10 条渠道、总上限 30 秒；失败不计入重试，等明天 |
| `lastSentDate` 先发后写，进程被杀导致重发 | 接受（漏发更糟）；正文含日期，重复可见 |
| 旧前端仍调 `targetFlowIds` | 兼容期保留读取，不写入；前端同版本上线 |
| 汇总正文含任务名，引发新的"身份"误解 | 正文只写"任务名：状态"，标题与来源恒为系统；`AC-3` 守 |
| 回滚 | 关闭 `dailySummary.enabled` 即停用；`channels.json` 可整文件删除（不影响任务）；旧端点保留一个版本 |

---

## 14. 未决（实施前需产品确认，默认按括号内执行）

1. **收件人**：现在只有站内通知落给所有能看站内消息的人（含非 admin）。是否只让 admin 看到「每日汇总」站内消息？（默认：**不按角色过滤**，站内消息一律可见，避免改通知模型。）
2. **面板链接**：是否为此加一个 `publicBaseUrl` 设置项（涉及"可被外网访问的地址"这类配置）？（默认：**不加**，本期省略该行。）

---

## 15. 与其它文档的关系

| 文档 | 关系 |
|---|---|
| `docs/PRD.md` | 产品决策唯一事实源；本需求作为 §9 候选落地后回写状态 |
| `docs/ARCHITECTURE.md` | 实施后补：`channels.json` 加入数据模型、系统通知独立于任务写入不变量说明 |
| `docs/API.md` | 已同步 5 个端点与旧端点兼容说明 |
| `docs/UI-STANDARDS.md` | 设置页两块布局与文案规则按它执行 |
| `docs/TEMPLATE-MARKET.md` | 无关 |

---

## 16. 实施记录

- **T1–T3**：`secret.js` 提供 `encryptChannels / decryptChannels / maskChannels`，任务渠道复用同一实现；`store.js` 新增 `channels.json`（与 flows 同密钥 AES-256-GCM，内存明文、落盘密文），`getSystemChannels / setSystemChannels / maskedSystemChannels`、`statsForRange()` 与首次启动迁移（`migratedFrom / migratedAt`，已有 `channels.json` 则跳过）。
- **T4–T6**：`buildDailySummaryText()` 与 `sendDailySummary(mode)` 在 `api.js`；守卫依次为 `duplicate → in-flight → empty`；并行发送全部系统渠道，外部失败写「汇总推送失败」；`runner.catchUpDailySummary()` 由 `startServer` 在 30 秒后调用一次，`scheduler.#syncDailySummary` 保持读同一配置键。
- **T7**：新增 `web/src/channel-fields.js`（12 类字段表，任务/系统渠道共用）与 `flow-list/system-notify.jsx`；设置页「通知与推送」只剩界面提示 + 系统通知两块，旧「推送单位」已删除。
- **T8**：`server/test/system-notify.test.js` 覆盖 AC-1～AC-12 与迁移；`push-units.test.js` 改为验证旧端点兼容与系统渠道解耦；`api-surface.test.js` 覆盖 5 个新端点。
- **备份**：脱敏备份的 `channels` 敏感值为 `***`；完整备份含明文；恢复返回 `channelsIgnored: true`，不导入系统渠道。
