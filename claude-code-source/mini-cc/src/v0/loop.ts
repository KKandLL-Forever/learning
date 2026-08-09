/**
 * mini-cc v0 —— 极简内核
 *
 * 对照真实源码：src/query.ts（1680 行）
 *   - State 类型          → query.ts:201
 *   - queryLoop()         → query.ts:238
 *   - 「整体重写 state」    → query.ts:262-276 的注释
 *
 * 这个文件是整门课的种子。后面每一课都往它身上加一个模块，
 * 但这个 while(true) 的形状不会再变。
 */

import type {
  AssistantMessage,
  Message,
  ModelAdapter,
  QueryEvent,
  Terminal,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js'

export type QueryParams = {
  messages: Message[]
  system: string
  tools: Tool[]
  model: ModelAdapter
  /** 防跑飞的硬闸。真实源码里对应 maxTurns 参数 + max_turns_reached attachment。 */
  maxTurns?: number
  signal?: AbortSignal
}

/**
 * 跨轮次携带的可变状态。
 *
 * v0 只有 3 个字段，真实源码有 10 个（消息历史、压缩状态、重试计数、
 * stopHookActive……）。但打包成一个对象的理由现在就成立：
 *
 * 循环里每个 continue 点都【整体重写】state，而不是散落几条独立赋值。
 * 漏写一个字段不会变成一个罕见路径上的诡异行为，而是当场类型报错。
 * 字段越多，这个约束越值钱。
 */
type State = {
  messages: Message[]
  turnCount: number
  /** 上一轮为何继续。测试里可以直接断言恢复路径是否触发过。 */
  transition: 'tool_use' | undefined
}

/**
 * 核心循环。
 *
 * 注意签名：AsyncGenerator<QueryEvent, Terminal>
 *   - yield 出去的是【事件】（一路交付给 UI）
 *   - return 回来的是【终止原因】（不是答案）
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryEvent, Terminal> {
  // 不可变参数——整个循环期间绝不重新赋值。
  const { system, tools, model, signal } = params
  const maxTurns = params.maxTurns ?? 10

  let state: State = {
    messages: params.messages,
    turnCount: 1,
    transition: undefined,
  }

  while (true) {
    // 每轮开头解构，读起来仍是裸变量名。
    const { messages, turnCount } = state

    // ── 闸门：先检查，再花钱 ──────────────────────────
    if (signal?.aborted) {
      return { reason: 'aborted' }
    }
    if (turnCount > maxTurns) {
      return { reason: 'max_turns', turnCount: turnCount - 1 }
    }

    yield { type: 'turn_start', turn: turnCount }

    // ── 一次 API 请求 ────────────────────────────────
    // 注意：把【完整历史】重新发一遍。模型没有记忆，
    // 它"记得"第 3 轮读过的文件，只因为那条 tool_result 还在 messages 里。
    const assistant = await model.complete({ system, messages, tools })
    yield { type: 'assistant_message', message: assistant }

    const toolUses = assistant.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    )

    // ── 没有 tool_use → 这一轮结束 ───────────────────
    if (toolUses.length === 0) {
      return { reason: 'completed' }
    }

    // ── 有 tool_use → 本地执行，结果塞回对话 ─────────
    // v0 是纯串行。第 0003 课会把这里换成「只读并发、写入串行」的分批调度。
    const results: ToolResultBlock[] = []
    for (const use of toolUses) {
      yield { type: 'tool_start', name: use.name, input: use.input }
      const result = await runOne(use, tools)
      results.push(result)
      yield {
        type: 'tool_end',
        name: use.name,
        preview: result.content.slice(0, 200),
        isError: result.is_error === true,
      }
    }

    // 整体重写 state —— 要么全写，要么类型报错。
    state = {
      messages: [...messages, assistant, { role: 'user', content: results }],
      turnCount: turnCount + 1,
      transition: 'tool_use',
    }
  }
}

/**
 * 执行单个工具调用。
 *
 * 【这个函数永不抛异常】——这是 API 契约的硬约束：
 * 每一个 tool_use 都必须有配对的 tool_result，否则下一轮请求直接 400。
 * 所以工具炸了、工具不存在、参数不对，全都转成 is_error 结果返回，
 * 让模型自己看到错误并换个思路。
 *
 * 真实源码里同一约束体现在 ensureToolResultPairing() 和
 * yieldMissingToolResultBlocks()（用户中断时给悬空 tool_use 补桩）。
 */
async function runOne(
  use: ToolUseBlock,
  tools: Tool[],
): Promise<ToolResultBlock> {
  const tool = tools.find((t) => t.name === use.name)

  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Error: 没有名为 "${use.name}" 的工具。可用工具：${tools.map((t) => t.name).join(', ')}`,
      is_error: true,
    }
  }

  try {
    const content = await tool.call((use.input ?? {}) as Record<string, unknown>)
    return { type: 'tool_result', tool_use_id: use.id, content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Error: ${message}`,
      is_error: true,
    }
  }
}
