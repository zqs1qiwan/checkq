# 0.6.1 自动恢复探测（实施依据）

> 状态：已实施。目标是在自动停用之后提供一条**可选、默认关闭、受风控约束**的恢复路径，避免失败任务反复触发站点风控。

## 1. 背景与边界

0.6.0 的自动停用规则是：调度触发的一次运行，重试全部用尽仍失败 → 停用调度。这条规则保护了实例，但也带来一个运维缺口：站点临时故障恢复后，任务不会自己回来。

本版补的是“停用后的试探”，不是“失败后无限重试”：

- 默认关闭，升级不会让任何现有任务开始探测。
- 只对自动停用（`enabled=false` 且 `pausedAt` 非空）的任务生效。
- 探测是真实运行，但静默：不发任务通知、不写外部渠道。
- 失败不会再次触发自动停用；达到上限后停止，并留站内记录。
- 探测成功才重新启用调度；用户手动重新启用仍然优先。

## 2. 数据模型

任务新增 `recovery` 字段（与 `retry` 同级，随任务落盘）：

```json
{
  "enabled": false,
  "intervalMinutes": 60,
  "maxAttempts": 2,
  "attempts": 0,
  "nextProbeAt": null,
  "lastProbeAt": null,
  "lastResult": null,
  "exhausted": false
}
```

- `enabled / intervalMinutes / maxAttempts` 是用户配置；`intervalMinutes` 收敛到 30–1440，`maxAttempts` 收敛到 1–5。
- `attempts / nextProbeAt / lastProbeAt / lastResult / exhausted` 是运行态，由 scheduler 与 `api.runFlow` 维护。
- 关闭探测时清空运行态；重新开启视为一次新的探测周期。
- 旧任务没有该字段时按默认值（关闭）读取，不批量改写数据。

## 3. 行为

### 3.1 自动停用时

`applyAutoPause` 在停用任务的同一次写入中，如果 `recovery.enabled=true`，设置：

- `attempts=0`
- `nextProbeAt=now + intervalMinutes`
- `lastProbeAt=null / lastResult=null / exhausted=false`

### 3.2 调度器

`Scheduler.start()` 在原有 60s 调度对账之外增加 60s recovery 对账：

- `init`：已暂停、已开启、但没有 `nextProbeAt` → 补齐下一次，不立即探测。
- `wait`：未到点 → 跳过。
- `probe`：到点且不在运行 → 先把 `nextProbeAt` 推到下一轮，再以 `trigger='probe'`、`{ notify:false }` 调用 `runFlow`。
- 已达到上限（`exhausted`）→ 永久跳过，直到用户重新配置。

### 3.3 运行结果

`api.runFlow` 对 `probe` 做独立处理：

- 成功：`enabled=true`、清空 `pausedAt/pausedReason`、写“任务已自动恢复”站内通知、`scheduler.rebuild()`；`run.recovered=true`。
- 失败：`attempts+1`；未到上限则 `nextProbeAt=now+interval`；到上限则 `nextProbeAt=null`、`exhausted=true`，写“自动恢复已停止”站内通知。
- 探测运行时关闭任务级重试：一次探测只跑一次，避免绕过“最多探测 N 次”的风控上限。
- `shouldAutoPause('probe', failed)` 恒为 false，避免探测失败再次改变调度。
- 探测不发送任务通知，不写 `run.notify`；`RunDrawer` 用 `run.recovery` 显示探测次数与结果。

## 4. 界面

- 任务详情与编辑器调度弹窗共用 `RecoveryFields`：开关默认关闭，开启后填写间隔与最多探测次数。
- 自动停用提示根据状态显示：未开启 → “勾选开关恢复或开启探测”；已开启 → “每 N 分钟探测一次 / 下次时间 / 已失败次数”；已停止 → “探测已停止”。
- 任务列表的“已暂停”悬停提示带探测状态。
- 运行抽屉显示“恢复探测：成功，已重新启用 / 失败，保持停用 / 失败，已停止自动探测”。

## 5. 验收标准

- **AC-1** 新任务 / 旧任务的 `recovery.enabled` 默认 false。
- **AC-2** 每个任务可独立配置间隔与次数；间隔被收敛到 30–1440，次数被收敛到 1–5。
- **AC-3** 开启探测的任务被自动停用后，`nextProbeAt` 落在 `now + intervalMinutes` 附近。
- **AC-4** 探测运行 `trigger='probe'`，不发任务通知、不写外部渠道，且一次探测只执行一次（不沿用任务级重试）。
- **AC-5** 探测失败不触发自动停用，调度保持停用。
- **AC-6** 探测成功自动重新启用调度并清空暂停标记。
- **AC-7** 达到 `maxAttempts` 后停止探测，并写“自动恢复已停止”站内通知。
- **AC-8** 探测运行不会被 60s 对账重复触发；任务运行中会跳过这一拍。
- **AC-9** 任务详情与编辑器调度弹窗都能配置恢复探测，且都不覆盖对方字段。
- **AC-10** 用户手动重新启用会清空暂停标记，并重置探测运行态。
- **AC-11** 克隆任务保留 `retry` 与 `recovery` 配置。
- **AC-12** 两处调度 UI 的重试等待预览使用 equal jitter 的真实区间（50%–100%），不再显示固定 0.75 倍。

## 6. 风险与取舍

- 最小间隔 30 分钟、最多 5 次是保守上限；不同站点风控强度不同，默认关闭是最后一道保险。
- 探测仍会消耗一次真实登录 / 请求；对明确封号的任务，建议用户关闭探测并手动处理。
- 探测运行会计入运行历史与今日统计；这是有意的，便于审计“探测了几次、什么时候恢复”。
- 本轮不提供“手动探测一次”的独立按钮；需要时用户可直接手动运行任务，不需要先打开自动探测。
