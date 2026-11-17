# v0.5 交付报告（审查 + 实现 + 验收）

> 日期：2026-11-16 · 范围：`docs/PRD.md` v0.5 六张 P0 卡 · 版本：`0.5.0`
> 本文只记录**做了什么、凭什么算做完、还差什么**。产品判断见 `docs/PRD.md`，架构约定见 `docs/ARCHITECTURE.md`，界面标准见 `docs/UI-STANDARDS.md`。

---

## 1. 审查结论（改之前的状态）

按 PRD 逐条核对 as-built，确认四处"文档说 A、代码是 B"或"文档说没做、其实做了"，以及四类必须先解决的结构问题：

| # | 发现 | 处理 |
|---|---|---|
| R1 | 画布只有节点与连线，出口未接**没有任何视觉提示**；`failed` 未接=失败、`next/true/false` 未接=**判成功**，于是"漏一条线"表现为"成功了但没做事" | 引入 `analyzeStructure` 作为唯一结构事实源，画布/大纲/保存清单共用；**不改引擎语义** |
| R2 | 失败只有错误分类与原始响应，没有"为什么 + 下一步" | 引入 `diagnose.js`（纯函数、九条规则、动作白名单） |
| R3 | 空实例首页只有一个空表；QD/青龙都有"第一次成功"的路径，我们两条都没有 | 引入本机演示站点 + 演练任务 |
| R4 | 改一个 cookie 必须进画布、改节点、保存、再回列表运行 | 任务行「运行 ▾」+「带改变量运行」 |
| R5 | 模板"实参分离 + 自动跟随"已成立，但分发只有一个裸输入框，无预览/哈希/订阅 | 索引协议 v1 落地 + 市场页 |
| R6 | 三个前端大文件（721/637/301 行）在动 P0-2 前会互相牵制 | 先抽 `hooks/`（history / run stream / structure），再改画布 |
| R7 | `resolveEntry` 把 `hasScript` 放在 `template` 里，`api.js` 却读顶层 → 预览永远显示"不含脚本" | 在顶层补 `hasScript`，并加单测（`example-index.test.js`） |
| R8 | `docs/API.md` 的 health 示例写死了版本号，与"文档不写死版本号"口径冲突 | 改成占位说明 |

**保留不改的东西**（有产品决策支撑，见 AGENTS §5）：缺线语义、模板零操作跟随、不做官方内容仓库、本地统计不外传、移动端只读 + 三动作。

---

## 2. 六张卡的实现要点

### P0-2 结构可见
- **服务端** `server/src/structure.js`：`analyzeStructure(flow)` → `{ entries, entryId, issues[], exits[], loops[], orphans, counts }`。问题分级：`each` 未接=error、分支与 `next` 未接=warn、`failed` 未接=info。导出 `defaultHandle` / `outputLabel` / `structureSignature`，**前后端同一份**（`web/src/stepTypes.js` 直接 re-export）。
- **前端**：`useStructure` 把画布状态投成纯数据后复用同一函数；`StepNode` 只给多出口标文字、未接出口画空心点、失败未接加角标；`LoopFrame` 用 `ViewportPortal` 按循环体 bbox 画虚线容器（**只渲染，不写数据**）；`OutlinePanel` 按 `entryId` 沿默认出口走链、`foreach` 展开缩进、孤岛单列、每行可「+ 加一步」；`StructureModal` 四段筛选 + 逐条定位；`save()` 后按 `structureSignature` 逐批弹一次（忽略过的不再打扰）。
- **大图折叠（≥60 节点）**：节点数到 60 起，`foreach` 循环体默认折叠——画布只留遍历节点本身，容器标签显示「循环 · N 步 · 已折叠」，节点角标提示「循环体已折叠」，点容器上的「展开 / 折叠」逐个切换；折叠只过滤渲染用的节点与连线，`nodes/edges` 数据、保存内容、大纲视图都不变。

### P0-3 可解释失败
- `server/src/diagnose.js`：规则 `missing-var / credential / risk-control / assert / network / server-error / client-error / engine / unknown`；输出 `{ rule, cause, confidence, evidence[], actions[] }`；`ACTIONS` 四个白名单动作；`redactText/redactUrl` 脱敏；断言规则带 `!(status>=400)` 守卫，避免"4xx 却被解释成断言错"。
- 运行完成前写入 `run.diagnosis` 再落库；`tools/diagnose-replay.cjs` + 7 条 fixture 保证规则不漂移。
- 前端 `DiagnosisCard`：原因 / 置信度点 / 证据 / 动作；动作全部走服务端给的 type，不在前端自造。

### P0-4 修改即重跑
- 运行端点支持 `dedupe:true` 与 `manualInFlight`，忙时返回 `{deduped:true, message}`（HTTP 200，不走 SSE）；前端 `runFlowStream` 识别后写"已在运行"并 toast，不再重复提交。
- 任务行「运行 ▾」四项；`vars-quick.jsx` 列变量、敏感值默认遮蔽、保存并运行；viewer 角色隐藏写入口。

### 创建入口归位（PRD §4.5）
- 顶栏主按钮改成「+ 新建」下拉，四分支并列：**空白流程 / 从模板 / 导入 HAR·JSON / 导入 cURL**；「从模板」直接切到模板页签。
- 「更多」只留进阶动作（快速组装、主题、通知、文档、退出），不再承担主要创建入口；空状态文案同步改成「+ 新建」。

### P0-1 演练场
- `server/src/demo.js`：`profile / checkin / items / reset`，内存态 1 小时 TTL、60 次/分钟/IP、四种 mode；`buildDemoFlow` 3 步（GET → POST 签到 + 断言 `last.json.code == 0` → log）；`ensureDemoFlow` 复用同一任务并把 baseUrl 重写为当前 origin；`originOf` 只接受同 host。
- 前端：空首页「先演练一遍」（受 `/api/system/features` 控制）；编辑器显示「演示 · 换成我的站点」（清 `isDemo` 并改名）。

### P0-6 度量最小版
- `server/src/metrics.js` 全部现算：窗口内运行/成功/失败/成功率、每日序列、首跑中位与 p90、修复中位、模板复用、跑得最多的任务；`Math.min(...firsts)` 修正、`minutes()` NaN 兜底。
- 5 个本地事件（`wizard_open / pick_apply / diag_action / guide_step / run_quick`）只写 `meta.json`，`GET/POST /api/system/events` 白名单校验，备份不导出。
- 前端设置「统计」页签 + 手写 sparkline；空库显示 0。

### P0-5 模板市场 v1
- `server/src/market.js`：`stableJson`（键排序）+ `sha256`、`parseIndex`（version=1 / ≤500 条 / id 唯一 / vars 声明 / 64hex / URL 与内联二选一）、`checkTemplate`（未知节点类型拒绝、敏感默认值清空、`hasScript`）、`resolveEntry`（拉取后重算哈希，不符报"内容与声明不符"）、`previewOf`。
- 端点：`index / preview / import（409 需 mode）/ subscribe / ack / subscriptions`；订阅存 `meta.market.subs`；`store` 模板带 `market` 元数据。
- 前端「市场」页签：订阅列表、索引浏览、搜索 + 标签、卡片（步数/变量数/hash12/来源/已导入）、预览弹窗（变量清单 + 必填标红 + 含脚本提示）、409 询问覆盖或另存。
- 随包示例 `docs/template-index.example.json`（内联模板，哈希自洽，有单测）。

---

## 3. 验收证据（2026-11-16 本机实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 单测 | `node --test "server/test/*.test.js"` | 35 文件全过（新增 structure 28 / diagnose 42 / v05 73 / example-index 5） |
| 前端构建 | `npm run build` + `node tools/copy-web.cjs` | 通过（`dist` 约 525KB JS / 74KB CSS，同步到 `server/public`） |
| 文案审计 | `node tools/copy-audit.cjs` | 通过 |
| 项目一致性 | `node tools/project-audit.cjs` | 通过（API 端点 61+ 条全命中、CSS 契约 5 条、三处版本 0.5.0） |
| 凭据与内容政策 | `node tools/secret-scan.cjs` | 通过 |
| 诊断回放 | `node tools/diagnose-replay.cjs` | 7 条 fixture 全通过 |
| 一轮全量 | `node tools/verify-round.cjs http://localhost:19998` | **全绿**（构建 16.0s / 产物同步 / 单测 34.9s / 三审计 / ui-smoke 71 通过 0 问题 / 交互巡检 0 findings） |

> `ui-smoke` 与交互巡检需要实例里有任务与模板；空库会报"没有分组头 / 任务列表为空"。造种子数据用 `node tools/seed-demo-instance.cjs http://localhost:19998`（只建「示例任务 / 示例模板」，不含真实站点）。
> **验收时修掉的一个假绿**：服务端从 `server/public` 提供前端，而 `npm run build` 只产出 `web/dist`——`server/public` 长期停留在旧构建，冒烟实际测的是上一版 UI。现已加 `tools/copy-web.cjs` 并接入 `verify-round`（第 2 步「前端产物同步」），`server/public` 在 `.gitignore` 内，属于构建产物。

---

## 4. 已知差距（不假装做完）

> 验收中发现并修掉的真问题：① **编辑器整页崩溃**——`drawerOpen` 由 `useRunStream` 提供，但"面板开合后 fitView"的 effect 写在它之前，首帧就触发 TDZ（`Cannot access 'drawerOpen' before initialization`），已把该 effect 移到 `useRunStream` 之后；② `server/public` 停留旧构建导致冒烟假绿，已加 `tools/copy-web.cjs` 并接入 `verify-round`；③ `login-lockout.test.js` 把旧版本号写死在断言里（改为读 `server/package.json`）；④ `server/src/version.js` 注释残留版本字面量（`project-audit` 会拦）。

1. **含脚本模板的首次运行阻断式确认**：当前在卡片与预览里标「含脚本」并提示自行审阅，没有"首次运行前强制确认"弹窗（v0.6）。
2. **MCP 工具未覆盖 v0.5 新能力**：`mcp/checkq-mcp.cjs` 仍是 20 个工具，没有 market / demo / metrics 工具。
3. **`POST /api/system/ai` 的 API Key 仍以明文落 `meta.json`**（PRD §8.2，v0.6 修）。
4. **市场索引不支持分页**：按协议上限 500 条，一屏筛选；超过时依赖搜索与标签。

> 「≥60 节点默认折叠循环体」已交付（见 §2 P0-2 末条），实测 62 节点的流程打开时画布只渲染 2 个节点，点「展开」后回到 62 个。

---

## 5. 与生产 0.3.17 的差距、数据继承（2026-11-16 实测）

生产现跑 0.3.17（`http://192.168.2.1:18888`）：31 个任务 / 8 个启用（其中 2 个 `cron` 为空，实际排期 6 个）/ 1 个模板 / 213 条运行记录。用生产脱敏备份（2,963,985 字节）搭出同构数据目录，让 0.5.0 直接吃这份数据，逐项核对：

| 核对项 | 方法 | 结果 |
|---|---|---|
| 任务能读入 | 备份 flows 原样写入 `flows.json` 后启动 | 31 / 31，名称、备注、分组、`retry`、节点与连线全在 |
| 启用与排期 | 对比 `GET /api/system/stats` | `enabledScheduled=6`、`nextRunAt=1794844920000`、`nextFlowName=QD-T01 …` —— **与生产逐字节一致** |
| 模板 | 备份 templates 写入 `templates.json` | 1 / 1，`varNames`/`vars`/节点齐全 |
| 历史运行记录 | 备份 runs 写入 `runs.json` | 213 条可列出（接口单页上限 200），详情可取；老记录没有 `diagnosis` 字段，界面按「有才显示」处理，不出空卡 |
| 编辑真实生产任务 | 对同构实例跑 `ui-smoke`（会打开第一个任务的编辑器） | **71 通过 / 0 问题** |
| 凭据密文连续 | 用 0.3.17 版 `secret.js` 加密 `SESSION=abc123`，再用 0.5.0 版解密，同一 `.secret` | 密文前缀 `enc:v1:`，解密回原文一致 |
| 数据层字段改动 | `git diff HEAD` | 仅新增 `flow.isDemo`、`template.market`；`findEntry` 删除（入口判定改由 `analyzeStructure` 承接）；`engine.js` 修 curl 超时单位与脚本快照序列化；`secret.js` 只把 `isSensitiveName` 改为 re-export。**没有重命名或删除任何已有字段** |

结论：**可以原地升级，数据目录不用动**。把镜像换成 0.5.0、`/mnt/nvme0n1-4/checkq/data` 原样挂回去即可；首次启动会把 31 个任务全部读入，6 个排期任务按原 cron 继续跑，213 条历史留着，凭据照旧解密。v0.5 新增的结构分析、诊断、演练、市场、度量都是计算出来的或旁路字段，不要求回填。

**两个别做错的迁移姿势**

1. **不要用 `POST /api/system/restore` 当迁移手段**。它是"把备份导入成新任务"：每条改名「（恢复）」、新 ID、默认停用、`tplId=null`，而且 `createFlow` 调用里没带 `group`/`retry`，分组与重试配置会丢，`runs` 也不导入。原地升级走数据目录，不走 restore。
2. **升级时机避开排期点**。6 个任务集中在 0:02–0:17；换镜像只中断容器，正在跑的那次会失败并计入重试，建议排期窗口外做，或先 `GET /api/system/backup` 留一份（脱敏版够用，完整版需再输密码）。

**仍无法在本机验证的一项**：生产镜像的替换路径（`docker compose` 换镜像 vs `pack-prebuilt.cjs` + `deploy-prebuilt.sh`）是否只动镜像层、不动 `/mnt/nvme0n1-4/checkq/data`。这属于部署动作，需要你决定何时做、用哪条路径；做之前先备份数据目录。

### 5.1 生产升级已执行（2026-11-16 13:53）

按 `pack-prebuilt.cjs` + `deploy-prebuilt.sh` 走的预构建替换（设备上不做 `docker build`，避免路由器重启）：

1. 备份数据目录 `/mnt/nvme0n1-4/checkq/data` → `data.bak-20261116-0.5.0`（3.4MB，含 `.secret`）；旧镜像留 `checkq:rollback-0.3.17` 与 `checkq:v0.3.17-ui32`；替换前容器快照 `checkq:v0.5.0.bak`。
2. 本机构建 → 打包（34 个文件，含 `structure/diagnose/demo/metrics/market`）→ `scp` 到 `/tmp` → 设备上替换 `/app/public` 与 `/app/src` → 重启 → 健康检查通过 → `docker commit` 为 `checkq:v0.5.0`，并同步 `checkq:latest`。
3. 升级前后对照：`version` 0.3.17 → **0.5.0**；flows 31 / enabled 8 / templates 1 不变；`enabledScheduled=6`、`nextRunAt=1794844920000`、`nextFlowName=QD-T01 …`、`todayRuns=22` **逐字段一致**；样例任务的敏感变量仍可解出（`vars filled=1/1`），说明 `.secret` 与 `enc:v1:` 连续；`GET /api/flows/:id` 已带 `structure`；前端产物换成新哈希 `assets/index-fGreATdw.js`。
4. 容器配置未变（`restart=unless-stopped`，挂载 `/mnt/nvme0n1-4/checkq/data → /data`）。**回退**：`docker rm -f checkq` 后用 `checkq:rollback-0.3.17` 以原参数重建，数据目录不需要回滚（新版本只写旁路字段，旧版本读得到的字段没动）；数据目录备份仍在，必要时可整体覆盖。
5. 升级时点 13:53，避开 0:02–0:17 排期窗口；升级后最近一次真实运行为升级前的 08:21，下一轮排期由 0.5.0 的调度器接管。

### 5.2 0.5.1 补丁（2026-11-16）

v0.5.0 上线后验收提出的三处问题已修，并随一轮小修一起发版：

- **图标体系**：新增 `IconMore/IconChevronDown/IconClose`，把 `▾ / ⋯ / ✕` 文本字形换成 SVG；`IconAuto/Globe/Help` 收窄到同一光学尺寸；弹窗与运行抽屉关闭按钮改用 SVG。
- **分组选择器**：新增 `GroupPicker.jsx` 替换任务详情与批量「分组…」里的原生 datalist；列出已有分组、当前值高亮、可清空、Esc 关闭。编辑器路径在没有分组列表时自己拉一次。
- **连续失败自动停用**：新增 `server/src/auto-pause.js`；`api.js` 在调度运行最终失败后停用任务并写 `pausedAt/pausedReason`，`run.paused=true`，结论追加「（已自动停用调度）」；列表显示「已暂停」，任务详情给出恢复开关。单测 `server/test/auto-pause.test.js` 16 项。
- **画布小修**：节点恢复 `overflow:visible`，`exit-flag`（失败未接）与 `loop-folded-hint` 不再被裁；画布控件 26×26、小地图补边框圆角。

验收口径同 v0.5.0：`verify-round` 全绿（构建 / 36 文件单测 / 三审计 / `ui-smoke` 72 通过 / 交互巡检 0 findings）。2026-11-16 已按 §5.1 路径升级生产到 0.5.1（备份 `data.bak-20261116-0.5.1`，flows 30 / enabled 8 / `nextRunAt` 不变，样例分组仍在）。

### 5.3 0.5.2 每日汇总修复（2026-11-16）

生产 0.5.1 上线后发现：两个已停用任务仍在通过每日汇总推送，站内标题还沿用该任务的渠道标题。根因是汇总「推送单位」只校验渠道不看 `enabled`，且站内通知标题沿用渠道 `title`。已改为：定时汇总只对启用单位发送（全停用则跳过）、标题固定「每日汇总」、站内通知不挂任务名；推送单位列表带 `enabled`，设置页标「已停用」。`push-units.test.js` 10/10。生产已升级到 0.5.2（备份 `data.bak-20261116-0.5.2`）；生产现有 2 个推送单位都已停用，08:10 汇总会跳过，设置页会提示。
