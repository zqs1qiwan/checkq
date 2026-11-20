<p align="center"><a href="https://zqs1qiwan.github.io/checkq/"><img src="web/public/brand/checkq-mark.svg" width="96" height="96" alt="CheckQ 标志" /></a></p>

<h1 align="center">CheckQ</h1>

<p align="center">开源的可视化自动挂机、签到框架</p>

<p align="center">
  <a href="https://github.com/zqs1qiwan/checkq/actions/workflows/ci.yml"><img src="https://github.com/zqs1qiwan/checkq/actions/workflows/ci.yml/badge.svg" alt="静态验收" /></a>
  <a href="https://zqs1qiwan.github.io/checkq/"><img src="https://github.com/zqs1qiwan/checkq/actions/workflows/pages.yml/badge.svg" alt="文档站 (GitHub Pages)" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/github/package-json/v/zqs1qiwan/checkq?label=version" alt="version" />
  <img src="https://img.shields.io/badge/node-22-339933.svg" alt="Node 22" />
</p>

CheckQ 把签到、打卡、查询、监控、上报这类重复 HTTP 操作做成可视化流程：拖拽积木搭建，导入 HAR 自动生成，定时执行，失败能看到原因。Docker 单容器部署，数据落在本地 `/data`。不内置浏览器渲染、验证码识别、多语言运行时与集群能力；需要时请用外部服务。

- 文档站：<https://zqs1qiwan.github.io/checkq/>
- 当前版本：`0.6.5`，变更见 [docs/CHANGELOG.md](docs/CHANGELOG.md)
- 许可证：MIT，见 [LICENSE](LICENSE)

## 目录

- [特性](#特性)
- [步骤类型](#步骤类型)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [文档](#文档)
- [测试与质量护栏](#测试与质量护栏)
- [贡献](#贡献)
- [安全](#安全)
- [许可证](#许可证)
- [English](#english)

## 特性

### 可视化流程搭建

- 十类步骤：HTTP 请求、条件判断、赋值、提取、延迟、随机延迟、日志、通知、脚本、遍历；拖拽连线即可搭建，出口语义与执行器一致
- 变量模板语法 `{{var}}` / `{{user.email}}`，缺变量渲染为空并在日志记录缺失名
- 画布「整理」按 DAG 分层自动布局；点选即逻辑，从 JSON 树或文本划选直接生成提取步骤

### 导入与模板

- 支持浏览器 HAR、cURL 和 QD 模板导入，自动生成可编辑流程；QD 的 `retry_count` / `retry_interval` 映射为 HTTP 步骤的重试配置
- 流程可存为模板，变量各自填写；支持 JSON 导出、CSV 批量创建任务与模板市场索引
- 模板更新后，任务的流程图与日志配置自动跟随；通知渠道在创建任务时复制，之后各任务独立维护；默认变量只补缺、不覆盖任务已有值。改动脚本逻辑则自动脱钩，不会悄悄覆盖已有任务

### 调度与容错

- 每个任务独立 cron、时区与抖动；同一任务同时只跑一个，重叠触发跳过这一拍
- 失败按指数退避重试，连续失败自动停用，可选恢复探测；`failed` 出口已接线时沿失败分支继续
- 运行可取消：排队中或运行中的任务都能停，HTTP、curl、等待、节点重试与任务级退避立即中断
- 单次运行默认 30 分钟超时（`CHECKQ_RUN_TIMEOUT_MS` 可调，60 秒–24 小时）

### 运行可见与诊断

- 实时运行抽屉、连续日志、日志与画布双向定位；排队与运行中的记录开始时即落库，刷新或重启后仍可见
- 九类失败诊断给原因与下一步；日志完整记录请求、响应、断言、耗时和变量快照
- 单次运行可导出脱敏 HAR；默认备份与模板导出自动脱敏，完整备份需再次输入当前密码

### 安全与多用户

- 多用户角色 `admin` / `operator` / `viewer`，`viewer` 写操作一律 403
- scrypt 密码哈希 + TOTP 两步验证 + 一次性恢复码；会话可列出、可吊销、可退出所有设备
- API Key 只存摘要，作用域 `read` / `run` / `write` / `secrets`，可绑定任务或分组
- 凭据（变量、通知渠道密钥、AI Key）AES-256-GCM 加密落盘，写盘/SSE/导出统一脱敏；审计日志保留 500 条

### 通知

- 12 种渠道：站内 / Webhook / Bark / Telegram / Server酱 / PushPlus / 钉钉 / 企业微信 / 飞书 / Gotify / ntfy / SMTP
- 任务成功、失败与每日汇总可分别推送；推送失败在任务详情里可见

### 部署

- Docker 单容器，零数据库依赖；数据落在 `/data`（`flows.json`、`runs.json`、`templates.json`、`meta.json`、`notifications.json`、`channels.json`，以及权限 600 的 `.secret` 密钥文件）
- 多阶段构建：前端产物打进服务端镜像，一个容器同时提供 API 与面板

## 步骤类型

| 类型 | 作用 |
|---|---|
| HTTP | 发请求，模板化 URL/头/体，断言成功/失败，保存响应；可选 `fetch` 或 `curl` 执行后端（curl 用于绕开对 Node fetch TLS 指纹的风控） |
| 条件 | jexl 表达式判断，真/假两个分支出口 |
| 赋值 | 文本模板或表达式计算 → 写入变量 |
| 提取 | 正则从响应体/状态码/响应头提取 → 变量 |
| 延迟 | 等待 N 秒 |
| 随机延迟 | 在指定秒数区间内随机等待 |
| 日志 | 输出信息到运行日志 |
| 通知 | 节点内推送（Webhook / Telegram / Bark）；任务级渠道共 12 种，在编辑器「通知渠道」里配置 |
| 脚本 | 执行 JS 计算并返回变量；独立受限子进程，64MB 内存 / 1 秒 / 64KB 脚本 / 256KB 结果 |
| 遍历 | 对数组逐项运行循环体 |

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/zqs1qiwan/checkq.git
cd checkq
export ADMIN_PASSWORD='换成你自己的强密码'   # PowerShell: $env:ADMIN_PASSWORD='换成你自己的强密码'
docker compose up -d --build
```

仓库自带的 `docker-compose.yml` 原样如下：

```yaml
services:
  checkq:
    build: .
    container_name: checkq
    restart: unless-stopped
    # 容器内服务默认监听 8888（server/src/index.js: PORT||8888）；
    # 宿主 18888 只是本地测试用的映射，避免和本机其它 8888 服务冲突。
    # 生产直连请用 docker-compose.prod.yml（8888:8888）。
    ports:
      - "18888:8888"
    environment:
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/data
```

打开 `http://localhost:18888`，用 `admin` 和你设置的密码登录；不设 `ADMIN_PASSWORD` 时首次启动会生成随机密码并打印到容器日志（仅显示一次）。新建空白流程拖拽搭建，或导入 HAR / JSON。

> 端口口径：服务端默认监听 **8888**（`server/src/index.js` 的 `PORT||8888`、Dockerfile `EXPOSE 8888`）。`docker-compose.yml` 把宿主 **18888** 映射到容器 8888，只是本地测试方便、避开本机已有的 8888；生产直连请用 `docker-compose.prod.yml`（`8888:8888`），访问 `http://localhost:8888`。`tools/deploy-prebuilt.sh` 会依次探测 8888 / 18888，也可用 `CHECKQ_PORT` 显式指定宿主端口。

### 本地开发

```bash
# 服务端：默认 8888，数据目录指向仓库内 ./data（已 gitignore）
cd server
npm ci
DATA_DIR=../data ADMIN_PASSWORD='change-me' npm run dev
```

```powershell
# Windows PowerShell
cd server
npm ci
$env:DATA_DIR='..\data'; $env:ADMIN_PASSWORD='change-me'; npm run dev
```

```bash
# 前端：另开终端，http://localhost:5173，/api 代理到 8888
cd web
npm ci
npm run dev
```

技术栈：Fastify 5 / React 18 / @xyflow/react / jexl / croner。Node 22（`.nvmrc`）。

## 项目结构

```text
.
├── server/                  # Fastify 服务端
│   ├── src/                 # api.js 路由、engine.js 执行、store.js 持久化、调度与安全模块
│   └── test/                # 全量单测（node --test）
├── web/                     # React 18 + @xyflow/react 前端
│   ├── src/                 # 页面、编辑器、组件与 styles.css 设计令牌
│   └── public/              # 品牌标志、favicon、apple-touch-icon
├── mcp/                     # stdio MCP server（面向外部 Agent 的工具集）
├── tools/                   # 静态审计、UI 巡检、构建与发布脚本
├── docs/                    # 架构、API、MCP、安全、更新日志、模板协议
├── wiki/                    # 由 tools/build-wiki.cjs 从 docs/ 生成的文档站产物
├── .github/workflows/       # CI、文档站发布、CodeQL、秘密扫描
├── Dockerfile               # 多阶段构建：前端产物 → 服务端镜像
├── docker-compose.yml       # 本地/测试（18888:8888）
└── docker-compose.prod.yml  # 生产（8888:8888）
```

## 文档

| 文档 | 内容 |
|---|---|
| [文档站](https://zqs1qiwan.github.io/checkq/) | 使用、部署、排障与安全说明（GitHub Pages） |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 运行时架构、模块地图、不变量、扩展指南与验收命令 |
| [MAINTENANCE.md](docs/MAINTENANCE.md) | 维护者手册：门禁、发版、社区健康、安全与文档站 |
| [API.md](docs/API.md) | REST API、鉴权、API Key 作用域与调用示例 |
| [MCP.md](docs/MCP.md) | stdio MCP server 接入与工具清单 |
| [SECURITY.md](docs/SECURITY.md) | 账号、会话、凭据加密、加固项、已知风险与运维手册 |
| [CHANGELOG.md](docs/CHANGELOG.md) | 版本变更记录 |
| [TEMPLATE-MARKET.md](docs/TEMPLATE-MARKET.md) | 模板索引与导入协议 |
| [ROADMAP.md](docs/ROADMAP.md) | 版本历史与后续方向 |
| [UI-STANDARDS.md](docs/UI-STANDARDS.md) | 界面契约、组件规范与文案金标准 |
| [BRAND.md](docs/BRAND.md) | 品牌名称、标志、色彩与资产路径 |

仓库只放框架本身，具体站点流程 / 模板不入库。

## 测试与质量护栏

所有静态护栏都可在本地运行，命中即 exit 1：

```bash
npm test                        # 服务端全量单测（node --test server/test/*.test.js）
npm run build                   # 前端构建（CI 同款）
node tools/project-audit.cjs    # 相对 import / 文档链接 / API·MCP 对照 / CSS 契约 / 版本号
node tools/copy-audit.cjs       # 文案金标准：无常驻说明、无副标题说教、无超长句
node tools/secret-scan.cjs      # 秘密扫描：工作区 + 完整 git 历史
node tools/diagnose-replay.cjs  # 诊断规则回放：规则改坏立即变红
```

浏览器类检查需要先起一个本地实例：

```bash
cd server
PORT=19998 DATA_DIR=/tmp/cq-ui node src/index.js
# 另开终端
node tools/seed-demo-instance.cjs http://localhost:19998
node tools/ui-smoke.cjs http://localhost:19998              # UI 冒烟：7 种视口 × 明暗主题
node tools/ui-interaction-audit.cjs http://localhost:19998  # 全量交互巡检：9 种视口 × 明暗主题
node tools/verify-round.cjs http://localhost:19998          # 一轮全量验收（含以上全部）
```

CI：`.github/workflows/ci.yml` 跑单测 + 前端构建 + 文案/项目一致性；`secret-scan.yml` 扫工作区与完整历史；`codeql.yml` 做 JavaScript/TypeScript 静态安全分析；`pages.yml` 发布文档站。

## 贡献

- 开发、测试与 PR 流程见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 社区行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 提交 Issue / PR 前先跑一遍上面的静态护栏

## 安全

- 威胁模型、加固项与已知风险见 [docs/SECURITY.md](docs/SECURITY.md)
- 漏洞请通过 GitHub Security Advisories 私密报告：<https://github.com/zqs1qiwan/checkq/security/advisories/new>；不要用公开 Issue 贴凭据或复现细节
- 部署前请设置 `ADMIN_PASSWORD`、前置 HTTPS 反代，并限制 `data/` 目录权限

## 许可证

[MIT](LICENSE)

## English

### Overview

CheckQ is an open-source, visual automation framework for repetitive HTTP work — check-ins, scheduled queries, monitoring and reporting. Build flows on a drag-and-drop canvas, import HAR / cURL / QD templates, schedule runs with cron, and read a plain-language diagnosis when something fails. Ships as a single Docker container with zero database dependency; data lives under `/data`.

### Features

- Visual flow editor with ten step types: HTTP, condition, set, extract, delay, random delay, log, notify, script, foreach
- HAR / cURL / QD template import; reusable templates with per-task variables; JSON export and CSV batch instantiation
- Per-task cron, timezone and jitter; exponential backoff, auto-pause, optional recovery probe, run cancel and global timeout
- Nine-class failure diagnosis, continuous logs, live run drawer, redacted HAR export; credentials encrypted at rest (AES-256-GCM) and redacted in logs and backups
- Multi-user roles, TOTP 2FA, revocable sessions, scoped API keys, audit log
- 12 notification channels (inbox, Webhook, Bark, Telegram, Server酱, PushPlus, DingTalk, WeCom, Feishu, Gotify, ntfy, SMTP)

### Quick Start

```bash
git clone https://github.com/zqs1qiwan/checkq.git
cd checkq
ADMIN_PASSWORD='change-me' docker compose up -d --build
# open http://localhost:18888
```

Local development: `cd server && npm ci && DATA_DIR=./data ADMIN_PASSWORD=change-me npm run dev`; in a second terminal `cd web && npm ci && npm run dev` and open `http://localhost:5173`.

### Docs

- Documentation site: <https://zqs1qiwan.github.io/checkq/>
- [Architecture](docs/ARCHITECTURE.md) · [REST API](docs/API.md) · [MCP server](docs/MCP.md) · [Security](docs/SECURITY.md) · [Changelog](docs/CHANGELOG.md) · [Template market](docs/TEMPLATE-MARKET.md) · [Roadmap](docs/ROADMAP.md)

### Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Run `npm test` and the static audits above before opening a pull request.

### License

MIT — see [LICENSE](LICENSE).
