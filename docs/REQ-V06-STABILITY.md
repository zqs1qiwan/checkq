# 0.6.0 稳定与安全迭代（实施依据）

> 状态：已实施。范围来自 `docs/PRD.md` §9.3「v0.6 可复用」的前置欠账，优先稳定核心执行链，不铺账号中心等大改。

## 1. 为什么这一版先做这些

v0.5.3 把每日汇总独立出来之后，剩余风险集中在三条核心链路上：

1. **凭据落盘不一致**：flows/templates/channels 已加密，`meta.ai.apiKey` 与旧 `meta.apiKey` 仍是明文；初始密码还曾被写进 `meta.json`。
2. **通知实现重复且无超时**：`api.js` 维护 12 类渠道，`engine.js` 的「通知」节点另有一套 webhook/telegram/bark，且 fetch 没有超时；新增渠道要改两处，失败也可能静默。
3. **跨任务并发无上限**：同任务已串行，但多个任务同时到点会一起执行，排期洪峰可能打满出口或拖慢整个实例。

这三点都属于核心稳定性/安全，不属于“附加功能”，因此先做。

## 2. 非目标（本版不做）

- 账号 / 凭据中心（一模板 N 账号）
- 任务取消、流级超时、熔断面板
- 飞书/钉钉卡片消息
- 市场分页、MCP 新工具
- 含脚本模板首次运行阻断确认

## 3. 设计

### 3.1 凭据加密补全

- `secret.js` 增加 `encryptMeta/decryptMeta`：只处理 `meta.ai.apiKey` 与 `meta.apiKey`。
- `store.js` 载入 `meta.json` 时解密，`#flushNow()`、首次初始化写盘时加密。
- 旧明文兼容：`decryptValue` 对非 `enc:v1:` 原样返回，下一次 flush 自然升级为密文。
- 初始密码不再写入 `meta`，只在启动日志打印一次。

### 3.2 统一通知出口

- 新增 `server/src/notify.js`：`sendChannel` / `sendToChannels` / `signBotUrl` / `smtpSend`。
- 所有渠道统一 15 秒 `AbortSignal.timeout`；站内通知通过注入的 `inbox(payload)` 回调落库，模块本身不依赖 store。
- `api.js` 只保留一层绑定（注入 `store.addNotification`），删除本地渠道实现与 SMTP/签名代码。
- `engine.js` 的「通知」节点把 webhook/telegram/bark 映射成渠道对象，复用 `sendToChannels`；全部失败仍判节点失败。
- 渠道发送改为并行，结果顺序保持输入顺序。

### 3.3 通知结果可见

- `Run.notify = { total, ok, failed: [{ type, error }] }`，在运行落库后回写。
- 外部渠道全部失败时另写站内通知「任务通知失败」，不依赖用户主动看日志。
- `RunDrawer` 显示「通知：N/M 渠道成功」，失败原因进悬停提示。

### 3.4 全局并发上限

- 新增 `server/src/concurrency.js`：FIFO 限制器，默认 4，范围 1–16。
- `api.js` 在 per-flow 串行队列之后再加全局 `acquire/release`；同任务串行语义不变。
- `CHECKQ_MAX_CONCURRENCY` 可调；`/api/system/stats` 新增 `maxConcurrency`、`globalWaiting`。
- 排队中的任务仍计入 `queueCount`，前端「排队中」状态不变。

## 4. 验收

| # | 验收项 | 方法 |
|---|---|---|
| AC-1 | AI Key 落盘密文、重启后可用 | `server/test/credential-meta.test.js` |
| AC-2 | 旧 API Key 落盘密文 | 同上 |
| AC-3 | 初始密码不落盘 | 同上 |
| AC-4 | 站内通知经统一出口落库 | `server/test/notify-transport.test.js` |
| AC-5 | 未知渠道返回失败而不是静默 | 同上 |
| AC-6 | 并发超过上限时排队，释放后 FIFO 唤醒 | `server/test/concurrency.test.js` |
| AC-7 | 任务通知每条渠道结果写入 run | `server/test/notify.test.js` + 全量测试 |
| AC-8 | 外部渠道全失败写站内告警 | `server/test/notify.test.js` 与手工实例 |
| AC-9 | 既有每日汇总/任务通知行为不回退 | `node --test "server/test/*.test.js"` |
| AC-10 | 构建、文案、秘密扫描、项目一致性、UI 冒烟、交互巡检全绿 | `node tools/verify-round.cjs` |

## 5. 风险与回滚

- 风险：`meta.json` 从明文变密文，旧版本如果直接读会拿到 `enc:v1:`。回滚必须换回本版或先导出凭据；生产升级前备份 `data` 目录。
- 风险：并发上限可能让同时到点的任务稍晚开始（不是失败）；默认 4，单任务实例无感。
- 回滚：镜像回退到上一版，数据目录保留；如只回退代码不换数据，AI 配置会显示为密文，需要重新填写或恢复备份。

## 6. 实施记录

- 代码：`server/src/{secret,store,notify,concurrency,api,engine}.js`；`web/src/components/RunDrawer.jsx`。
- 测试：新增 `credential-meta.test.js`、`notify-transport.test.js`、`concurrency.test.js`；全量 44 项通过。
- 文档：`ARCHITECTURE.md`、`API.md`、`CHANGELOG.md`、`STORAGE-BACKUP.md`、`SECURITY.md`、`PRD.md`。
- 验收：`verify-round` 全绿（构建 / 产物同步 / 44 项单测 / 三审计 / ui-smoke 72 通过 / 交互巡检 0 findings）。
- 生产：`checkq:v0.6.0` 已替换并提交，`checkq:latest` 指向同镜像；升级前数据备份 `data.bak-20261117-0.6.0`，基线回退镜像 `checkq:v0.5.3.bak-20261117`，本次部署前镜像 `checkq:v0.6.0.bak`。生产健康 `{"ok":true,"version":"0.6.0"}`，30 个任务、系统通知配置均保留。
- 已知非阻塞：前端主包 gzip 约 174KB，构建提示单块 >500KB；本轮不做代码分块，避免在稳定版引入打包结构变化。
