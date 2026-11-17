/**
 * 向导纯逻辑（无 React / 无 DOM 依赖）：组件与服务端单测共用同一份实现，
 * 避免「测试抄一份副本、和 shipped 代码分叉」。
 */

/** 自然语言式向导（菜单式）：填站点/事件 → 生成流程骨架（全程不写正则） */
export function buildWizardFlow({ url, method, keyword, eventLabel }) {
  const hostname = (() => {
    try { return new URL(url).hostname; } catch { return '自定义任务'; }
  })();
  const nodes = [
    { id: 'n0', type: 'http', name: `${method} ${hostname}`, x: 80, y: 60, config: { method, url, headers: [{ name: 'user-agent', value: 'Mozilla/5.0', enabled: true }], body: '', asserts: keyword ? [{ res: [keyword], from: 'content' }] : [] } },
    { id: 'n1', type: 'log', name: '记录结果', x: 360, y: 60, config: { text: `${eventLabel}完成：{{last.status}}` } },
  ];
  const edges = [{ id: 'e0', source: 'n0', sourceHandle: 'success', target: 'n1' }];
  return { name: `${hostname} · ${eventLabel}`, nodes, edges, vars: {}, cron: '0 8 * * *', timezone: 'Asia/Shanghai', enabled: false };
}

/** 自然语言解析（对话生成原型）：一句话 → {url, method, keyword, eventLabel} */
export function parseNatural(text) {
  const t = String(text || '');
  const urlM = t.match(/https?:\/\/[^\s"'）)]+/);
  const url = urlM ? urlM[0] : '';
  const method = /\bPOST\b/i.test(t) ? 'POST' : 'GET';
  const kwM = t.match(/看到(.{2,12}?)算?成功/) || t.match(/成功词[是:：](.{2,12})/);
  const keyword = kwM ? kwM[1].replace(/算?成功$/, '').trim() : '';
  const events = ['签到', '抽卡', '库存监控', '信息查询'];
  const eventLabel = events.find((e) => t.includes(e)) || (t.includes('签到') ? '签到' : '其他');
  return { url, method, keyword, eventLabel };
}
