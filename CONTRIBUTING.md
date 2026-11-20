# 贡献指南 / Contributing

感谢你愿意改进 CheckQ。本文说明开发环境、验证命令、提交与 PR 流程，以及必须遵守的文案与品牌约束。English version follows the Chinese one.

- 项目目标与架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 界面契约与文案金标准：[docs/UI-STANDARDS.md](docs/UI-STANDARDS.md)
- 品牌与资产：[docs/BRAND.md](docs/BRAND.md)
- 安全边界：[docs/SECURITY.md](docs/SECURITY.md)
- 社区行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 1. 开发环境

| 项 | 要求 |
|---|---|
| Node.js | 22（见 `.nvmrc`；CI 与 Docker 均为 22） |
| 包管理 | npm（仓库含 `server/` 与 `web/` 两份 lockfile，用 `npm ci`） |
| 数据目录 | 本地开发用仓库内 `./data`（已 gitignore）；生产用 `/data` |

```bash
# 服务端（默认 8888）
cd server
npm ci
DATA_DIR=../data ADMIN_PASSWORD='change-me' npm run dev

# 前端（另开终端，http://localhost:5173，/api 代理到 8888）
cd web
npm ci
npm run dev
```

完整构建走 Docker：`docker compose up -d --build`。

## 2. 目录与改动边界

| 路径 | 职责 | 改动注意 |
|---|---|---|
| `server/src/` | 路由、执行引擎、调度、持久化、鉴权与加密 | 引擎语义以 `engine.js` 为准；改数据字段必须同步 `store.js` 与迁移 |
| `server/test/` | 全量单测（`node --test`） | 行为改动必须带回归测试 |
| `web/src/` | 页面、编辑器、组件、设计令牌 | 先读 `docs/UI-STANDARDS.md`；令牌只在 `styles.css` `:root` 定义 |
| `docs/` | 架构、API、MCP、安全、更新日志、模板协议 | 改接口/工具/版本时同步 |
| `tools/` | 静态审计、UI 巡检、构建与发布脚本 | 新增护栏需要接进 CI 或 `verify-round` |
| `mcp/` | stdio MCP server | 工具名与 `docs/MCP.md` 保持一致 |
| `wiki/` | 由 `docs/` 生成的文档站产物 | 不手工改产物，改源文档后重新生成 |

共享模块只保留一份：`server/src/model.js`、`sensitive-name.js`、`text-regex.js`、`structure.js` 由前端、服务端与测试共用，不要在 `web/src/` 复制副本。

不要提交：`data/`、`node_modules/`、`web/dist/`、`server/public/`、真实凭据、具体站点的流程 / 模板 / 私有词表。`.gitignore` 已覆盖这些路径。

## 3. 提交前必须通过的检查

```bash
npm test                        # 服务端全量单测
npm run build                   # 前端构建
node tools/project-audit.cjs    # 相对 import / 文档链接 / API·MCP 对照 / CSS 契约 / 版本号
node tools/copy-audit.cjs       # 文案金标准
node tools/secret-scan.cjs      # 工作区 + 完整 git 历史的秘密扫描
node tools/diagnose-replay.cjs  # 诊断规则回放
```

涉及 UI 的改动，再跑浏览器类检查（需要本地实例）：

```bash
cd server
PORT=19998 DATA_DIR=/tmp/cq-ui node src/index.js

# 另开终端
node tools/seed-demo-instance.cjs http://localhost:19998
node tools/ui-smoke.cjs http://localhost:19998
node tools/ui-interaction-audit.cjs http://localhost:19998
node tools/verify-round.cjs http://localhost:19998
```

CI 会跑单测、前端构建、文案审计与项目一致性审计；秘密扫描与 CodeQL 在独立 workflow 中运行。任何一项变红都先修再提 PR。

## 4. 提交规范

采用 Conventional Commits，一个提交只做一件事：

```text
<type>(<scope>): <subject>
```

- `type`：`feat` / `fix` / `docs` / `refactor` / `test` / `perf` / `style` / `build` / `ci` / `chore` / `revert`
- `scope`：`server` / `web` / `editor` / `docs` / `ci` / `api` / `mcp` / `security` 等
- `subject`：中文或英文均可，写清做了什么，不写「update」「fix bug」这类空话
- 正文说明动机、影响面与验证方式；关联 Issue 用 `Refs #123`

示例：

```text
feat(editor): 支持复制粘贴步骤并保留连线
fix(engine): 取消运行时中断 curl 子进程
docs(security): 补齐 API Key 作用域与在途运行说明
```

版本号只有一个事实源：`server/package.json`（运行时由 `server/src/version.js` 读取）；根 / `server` / `web` 三处 `package.json` 必须一致，运行时代码不得硬编码版本号；发布时同步 `docs/CHANGELOG.md`。

## 5. PR 流程

1. 从 `main` 拉分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 完成改动与回归测试，本地跑完第 3 节的全部静态护栏。
3. 按 `.github/PULL_REQUEST_TEMPLATE.md` 填写：动机、改动清单、验证命令与输出、影响面、回滚方式。
4. UI 改动附明暗主题与窄屏截图；行为改动附失败/成功两条路径的证据。
5. 涉及鉴权、会话、凭据加密、脱敏、API Key 作用域的改动，必须在 PR 里写清威胁与边界，并补测试。
6. 回应 review 意见后重新跑护栏；合并采用 squash，保持 `main` 随时可发布。

## 6. 文案与品牌约束

- 产品名统一写 `CheckQ`（`Q` 大写，中间无空格）。
- 语气克制、清楚、可执行：给状态、原因和下一步，不写营销口号与形容词堆叠。
- 界面不写常驻说明文字：解释放 `title` 悬停，`copy-audit` 会拦副标题式说教。
- 术语表：任务、模板、变量、步骤、运行、调度、通知渠道、凭据；界面避免混用「流程 / 实例 / 节点」。
- 错误文案用三段式：`{对象}{动作}失败：{人话原因}。{下一步}`；原因来自可观测证据，不猜。
- 危险动作说清删什么、影响谁；不写「确定要删除吗？」这类空确认。
- 品牌标志只用 `web/public/brand/checkq-mark.svg`，不改图形、不加渐变 / 阴影 / 描边；色彩与留白见 [docs/BRAND.md](docs/BRAND.md)。
- 同一屏不重复堆叠多个标志；GitHub 与文档站标题只用文字 `CheckQ`。
- 文档中文为主，英文摘要作为第二语言；链接用相对路径并保证可解析。

## 7. 文档改动

- 用户文档从 `docs/` 生成，`wiki/` 只放产物；用户文档不写内部开发内容。
- 改 API 端点同步 `docs/API.md`，改 MCP 工具同步 `docs/MCP.md`：`project-audit` 会逐条对照代码。
- 改版本或发布同步 `docs/CHANGELOG.md`，面向使用者描述变化与迁移动作。
- 文档里的相对链接必须存在；`project-audit` 会扫描所有 Markdown。

## 8. 安全问题

不要在公开 Issue 里写漏洞细节、真实凭据或可复现的生产地址。请通过 [GitHub Security Advisories](https://github.com/zqs1qiwan/checkq/security/advisories/new) 私密报告，并附影响范围、复现步骤与建议修复；收到确认后再公开讨论。完整安全边界见 [docs/SECURITY.md](docs/SECURITY.md)。

## 9. 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。维护者有权删除不当内容并限制参与。

---

## English

Thanks for improving CheckQ. This section summarizes the essentials; the Chinese text above is authoritative.

### Setup

Node.js 22 (`.nvmrc`), npm with the two lockfiles. Run the server and the web dev server separately:

```bash
cd server && npm ci && DATA_DIR=../data ADMIN_PASSWORD=change-me npm run dev   # :8888
cd web && npm ci && npm run dev                                                # :5173, /api proxied to :8888
```

Full builds use Docker: `docker compose up -d --build`.

### Before you submit

Run `npm test`, `npm run build`, then `node tools/project-audit.cjs`, `node tools/copy-audit.cjs`, `node tools/secret-scan.cjs` and `node tools/diagnose-replay.cjs`. UI changes also need the browser checks: `tools/ui-smoke.cjs`, `tools/ui-interaction-audit.cjs` or the full `tools/verify-round.cjs` against a local instance.

### Commit convention

Conventional Commits, one concern per commit: `<type>(<scope>): <subject>`, with types `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `style`, `build`, `ci`, `chore`, `revert`. Keep all three `package.json` versions in sync and never hardcode the version in runtime code — `server/src/version.js` is the single source.

### Pull requests

Branch from `main` (`feat/...`, `fix/...`, `docs/...`), fill in `.github/PULL_REQUEST_TEMPLATE.md` with motivation, change list, verification commands and impact, and add regression tests for behavior changes. Security-sensitive changes (auth, sessions, credential encryption, redaction, API-key scopes) must describe the threat model and boundaries. Squash merge; keep `main` releasable.

### Copy and brand rules

Write the product name as `CheckQ`. Copy should be restrained, factual and actionable: state, cause, next step — no marketing slogans. No persistent explanatory text in the UI; put explanations in `title` tooltips (`copy-audit` enforces this). Use the shared glossary (task, template, variable, step, run, schedule, notification channel, credential) and the error template `{object}{action} failed: {plain-language cause}. {next step}`. Only use `web/public/brand/checkq-mark.svg`; never restyle, recolor or add effects — see [docs/BRAND.md](docs/BRAND.md).

### Docs

Keep `docs/API.md` and `docs/MCP.md` in sync with code (the project audit compares them), update `docs/CHANGELOG.md` on releases, and make sure every relative link resolves. User-facing docs never contain internal development notes.

### Security and conduct

Do not disclose vulnerabilities, real credentials or production addresses in public issues; report privately via [GitHub Security Advisories](https://github.com/zqs1qiwan/checkq/security/advisories/new) as described in [docs/SECURITY.md](docs/SECURITY.md). All participants must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
