# 快速组装与 AI 助手

> **定位**：这两项都属于"帮用户把第一版流程写出来"的辅助能力，**不是**产品的核心路径。
> **红线**：模型只产出流程草稿，永不直接发起外部请求、永不自动运行、永不接触真实凭据。
> 产品口径见 `docs/PRD.md` §1、§5；接口见 `docs/API.md`。

---

## 1. 快速组装（纯规则，默认路径）

**一句话描述 → 两节点草稿。** 完全在前端运行，零网络请求、零 API 消耗，离线可用。

| 项 | 实现 |
|---|---|
| 输入解析 | `web/src/components/flow-list/wizard-logic.js` 的 `parseNatural(text)`：正则抽取 URL、方法（出现 `POST` 即 POST）、成功词（"看到…算成功"/"成功词：…"）、事件类型（签到 / 抽卡 / 库存监控 / 信息查询） |
| 生成 | `buildWizardFlow({url, method, keyword, eventLabel})`：`http` 节点（带 UA 头、可选关键字断言）+ `log` 节点（`{{eventLabel}}完成：{{last.status}}`） |
| 默认值 | `cron: '0 8 * * *'`、`enabled: false` |
| 共用 | 同一份纯逻辑被组件与 `server/test/wizard.test.js` 共用（避免前后端分叉） |

**它擅长**：单步查询、单步签到、URL 明确且结果可用一句话描述的场景。
**它不擅长**：多步链路（登录 → 取 token → 签到）、需要 POST body、需要变量引用、需要循环。

> 失败处理：解析不出 URL 时就地提示"没识别到地址，请直接填 URL"，不生成空流程。

---

## 2. AI 助手（可选，BYO Key）

**用户自带 OpenAI 兼容端点**（DeepSeek / OpenAI / Ollama 等），不内置供应商、不代付费用。

| 端点 | 权限 | 行为 |
|---|---|---|
| `GET /api/system/ai` | 登录用户 | 返回 `configured`、`baseUrl`、`model`、`timeoutSec`、`maxTokens`、`hasKey`；`apiKey` 只回显前缀（`sk-abc…`），永不返回明文 |
| `PUT /api/system/ai` | **仅 admin** | 保存 `{baseUrl, apiKey, model, timeoutSec?, maxTokens?}`；`baseUrl` 仅 http(s)，自动去尾 `/`，兼容 `.../v1` 与 `.../v1/chat/completions`；`model` 必填；`timeoutSec` 5–120（默认 60）、`maxTokens` 1–4096（默认 1024）；传打码占位时保留旧 Key，三个字段全空=清空；审计 `ai.config.save` |
| `POST /api/ai/test` | **仅 admin** | 用已保存配置发一条「只回复 ok」的最小请求 → `{ ok, latencyMs, model, sample, usage }`；body 可带 `{ timeoutSec }`（1–120）仅本次覆盖；401/404/超时/非 JSON 返回中文错误；审计 `ai.test` |
| `POST /api/ai/generate` | 登录用户（API Key 需 `write` 作用域） | 代理调用 `POST {baseUrl}/chat/completions`，超时读配置（默认 60s），`max_tokens` 读配置（默认 1024）；30 次/分钟；审计 `ai.generate`（只记输入长度/结果，不记 prompt） |

生成前，CheckQ 在本地检查描述。发现常见凭据字段、带认证信息的 URL、当前模型密钥或已保存的敏感任务变量值时，返回 400，模型端点不会收到请求。检测依赖凭据格式和已知值。描述只填写任务动作、目标和成功条件，凭据在 CheckQ 内配置。

**服务端结构校验（任何 AI 产物都必须过）**

1. 输出必须是 JSON（自动剥离 Markdown 代码围栏）；
2. 节点类型仅限 `http / log / set / delay`，节点数 ≤ 6，节点 id 唯一；
3. `edges` 的 source/target 必须存在于 nodes，自环/重复/悬空引用直接丢弃（最多 8 条）；
4. `cron` 只接受 5 段或空串；
5. 必须含一个合法 `http` 节点，URL 为绝对 `http(s)`；
6. 过滤 `__proto__ / constructor / prototype` 等危险键，防原型污染；
7. 统一补齐 `timezone: Asia/Shanghai`、`enabled: false`、`vars: {}`；
8. 校验失败 → 返回可读中文错误，**不落库**；错误文案不含 Key。

**超时与错误**

| 场景 | 返回 |
|---|---|
| 未配置 | 400「未配置 AI：请先填写 Base URL / API Key / 模型并保存」 |
| 上游 401 | 502「LLM 接口错误 401（API Key 无效或未授权）」 |
| 上游 404 | 502「…404（接口地址不存在，请确认 Base URL 是否指向 OpenAI 兼容的 /v1）」 |
| 超时 | 504「AI 接口超时（N 秒未响应）」 |
| 返回非 JSON | 502「LLM 返回的不是 JSON（请检查 Base URL…）」 |
| 模型端点返回重定向 | 502，提示配置最终 Base URL |
| 调用过频 | 429「AI 调用过于频繁（每分钟最多 30 次）」 |

测试连接和生成流程只请求配置的模型端点。模型服务返回 HTTP 错误时，CheckQ 使用状态码生成提示，API 回包与审计均省略上游错误正文。生成成功的审计记录模型、输入长度与草稿规模。

**用户流程**：一句话 →「AI 生成流程」→ 预览（名称 / 节点数 / cron / 节点链）→「用 AI 结果创建」→ 落库为**停用**任务。

**降级**：未配置、超时、返回非法结构 → 明确中文提示，规则模式始终可用（不因 AI 失败而阻塞建流程）。

---

## 3. 已知边界与风险

| 项 | 现状 | 处理 |
|---|---|---|
| Key 存储 | 存于 `meta.json`，通过 `encryptMeta/decryptMeta` 使用 AES-256-GCM 加密，内存解密、响应打码 | 已交付；回归覆盖见 `server/test/credential-meta.test.js` 与 `server/test/ai.test.js` |
| 模型幻觉 | 可能生成不存在的域名或错误方法 | 服务端结构校验 + 用户确认预览 + 任务默认停用 |
| 提示注入 | 当前只接收用户一句话，不接收页面内容，注入面很小 | 若未来把响应体喂给模型，必须先做隔离与白名单，并单独评审 |
| 数据外发 | 只有用户主动点「AI 生成」才会把**那句话**发给其自配端点 | 界面明确提示；不做后台调用 |
| 费用 | 由用户自己的 Key 承担 | 不做默认供应商、不做代付 |

---

## 4. 本期（v0.5）的取舍

- **做**：保持现状；AI 只做"草稿生成"，不进入诊断、不改流程、不自动运行。
- **不做**：对话式编排面板（ChatPanel）、日志解释、自动修复。
- **为什么**：P0-3 的诊断必须可复现、可回放、离线可用；用模型解释日志会让结论不可验证，也会把用户日志外发给第三方。

> 若未来要做"AI 解释日志"，前置条件是：用户显式开启、每次发送可预览、脱敏后发送、结果标注"仅供参考"且不产生动作按钮。

---

## 5. 未来方向（不进本期）

| 方向 | 价值 | 进入条件 |
|---|---|---|
| 模板生成 | 从一句描述产出多步链路草稿 | 规则版已覆盖 80% 单步场景后 |
| 对话式编排 | 多轮改流程（`flow_get → flow_update → flow_run → 读日志`） | MCP 已能满足外部 Agent，先看真实需求 |
| 日志解释 | 把"看不懂"变成"看得懂" | 诊断规则覆盖率稳定后，且满足 §4 的隐私前置 |

---

## 6. 维护提示

- 改动快速组装逻辑时，同时更新 `wizard-logic.js` 与 `server/test/wizard.test.js`（共用一份逻辑，禁止复制）。
- 改动 AI 接口（权限/超时/配置项/结构收敛）时，同时更新 `server/src/openapi.js`、`docs/API.md` 与 `server/test/ai.test.js`。
- 改动 AI 校验白名单时，同时更新本文与 `docs/PRD.md` §5 的相关验收。
- Key 的加密方案落地后，必须回头修改本文 §3 的"明文"描述，并补一条回归测试。
