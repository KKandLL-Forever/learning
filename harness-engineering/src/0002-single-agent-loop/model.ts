// 第 0002 课：Model Adapter（ mock + DeepSeek 两种实现）

import OpenAI from "openai";
import {
  Message,
  MessageContent,
  ModelAdapter,
  ModelResponseChunk,
  TextContent,
  ToolDefinition,
  ToolUse,
} from "./types.ts";

// 教学用 Mock Model：不需要 API Key，按固定规则模拟 Tool Use
export class MockModel implements ModelAdapter {
  private turn = 0;
  private originalInput = "";

  private extractText(content: MessageContent): string {
    if (typeof content === "string") return content;
    return content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
  ): AsyncIterable<ModelResponseChunk> {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const input = this.extractText(lastUserMessage?.content ?? "");

    // 记住原始用户输入，避免工具结果块覆盖它
    if (input.length > 0 && !input.includes("tool_result")) {
      this.originalInput = input;
    }

    this.turn++;

    // 第一次调用：让模型"决定"调用 get_weather
    if (this.turn === 1) {
      const city = this.originalInput.includes("北京") ? "北京" : "上海";
      const toolUse: ToolUse = {
        id: `tool_${this.turn}`,
        name: "get_weather",
        input: { city },
      };
      yield { type: "text", text: `我帮你查一下${city}的天气。` };
      yield { type: "tool_use", toolUse };
      return;
    }
    if(this.turn === 2) {
      const toolUse: ToolUse = {
        id: `tool_${this.turn}`,
        name: "get_time",
        input: { time: "2026-07-11 11:20:00" },
      };
      yield { type: "text", text: `我帮你查一下当前时间。` };
      yield { type: "tool_use", toolUse };
      return;
    }

    // 拿到工具结果后：总结回答
    const city = this.originalInput.includes("北京") ? "北京" : "上海";
    yield { type: "text", text: `根据查询结果，${city}当前天气：晴天，25°C，湿度 45%。` };
    const time = "2026-07-11 11:20:00";
    yield { type: "text", text: `当前时间是：${time}` };
  }
}

// DeepSeek 真实模型适配器
// DeepSeek 提供 OpenAI 兼容接口，所以直接用 openai SDK，只改 baseURL。
export class DeepSeekModel implements ModelAdapter {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "deepseek-v4-flash") {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com",
    });
    this.model = model;
  }

  // 把我们内部的 Message 翻译成 OpenAI/DeepSeek 的消息格式。
  // 说明：DeepSeek 用 role:"tool" + tool_call_id 回传工具结果，
  // 这里为保持教学示例简洁，把工具结果块降级成一条 user 文本消息，
  // 真实项目里应保留 tool_call_id 走标准的 tool 角色协议。
  private toOpenAIMessage(m: Message): OpenAI.Chat.ChatCompletionMessageParam {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }
    const text = m.content
      .map((b) => (b.type === "text" ? b.text : `工具结果：${b.content}`))
      .join("\n");
    return { role: m.role, content: text };
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
  ): AsyncIterable<ModelResponseChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      messages: messages.map((m) => this.toOpenAIMessage(m)),
      tools: tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    });

    // 工具调用的参数是分片流式返回的，按 index 累积后再一次性 yield
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const part of stream) {
      const delta = part.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: "text", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const acc = toolCalls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCalls.set(tc.index, acc);
        }
      }
    }

    for (const acc of toolCalls.values()) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(acc.args || "{}");
      } catch {
        input = {};
      }
      yield { type: "tool_use", toolUse: { id: acc.id, name: acc.name, input } };
    }
  }
}
