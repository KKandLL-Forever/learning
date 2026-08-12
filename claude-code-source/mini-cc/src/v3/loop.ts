/**
 * mini-cc v3 —— 内核（工具执行整段搬到了 runTools.ts）
 *
 * 对照真实源码：src/query.ts（1680 行）
 *   - State 类型          → query.ts:201
 *   - queryLoop()         → query.ts:238
 *   - 调用 runTools()      → query.ts:1340
 *
 * v2 把循环里那段「挨个跑工具」的 for 循环整个换掉了，换成一行
 * yield* runTools(...)。循环因此变短，而且它不再知道谁能并发。
 *
 * 这正是第 0002 课那个说法的兑现：工具契约里的 isConcurrencySafe
 * 是给【调度器】这个消费者准备的，循环从头到尾没读过它。
 */

import { runTools } from './runTools.js'
import type {
  Message,
  ModelAdapter,
  PermissionContext,
  QueryEvent,
  Terminal,
  Tool,
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
  /** v3 新增：权限上下文。模型「想调用」不再等于「能调用」。 */
  permissions: PermissionContext
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
  const { system, tools, model, signal, permissions } = params
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

    // ── 有 tool_use → 交给调度器 ─────────────────────
    // v0/v1 在这里写了个 for 循环挨个跑。v2 换成 runTools()：
    // 它先分批，再按「批间串行、批内并发」执行。
    // 循环本身不需要知道谁能并发，那是工具契约回答的问题。
    const results = yield* runTools(toolUses, tools, permissions)

    // 整体重写 state —— 要么全写，要么类型报错。
    state = {
      messages: [...messages, assistant, { role: 'user', content: results }],
      turnCount: turnCount + 1,
      transition: 'tool_use',
    }
  }
}
