/**
 * mini-cc v2 —— buildTool 与 fail-closed 默认值
 *
 * 对照真实源码：src/Tool.ts:757 `TOOL_DEFAULTS` · Tool.ts:783 `buildTool()`
 *
 * ── 这个文件存在的唯一理由 ──
 *
 * 工具作者会忘事。47 个成员，不可能每个工具都写全。
 * 问题是：【当作者没写时，系统该假设什么？】
 *
 * "fail-closed"（失败时关闭）是安全工程的基本原则：
 * 信息缺失时，选那个「猜错了也不会出事」的方向。
 * 门禁系统断电时应该锁死而不是打开——就是这个意思。
 */

import type {
  DefaultableToolKeys,
  Tool,
  ToolDef,
} from './types.js'

/**
 * 默认值全部倒向「保守」的一侧。
 *
 * 以 isConcurrencySafe 为例，两个方向的后果完全不对称：
 *
 *   默认 true  → 工具可能被安排和别的工具并行执行。
 *                两个写操作打架 → 数据损坏。
 *                而且只在时序不巧时复现，极难调试。
 *
 *   默认 false → 最坏结果是它被串行执行，慢一点。
 *
 * 所以默认 false。isReadOnly 同理——假设它会写。
 */
export const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: Record<string, unknown>) => false, // 假定不安全
  isReadOnly: (_input?: Record<string, unknown>) => false, // 假定会写
  isDestructive: (_input?: Record<string, unknown>) => false,
  maxResultSizeChars: 50_000,
  userFacingName: (_input?: Record<string, unknown>) => '',
  renderToolUse: (input?: Record<string, unknown>) => JSON.stringify(input ?? {}),
}

type ToolDefaults = typeof TOOL_DEFAULTS

/**
 * 类型层面镜像运行时的 `{ ...TOOL_DEFAULTS, ...def }` 展开。
 *
 * 作用：如果 def 提供了某个可默认成员，用 def 的类型；
 * 没提供就用默认值的类型。这样 buildTool 的返回值永远是完整的 Tool，
 * 调用方不需要到处写 `tool.isReadOnly?.(input) ?? false`。
 *
 * 对照真实源码：Tool.ts:735 `BuiltTool<D>`
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * 从一个可以省略成员的定义，构造出完整的 Tool。
 *
 * 所有工具都应该走这个函数——这样默认值只存在于一个地方。
 *
 * 注意 userFacingName 的位置：它在展开的【中间】。
 * 先铺 TOOL_DEFAULTS，再用 def.name 覆盖 userFacingName，
 * 最后铺 def —— 所以工具自己声明的 userFacingName 仍然赢。
 * 真实源码 Tool.ts:787 是一模一样的三层顺序。
 */
export function buildTool<D extends ToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as unknown as BuiltTool<D>
}

/**
 * 把一个工具的安全声明压成一行，给终端表格用。
 * 顺带让「默认值」这件事在界面上肉眼可见。
 */
export function describeSafety(
  tool: Tool,
  input: Record<string, unknown> = {},
): string {
  const flags = [
    tool.isReadOnly(input) ? '只读' : '会写',
    tool.isConcurrencySafe(input) ? '可并发' : '须串行',
    tool.isDestructive(input) ? '不可逆' : '可逆',
  ]
  return flags.join(' · ')
}
