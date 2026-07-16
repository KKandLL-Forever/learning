// 第 0003 课：编排者 — 路由、分发、收集、汇总

import { AgentMessage, Router, Worker } from "./types.ts";

export class Orchestrator {
  constructor(
    private workers: Worker[],
    private router: Router,
  ) {}

  async run(userTask: string): Promise<{ answer: string; log: AgentMessage[] }> {
    const log: AgentMessage[] = [];
    log.push({ from: "user", to: "orchestrator", content: userTask });

    // 1. 路由：决定把任务交给哪些 Worker
    const chosen = await this.router.route(userTask, this.workers);

    // 2. 分发 + 收集
    //    这里为教学清晰用顺序执行；相互独立的任务可以用
    //    Promise.all 并行，是多 Agent 系统的一大性能优势。
    const results: AgentMessage[] = [];
    for (const name of chosen) {
      const worker = this.workers.find((w) => w.name === name);
      if (!worker) continue;

      log.push({ from: "orchestrator", to: name, content: userTask });
      const result = await worker.run(userTask);

      const msg: AgentMessage = { from: name, to: "orchestrator", content: result };
      results.push(msg);
      log.push(msg);
    }

    // 3. 汇总：把各 Worker 的结果合并成最终答案
    const answer = this.synthesize(results);
    log.push({ from: "orchestrator", to: "user", content: answer });

    return { answer, log };
  }

  private synthesize(results: AgentMessage[]): string {
    if (results.length === 0) return "（没有 Worker 处理该任务）";
    if (results.length === 1) return results[0].content;
    // 多个结果 → 标注来源后拼接
    return results.map((r) => `【${r.from}】${r.content}`).join("\n");
  }
}
