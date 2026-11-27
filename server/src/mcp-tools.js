/**
 * CheckQ MCP 工具定义与共享调度器（22 工具，供 HTTP /api/mcp 与本地 stdio MCP 对齐）。
 */

export const MCP_TOOLS = [
  { name: 'health', description: 'CheckQ 健康检查（版本、连通性）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'whoami', description: '当前身份与权限（登录用户 / API Key 作用域），用于自检', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'stats', description: '运维健康统计（任务数/运行数/成功率/下次调度）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'notifications_list', description: '站内通知列表（含未读数）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },

  { name: 'flows_list', description: '列出所有任务（含 cron/enabled/nextRunAt/上次结果）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'flow_get', description: '读取单个任务的完整定义（nodes/edges/vars/log/notify）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'flow_validate', description: '静态校验流程定义（节点类型/连线/允许请求源，不落库）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['nodes'], properties: { name: { type: 'string' }, nodes: { type: 'array' }, edges: { type: 'array' }, allowEmptyDraft: { type: 'boolean' } } } },
  { name: 'flow_run', description: '运行一个任务，支持 wait=false 异步触发与 debug 模式', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, wait: { type: 'boolean', default: true }, debug: { type: 'boolean', default: false } } } },
  { name: 'flow_logs', description: '读取某任务的连续日志流（多次运行的人话日志）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, limit: { type: 'number' }, before: { type: 'string' } } } },
  { name: 'flow_update_vars', description: '合并更新任务变量（如 cookie / wbToken / ua），传 null 可删除键，不回显敏感明文', annotations: { readOnlyHint: false, idempotentHint: true }, inputSchema: { type: 'object', required: ['id', 'vars'], properties: { id: { type: 'string' }, vars: { type: 'object' } } } },
  { name: 'flow_update', description: '更新任务基础配置（name/cron/timezone/jitterMinutes/enabled/note）', annotations: { readOnlyHint: false, idempotentHint: true }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, cron: { type: 'string' }, timezone: { type: 'string' }, jitterMinutes: { type: 'number' }, enabled: { type: 'boolean' }, note: { type: 'string' }, group: { type: 'string' } } } },
  { name: 'flow_toggle', description: '启用/停用某个任务的定时调度', annotations: { readOnlyHint: false, idempotentHint: true }, inputSchema: { type: 'object', required: ['id', 'enabled'], properties: { id: { type: 'string' }, enabled: { type: 'boolean' } } } },
  { name: 'flow_create', description: '新建一个任务（可从模板克隆；至少给 name）', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, cron: { type: 'string' }, timezone: { type: 'string' }, group: { type: 'string' }, vars: { type: 'object' }, templateId: { type: 'string' }, nodes: { type: 'array' }, edges: { type: 'array' }, enabled: { type: 'boolean' } } } },
  { name: 'flow_notify_test', description: '向该任务配置的通知渠道发一条测试消息', annotations: { readOnlyHint: false, idempotentHint: false }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'flow_delete', description: '删除一个任务（不可恢复；需要 write 作用域）', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },

  { name: 'templates_list', description: '列出所有模板（含变量名）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'template_get', description: '读取模板详情（变量名与默认变量值，敏感项已脱敏）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'template_instantiate', description: '从模板创建任务（变量各自覆盖，保留模板流程图）', annotations: { readOnlyHint: false, idempotentHint: false }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, vars: { type: 'object' }, note: { type: 'string' } } } },
  { name: 'import_curl', description: '把 cURL 命令解析为 http 节点配置（不创建任务）', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } },
  { name: 'runs_list', description: '列出某任务的历史运行记录', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['flowId'], properties: { flowId: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'run_get', description: '读取某次运行的完整日志与变量快照', annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'run_cancel', description: '取消排队中或运行中的任务运行（需要 run 作用域）', annotations: { readOnlyHint: false, idempotentHint: true }, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
];

export async function executeMcpTool(name, rawArgs, api) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  switch (name) {
    case 'health': return api('GET', '/api/health');
    case 'whoami': return api('GET', '/api/me');
    case 'stats': return api('GET', '/api/system/stats');
    case 'notifications_list': return api('GET', `/api/notifications?limit=${encodeURIComponent(args.limit || 50)}`);
    case 'flows_list': {
      const all = await api('GET', '/api/flows');
      const s = String(args.search || '').trim().toLowerCase();
      return s ? all.filter((f) => String(f.name || '').toLowerCase().includes(s) || String(f.group || '').toLowerCase().includes(s)) : all;
    }
    case 'flow_get': return api('GET', `/api/flows/${encodeURIComponent(args.id)}`);
    case 'flow_validate': return api('POST', '/api/flows/validate', args);
    case 'flow_run': return api('POST', `/api/flows/${encodeURIComponent(args.id)}/run`, {
      ...(args.wait === false ? { wait: false } : {}),
      ...(args.debug === true ? { debug: true } : {}),
    });
    case 'flow_logs': {
      const q = new URLSearchParams({ limit: String(args.limit || 200) });
      if (args.before) q.set('before', String(args.before));
      return api('GET', `/api/flows/${encodeURIComponent(args.id)}/logs?${q.toString()}`);
    }
    case 'flow_update_vars': return api('PATCH', `/api/flows/${encodeURIComponent(args.id)}/vars`, { vars: args.vars || {} });
    case 'flow_update': {
      const patch = {};
      for (const k of ['name', 'cron', 'timezone', 'jitterMinutes', 'enabled', 'note', 'group']) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      return api('PUT', `/api/flows/${encodeURIComponent(args.id)}`, patch);
    }
    case 'flow_toggle': return api('PUT', `/api/flows/${encodeURIComponent(args.id)}`, { enabled: !!args.enabled });
    case 'flow_create': {
      if (args.templateId) {
        const flow = await api('POST', `/api/templates/${encodeURIComponent(args.templateId)}/instantiate`, {
          name: args.name,
          vars: args.vars || {},
        });
        const patch = {};
        for (const k of ['cron', 'timezone', 'enabled', 'group']) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        return Object.keys(patch).length ? api('PUT', `/api/flows/${encodeURIComponent(flow.id)}`, patch) : flow;
      }
      return api('POST', '/api/flows', {
        name: args.name,
        cron: args.cron || '',
        timezone: args.timezone || 'Asia/Shanghai',
        group: args.group,
        enabled: args.enabled === true,
        vars: args.vars || {},
        nodes: args.nodes || [{ id: 'n0', type: 'log', name: '开始', x: 100, y: 120, config: { text: '开始执行' } }],
        edges: args.edges || [],
      });
    }
    case 'flow_notify_test': return api('POST', `/api/flows/${encodeURIComponent(args.id)}/notify-test`, {});
    case 'flow_delete': return api('DELETE', `/api/flows/${encodeURIComponent(args.id)}`);
    case 'templates_list': return api('GET', '/api/templates');
    case 'template_get': return api('GET', `/api/templates/${encodeURIComponent(args.id)}`);
    case 'template_instantiate': return api('POST', `/api/templates/${encodeURIComponent(args.id)}/instantiate`, {
      name: args.name, vars: args.vars, note: args.note,
    });
    case 'import_curl': return api('POST', '/api/import/curl', { command: args.command });
    case 'runs_list': return api('GET', `/api/runs?flowId=${encodeURIComponent(args.flowId || '')}&limit=${encodeURIComponent(args.limit || 30)}`);
    case 'run_get': return api('GET', `/api/runs/${encodeURIComponent(args.id)}`);
    case 'run_cancel': return api('POST', `/api/runs/${encodeURIComponent(args.id)}/cancel`, {});
    default: throw new Error(`未知工具: ${name}`);
  }
}
