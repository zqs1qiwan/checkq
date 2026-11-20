## 这个 PR 做了什么

<!-- 一两句话说清动机与结果；关联 Issue 用 Refs #123 -->

## 改动类型

- [ ] 新功能（feat）
- [ ] 缺陷修复（fix）
- [ ] 重构 / 性能（refactor / perf）
- [ ] 文档（docs）
- [ ] 测试 / CI / 构建（test / ci / build）
- [ ] 其它（chore / revert）

## 改动清单

<!-- 列出主要文件或模块，说明为什么改这里 -->

## 验证

- [ ] `npm test` 通过
- [ ] `npm run build` 通过
- [ ] `node tools/project-audit.cjs` 通过
- [ ] `node tools/copy-audit.cjs` 通过
- [ ] `node tools/secret-scan.cjs` 通过
- [ ] `node tools/diagnose-replay.cjs` 通过
- [ ] UI 改动：已跑 `node tools/ui-smoke.cjs` / `node tools/ui-interaction-audit.cjs`（或 `verify-round`）

命令与关键输出：

```text
（粘贴实际执行结果）
```

## 影响面与回滚

<!-- 影响哪些接口 / 数据结构 / 界面；不兼容变更如何迁移；如何回滚 -->

## UI 改动

<!-- 有界面变化时附明暗主题与窄屏截图；无则写「无」 -->

## 安全自查

- [ ] 未提交真实凭据、`data/` 目录或具体站点的流程 / 模板
- [ ] 新增落盘字段若可能含凭据，已走 `secret.js` 加密
- [ ] 新增日志 / 导出字段已走 `redact.js` 脱敏
- [ ] 鉴权、会话、API Key 作用域变更已说明威胁边界并补测试
- [ ] 版本号三处 `package.json` 一致，运行时代码未硬编码版本号
