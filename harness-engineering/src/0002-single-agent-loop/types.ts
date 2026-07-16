// 第 0002 课：单 Agent 循环 — 类型定义

export type TextContent = { type: "text"; text: string };
export type ToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
export type ContentBlock = TextContent | ToolResultContent;

export type MessageContent = string | ContentBlock[];

export interface Message {
  role: "user" | "assistant" | "system";
  content: MessageContent;
}

// JSON Schema 对象：DeepSeek/OpenAI 的 function.parameters 要求顶层必须是 { type: "object", ... }
export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<string> | string;
}

export interface ModelResponseChunk {
  type: "text" | "tool_use" | "done";
  text?: string;
  toolUse?: ToolUse;
  result?: AgentResult;
}

export interface ModelAdapter {
  stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<ModelResponseChunk>;
}

export interface AgentConfig {
  model: ModelAdapter;
  systemPrompt?: string;
  maxTurns?: number;
}

export interface AgentResult {
  response: string;
  messages: Message[];
  turns: number;
}