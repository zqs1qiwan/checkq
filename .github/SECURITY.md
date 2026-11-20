# 安全策略

## 报告漏洞

请使用 GitHub 的私密漏洞报告通道：

<https://github.com/zqs1qiwan/checkq/security/advisories/new>

不要在公开 Issue、Discussion 或 PR 中粘贴真实凭据、Cookie、Token 或可被直接利用的复现细节。

报告时请尽量附上：

- 受影响版本（`GET /api/health` 或「设置 → 关于」）
- 部署方式（Docker / 源码）与反向代理
- 复现步骤、影响范围与你的修复建议（如有）

## 完整安全说明

威胁模型、账号与会话、凭据加密、API Key 作用域、已知风险与运维手册见 [`docs/SECURITY.md`](../docs/SECURITY.md)。

## 支持范围

仅对最新发布版本与 `main` 分支提供安全修复；旧版本请先升级再复测。
