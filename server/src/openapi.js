/**
 * 开放 API 描述（OpenAPI 3.1）—— 供外部 Agent / 集成自助发现
 * 暴露：GET /api/openapi.json
 */

import { VERSION } from './version.js';

const scopes = {
  read: '查看任务、运行记录、日志、统计、模板（凭据脱敏）',
  run: '触发任务运行（跑签到）',
  write: '修改变量 / 调度 / 新建任务 / 通知配置',
  secrets: '读取任务与模板中的明文凭据（Cookie / Token / 密码）',
};

const errorResponses = {
  400: { description: '参数错误（中文 error 说明）' },
  401: { description: '未登录、API Key 无效或已过期回收' },
  403: { description: '权限不足（API Key 作用域不包含所需能力，或需要管理员）' },
  404: { description: '资源不存在' },
  409: { description: '状态冲突（如运行已结束、取消无效）' },
  429: { description: '请求过于频繁（登录限流 / AI 调用限流）' },
  502: { description: '上游或外部接口失败（如 LLM 接口错误、返回非 JSON）' },
  504: { description: '上游接口超时' },
};

function op(summary, extra = {}) {
  return {
    summary,
    tags: extra.tags || ['flows'],
    description: extra.description,
    parameters: extra.parameters,
    requestBody: extra.requestBody,
    responses: {
      200: { description: '成功', content: { 'application/json': { schema: extra.schema || { type: 'object' } } } },
      ...(extra.errors || []).reduce((acc, code) => ({ ...acc, [code]: errorResponses[code] }), {}),
    },
    'x-required-scope': extra.scope || 'read',
    ...(extra.role ? { 'x-required-role': extra.role } : {}),
  };
}

const idParam = (name = 'id', desc = '资源 ID') => ({
  name, in: 'path', required: true, description: desc, schema: { type: 'string' },
});

export function buildOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'CheckQ 开放 API',
      version: VERSION,
      description:
        'CheckQ 自动化签到引擎的对外接口。认证二选一：① 请求头 `x-api-key: <key>`（推荐，可按作用域发放）；② 浏览器会话 Cookie（登录后自动带上）。\n' +
        'API Key 作用域：' + Object.entries(scopes).map(([k, v]) => `\`${k}\` = ${v}`).join('；') + '。\n' +
        '写操作需 `write`，运行任务需 `run`，只读操作用 `read`。过期 Key 会被自动回收。\n' +
        '标注 `x-required-role: admin` 的端点（如 AI 配置写入、AI 连接测试）只接受管理员浏览器会话，API Key 不能代替。',
      contact: { name: 'CheckQ', url: 'http://localhost:8888/' },
    },
    servers: [
      { url: 'http://localhost:8888', description: '服务端默认端口（容器内 / docker-compose.prod.yml）' },
      { url: 'http://localhost:18888', description: '本地测试宿主映射（docker-compose.yml：18888 → 容器 8888）' },
    ],
    security: [{ apiKeyAuth: [] }, { cookieAuth: [] }],
    components: {
      securitySchemes: {
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key', description: '面板「设置 → API Key」生成，可设作用域与回收日期' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'qsid', description: '浏览器登录会话（httpOnly）' },
      },
      schemas: {
        Flow: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, note: { type: 'string' },
            group: { type: 'string', description: '分组名；空串 = 未分组' },
            cron: { type: 'string' }, timezone: { type: 'string' }, enabled: { type: 'boolean' },
            vars: { type: 'object', additionalProperties: { type: 'string' }, description: '流程变量（cookie/token 等；落盘加密，返回明文以便编辑）' },
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
            log: { type: 'object' },
            notify: { type: 'object' },
            retry: { type: 'object', description: '任务级失败重试策略' },
            recovery: { type: 'object', description: '自动停用后的恢复探测（默认关闭）' },
          },
        },
        Run: {
          type: 'object',
          properties: {
            id: { type: 'string' }, flowId: { type: 'string' }, trigger: { type: 'string', enum: ['manual', 'cron', 'debug', 'probe'] },
            status: { type: 'string', enum: ['queued', 'running', 'success', 'failed', 'cancelled'] },
            interrupted: { type: 'boolean', description: '服务重启时尚未结束的运行' },
            timedOut: { type: 'boolean' }, cancelled: { type: 'boolean' },
            startedAt: { type: 'integer' }, durationMs: { type: 'integer' },
            finalMessage: { type: 'string' }, summary: { type: 'string' },
            logs: { type: 'array', items: { type: 'object', description: '步骤日志（人话日志）' } },
            recovery: { type: 'object', description: 'trigger=probe 时的探测结果' },
          },
        },
        LogEntry: {
          type: 'object',
          properties: {
            runId: { type: 'string' }, startedAt: { type: 'integer' }, status: { type: 'string' },
            position: { type: 'integer', minimum: 0, description: '跨页运行的日志位置，从 0 开始' },
            interrupted: { type: 'boolean' }, timedOut: { type: 'boolean' },
            index: { type: 'integer' }, name: { type: 'string' }, message: { type: 'string' },
            type: { type: 'string' }, ok: { type: 'boolean' }, ms: { type: 'integer' },
          },
        },
        AiConfig: {
          type: 'object',
          description: 'AI 助手配置（读取时 API Key 只回显前缀，永不返回明文）',
          properties: {
            configured: { type: 'boolean', description: 'baseUrl / apiKey / model 是否都已填写' },
            baseUrl: { type: 'string', description: 'OpenAI 兼容端点，已归一化（去尾 /，兼容 .../v1 与 .../v1/chat/completions）' },
            model: { type: 'string' },
            apiKey: { type: 'string', description: '打码前缀，例如 sk-abc…' },
            hasKey: { type: 'boolean' },
            timeoutSec: { type: 'integer', minimum: 5, maximum: 120, description: 'LLM 调用超时（默认 60 秒）' },
            maxTokens: { type: 'integer', minimum: 1, maximum: 4096, description: '生成草稿时的最大输出 tokens（默认 1024）' },
          },
        },
        AiConfigInput: {
          type: 'object',
          properties: {
            baseUrl: { type: 'string', description: '仅 http(s)；可填 .../v1 或 .../v1/chat/completions' },
            apiKey: { type: 'string', description: '传空或打码占位（以 … 结尾）时保留旧 Key；全空 = 清空配置' },
            model: { type: 'string', description: '必填（有 baseUrl/apiKey 时）' },
            timeoutSec: { type: 'integer', minimum: 5, maximum: 120, default: 60 },
            maxTokens: { type: 'integer', minimum: 1, maximum: 4096, default: 1024 },
          },
        },
        AiDraft: {
          type: 'object',
          description: 'AI 生成的流程草稿：始终 enabled=false、vars={}，不会落库',
          properties: {
            name: { type: 'string' }, cron: { type: 'string', description: '仅 5 段 cron 或空串' },
            timezone: { type: 'string', const: 'Asia/Shanghai' }, enabled: { type: 'boolean', const: false },
            vars: { type: 'object', additionalProperties: { type: 'string' } },
            nodes: { type: 'array', maxItems: 6, items: { type: 'object' } },
            edges: { type: 'array', maxItems: 8, description: '仅保留 source/target 都存在且去重后的连线（最多 8 条）', items: { type: 'object' } },
          },
        },
      },
    },
    'x-scopes': scopes,
    paths: {
      '/api': { get: op('接口索引（无需鉴权即可访问的元信息）', { tags: ['meta'], scope: null }) },
      '/api/health': { get: op('健康检查', { tags: ['meta'] }) },
      '/api/me': { get: op('当前身份（会话用户 / API Key 身份与作用域）', { tags: ['meta'] }) },
      '/api/mcp': {
        post: op('MCP JSON-RPC 2.0 端点（initialize / tools/list / tools/call）', {
          tags: ['mcp'], scope: 'read',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { jsonrpc: { type: 'string' }, id: {}, method: { type: 'string' }, params: { type: 'object' } }, required: ['method'] } } } },
          errors: [400, 401, 403],
        }),
      },
      '/api/login': { post: op('用户名+密码（+可选两步验证码）登录，返回 HttpOnly Cookie qsid', { tags: ['auth'], scope: null, errors: [401, 429] }) },
      '/api/logout': { post: op('退出当前会话', { tags: ['auth'] }) },
      '/api/flows': {
        get: op('列出任务（含 cron/enabled/nextRunAt/上次结果）', { tags: ['flows'], schema: { type: 'array', items: { $ref: '#/components/schemas/Flow' } } }),
        post: op('新建任务（允许草稿；需 write 作用域）', {
          tags: ['flows'], scope: 'write',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Flow' } } } },
          schema: { $ref: '#/components/schemas/Flow' }, errors: [400, 401, 403],
        }),
      },
      '/api/flows/validate': {
        post: op('静态校验流程定义（节点类型 / 连线 / 允许请求源，不落库）', {
          tags: ['flows'], scope: 'read',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } } } },
          errors: [401, 403],
        }),
      },
      '/api/flows/batch': {
        post: op('批量运行/启用/停用/删除/设分组', {
          tags: ['flows'], scope: 'write',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ids', 'action'], properties: { ids: { type: 'array', items: { type: 'string' } }, action: { type: 'string', enum: ['run', 'enable', 'disable', 'delete', 'set-group'] }, wait: { type: 'boolean' }, group: { type: 'string' } } } } } },
          errors: [400, 401, 403],
        }),
      },
      '/api/flows/{id}': {
        get: op('任务详情（nodes/vars/log/notify）', { tags: ['flows'], parameters: [idParam()], schema: { $ref: '#/components/schemas/Flow' } }),
        put: op('更新任务（vars/cron/timezone/jitterMinutes/enabled/name/note）', {
          tags: ['flows'], scope: 'write', parameters: [idParam()],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Flow' } } } },
          errors: [401, 403, 409],
        }),
        delete: op('删除任务（不可恢复）', { tags: ['flows'], scope: 'write', parameters: [idParam()], errors: [401, 403, 404] }),
      },
      '/api/flows/{id}/vars': {
        patch: op('只写合并更新任务变量（传 null 可删除键；不修改节点且不回显密钥）', {
          tags: ['flows'], scope: 'write', parameters: [idParam()],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { vars: { type: 'object', additionalProperties: { type: ['string', 'null'] } } } } } } },
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, varsCount: { type: 'integer' }, updatedKeys: { type: 'array', items: { type: 'string' } } } },
          errors: [400, 401, 403, 404],
        }),
      },
      '/api/flows/{id}/run': {
        post: op('立即运行一次（wait=false 返回 202 排队；debug=true 单次调试）', {
          tags: ['flows'], scope: 'run', parameters: [idParam()],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { wait: { type: 'boolean', default: true }, debug: { type: 'boolean', default: false }, dedupe: { type: 'boolean' }, stream: { type: 'boolean' }, debugStopId: { type: 'string' }, timeoutMs: { type: 'integer' } } } } } },
          schema: { $ref: '#/components/schemas/Run' }, errors: [401, 403],
        }),
      },
      '/api/flows/{id}/clone': { post: op('克隆任务（新副本默认停用）', { tags: ['flows'], scope: 'write', parameters: [idParam()], errors: [401, 403, 404] }) },
      '/api/flows/{id}/curl': { post: op('导出指定 HTTP 节点的等价 curl 命令', { tags: ['flows'], parameters: [idParam()], errors: [400, 401, 403, 404] }) },
      '/api/flows/{id}/logs': {
        get: op('连续日志流（普通运行整组返回，超长运行由后向前分段）', {
          tags: ['flows'],
          parameters: [
            idParam(),
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 20, maximum: 2000, default: 200 } },
            { name: 'before', in: 'query', description: '上一页返回的 nextBefore', schema: { type: 'string' } },
          ],
          schema: { type: 'object', properties: {
            entries: { type: 'array', items: { $ref: '#/components/schemas/LogEntry' } },
            runs: { type: 'array', items: { $ref: '#/components/schemas/Run' } },
            hasMore: { type: 'boolean' }, nextBefore: { type: ['string', 'null'] },
          } },
        }),
      },
      '/api/flows/{id}/notify-test': {
        post: op('向该任务已配置的渠道发一条测试通知', { tags: ['flows'], scope: 'write', parameters: [idParam()], errors: [401, 403] }),
      },
      '/api/import/curl': { post: op('解析 cURL 命令为 HTTP 节点配置', { tags: ['import'], scope: 'write', errors: [400, 401, 403] }) },
      '/api/import/har': { post: op('解析 HAR JSON 为 CheckQ 流程草稿', { tags: ['import'], scope: 'write', errors: [400, 401, 403] }) },
      '/api/runs': {
        get: op('运行历史（按 flowId 过滤）', {
          tags: ['runs'],
          parameters: [{ name: 'flowId', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 30 } }],
          schema: { type: 'array', items: { $ref: '#/components/schemas/Run' } },
        }),
      },
      '/api/runs/{id}': { get: op('某次运行详情（日志 + 变量快照，变量已脱敏）', { tags: ['runs'], parameters: [idParam()], schema: { $ref: '#/components/schemas/Run' } }) },
      '/api/runs/{id}/cancel': {
        post: op('取消排队中或运行中的一次运行；已结束返回 409', {
          tags: ['runs'], scope: 'run', parameters: [idParam()], errors: [401, 403, 404, 409],
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, cancelling: { type: 'boolean' }, run: { $ref: '#/components/schemas/Run' } } },
        }),
      },
      '/api/runs/{id}/har': { get: op('导出单次运行的 HAR（默认脱敏；响应体沿用日志截断）', { tags: ['runs'], parameters: [idParam()], schema: { type: 'object' } }) },
      '/api/templates': {
        get: op('模板列表（含变量名）', { tags: ['templates'], schema: { type: 'array', items: { type: 'object' } } }),
        post: op('创建模板', { tags: ['templates'], scope: 'write', errors: [400, 401, 403] }),
      },
      '/api/templates/from-flow/{flowId}': { post: op('将已有任务另存为模板', { tags: ['templates'], scope: 'write', parameters: [idParam('flowId', '源任务 ID')], errors: [401, 403, 404] }) },
      '/api/templates/from-url': { post: op('从远程 URL 导入模板（流式限体积 + 校验）', { tags: ['templates'], scope: 'write', errors: [400, 401, 403, 502] }) },
      '/api/templates/{id}': {
        get: op('模板详情（变量名 + 默认值，敏感项已脱敏）', { tags: ['templates'], parameters: [idParam()], schema: { type: 'object' } }),
        put: op('更新模板（自动同步关联派生任务）', { tags: ['templates'], scope: 'write', parameters: [idParam()], errors: [400, 401, 403, 404] }),
        delete: op('删除模板（已派生任务保留本地副本）', { tags: ['templates'], scope: 'write', parameters: [idParam()], errors: [401, 403, 404] }),
      },
      '/api/templates/{id}/export': { get: op('导出脱敏模板 JSON', { tags: ['templates'], parameters: [idParam()], errors: [401, 404] }) },
      '/api/templates/{id}/instantiate': {
        post: op('从模板创建任务（变量可覆盖）', {
          tags: ['templates'], scope: 'write', parameters: [idParam()],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, vars: { type: 'object' } } } } } },
          errors: [401, 403],
        }),
      },
      '/api/templates/{id}/instantiate-csv': { post: op('CSV 批量从模板创建任务', { tags: ['templates'], scope: 'write', parameters: [idParam()], errors: [400, 401, 403, 404] }) },
      '/api/notifications': {
        get: op('站内通知列表', { tags: ['meta'], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }], schema: { type: 'object' } }),
        delete: op('清空站内通知', { tags: ['meta'], scope: 'write', errors: [401, 403] }),
      },
      '/api/notifications/read': { post: op('标记站内通知已读', { tags: ['meta'], scope: 'write', errors: [400, 401, 403] }) },
      '/api/system/stats': { get: op('运维统计（任务数/今日运行/成功率/下次调度）', { tags: ['meta'], schema: { type: 'object' } }) },
      '/api/system/push-targets': { get: op('可推送单位（带通知渠道的任务）', { tags: ['meta'], schema: { type: 'array', items: { type: 'object' } } }) },
      '/api/system/backup': {
        get: op('导出脱敏备份 JSON', { tags: ['system'], errors: [401, 403] }),
        post: op('导出完整备份（含明文凭据，需校验当前密码）', { tags: ['system'], scope: 'write', errors: [401, 403] }),
      },
      '/api/system/restore': { post: op('从备份恢复任务与模板（默认停用并分配新 ID）', { tags: ['system'], scope: 'write', errors: [400, 401, 403] }) },
      '/api/system/ui': {
        get: op('获取界面偏好设置', { tags: ['system'] }),
        put: op('保存界面偏好设置', { tags: ['system'], scope: 'write' }),
      },
      // ---- AI 助手 ----
      '/api/system/ai': {
        get: op('读取 AI 助手配置（登录用户；API Key 只回显前缀，绝不返回明文）', {
          tags: ['ai'], schema: { $ref: '#/components/schemas/AiConfig' }, errors: [401],
        }),
        put: op('保存 AI 配置（仅管理员）：baseUrl 仅 http(s)、自动去尾 / 并兼容 /v1 与 /v1/chat/completions；Key 传空或打码占位保留旧值；全空=清空', {
          tags: ['ai'], scope: 'write', role: 'admin',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AiConfigInput' } } } },
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' }, configured: { type: 'boolean' }, cleared: { type: 'boolean' },
              baseUrl: { type: 'string' }, model: { type: 'string' }, apiKey: { type: 'string' },
              timeoutSec: { type: 'integer' }, maxTokens: { type: 'integer' },
            },
          },
          errors: [400, 401, 403],
        }),
      },
      '/api/ai/test': {
        post: op('测试 AI 连接（仅管理员）：用已保存配置发一条最小请求；401/404/超时/非 JSON 返回中文错误且不回显 Key', {
          tags: ['ai'], scope: 'write', role: 'admin',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { timeoutSec: { type: 'integer', minimum: 1, maximum: 120, description: '仅本次测试的超时覆盖（默认取配置）' } },
                },
              },
            },
          },
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' }, latencyMs: { type: 'integer' }, model: { type: 'string' },
              sample: { type: 'string', description: '模型回复的前 120 字' },
              usage: { type: ['object', 'null'], description: '上游返回的 token 用量（可能为空）' },
              error: { type: 'string', description: '失败时的中文原因（已脱敏）' },
            },
          },
          errors: [400, 401, 403, 429, 502, 504],
        }),
      },
      '/api/ai/generate': {
        post: op('一句话生成流程草稿（登录用户；API Key 需 write 作用域）：≤6 节点、edges 仅引用存在的节点并去重、cron 仅 5 段、草稿 enabled=false/vars={}', {
          tags: ['ai'], scope: 'write',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { sentence: { type: 'string', maxLength: 500 } }, required: ['sentence'] } } },
          },
          schema: { type: 'object', properties: { draft: { $ref: '#/components/schemas/AiDraft' } } },
          errors: [400, 401, 403, 429, 502],
        }),
      },
      '/api/system/apikeys': {
        get: op('API Key 列表（管理员；含作用域与回收日期）', { tags: ['keys'], errors: [401, 403] }),
        post: op('生成 API Key（管理员；可指定 scopes 与回收日期，明文只返回一次）', {
          tags: ['keys'], scope: 'write',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'run', 'write'] } }, expiresAt: { type: 'string', description: '回收日期 YYYY-MM-DD，留空=永不过期' } } } } } },
          errors: [401, 403],
        }),
      },
      '/api/system/apikeys/{id}': {
        put: op('更新 API Key 作用域/IP 白名单/回收日期', { tags: ['keys'], scope: 'write', role: 'admin', parameters: [idParam('id', 'API Key ID')], errors: [400, 401, 403, 404] }),
        delete: op('吊销 API Key（立即失效）', { tags: ['keys'], scope: 'write', role: 'admin', parameters: [idParam('id', 'API Key ID')], errors: [401, 403] }),
      },
      '/api/system/ip-blocklist': {
        get: op('全局 IP 黑名单列表（管理员）', { tags: ['admin'], role: 'admin', errors: [401, 403] }),
        put: op('加入全局 IP 黑名单（管理员）', { tags: ['admin'], scope: 'write', role: 'admin', errors: [400, 401, 403] }),
      },
      '/api/system/ip-blocklist/{ip}': { delete: op('移出全局 IP 黑名单（管理员）', { tags: ['admin'], scope: 'write', role: 'admin', parameters: [idParam('ip', 'IP 或 CIDR')], errors: [401, 403] }) },
      '/api/system/users': { get: op('用户列表（管理员）', { tags: ['admin'], role: 'admin', errors: [401, 403] }) },
      '/api/system/audit': { get: op('审计日志（管理员）', { tags: ['admin'], role: 'admin', errors: [401, 403] }) },
      // ---- v0.5 ----
      '/api/system/features': { get: op('功能开关（演练场是否可用）', { tags: ['meta'], schema: { type: 'object', properties: { demo: { type: 'boolean' }, version: { type: 'string' } } } }) },
      '/api/system/metrics': { get: op('本机度量（运行/成功率/首跑与修复耗时/模板复用）', { tags: ['meta'], parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 7 } }], schema: { type: 'object' } }) },
      '/api/system/events': {
        get: op('本地事件计数（只存本机）', { tags: ['meta'], schema: { type: 'object' } }),
        post: op('记录本地界面事件（白名单 5 个名字）', {
          tags: ['meta'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', enum: ['wizard_open', 'pick_apply', 'diag_action', 'guide_step', 'run_quick'] } }, required: ['name'] } } } },
          errors: [400],
        }),
      },
      '/api/market/subscriptions': { get: op('已订阅的模板索引', { tags: ['market'], schema: { type: 'object' } }) },
      '/api/market/index': { get: op('解析模板索引（version=1 / sha256 / ≤500 条）', { tags: ['market'], parameters: [{ name: 'url', in: 'query', required: true, schema: { type: 'string' } }], errors: [400, 502] }) },
      '/api/market/preview': { post: op('预览某个条目（服务端重算 sha256）', { tags: ['market'], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, id: { type: 'string' } }, required: ['url', 'id'] } } } }, errors: [400, 404, 502] }) },
      '/api/market/import': { post: op('导入条目（409 需 mode=overwrite|copy）', { tags: ['market'], scope: 'write', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, id: { type: 'string' }, mode: { type: 'string', enum: ['overwrite', 'copy'] } }, required: ['url', 'id'] } } } }, errors: [400, 404, 409, 502] }) },
      '/api/market/subscribe': {
        get: op('（同 /api/market/subscriptions）', { tags: ['market'] }),
        post: op('订阅索引地址', { tags: ['market'], scope: 'write', errors: [400, 502] }),
        delete: op('取消订阅', { tags: ['market'], scope: 'write', parameters: [{ name: 'url', in: 'query', required: true, schema: { type: 'string' } }] }),
      },
      '/api/market/ack': { post: op('记录已看到的条目数（不再提示新增）', { tags: ['market'], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, count: { type: 'integer' } }, required: ['url'] } } } } }) },
      '/api/demo/flow': { post: op('创建或复用演练任务（只指向本机演示站点）', { tags: ['demo'], scope: 'write', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { origin: { type: 'string' } } } } } } }) },
      '/api/demo/profile': { get: op('演示站点：个人资料', { tags: ['demo'] }) },
      '/api/demo/checkin': { post: op('演示站点：签到（code=0 成功）', { tags: ['demo'] }) },
      '/api/demo/items': { get: op('演示站点：条目列表（foreach 示例）', { tags: ['demo'] }) },
      '/api/demo/reset': { post: op('演示站点：清空内存状态', { tags: ['demo'], scope: 'write' }) },
    },
  };
}
