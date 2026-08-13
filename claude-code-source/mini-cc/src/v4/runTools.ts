/**
 * mini-cc v4 —— 批次执行
 *
 * 对照真实源码：src/services/tools/toolOrchestration.ts:19 `runTools()`
 *              src/services/tools/toolExecution.ts:1413（在这里接上预算第一层）
 *
 * 分批只解决了一半问题，另一半在这里：
 *   批与批之间【严格串行】，批内才并发。
 *
 * 真实源码用一个普通的 for...of 遍历批次，每批内部 for await 消费到底
 * 才进入下一批。因果顺序就是这么保证的。
 */

import { getPersistenceThreshold, maybePersistLargeToolResult } from './budget.js'
import { all } from './concurrency.js'
import { partitionToolCalls, type Batch } from './partition.js'
import { canUseTool } from './permissions.js'
import type {
  PermissionContext,
  QueryEvent,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js'

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
  permissions: PermissionContext,
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
      const generators = batch.blocks.map((block) => runOne(block, tools, permissions))
      for await (const step of all(generators, maxConcurrency())) {
        if (step.kind === 'event') yield step.event
        else collected.set(step.result.tool_use_id, step.result)
      }
    } else {
      // 不安全批一律串行。真实源码里这一批通常只有一个调用，
      // 因为不安全的调用在分批时就被单独切出来了。
      for (const block of batch.blocks) {
        for await (const step of runOne(block, tools, permissions)) {
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
  permissions: PermissionContext,
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

  // ── 步骤 C：权限判定 ───────────────────────────────────
  // 这一步夹在 validateInput 和 call() 之间。在此之前工具是无条件执行的，
  // 从 v3 开始，模型「想调用」不再等于「能调用」。
  const decision = await canUseTool(tool, input, permissions)
  yield {
    kind: 'event',
    event: {
      type: 'permission',
      name: use.name,
      behavior: decision.behavior,
      decidedAt: decision.decidedAt ?? '（未标注）',
    },
  }

  if (decision.behavior !== 'allow') {
    // ask 在这里也当拒绝处理。真实源码里 ask 会弹 UI 等用户点，
    // 而无人值守的后台 agent 设了 shouldAvoidPermissionPrompts，
    // 所有会变成 ask 的路径统一转成 deny，并告诉模型
    // 「是没法问，不是被禁止」，好让它换个思路而不是反复重试。
    const verb = decision.behavior === 'ask' ? '需要人工确认，当前无法询问' : '被拒绝'
    const message = `Error: ${use.name} ${verb}。${decision.message ?? ''}（判定于 ${decision.decidedAt}）`
    yield { kind: 'event', event: { type: 'tool_end', name: use.name, preview: message, isError: true } }
    yield emit(message, true)
    return
  }

  try {
    const content = await tool.call(input)
    yield { kind: 'event', event: { type: 'tool_end', name: use.name, preview: content.slice(0, 200), isError: false } }

    // ── 步骤 D：结果预算第一层 ───────────────────────────
    // 结果在【交给消息历史之前】就被换掉，而不是先塞进去再回头裁剪。
    // 位置很重要：从这里往后，全文只存在于磁盘上，
    // 内存里的 messages 从头到尾没装过那 800KB。
    const outcome = await maybePersistLargeToolResult(
      { type: 'tool_result', tool_use_id: use.id, content },
      tool.name,
      getPersistenceThreshold(tool.maxResultSizeChars),
    )
    if (outcome.persisted) {
      yield {
        kind: 'event',
        event: { type: 'result_persisted', name: use.name, ...outcome.persisted },
      }
    }
    yield { kind: 'result', result: outcome.block }
  } catch (error) {
    const message = `Error: ${error instanceof Error ? error.message : String(error)}`
    yield { kind: 'event', event: { type: 'tool_end', name: use.name, preview: message, isError: true } }
    yield emit(message, true)
  }
}
