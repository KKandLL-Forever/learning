/**
 * mini-cc v2 —— 批次执行
 *
 * 对照真实源码：src/services/tools/toolOrchestration.ts:19 `runTools()`
 *
 * 分批只解决了一半问题，另一半在这里：
 *   批与批之间【严格串行】，批内才并发。
 *
 * 真实源码用一个普通的 for...of 遍历批次，每批内部 for await 消费到底
 * 才进入下一批。因果顺序就是这么保证的。
 */

import { all } from './concurrency.js'
import { partitionToolCalls, type Batch } from './partition.js'
import type { QueryEvent, Tool, ToolResultBlock, ToolUseBlock } from './types.js'

/** 真实源码：CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY，默认 10。 */
function maxConcurrency(): number {
  return Number.parseInt(process.env.MINI_CC_MAX_CONCURRENCY || '', 10) || 10
}

/** 单个工具跑出来的东西：若干进度事件，外加最后一条结果。 */
type ToolStep =
  | { kind: 'event'; event: QueryEvent }
  | { kind: 'result'; result: ToolResultBlock }

export async function* runTools(
  toolUses: ToolUseBlock[],
  tools: Tool[],
): AsyncGenerator<QueryEvent, ToolResultBlock[]> {
  const batches = partitionToolCalls(toolUses, tools)

  // 先把分批方案交出去，UI 可以直接画出来。
  yield {
    type: 'batch_plan',
    batches: batches.map((b) => ({
      isConcurrencySafe: b.isConcurrencySafe,
      names: b.blocks.map((x) => x.name),
    })),
  }

  // 并发批里结果的到达顺序是乱的，按 tool_use_id 收集，最后按原始顺序还原。
  // API 只要求每个 tool_use 都有配对的 tool_result，不强制顺序，
  // 但保持原序能让 transcript 读起来和模型请求的顺序一致，调试省事。
  const collected = new Map<string, ToolResultBlock>()

  for (const [index, batch] of batches.entries()) {
    yield { type: 'batch_start', index, total: batches.length, batch: describe(batch) }

    if (batch.isConcurrencySafe) {
      // 批内并发，上限 10。all() 谁先有动静就先交付谁。
      const generators = batch.blocks.map((block) => runOne(block, tools))
      for await (const step of all(generators, maxConcurrency())) {
        if (step.kind === 'event') yield step.event
        else collected.set(step.result.tool_use_id, step.result)
      }
    } else {
      // 不安全批一律串行。真实源码里这一批通常只有一个调用，
      // 因为不安全的调用在分批时就被单独切出来了。
      for (const block of batch.blocks) {
        for await (const step of runOne(block, tools)) {
          if (step.kind === 'event') yield step.event
          else collected.set(step.result.tool_use_id, step.result)
        }
      }
    }

    yield { type: 'batch_end', index }
    // 这个 yield 之后才进入下一批 —— 上一批的副作用此刻已经全部落地。
  }

  return toolUses.map((use) => collected.get(use.id)!).filter(Boolean)
}

function describe(batch: Batch) {
  return {
    isConcurrencySafe: batch.isConcurrencySafe,
    names: batch.blocks.map((b) => b.name),
  }
}

/**
 * 执行单个工具调用，把过程拆成事件流。
 *
 * 和 v1 的 runOne 相比只有一处结构变化：它现在是【生成器】而不是普通函数。
 * 因为要交给 all() 去合流，all() 合的是生成器。
 *
 * 永不抛异常这条约束没变，见第 0001 课。
 */
async function* runOne(
  use: ToolUseBlock,
  tools: Tool[],
): AsyncGenerator<ToolStep, void> {
  const tool = tools.find((t) => t.name === use.name)

  yield { kind: 'event', event: { type: 'tool_start', name: use.name, input: use.input } }

  const emit = (content: string, isError: boolean): ToolStep => ({
    kind: 'result',
    result: { type: 'tool_result', tool_use_id: use.id, content, ...(isError && { is_error: true }) },
  })

  if (!tool) {
    const message = `Error: 没有名为 "${use.name}" 的工具。可用工具：${tools.map((t) => t.name).join(', ')}`
    yield { kind: 'event', event: { type: 'tool_end', name: use.name, preview: message, isError: true } }
    yield emit(message, true)
    return
  }

  const input = (use.input ?? {}) as Record<string, unknown>

  const validation = tool.validateInput?.(input)
  if (validation && !validation.ok) {
    const message = `Error: ${validation.message}`
    yield { kind: 'event', event: { type: 'tool_end', name: use.name, preview: message, isError: true } }
    yield emit(message, true)
    return
  }

  try {
    const content = await tool.call(input)
    yield { kind: 'event', event: { type: 'tool_end', name: use.name, preview: content.slice(0, 200), isError: false } }
    yield emit(content, false)
  } catch (error) {
    const message = `Error: ${error instanceof Error ? error.message : String(error)}`
    yield { kind: 'event', event: { type: 'tool_end', name: use.name, preview: message, isError: true } }
    yield emit(message, true)
  }
}
