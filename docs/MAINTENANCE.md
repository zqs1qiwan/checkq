# 维护手册

> 面向维护者：如何跑门禁、发版、处理安全与依赖、维护文档站。产品需求见 `docs/PRD.md`，架构见 `docs/ARCHITECTURE.md`。

---

## 1. 每次改动的最低门禁

```bash
npm test                          # server 全量单测（node --test server/test/*.test.js）
npm run build                     # web 生产构建
node tools/project-audit.cjs      # import / 文档链接 / API·MCP 对照 / CSS 契约 / 版本号
node tools/copy-audit.cjs         # 文案金标准
node tools/secret-scan.cjs        # 工作区 + 完整 git 历史秘密扫描
node tools/diagnose-replay.cjs    # 诊断规则回放
```

涉及界面时再跑（需要本地实例）：

```bash
cd server
PORT=19998 DATA_DIR=/tmp/cq-ui ADMIN_PASSWORD=test1234 node src/index.js
# 另开终端
node tools/seed-demo-instance.cjs http://localhost:19998
node tools/ui-smoke.cjs http://localhost:19998
node tools/ui-interaction-audit.cjs http://localhost:19998
node tools/verify-round.cjs http://localhost:19998
```

CI（`.github/workflows/ci.yml`）覆盖单测、前端构建、文案与项目一致性；`secret-scan.yml` 扫完整历史；`codeql.yml` 做 JavaScript/TypeScript 静态安全分析；`pages.yml` 发布文档站。

---

## 2. 发版清单

1. 确认 `main` 干净、CI 全绿。
2. 同步三处 `package.json`（根 / `server` / `web`）与两个 `package-lock.json`；运行时版本由 `server/src/version.js` 读取 `server/package.json`。
3. 在 `docs/CHANGELOG.md` 顶部写本版条目（新功能 / 改进 / 修复 / 安全）。
4. `node tools/build-wiki.cjs` 重新生成 `wiki/`（版本号与页脚会自动更新）。
5. 跑第 1 节全部门禁。
6. 提交并打 tag：`git tag vX.Y.Z && git push origin main --tags`。
7. 在 GitHub Releases 用 `docs/CHANGELOG.md` 的条目建 Release；正文注明升级注意事项。
8. push 后确认 `静态验收`、`秘密扫描`、`CodeQL`、`文档站 (GitHub Pages)` 四个 workflow 全绿，并打开 Pages 验证新版。

---

## 3. 社区健康

仓库应保持以下文件存在且可用：

| 文件 | 作用 |
|---|---|
| `README.md` | 项目定位、特性、快速开始、文档矩阵、贡献与安全入口 |
| `CONTRIBUTING.md` | 开发环境、目录边界、提交规范、PR 流程 |
| `CODE_OF_CONDUCT.md` | 社区行为准则与执行方式 |
| `.github/SECURITY.md` | 私密漏洞报告渠道（GitHub Security Advisories） |
| `.github/ISSUE_TEMPLATE/*` | Bug / 功能请求表单，关闭空白 Issue |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 动机、验证、影响面、回滚 |
| `.github/dependabot.yml` | npm（server / web）与 GitHub Actions 每周升级 |
| `.github/workflows/*` | CI、秘密扫描、CodeQL、Pages |

仓库设置建议：

- About：description、homepage（Pages 地址）、topics、MIT license。
- Social preview 上传 `docs/assets/social-preview.png`（该文件只用于仓库设置，不在 README 展示）。
- 开启 Dependabot alerts 与 security updates；可选对 `main` 要求 CI 通过。
- 文档只保留一个入口：GitHub Pages；仓库 Wiki 不再维护（避免两套文档）。

---

## 4. 安全与依赖

- 漏洞通过 GitHub Security Advisories 私密报告，不要在公开 Issue 贴凭据。
- 凭据（变量、通知渠道密钥、AI Key）使用 AES-256-GCM 加密落盘；备份默认脱敏，完整备份需再次输入当前密码。
- Dependabot 只做常规升级；安全通告单独处理，合并前跑第 1 节门禁。
- 升级 Node 大版本时同步 `.nvmrc`、CI 的 `setup-node` 与 Dockerfile 基础镜像。

---

## 5. 文档站

- 源：`docs/*.md` + `tools/build-wiki.cjs` 内的上手页。
- 产物：`wiki/`（提交入库，Pages 直接发布）。
- 改文档后必须重新生成并提交 `wiki/`；不要手工改 `wiki/*.html`。
- 新增页面：在 `tools/build-wiki.cjs` 的 `PAGES` / `SOURCES` 注册，确保 `project-audit` 的页面清单检查通过。

---

## 6. 已知待办

- `main` 尚未配置分支保护；可在仓库 Settings → Branches 要求 `静态验收` 通过。
- 前端主包约 558 kB（gzip 182 kB），后续可按编辑器 / 设置页做动态拆包。
- 仓库 Wiki 为空；若启用需先明确与 Pages 的分工，否则建议关闭。
