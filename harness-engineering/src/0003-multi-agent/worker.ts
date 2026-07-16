// 第 0003 课：把第 0002 课的 Agent 包装成一个 Worker

import { Agent } from "../0002-single-agent-loop/agent.ts";
import { ToolRegistry } from "../0002-single-agent-loop/tools.ts";
import { ModelAdapter } from "../0002-single-agent-loop/types.ts";
import { Worker } from "./types.ts";

// 每个 Worker 内部持有一个独立的 Agent 实例 → 独立的 messages 历史，
// 这就是"上下文隔离"：一个 Worker 的对话不会污染另一个 Worker。
export function makeWorker(opts: {
  name: string;
  description: string;
  model: ModelAdapter;
  systemPrompt: string;
  tools?: ToolRegistry;
}): Worker {
  const agent = new Agent(
    { model: opts.model, systemPrompt: opts.systemPrompt },
    opts.tools ?? new ToolRegistry(),
  );

  return {
    name: opts.name,
    description: opts.description,
    async run(task: string): Promise<string> {
      let final = "";
      for await (const chunk of agent.run(task)) {
        if (chunk.type === "done" && chunk.result) {
          final = chunk.result.response;
        }
      }
      return final;
    },
  };
}
