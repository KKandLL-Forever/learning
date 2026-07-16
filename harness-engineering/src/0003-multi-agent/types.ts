// 第 0003 课：多 Agent 系统 — 类型定义

import { ModelAdapter, ModelResponseChunk } from "../0002-single-agent-loop/types.ts";

// Agent 之间传递的消息（消息传递协议的最小形态）
export interface AgentMessage {
  from: string;
  to: string;
  content: string;
}

// Worker：一个能接收任务、返回结果的子 Agent
export interface Worker {
  name: string;
  description: string; // 给 Orchestrator 看，用于路由决策
  run(task: string): Promise<string>;
}

// Router：决定把任务交给哪些 Worker
export interface Router {
  route(task: string, workers: Worker[]): Promise<string[]>;
}

// 极简脚本化模型：返回固定回复，用于离线演示（无需 API Key）
// 它同样实现 ModelAdapter，所以能直接塞进第 0002 课的 Agent。
export class ScriptedModel implements ModelAdapter {
  constructor(private reply: string) {}

  async *stream(): AsyncIterable<ModelResponseChunk> {
    yield { type: "text", text: this.reply };
  }
}
