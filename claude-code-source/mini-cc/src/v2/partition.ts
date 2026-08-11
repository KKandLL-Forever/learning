/**
 * mini-cc v2 —— 把一批 tool_use 切成批次
 *
 * 对照真实源码：src/services/tools/toolOrchestration.ts:91 `partitionToolCalls()`
 *
 * 规则只有一条：
 *   合并【位置上相邻】的安全调用，碰到不安全的就断开，后面重新起一批。
 *
 * 注意「相邻」两个字。很多人第一眼会以为是「把所有只读的挑出来一起跑」，
 * 那是错的。判断条件只看【最后一个批次】是不是安全批，跨不过中间的写操作。
 */

import type { Tool, ToolUseBlock } from './types.js'

export type Batch = {
  isConcurrencySafe: boolean
  blocks: ToolUseBlock[]
}

/**
 * 判断这一次调用安不安全。
 *
 * 两道 fail-closed 保险，都来自真实源码 toolOrchestration.ts:98-108：
 *   1. 工具不存在、或参数没通过 schema 校验 → 一律 false
 *   2. isConcurrencySafe 自己抛异常 → catch 住，返回 false
 *
 * 第 2 条的源码注释点名了真实场景：BashTool 判断只读性时要解析 shell 引号，
 * 解析炸了就会抛。这时候「不知道安不安全」必须当成「不安全」。
 */
function checkSafe(tool: Tool | undefined, input: unknown): boolean {
  if (!tool) return false

  const parsed = validateAgainstSchema(tool, input)
  if (!parsed.ok) return false

  try {
    // 注意传了 input。同一个工具的安全性可以取决于具体调用，
    // 真实源码里 BashTool 就是靠这个区分 `ls` 和 `rm x`。
    return Boolean(tool.isConcurrencySafe(parsed.value))
  } catch {
    return false
  }
}

/** v2 的 schema 校验很浅，够用就行。真实源码用的是 zod 的 safeParse。 */
function validateAgainstSchema(
  tool: Tool,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (input === null || typeof input !== 'object') return { ok: false }
  const value = input as Record<string, unknown>
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in value)) return { ok: false }
  }
  return { ok: true, value }
}

export function partitionToolCalls(
  toolUses: ToolUseBlock[],
  tools: Tool[],
): Batch[] {
  return toolUses.reduce<Batch[]>((acc, toolUse) => {
    const tool = tools.find((t) => t.name === toolUse.name)
    const isConcurrencySafe = checkSafe(tool, toolUse.input)

    const lastBatch = acc[acc.length - 1]

    // 整个算法就是这个 if。
    // 右半边 lastBatch?.isConcurrencySafe 是「相邻」的全部含义：
    // 只看上一批是不是安全批，不去翻更早的批次。
    if (isConcurrencySafe && lastBatch?.isConcurrencySafe) {
      lastBatch.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
