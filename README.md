<p align="center"><a href="https://zqs1qiwan.github.io/checkq/"><img src="web/public/brand/checkq-mark.svg" width="76" height="76" alt="CheckQ 标志" /></a></p>

<h1 align="center">CheckQ</h1>

<p align="center"><strong>开源的可视化自动挂机、签到框架。</strong></p>

<p align="center">拖拽积木式搭建 · Docker 一行部署 · HAR / cURL 导入 · 失败可解释 · 日志完整可见</p>

<p align="center"><img src="docs/assets/social-preview.png" width="880" alt="CheckQ — 开源的可视化自动挂机、签到框架" /></p>

CheckQ 是一个零依赖单容器的自动化框架：把每天重复的签到、打卡、查询、监控和上报，做成一条看得见、跑得稳、能复用的流程。浏览器里拖拽积木即可搭建，导入 HAR 自动生成流程；条件分支、变量提取、失败重试全可视化，运行日志完整可见（请求、响应、每一步耗时）。

## 产品方向

CheckQ 是一个**看得见、说得清、拿得走**的开源可视化自动挂机、签到框架：零依赖单容器、流程等于真实执行、失败能给出原因与下一步、模板可复用可分发。

**明确不做**：浏览器渲染与验证码识别、Python/Shell/TypeScript 多语言运行时、集群与多租户。需要这些能力时请用外部服务，本项目不把它们做成内置能力。

- 产品定义、需求与发展路线：`docs/PRD.md`（一页结论在 §0）
- 架构、模块职责与扩展点：`docs/ARCHITECTURE.md`
- 界面与交互金标准：`docs/UI-STANDARDS.md`
- 品牌标志、色彩与资产：`docs/BRAND.md`
- 接口：`docs/API.md` / `docs/MCP.md`；竞品事实：`docs/COMPETITIVE-ANALYSIS.md`


## 📖 文档中心（GitHub Pages）

完整文档站：**<https://zqs1qiwan.github.io/checkq/>**

- 入口：面板顶栏「文档中心」图标 → 文档站（面板不再内置重复引导）
- 站点只讲**框架功能**（不含任何具体签到脚本 —— 那属于模板市场）；`tools/build-wiki.cjs` 从 `docs/` 自动生成，带站内搜索与更新日志（`push` 到 main 时由 `.github/workflows/pages.yml` 自动发布）
- 品牌与标志：`docs/BRAND.md`；GitHub 仓库社交预览图：`docs/assets/social-preview.png`（Settings → Social preview 上传）
- 本地预览：`node tools/build-wiki.cjs` → 打开 `wiki/index.html`
- 本地测试案例（具体站点的流程 / 模板 / 实例笔记）**仅供本地使用**：按 `.gitignore` 与本地 `.git/info/exclude` 留在工作区，不进公开仓库；`secret-scan` / `project-audit` 会在误提交时拦下

> 首次启用需在仓库 **Settings → Pages → Source** 选 **GitHub Actions**（之后每次 push 自动发布）。

## 品牌资产

| 标准标志 | 单色标志 | 浏览器图标 |
| --- | --- | --- |
| <img src="web/public/brand/checkq-mark.svg" width="44" alt="CheckQ 标准标志" /> | <img src="web/public/brand/checkq-mark-mono.svg" width="44" alt="CheckQ 单色标志" /> | <img src="web/public/favicon-32x32.png" width="32" alt="CheckQ favicon" /> |

品牌规范、色值与使用边界见 [`docs/BRAND.md`](docs/BRAND.md)；GitHub 社交预览图见 [`docs/assets/social-preview.png`](docs/assets/social-preview.png)（Settings → Social preview 上传）。

## 特性

- **模板系统** — 调试好的流程一键「存为模板」，列表管理变量名与任务数；从模板创建任务自动克隆节点图，变量（cookie 等）各任务独立填写
- **模板联动** — 派生任务 = 模板 + 各自的参数：模板一改，所有派生任务立刻跟着变（无需任何同步操作）；任务里改了脚本内容会自动转成独立任务
- **积木式流程编辑器** — 类似苹果捷径。HTTP 请求、条件分支、变量赋值、正则提取、延迟、随机延迟、循环（对每一项）、脚本、日志、通知，拖拽连线即成流程
- **点选生成逻辑** — 运行后点击响应中的任意 JSON 值或划选文字，一键生成提取/断言/关键字/通知节点，自动接入流程链尾；生成物是标准节点配置，可继续编辑（见 `docs/PRD.md` §2.1）
- **HAR / cURL 导入** — 浏览器 DevTools 的 HAR、qiandao(QD) 框架模板、cURL 命令均可导入，自动识别生成流程图；QD 模板的 `api://util/delay` 转 delay 节点、`util/unicode|urldecode` 转 log 节点、变量 URL 放行（兼容性实测矩阵见 docs/QIANDAO-COMPAT.md）
- **关键字提取与日志三档** — flow 级配置 keywords 正则规则（如提取标题），每次运行自动汇总到运行摘要；日志按 all / failure / summary 三档记录，记录内容四开关（请求头/请求体/响应体/变量快照）与响应体截断长度可配，编辑器顶栏「日志配置」可编辑；敏感头（cookie/authorization）自动脱敏
- **调度抖动** — 流级 `jitterMinutes`（0-30，编辑器顶栏可设）：cron 触发后随机延迟 0-N 分钟，避免整点风控指纹；模板管理弹窗可编辑默认变量值
- **条件分支** — jexl 表达式，如 `last.json.code == 0`，按响应内容决定走向
- **run 级 Cookie 罐** — 一次运行内响应 Set-Cookie 自动入罐，后续同域请求自动携带（登录→签到链开箱即用），显式 Cookie 头同名键优先，节点可退出
- **函数式模板表达式** — `{{md5("f=1&s="+id)|upper}}`、`{{x|default('兜底')}}`、`{{multiply(timestamp('float'),1000)|int}}`，对齐 QD jinja 常用写法，白名单求值无 eval
- **错误可见** — 每一步的请求、响应、断言结果、耗时全部落日志，失败时直接看到原始响应内容
- **调试** — 编辑器内「调试到此为止」：从头执行到选中节点即停；「单步运行」逐节点验证
- **cron 调度** — 每个流程独立 cron 表达式，支持时区；任务列表直接显示下次运行时间，支持搜索与筛选（全部 / 已启用调度 / 最近失败）
- **账号与安全** — 用户名 + 密码登录（多用户 / admin·operator·viewer 角色）、TOTP 两步验证 + 一次性恢复码、会话可吊销、scrypt 加盐哈希（明文不落盘）、API Key 只存摘要、审计日志
- **通知** — 12 种渠道原生集成（站内 / Webhook / Bark / Telegram / Server酱 / PushPlus / 钉钉 / 企业微信 / 飞书 / Gotify / ntfy / 邮件SMTP），钉钉/飞书支持加签；首页 🔔 站内通知中心
- **模板导出与批量创建** — 模板导出为 JSON（敏感变量脱敏）；CSV 批量导入一键创建多份任务
- **日/夜/自动 主题** — 顶栏三段切换，「自动」跟随系统即时刻切换；批量操作默认收起（列表页「批量管理」按需开启），按钮/标题不再折行压缩
- **任务分组 / 折叠** — 每个任务可归属分组（`group`，留空=未分组）；列表按组折叠，组头显示任务数、启用数、今日成功/失败/成功率、下次调度；大分组默认收起，搜索/筛选时自动展开；支持批量「分组…」一次归入
- **编辑器效率** — 撤销/重做（Ctrl+Z / Ctrl+Y）、节点复制粘贴（Ctrl+C / Ctrl+V，含内部连线）、MiniMap、按连线层级「整理」布局；点击日志步骤 ↔ 画布节点双向定位
- **单次运行导出 HAR** — 运行抽屉一键导出，默认脱敏（cookie/token/密码替换为 `***`），可直接拖进浏览器 DevTools 复现
- **失败自动重试** — 任务级退避重试：默认最多 3 次、指数退避 5 秒起、随机抖动、单次等待上限 5 分钟；**跑满次数仍失败才判定真正失败**，每次尝试与等待时长都写进运行记录、日志与通知。调试运行不重试，调度不会在重试期间重复触发
- **结构可见（v0.5）** — 画布标出每个出口是否接线（未接=空心点，`http` 失败出口未接时节点带「失败未接」角标、连线走虚线）；`foreach` 循环体有虚线容器，流程到 60 个节点时循环体默认折叠，点「展开」逐个放开；「大纲」视图按执行顺序列出步骤；保存后结构有隐患时弹「结构检查」清单——**只提示，不改执行语义**
- **创建入口四分支（v0.5）** — 顶栏「+ 新建」直接给：空白流程 / 从模板 / 导入 HAR·JSON / 导入 cURL；「更多」只留进阶动作
- **可解释失败（v0.5）** — 失败时先给原因与下一步：缺变量 / 凭据失效 / 风控页 / 断言不符 / 网络 / 5xx / 4xx / 引擎 / 未知九条规则，卡片上直接可点「看该步响应 / 改变量 / 调断言 / 复制排障摘要」
- **修改即重跑（v0.5）** — 任务行「运行 ▾」：立即运行 / 带改变量运行 / 只看日志 / 调试运行；改 cookie 这类参数不必进画布，同一任务重复点击自动去重
- **演练场（v0.5）** — 空实例「先演练一遍」：内置本机演示站点，零站点零凭据就能跑通一次成功；之后一键换成自己的站点（`CHECKQ_DEMO=0` 可关）
- **模板市场（v0.5）** — 首页「市场」页签：填索引地址即可订阅、搜索、按标签筛选、预览（变量清单 + 哈希校验 + 含脚本提示）、导入；协议见 `docs/TEMPLATE-MARKET.md`，随包示例 `docs/template-index.example.json`
- **本机统计（v0.5）** — 设置「统计」：近 N 天运行量与成功率、首跑耗时中位/p90、失败后修复耗时、模板复用；只算本机、不外传、不随备份导出
- **稳定与安全（v0.6.0）** — AI 助手 Key 与旧 API Key 落盘加密；12 类通知统一出口、15 秒超时、并行发送；每次运行记录通知成功/失败，外部渠道全失败时站内告警；跨任务并发默认上限 4，排期洪峰不会同时打满出口（`CHECKQ_MAX_CONCURRENCY` 可调）
- **自动恢复探测（v0.6.1）** — 任务因调度失败被自动停用后，可选开启“恢复探测”：按至少 30 分钟的间隔静默重跑，成功自动重新启用，失败最多 5 次后停止并留站内记录；默认关闭，避免失败账号反复触发站点风控
- **现代 Web 原生能力** — 弹窗用原生 `<dialog>`（焦点管理 / Esc / 背景 inert / 顶层渲染），菜单用 Popover API，明暗主题声明 `color-scheme`，表格 sticky 表头 + 容器查询，长日志 `content-visibility`；UI 决策依据 [Modern Web Guidance 1.0](https://developer.chrome.com/docs/modern-web-guidance)
- **基础信息可改** — 点任务名打开任务详情（备注、调度、重试策略、变量、通知渠道…），名字与备注当场就能改；进画布是「更多 → 编辑流程」这样的显式动作
- **下拉不丢** — 所有菜单以浮层渲染并自动避让边界，表格底部那几行的「···」也点得到；弹窗内的菜单挂到该弹窗内部，不会被模态遮罩拦住
- **窄屏不挤** — 小屏顶栏只留「品牌 / 新建 / 更多 / 设置」四个等高控件，主题、通知、文档、身份收进「更多」；工具条左右分组各自不拆散，弹窗显式居中不会贴到左上角
- **文档与护栏齐全** — PRD / API / MCP / 安全 / 存储文档 + 自动生成的纯用户视角文档站；`ui-smoke` / `ui-interaction-audit` / `copy-audit` / `secret-scan` / `project-audit` 五个机械护栏（命中即 exit 1），`verify-round` 串起一轮全量验收
- **单容器部署** — 无原生编译依赖，`docker compose up -d` 即用
- **框架即框架** — 不内置任何业务模板；只会给你一条指向本机演示站点的演练任务。真实模板来自你自己创建 / JSON 导入 / 自填索引订阅（产品定义与路线见 `docs/PRD.md`）

## 快速开始

```bash
mkdir checkq && cd checkq
curl -O https://raw.githubusercontent.com/zqs1qiwan/checkq/main/docker-compose.yml
# 或克隆本仓库后:
docker compose up -d --build
```

```yaml
# docker-compose.yml
services:
  checkq:
    build: .
    ports:
      - "18888:8888"
    environment:
      - ADMIN_PASSWORD=changeme        # 首次登录密码（不设则自动生成并打印到容器日志）
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/data
```

打开 `http://localhost:18888`，新建空白流程拖拽搭建，或导入 HAR / JSON。

> 端口口径：服务端默认监听 **8888**（`server/src/index.js` 的 `PORT||8888`、Dockerfile `EXPOSE 8888`）。上面这份 `docker-compose.yml` 把宿主 **18888** 映射到容器 8888，只是本地测试方便、避开本机已有的 8888；生产直连请用 `docker-compose.prod.yml`（`8888:8888`），访问 `http://localhost:8888`。`tools/deploy-prebuilt.sh` 会依次探测 8888 / 18888，也可用 `CHECKQ_PORT` 显式指定宿主端口。

## 流程步骤类型

| 类型 | 作用 |
|---|---|
| HTTP | 发请求，模板化 URL/头/体，断言成功/失败，保存响应；可选 `fetch` 或 `curl` 执行后端（curl 用于绕开对 Node fetch TLS 指纹的风控） |
| 条件 | jexl 表达式判断，真/假两个分支出口 |
| 赋值 | 文本模板或表达式计算 → 写入变量 |
| 提取 | 正则从响应体/状态码/响应头提取 → 变量 |
| 延迟 | 等待 N 秒 |
| 日志 | 输出信息到运行日志 |
| 通知 | 节点内推送（Webhook / Telegram / Bark）；任务级通知渠道共 12 种，在编辑器「通知渠道」里配置 |

变量模板语法：`{{var}}`、`{{user.email}}`，缺变量渲染为空并在日志记录缺失名。

## API

除 `/api/login`、`/api/health`、`/api`、`/api/openapi.json`、`/api/system/bootstrap`、`/api/me` 外，所有 `/api/*` 需登录 cookie 或 `X-API-Key`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/login | 登录 |
| GET/POST | /api/flows | 列表 / 新建 |
| GET/PUT/DELETE | /api/flows/:id | 详情 / 保存 / 删除 |
| POST | /api/flows/:id/run | 立即运行（可选 `debugStopId` 调试到指定节点） |
| GET | /api/runs?flowId= | 运行历史 |
| GET | /api/runs/:id | 单次运行详情 |
| POST | /api/import/har | HAR/QD 模板导入 → 流程草稿（QD `retry_count/retry_interval` 自动映射为 http 节点 `retry`） |
| POST | /api/import/curl | cURL 命令解析 → HTTP 节点配置 |
| GET/POST | /api/templates | 模板列表 / JSON 导入建模板 |
| GET/PUT/DELETE | /api/templates/:id | 模板详情 / 改名改变量 / 删除（不影响已建任务） |
| POST | /api/templates/from-flow/:flowId | 流程另存为模板（敏感变量脱敏导出） |
| POST | /api/templates/:id/instantiate | 实例化 → 新任务（克隆节点图 + 变量合并） |
| POST | /api/flows/batch | 批量动作 `{ action: run\|enable\|disable\|delete\|set-group, ids }`（CSV 批量建任务见 `/api/templates/:id/instantiate-csv`） |

## 开发

```bash
# server
cd server && npm install && npm run dev
# web (另开终端)
cd web && npm install && npm run dev   # http://localhost:5173，/api 代理到 8888
# 单测
cd server && node test/engine.test.js && node test/engine-v02.test.js && node test/curl-import.test.js && node test/logging.test.js
# 全量单测
cd server && for f in test/*.test.js; do node $f; done
# 前端规范（生成本地 .agents/skills，不入库）
npx modern-web-guidance@latest install
```

质量护栏（都可用本地命令跑，命中即 exit 1）：

| 工具 | 作用 |
|---|---|
| `node tools/ui-smoke.cjs <baseUrl>` | UI 冒烟检查：无依赖 CDP 驱动真实浏览器，按 7 种视口 × 明暗主题逐项体检（横向溢出 / 顶栏重叠 / 图标按钮框 / 下拉菜单被裁 / 弹窗 ✕·Esc·滚动锁·居中 / 页面出现 undefined·NaN / 控制台报错） |
| `node tools/ui-interaction-audit.cjs <baseUrl>` | 全量交互巡检：9 视口 × 明暗主题，逐项核对顶栏单行等高、工具条分组、弹窗居中、设置分区、任务详情、模板页、移动端「更多」、编辑器画布/MiniMap/更多菜单 |
| `node tools/verify-round.cjs <baseUrl>` | 一轮全量验收执行器：构建 → 服务端全量单测 → 3 个审计 → UI 冒烟 → 交互巡检，输出本轮汇总（验收口径见 `docs/PRD.md` §11.2） |
| `node tools/copy-audit.cjs` | 文案金标准审计：无常驻说明性文字、无说明性副标题、label 无括号说明 |
| `node tools/secret-scan.cjs` | 秘密扫描：工作区 + 完整 git 历史的高危凭据 + 仓库内容政策（私有词表本地留存，不入库） |
| `node tools/project-audit.cjs` | 项目一致性：相对 import、文档链接、wiki 页面来源、API 端点、MCP 工具、CSS 契约与陈旧交互说法 |

UI 冒烟检查需要先起一个本地实例（默认 `http://localhost:19998`）：

```bash
cd server && PORT=19998 DATA_DIR=/tmp/cq-ui ADMIN_PASSWORD=test1234 node src/index.js
node tools/ui-smoke.cjs http://localhost:19998
```

技术栈：Fastify / React 18 / @xyflow/react / jexl / croner。零数据库依赖，数据落在 `/data`（flows.json、runs.json、templates.json、meta.json、notifications.json）。

## License

MIT
