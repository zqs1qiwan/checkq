/**
 * cron 调度器 — croner，时区支持
 * flow.enabled && flow.cron → 每分钟 tick 匹配
 */

import { Cron } from 'croner';
import { recoveryAction, nextProbeTime } from './recovery.js';

export class Scheduler {
  constructor(store, runner) {
    this.store = store;
    this.runner = runner; // { runFlow(flow, trigger) }
    this.jobs = new Map(); // flowId -> Cron
    this.interval = null;
    this.recoveryInterval = null;
  }

  start() {
    this.rebuild();
    // 每 60s 对账一次（外部改动 flow 后自动重建任务）
    this.interval = setInterval(() => this.rebuild(), 60_000);
    // 恢复探测独立对账：只扫「自动停用且开启 recovery」的任务
    this.recoveryInterval = setInterval(() => this.#tickRecovery(), 60_000);
    this.#tickRecovery();
  }

  stop() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    if (this.interval) clearInterval(this.interval);
    if (this.recoveryInterval) clearInterval(this.recoveryInterval);
  }

  rebuild() {
    const want = new Map();
    for (const f of this.store.flows) {
      if (f.enabled && f.cron) want.set(f.id, f);
    }
    // 移除不再需要的（包含非 flows 的汇总任务 id 统一在这里对账）
    for (const [id, job] of this.jobs) {
      if (id.startsWith('__summary__')) continue;
      if (!want.has(id) || job.expression !== want.get(id).cron) {
        job.stop();
        this.jobs.delete(id);
      }
    }
    // 新增
    for (const [id, f] of want) {
      if (this.jobs.has(id)) continue;
      try {
        const job = new Cron(f.cron, { timezone: f.timezone || 'Asia/Shanghai' }, async () => {
          const flow = this.store.getFlow(id);
          if (!flow || !flow.enabled) return;
          // 随机抖动（PRD §4.5）：触发时刻在 cron 点后随机延迟 0-jitterMinutes 分钟，避免整点风控
          const jitter = Math.min(30, Math.max(0, Number(flow.jitterMinutes) || 0));
          const delay = jitter > 0 ? Math.random() * jitter * 60 * 1000 : 0;
          if (delay > 0) console.log(`[CheckQ] jitter: ${flow.name} 延迟 ${Math.round(delay / 1000)}s (${jitter}min 抖动)`);
          setTimeout(async () => {
            const cur = this.store.getFlow(id);
            if (!cur || !cur.enabled) return;
            // 上一次运行（可能正在退避重试）还没结束 → 跳过这一拍，避免同一任务堆积
            if (this.runner.isBusy && this.runner.isBusy(id)) {
              console.log(`[CheckQ] 跳过 ${cur.name}：上一次运行/重试尚未结束`);
              return;
            }
            await this.runner.runFlow(cur, 'cron');
          }, delay);
        });
        this.jobs.set(id, job);
      } catch (err) {
        console.error(`[CheckQ] cron "${f.cron}" invalid on flow ${f.name}: ${err.message}`);
      }
    }
    this.#syncDailySummary();
  }

  /**
   * 自动恢复探测：只处理「自动停用 + recovery.enabled」的任务。
   * 先写下一次时间再启动，避免运行期间 60s 对账重复触发；
   * probe 失败由 api.runFlow 计数，调度器只负责按时发起。
   */
  #tickRecovery() {
    const now = Date.now();
    for (const f of this.store.flows) {
      const plan = recoveryAction(f, now);
      if (plan.action === 'init') {
        const rec = { ...plan.recovery, nextProbeAt: plan.nextProbeAt };
        this.store.updateFlow(f.id, { recovery: rec });
        continue;
      }
      if (plan.action !== 'probe') continue;
      if (this.runner.isBusy && this.runner.isBusy(f.id)) {
        console.log(`[CheckQ] 跳过恢复探测 ${f.name}：任务仍在运行`);
        continue;
      }
      const rec = { ...plan.recovery, nextProbeAt: nextProbeTime(plan.recovery, now), lastProbeAt: now };
      this.store.updateFlow(f.id, { recovery: rec });
      const cur = this.store.getFlow(f.id);
      if (!cur) continue;
      console.log(`[CheckQ] 恢复探测 ${cur.name}（第 ${rec.attempts + 1}/${rec.maxAttempts} 次）`);
      Promise.resolve(this.runner.runFlow(cur, 'probe', { notify: false }).catch((err) => {
        console.error(`[CheckQ] 恢复探测异常 ${cur.name}: ${err.message}`);
      }));
    }
  }

  #syncDailySummary() {
    const cfg = this.store.meta.dailySummary || {};
    const id = '__summary__';
    const existing = this.jobs.get(id);
    if (!cfg.enabled || !cfg.time) {
      if (existing) { existing.stop(); this.jobs.delete(id); }
      return;
    }
    const expr = `${String(cfg.time).split(':')[1] || '0'} ${String(cfg.time).split(':')[0] || '8'} * * *`;
    if (existing && existing.expression === expr) return;
    if (existing) existing.stop();
    try {
      const job = new Cron(expr, { timezone: cfg.timezone || 'Asia/Shanghai' }, async () => {
        if (this.runner.sendDailySummary) await this.runner.sendDailySummary();
      });
      this.jobs.set(id, job);
    } catch (err) {
      console.error(`[CheckQ] daily summary cron invalid: ${err.message}`);
    }
  }
}
