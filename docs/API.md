# CheckQ REST API — AI-ready 参考

> 本文面向 Agent / MCP / 外部脚本。所有端点相对基址 `http://<host>:<port>`（服务端默认监听 `8888`；仓库提供的 docker-compose 映射到宿主 `18888`）。
> 鉴权二选一：**Cookie Session**（`POST /api/login`）或 **X-API-Key**（设置页生成，或 `POST /api/system/apikeys`）。
> Content-Type: `application/json`。所有响应 JSON；错误统一 `{ error: string }` + HTTP 状态码。


## 0. 开放 API（给外部 Agent / 集成）

| 项 | 值 |
|---|---|
| 基址 | `http://<host>:8888`（服务端默认）；本地测试用 `docker-compose.yml` 时宿主映射为 `18888:8888`，示例 URL 里的 `checkq.local:18888` 即指该映射 |
| 接口索引 | `GET /api`（免登录，返回认证方式与端点清单） |
| 机器可读描述 | `GET /api/openapi.json`（OpenAPI 3.1，Agent 可自动生成客户端） |
| 认证 | ① `x-api-key: <key>`（推荐）② 会话 Cookie `qsid` |
| Key 生成 | 设置 → API Key（可命名、选作用域、设回收日期；明文只显示一次） |
| 作用域 | `read` 查看 / `run` 运行任务 / `write` 改配置 / `secrets` 读明文凭据；权限不足返回 403。旧 Key 未声明作用域时默认 `read/run/write`，**不含 `secrets`** |
| 任务范围 | `flowIds` 指定任务、`groups` 指定分组（两者都填取并集；都为空 = 全部任务）。受限 Key 不能创建/克隆任务或模板，也不能改分组逃逸范围 |
| 回收日期 | 到期自动失效并从列表移除（过期请求返回 401「已过期并被回收」） |
| 限流 | 登录 5 次/10 分钟（IP）+ 8 次/15 分钟（账号）；AI 生成/连接测试 30 次/分钟（每账号或 Key），其余 API 调用无固定限流 |
| IP 名单 | 每把 Key 可设 **IP 允许名单**（CIDR）；另有**全局 IP 黑名单**（登录与 API Key 同时生效）；名单外返回 403 |

最小示例：

```bash
# 1) 只读 + 可运行 的 Key（面板生成）
curl -H "x-api-key: cq_xxxx" http://checkq.local:8888/api/flows
# 2) 跑一次签到
curl -X POST -H "x-api-key: cq_xxxx" http://checkq.local:8888/api/flows/<id>/run
# 3) 读人话日志（连续多次运行）
curl -H "x-api-key: cq_xxxx" "http://checkq.local:8888/api/flows/<id>/logs?limit=200"
```

完整说明见 `docs/AGENT-ACCESS.md`。

## 1. 鉴权

### POST /api/login
```json
{ "password": "..." }
```
响应：`{ ok: true }` + `Set-Cookie: qsid=...`（7 天有效）。登录失败 5 次/10 分钟 → 429。

### POST /api/logout
清除会话。

### X-API-Key（推荐给 Agent/MCP）
```
X-API-Key: <key>
```
通过 `POST /api/system/apikeys`（需管理员）生成，明文只在创建时返回一次；完整清单见 `GET /api/system/apikeys`。`GET /api/system/settings` 返回 `{ hasApiKey, apiKeys?, userCount }`：`hasApiKey` 对旧版单 Key 或新版多 Key 都为真；`apiKey`（仅前 8 位）只有旧版单 Key 才有，新版为 `null`；管理员另返回 `apiKeys` 数组。

### GET /api/health
```json
{ "ok": true, "version": "<当前版本，取自 server/package.json>" }
```
无需鉴权。版本号不在文档里写死。

## 2. 通用字段

- **Flow**：`{ id, name, note, group, cron, timezone, enabled, pausedAt, pausedReason, jitterMinutes, retry, recovery, vars, nodes, edges, notify, log, tplId, isDemo, createdAt, updatedAt, lastRun, nextRunAt }`（列表摘要额外带 `today: { runs, success, failed, rate }`；`isDemo:true` = 演练任务，不参与市场导出。`pausedAt/pausedReason` 由「连续失败自动停用」写入，`PUT` 时带 `enabled:true` 会清空这两项）
- **Node**：`{ id, type, name, x, y, config }`
- **Retry（任务级失败重试）**：`{ enabled, maxAttempts, backoff: "exponential"|"linear"|"fixed", baseDelayMs, maxDelayMs, jitter }`。一次运行最多尝试 `maxAttempts` 次，**只有最后一次仍失败才判定任务失败**；默认 `{ enabled:true, maxAttempts:3, backoff:"exponential", baseDelayMs:5000, maxDelayMs:300000, jitter:true }`。调试运行（`debugStopId`）不重试。
- **Recovery（自动恢复探测）**：`{ enabled, intervalMinutes, maxAttempts, attempts, nextProbeAt, lastProbeAt, lastResult, exhausted }`。默认 `enabled:false`；`intervalMinutes` 收敛到 30–1440，`maxAttempts` 收敛到 1–5。`PUT /api/flows/:id` 只传配置字段即可，运行态由服务端维护。仅对 `enabled:false + pausedAt` 的任务生效；探测静默运行，成功自动启用，失败到上限停止并写站内通知；一次探测只执行一次（不沿用任务级重试）。
- **Log config**：`{ level: "all"|"failure"|"summary", record: "all"|"log"|"log-final", include: {reqHeaders,reqBody,resBody,varsSnapshot}, resBodyLimit, keywords: [{name,regex,from,into,stepId,negate}] }`
- **Run**：`{ id, flowId, trigger, queuedAt, startedAt, finishedAt, status, durationMs, summary, vars, logs, finalMessage, attempts, attempt, maxAttempts, paused, notify, recovered, recovery, cancelled, timedOut, interrupted }`。`status` 为 `queued|running|success|failed|cancelled`。超时为 `failed` + `timedOut:true`，重启中断为 `failed` + `interrupted:true`，人工取消为 `cancelled` + `cancelled:true`。重启对账只更新历史，不执行原任务；`trigger` 为 `manual|cron|debug|probe`；`attempts[]` 每项 `{ attempt, startedAt, durationMs, ok, message, nextDelayMs? }`；`paused:true` 表示这次失败同时触发了自动停用；`notify` = `{ total, ok, failed: [{ type, error }] }`（通知渠道发送结果，未配置通知时不出现）；取消的运行不触发自动停用与任务通知；`trigger='probe'` 时 `recovered:true` 表示探测成功并重新启用，`recovery` = `{ attempt, maxAttempts, outcome, exhausted }`，且不产生 `notify`。
- **StepLog**：`{ stepId, index, name, type, ok, message, ms, missing, asserts, keywords, detail }`；`detail` 对 http 步骤是 `{ method, url, headers, body, attempt, proxy, jar, response: { status, headers, setCookie, body, ms } }`；失败步骤额外带 `errorType: "network"|"assert"|"engine"`。
- **Diagnosis（可解释失败）**：失败运行在 `run.diagnosis`，形如 `{ rule, cause, confidence: "high"|"medium"|"low", evidence: [{ label, value }], actions: [{ type, label, stepId?, vars? }] }`。`actions[].type` 只在 `show-response / edit-vars / edit-assert / copy-issue` 白名单里；文案不含"可能/也许/大概"这类猜测词（`server/test/diagnose.test.js` 会拦）。
- **Structure（结构可见）**：`GET /api/flows/:id` 额外返回 `structure`，形如 `{ ok, entries, entryId, issues: [{ id, kind, level, message, nodeId?, handle? }], exits: [{ nodeId, type, handle, label, connected, target }], loops: [{ foreachId, nodeIds, closed }], orphans, counts }`。`kind` 见 `no-entry / multi-entry / orphan / dangling / unknown-type / loop-cycle / loop-large`；`level` 为 `error|warn|info`。**只是描述，不改引擎语义**。

## 3. 运行时开关

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8888` | 服务端口 |
| `DATA_DIR` | `/data` | 数据目录（JSON 文件与 `.secret`） |
| `ADMIN_PASSWORD` | 首次随机 | 仅首次建库时用；之后在设置页改 |
| `CHECKQ_SECRET` | 自动生成 | 凭据加密密钥；已有数据不要更换 |
| `CHECKQ_MAX_CONCURRENCY` | `4` | 同时执行的任务数上限（1–16） |
| `CHECKQ_RUN_TIMEOUT_MS` | `1800000` | 单次运行的整体超时（60 秒–24 小时）；请求体可用 `timeoutMs` 为单次运行覆盖 |
| `CHECKQ_DEMO` | 开启 | `0` 关闭演练场 |

## 4. 端点清单
### 系统
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康 |
| GET | /api/system/settings | `{ hasApiKey, apiKey }` |
| POST | /api/system/password | `{ oldPassword, newPassword }` |
| POST | /api/system/apikey | 生成/重新生成 API Key，返回 `{ apiKey }` |
| GET | /api/system/stats | `{ flows, enabledScheduled, templates, todayRuns, todaySuccess, todayFailed, successRate, nextRunAt, nextFlowName, runningFlowIds, queuedFlowIds, queuedFlows, queueCount, runningCount, maxConcurrency, globalWaiting, dailySummary, unreadNotifications }`。今日按服务器本地日期和运行开始时间统计，已取消计入总数，排队中与运行中单独统计。 |
| GET | /api/system/ai | AI 助手配置（任意登录用户）：`{ configured, baseUrl, model, apiKey(打码前缀…), hasKey, timeoutSec, maxTokens }`；API Key 永不回显明文 |
| PUT | /api/system/ai | 保存 AI 配置（**仅 admin**）：`{ baseUrl, apiKey, model, timeoutSec?, maxTokens? }`。`baseUrl` 仅 http(s)，自动去尾 `/` 并兼容 `.../v1` 与 `.../v1/chat/completions`；`timeoutSec` 5–120（默认 60）、`maxTokens` 1–4096（默认 1024）；`model` 必填；`apiKey` 传空或打码占位保留旧 Key，三个字段全空=清空配置；审计 `ai.config.save`（不记 Key） |
| POST | /api/ai/test | 测试连接（**仅 admin**）：用已保存配置发一条最小请求，body 可带 `{ timeoutSec }`（1–120，仅本次覆盖）→ `{ ok, latencyMs, model, sample, usage }`。上游 401/404/超时/非 JSON 返回中文 `error`（已脱敏，不含 Key）；审计 `ai.test` |
| POST | /api/ai/generate | `{ sentence }` → `{ draft }`。登录用户可用，API Key 需 `write` 作用域；≤6 节点、`edges` 只保留 source/target 都存在且去重后的连线、`cron` 仅 5 段或空、过滤 `__proto__/constructor/prototype`，草稿固定 `enabled:false`、`vars:{}`；超时读配置；审计 `ai.generate`（只记输入长度/结果，不记 prompt） |
| GET/PUT | /api/system/daily-summary-config | 每日汇总定时配置（兼容一版；`targetFlowIds` 只读，不再写入；新代码用 `/api/system/notify`） |
| GET/PUT | /api/system/notify | 系统通知设置：`{ daily, channels, migratedFrom, lastResult }`；GET 任意登录用户，PUT 需 admin；`channels` 含内置 `inbox`，外部渠道最多 10 条 |
| POST | /api/system/notify/preview | `{ date? }` → `{ text, window, counts, skipped? }`（任意登录用户） |
| POST | /api/system/notify/test | `{ channelId? }` 测试发送（admin，正文前缀「（测试）」） |
| POST | /api/system/notify/send | `{ date?, dryRun? }` 立即发送（admin；跳过空日与幂等，不写 `lastSentDate`） |
| GET | /api/notifications?limit= | 站内通知列表 `{ items, unread, total }` |
| POST | /api/notifications/read | 标记已读，返回 `{ ok, updated }`。省略 `ids` 或传 `{}` 标记全部，`ids: []` 不修改。`ids` 必须为非空字符串组成的数组。重复或不存在的 ID 不计入 `updated`。参数无效返回 400，保存失败返回 500 并保留原状态。 |
| DELETE | /api/notifications | 清空站内通知 |
| POST | /api/system/daily-summary | 兼容一版：带 `{ flowId }`/`{ flowIds }` 时按任务渠道发送；无 body 走系统通知立即发送 |
| GET | /api/system/backup | 导出脱敏备份（flows/runs/templates/channels，敏感凭据置 `***`） |
| POST | /api/system/backup | 导出完整备份（需 `{ password }` 校验当前密码，含明文凭据与系统渠道） |
| POST | /api/system/restore | 从备份导入（flows/templates 以新 ID 创建、默认停用；不恢复 runs 与系统渠道，返回 `channelsIgnored: true`） |
| GET/PUT | /api/system/ui | 界面偏好（提示级别 toastLevel） |
| GET/POST | /api/system/bootstrap | 首次启动初始化：查询是否需要建管理员 / 创建首个管理员账号 |
| GET | /api/system/push-targets | 兼容一版：系统渠道摘要 `[{ id, type, title, enabled }]`（不再返回任务） |
| GET | /api/flows/:id/logs | 连续日志流。使用 `limit`（20–2000）和 `before` 翻页。`entries` 与 `runs` 摘要含 `diagnosis`。普通运行整组返回，超长运行分段返回。 |

### 任务 (Flows)
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/flows | 列表（摘要：id/name/note/group/cron/timezone/enabled/pausedAt/pausedReason/jitterMinutes/retry/varsCount/nodesCount/tplId/template/lastRun/today/nextRunAt）。`template` = `{ id, name }` —— 来源模板；派生任务的流程图始终是模板当前版本；`today` = `{ runs, success, failed, rate }` |
| POST | /api/flows | 创建（body = Flow 对象；空 nodes 允许，仅草稿；显式 `enabled:true` 且给了 cron 时按请求启用） |
| GET | /api/flows/:id | 详情（含 nodes/edges/vars/log/notify/template/structure；派生任务返回的是模板当前流程） |
| PUT | /api/flows/:id | 更新（部分字段合并）。派生任务改了脚本内容 → 自动转为独立任务，返回体 `detached` = 模板名 |
| DELETE | /api/flows/:id | 删除 |
| POST | /api/flows/:id/run | `{ stream?: bool, debugStopId?, debug?, dedupe?, timeoutMs? }` 运行；stream=true → SSE（start/log/done，`start` 带 `runId`）。`dedupe:true` 时若该任务已有一次运行在跑，直接返回 `{ ok:true, deduped:true, queued:true, message:"已在运行，本次未重复提交" }`（HTTP 200，不走 SSE）。运行一开始就写入 `queued` 记录，排队与执行中都能在运行历史里看到。失败按 `flow.retry` 自动退避重试，跑满次数才最终失败；调度触发时若上一次运行/重试尚未结束则跳过这一拍。调度触发（`cron`/`schedule`）跑满仍失败 → 自动停用该任务调度（`enabled:false` + `pausedAt/pausedReason`），该次 `run.paused=true` 且结论带「（已自动停用调度）」。整体超时默认 30 分钟，可用 `timeoutMs` 或 `CHECKQ_RUN_TIMEOUT_MS` 调整。 |
| POST | /api/flows/:id/clone | 克隆为「·副本 N」，enabled:false |
| POST | /api/flows/:id/curl | 生成等价 curl 命令（变量代入） |
| POST | /api/flows/batch | `{ action: run\|enable\|disable\|delete\|set-group, ids: [], group?, wait? }`。`set-group` 的空分组表示移出分组。`run` 默认等待最终结果。传 `wait: false` 时按提交结果返回，至少一项提交成功则为 HTTP 202。`ok` 和 `failed` 统计提交成功和失败的项数，接收项附 `runId` 和提交时的 `status: 'queued'`，可用 `GET /api/runs/:id` 查询当前状态与结果。 |
| POST | /api/flows/:id/notify-test | 测试通知渠道 |

### 运行记录
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/runs?flowId=&limit= | 列表（默认 limit 30，上限 200） |
| GET | /api/runs/:id | 单条详情（完整 logs） |
| POST | /api/runs/:id/cancel | 取消排队中或运行中的此次运行；非 `queued/running` 返回 409。排队取消会立即移出队列，原运行请求会返回取消结果。运行中取消会中断 HTTP/curl、delay、节点重试和任务级退避。状态写 `cancelled`，不触发自动停用与任务通知 |
| GET | /api/runs/:id/har | 导出单次运行的 HAR（默认脱敏；响应体沿用日志截断） |

### 模板
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/templates | 列表（含 `updatedAt` 版本号与派生任务数 `taskCount`） |
| POST | /api/templates | 新建模板（body = 完整模板 JSON：`name, desc, vars, varNames, nodes, edges, log, notify`） |
| POST | /api/templates/from-flow/:flowId | 从已有流程另存为模板 `{ name?, desc? }` |
| GET | /api/templates/:id | 详情 |
| PUT | /api/templates/:id | 更新 —— 派生任务的流程图 / 日志配置立刻跟随；通知渠道在创建任务时复制，之后各任务独立维护（无需同步动作） |
| DELETE | /api/templates/:id | 删除（派生任务保留最后一份流程，照常可跑） |
| POST | /api/templates/:id/instantiate | `{ vars? }` 实例化为任务（任务 = 模板 + 自己的参数） |
| POST | /api/templates/:id/instantiate-csv | CSV 批量实例化 |
| GET | /api/templates/:id/export | 导出 JSON |
| POST | /api/templates/from-url | 从 URL 导入模板索引（旧单模板通道；批量订阅走 `### 模板市场 v1`） |

### 演练场（P0-1，本机内置，无外部依赖）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/system/features | `{ demo: bool, version }` —— 演练场是否可用（`CHECKQ_DEMO=0` 可关） |
| POST | /api/demo/flow | `{ origin? }` → 创建或复用一条「演练任务」（只含本机演示地址，`isDemo:true`；origin 只接受与请求同 host） |
| GET | /api/demo/profile | 演示站点：个人资料（需要演示会话） |
| POST | /api/demo/checkin | 演示站点：签到 `{ user }` → `{ code, message }`；mode 支持 `ok\|login\|risk\|slow` |
| GET | /api/demo/items | 演示站点：列表（`foreach` 用） |
| POST | /api/demo/reset | 演示站点：清空内存状态（1 小时 TTL、60 次/分钟/IP） |

### 度量与本地事件（P0-6，只算本机、不外传）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/system/metrics?days=7 | `{ window:{runs,success,failed,rate}, daily[], firstRun:{samples,medianMinutes,p90Minutes}, repair:{samples,medianMinutes}, template:{templates,derivedTasks,avgDerived}, topFlows[], totals, localOnly:true }` |
| GET | /api/system/events | 本地事件计数 `{ events: { wizard_open: n, … } }`（只存 meta.json，不随备份导出） |
| POST | /api/system/events | `{ name }`，白名单：`wizard_open / pick_apply / diag_action / guide_step / run_quick`，其它名字 400 |

### 模板市场 v1（P0-5，索引协议见 `TEMPLATE-MARKET.md`）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/market/subscriptions | 已订阅索引 `{ items: [{ url, name, addedAt, lastCheckedAt, seenCount, count }] }` |
| GET | /api/market/index?url= | 解析索引 → `{ url, name, updatedAt, entries: [预览], newCount, subscribed, localTemplates }`；version≠1 / 超 500 条 / 缺 sha256 → 400 |
| POST | /api/market/preview | `{ url, id }` → `{ entry, template, varsCleared, hashOk, sha256, hasScript }`；服务端重算 sha256，不符直接 400 |
| POST | /api/market/import | `{ url, id, mode?: overwrite\|copy }` → `{ id, name, replaced, missingVars, varsCleared, hasScript }`；同一 sourceId 已存在且未指定 mode → 409 `{ error, conflict }` |
| POST | /api/market/subscribe | `{ url }` 订阅索引（须 http/https，且先校验一遍索引） |
| DELETE | /api/market/subscribe?url= | 取消订阅 |
| POST | /api/market/ack | `{ url, count }` 记「已看到 N 条」，之后不再重复提示新增 |

### 导入
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/import/curl | `{ command: "curl ..." }` → `{ config }`（单个 http 节点配置） |
| POST | /api/import/har | HAR 导入 |

### 其他
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/cookie-capture | 浏览器登录抓 Cookie 回填 |
| POST | /api/browser-login/start | 启动浏览器登录 |
| POST | /api/browser-login/capture | 捕获 Cookie |

## 5. SSE 运行协议

`POST /api/flows/:id/run` with `{ "stream": true }`：
```
event: start
data: {"flowId":"...","flowName":"...","runId":"...","queued":false,"startedAt":1730000000000}

event: log
data: { "index":1, "name":"...", "type":"http", "ok":true, "message":"...", "ms":120, ... }

event: done
data: { "id":"run-xxx", "status":"success", "durationMs":..., "summary":"...", "logs":[...], "vars":{...} }
```
`status` 可能是 `success | failed | cancelled`；超时是 `failed` + `timedOut:true`，人工取消是 `cancelled` + `cancelled:true`。


### 账号 / Agent 接入
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/me | 当前登录身份（用户名/角色/是否启用 2FA） |
| PUT | /api/system/account | 修改自己的用户名 / 显示名（改用户名需当前密码，改完强制重登） |
| POST | /api/system/password | 修改自己的密码（需旧密码，改后其它会话失效） |
| GET | /api/system/sessions | 我的会话列表 |
| DELETE | /api/system/sessions/:id | 吊销某个会话 |
| POST | /api/system/logout-all | 退出所有设备 |
| GET | /api/system/users | 用户列表（管理员） |
| POST | /api/system/users | 新建用户（管理员） |
| PUT | /api/system/users/:id | 改角色 / 停用（管理员） |
| POST | /api/system/users/:id/password | 重置他人密码（管理员） |
| DELETE | /api/system/users/:id | 删除用户（管理员） |
| POST | /api/system/users/:id/2fa/reset | 重置他人 2FA（管理员） |
| POST | /api/system/2fa/enroll | 开始绑定两步验证（需密码） |
| POST | /api/system/2fa/confirm | 确认绑定（校验验证码，返回恢复码） |
| POST | /api/system/2fa/disable | 关闭两步验证（需密码 + 验证码） |
| POST | /api/system/2fa/recovery-codes | 重新生成恢复码 |
| GET | /api/system/audit | 审计日志（管理员） |
| GET | /api/system/apikeys | API Key 列表（含作用域） |
| POST | /api/system/apikeys | 生成 API Key（可指定 scopes: read/run/write） |
| DELETE | /api/system/apikeys/:id | 吊销 API Key |
| PUT | /api/system/apikeys/:id | 改 Key（scopes / allowedIps / expiresAt / name） |
| GET | /api/system/ip-blocklist | 全局 IP 黑名单（管理员） |
| PUT | /api/system/ip-blocklist | 加入黑名单（body: { ip }，支持 CIDR） |
| DELETE | /api/system/ip-blocklist/:ip | 移出黑名单 |

### 推送与备份
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/system/push-targets | 兼容一版：系统渠道摘要 `[{ id, type, title, enabled }]` |
| GET | /api/flows/:id/logs | 连续日志流。每页最多返回 60 条运行摘要，零步骤运行也占一个摘要。若 `hasMore` 为真，请原样传回 `nextBefore` 作为 `before`。旧版运行 ID 游标仍可使用。 |
| GET | /api/system/backup | 脱敏备份（凭据已清空） |
| POST | /api/system/backup | 完整备份（需当前密码，含明文凭据） |

超长运行从末段开始返回，每段内的日志仍按执行顺序排列。客户端跨页合并时，可按 `runId` 分组，并用 `position` 排序。若游标指向已清理的运行，接口返回空页，`hasMore` 为假。

## 6. 节点类型 (10 种)

| type | config 关键字段 |
|---|---|
| http | method, url, headers[{name,value,enabled}], body, timeout(秒), backend(fetch\|curl), charset, proxy{url}, retry{times,backoffMs,retryOn}, asserts[], maxRespBytes（默认 2MB，最小 64KB，上限 8MB；超限立即中断） |
| condition | expr (jexl) |
| set | name, value |
| extract | mode(json\|header\|setCookie), path, name, optional |
| delay | seconds |
| random-delay | min, max |
| log | text (支持 `{{var}}` / `{{last.status}}`) |
| notify | text, webhookUrl?, tgToken? + tgChat?, barkUrl? |
| script | code（JS 隔离沙箱，vars/last/steps 可读；独立子进程：64MB 内存、1s 执行、64KB 脚本、256KB 结果） |
| foreach | source, itemVar, indexVar |

断言 asserts：`{ res: [regex], from: "content"|"status", negate }` 或 `{ expr, expect }`。

### 通知渠道（flow.notify.channels[]，12 种）
| type | 关键字段 |
|---|---|
| inbox | title（站内通知，无需外部服务） |
| webhook | url |
| bark | url, title, group |
| telegram | token, chat |
| serverchan | key, title |
| pushplus | token, title |
| dingtalk | url, secret?, title |
| wecom | url |
| feishu | url, secret? |
| gotify | url, token, priority |
| ntfy | url, topic, priority |
| email | host, port, user, pass, from, to, subject |

## 7. 模板变量语法

`{{var}}`、过滤器 `{{x|urlencode}}`、函数 `timestamp` / `now:%Y-%m-%d`、jexl 表达式 `{{last.json.code == 0}}`。

## 8. 错误码

| HTTP | 含义 |
|---|---|
| 400 | 参数/校验失败（validateFlow、空流程等） |
| 401 | 未登录 / API Key 无效 |
| 404 | 资源不存在 |
| 429 | 登录防爆破（5 次/10 分钟） |
| 500 | 引擎异常（成环、节点类型未知等） |

## 9. Agent 调用最小示例

```bash
# 1. 生成 API Key（先用密码登录一次）
curl -s -c cq.txt -X POST http://host:8888/api/login -H 'Content-Type: application/json' -d '{"password":"..."}'
curl -s -b cq.txt -X POST http://host:8888/api/system/apikeys -H 'Content-Type: application/json' -d '{"name":"agent","scopes":["read","run"]}'

# 2. 用 Key 跑任务
curl -s -H 'X-API-Key: <key>' http://host:8888/api/flows
curl -s -H 'X-API-Key: <key>' -X POST http://host:8888/api/flows/<id>/run
```
