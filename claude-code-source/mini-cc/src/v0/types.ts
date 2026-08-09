/**
 * mini-cc v0 —— 类型契约
 *
 * 对照真实源码：src/types/message.ts、src/Tool.ts、src/query/transitions.ts
 *
 * v0 只保留能让循环跑起来的最小集合。真实的 Tool 有 40+ 个成员（第 0002 课展开），
 * 真实的 Terminal 有更多终止原因，这里都先砍掉。
 */

// ── 消息内容块 ──────────────────────────────────────────

export type TextBlock = { type: 'text'; text: string }

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AssistantContent = TextBlock | ToolUseBlock

export type UserMessage = {
  role: 'user'
  content: string | ToolResultBlock[]
}

export type AssistantMessage = {
  role: 'assistant'
  content: AssistantContent[]
}

export type Message = UserMessage | AssistantMessage

// ── 终止原因 ────────────────────────────────────────────

/**
 * 循环不返回「答案」，返回「为什么停下来了」。
 *
 * 这是整个设计里最容易被忽略的一个决定：答案已经通过 yield 逐条交付出去了，
 * return 值留给调用方做控制流判断——是正常结束？还是撞上了轮次上限需要提示用户？
 */
export type Terminal =
  | { reason: 'completed' }
  | { reason: 'max_turns'; turnCount: number }
  | { reason: 'aborted' }

// ── 事件流 ──────────────────────────────────────────────

/** 循环向外持续 yield 的事件。UI 层 for await 消费它。 */
export type QueryEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_end'; name: string; preview: string; isError: boolean }

// ── 工具契约 ────────────────────────────────────────────

export type JSONSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export type Tool = {
  name: string
  description: string
  inputSchema: JSONSchema
  /** 执行工具，返回给模型看的文本结果。抛异常由循环兜住，转成 is_error 结果。 */
  call(input: Record<string, unknown>): Promise<string>
}

// ── 模型适配器 ──────────────────────────────────────────

/**
 * 循环只依赖这一个接口，不依赖任何具体 SDK。
 * 这就是 harness-engineering 第 0002 课「三个边界」里的模型边界——
 * 有了它，MockModel 才能在没有 API key 的情况下驱动整个循环。
 */
export type ModelAdapter = {
  complete(params: {
    system: string
    messages: Message[]
    tools: Tool[]
  }): Promise<AssistantMessage>
}
