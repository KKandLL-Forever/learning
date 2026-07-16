// 第 0002 课：单 Agent 循环实现

import {
  AgentConfig,
  ContentBlock,
  Message,
  ModelResponseChunk,
} from "./types.ts";
import { ToolRegistry } from "./tools.ts";

export class Agent {
  private config: AgentConfig;
  private tools: ToolRegistry;

  constructor(config: AgentConfig, tools: ToolRegistry) {
    this.config = config;
    this.tools = tools;
  }

  async *run(userInput: string): AsyncGenerator<ModelResponseChunk, void, unknown> {
    const messages: Message[] = [];

    if (this.config.systemPrompt) {
      messages.push({ role: "system", content: this.config.systemPrompt });
    }

    messages.push({ role: "user", content: userInput });

    const maxTurns = this.config.maxTurns ?? 10;
    let responseText = "";

    for (let turn = 0; turn < maxTurns; turn++) {
      let turnText = "";
      const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];

      // 流式接收模型输出
      for await (const chunk of this.config.model.stream(
        messages,
        this.tools.getAllDefinitions(),
      )) {
        yield chunk;

        if (chunk.type === "text" && chunk.text) {
          turnText += chunk.text;
        }

        if (chunk.type === "tool_use" && chunk.toolUse) {
          toolUses.push(chunk.toolUse);
        }
      }

      // 把模型本次回复加入历史
      messages.push({ role: "assistant", content: turnText });

      // 没有工具调用 → 任务完成
      if (toolUses.length === 0) {
        responseText = turnText;
        break;
      }

      // 执行工具，并把结果塞回历史
      const toolResultBlocks: ContentBlock[] = [];
      for (const toolUse of toolUses) {
        const result = await this.tools.execute(toolUse.name, toolUse.input);
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }
      if (toolResultBlocks.length > 0) {
        messages.push({ role: "user", content: toolResultBlocks });
      }
    }

    yield {
      type: "done",
      result: { response: responseText, messages, turns: messages.length },
    };
  }
}
