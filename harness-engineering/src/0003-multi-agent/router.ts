// 第 0003 课：路由器 — 决定任务交给谁

import { Router, Worker } from "./types.ts";

// 关键词路由：规则驱动，离线可用，最容易理解。
// 生产环境里通常换成"模型路由"（ModelRouter）：把各 Worker 的
// description 拼进 prompt，让 LLM 输出该调用哪个 Worker。
export class KeywordRouter implements Router {
  constructor(
    private rules: { keywords: string[]; worker: string }[],
  ) {}

  async route(task: string, workers: Worker[]): Promise<string[]> {
    const chosen = new Set<string>();

    for (const rule of this.rules) {
      if (rule.keywords.some((k) => task.includes(k))) {
        chosen.add(rule.worker);
      }
    }

    // 没命中任何规则 → 兜底交给第一个 Worker
    if (chosen.size === 0 && workers.length > 0) {
      chosen.add(workers[0].name);
    }

    return [...chosen];
  }
}
