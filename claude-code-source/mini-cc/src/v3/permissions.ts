/**
 * mini-cc v3 —— 权限判定
 *
 * 对照真实源码：src/utils/permissions/permissions.ts:1158
 *              `hasPermissionsToUseToolInner()`
 *
 * ── 这个文件里最重要的东西不是任何一个检查，而是它们的【顺序】──
 *
 * 系统里有好几种规则会对同一次调用给出互相矛盾的判断。谁赢？
 * 由检查顺序决定，先 return 的那个赢。
 *
 * 排序原则：
 *   越是「用户明确表达过的意图」和「不可挽回的破坏」，越靠前；
 *   越是「图省事的全局开关」，越靠后。
 *
 * 所以 bypassPermissions（全放行）排在第 8 位而不是第 1 位。
 * 用户开「全放行」的本意是「常规操作别烦我」，
 * 不是「允许你改我的 git 配置」。
 */

import { isAbsolute, join, resolve, sep } from 'node:path'
import type {
  PermissionContext,
  PermissionDecision,
  Tool,
} from './types.js'

// ── 敏感路径：这一层对 bypass 免疫 ──────────────────────

/**
 * 真实源码 permissions.ts:1252 注释里点名的四类：
 *   .git/ · .claude/ · .vscode/ · shell 配置
 *
 * 改这些文件的后果不可挽回，或者会影响到 Claude 自己之后的行为，
 * 所以无论什么模式都要问用户。
 */
const SENSITIVE_DIRS = ['.git', '.claude', '.vscode']
const SENSITIVE_FILES = ['.bashrc', '.zshrc', '.bash_profile', '.profile', 'profile.ps1']

export function checkPathSafety(rawPath: string, root: string): string | null {
  // 真实源码这里会同时检查原始路径【和 symlink 解析后的路径】，
  // 否则一个指向 .git/ 的软链就能绕过整套检查。
  const full = resolve(isAbsolute(rawPath) ? rawPath : join(root, rawPath))
  const parts = full.split(sep)

  for (const dir of SENSITIVE_DIRS) {
    if (parts.includes(dir)) return `路径位于敏感目录 ${dir}/ 之内`
  }
  const base = parts[parts.length - 1] ?? ''
  if (SENSITIVE_FILES.includes(base)) return `${base} 是 shell 配置文件`

  return null
}

// ── 十步判定 ────────────────────────────────────────────

/**
 * 每一步都带 `decidedAt` 标出是谁做的决定。
 * 真实源码里对应的是 `decisionReason` 字段，用途一样：
 * 出问题时能回答「这次为什么被拦/被放行」。
 */
export async function canUseTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: PermissionContext,
  /**
   * 传一个数组进来，就能拿到「这次判定走过哪些关卡」的完整记录。
   * 每条格式是 `PASS|关卡|说明` 或 `STOP|关卡|说明`。
   * 权限判定平时是个黑盒，只有把走过的路记下来才看得懂。
   */
  trace?: string[],
): Promise<PermissionDecision> {
  const inner = await canUseToolInner(tool, input, ctx, trace)

  // ── 外层变换：只在结果是 ask 时生效 ──────────────────
  //
  // 真实源码 permissions.ts:504 的注释说得很清楚：
  //   "This is done at the end so it can't be bypassed by early returns"
  // 放在最后，前面任何一个提前 return 都绕不过它。
  if (inner.behavior === 'ask' && ctx.mode === 'dontAsk') {
    trace?.push('STOP|外层 dontAsk|无人可问，把 ask 改判成 deny')
    return {
      behavior: 'deny',
      decidedAt: 'dontAsk 模式',
      message: `${tool.name} 需要确认，但当前模式不允许询问，已拒绝。`,
    }
  }

  return inner
}

async function canUseToolInner(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: PermissionContext,
  trace?: string[],
): Promise<PermissionDecision> {
  const { rules, mode } = ctx
  const pass = (step: string, why: string) => trace?.push(`PASS|${step}|${why}`)
  const stop = (step: string, why: string) => trace?.push(`STOP|${step}|${why}`)

  // 1a. 整工具 deny 规则。最高优先级，任何模式都拦。
  if (rules.deny.includes(tool.name)) {
    stop('1a 整工具 deny 规则', `规则禁用了 ${tool.name}`)
    return {
      behavior: 'deny',
      decidedAt: '1a 整工具 deny 规则',
      message: `${tool.name} 已被规则禁用。`,
    }
  }
  pass('1a 整工具 deny 规则', '没配这条规则')

  // 1b. 整工具 ask 规则。
  if (rules.ask.includes(tool.name)) {
    stop('1b 整工具 ask 规则', `规则要求每次用 ${tool.name} 都问`)
    return {
      behavior: 'ask',
      decidedAt: '1b 整工具 ask 规则',
      message: `规则要求每次使用 ${tool.name} 都确认。`,
    }
  }
  pass('1b 整工具 ask 规则', '没配这条规则')

  // 1c. 问工具自己。默认 passthrough，交给通用系统裁决。
  //     真实源码这里包了 try/catch：schema 解析失败就【保持 passthrough】，
  //     既不放行也不拒绝，让后面的通用规则接手。
  let toolResult: PermissionDecision = {
    behavior: 'passthrough',
    decidedAt: '1c 工具未表态',
  }
  try {
    toolResult = (await tool.checkPermissions?.(input, ctx)) ?? toolResult
  } catch {
    // 保持 passthrough
  }
  pass('1c 问工具自己', `工具的意见是 ${toolResult.behavior}`)

  // 1d. 工具自己说拒绝。
  if (toolResult.behavior === 'deny') {
    stop('1d 工具自身 deny', toolResult.message ?? '工具拒绝了这次调用')
    return { ...toolResult, decidedAt: toolResult.decidedAt ?? '1d 工具自身 deny' }
  }
  pass('1d 工具自身 deny', '工具没有拒绝')

  // 1e. 工具声明必须人工确认。bypass 模式下也要问。
  if (tool.requiresUserInteraction?.() && toolResult.behavior === 'ask') {
    stop('1e requiresUserInteraction', '工具声明必须人工确认')
    return { ...toolResult, decidedAt: '1e requiresUserInteraction' }
  }
  pass('1e requiresUserInteraction', '工具没有这个要求')

  // 1f. 内容级 ask 规则，优先于 bypass 模式。
  //     用户显式配过 Bash(npm publish:*) 这种规则，说明他就是想在这件事上被问。
  if (toolResult.behavior === 'ask' && toolResult.reason === 'rule') {
    stop('1f 内容级 ask 规则', '用户显式配过要问这一类调用')
    return { ...toolResult, decidedAt: '1f 内容级 ask 规则（bypass 免疫）' }
  }
  pass('1f 内容级 ask 规则', '没命中用户配的内容级规则')

  // 1g. 安全检查。【这是最后一道不可绕过的闸】
  if (toolResult.behavior === 'ask' && toolResult.reason === 'safetyCheck') {
    stop('1g 敏感路径 safetyCheck', toolResult.message ?? '碰到了敏感路径')
    return { ...toolResult, decidedAt: '1g 敏感路径 safetyCheck（bypass 免疫）' }
  }
  pass('1g 敏感路径 safetyCheck', '不是敏感路径')

  // ── 分界线 ────────────────────────────────────────────
  // 以上全是「拦住」的理由，以下才轮到「放行」的理由。
  // 真实源码里有一个函数 checkRuleBasedPermissions()，它的规格就是
  // 「步骤 2a 之前的全部步骤」（permissions.ts:1062）。
  // 顺序如果不是语义的一部分，这个函数根本没法定义。

  // 2a. bypassPermissions 模式。必须在 1d–1g 之后，否则前面全白设。
  if (mode === 'bypassPermissions') {
    stop('2a bypassPermissions 模式', '用户开了全放行')
    return {
      behavior: 'allow',
      decidedAt: '2a bypassPermissions 模式',
    }
  }
  pass('2a bypassPermissions 模式', `当前是 ${mode} 模式，不是全放行`)

  // 2b. 整工具 allow 规则。
  if (rules.allow.includes(tool.name)) {
    stop('2b 整工具 allow 规则', `规则放行了 ${tool.name}`)
    return { behavior: 'allow', decidedAt: '2b 整工具 allow 规则' }
  }

  // 只读工具放行。读操作可逆、无副作用，没有理由每次都问。
  // 真实源码里 Read/Grep/Glob 是通过自己的 checkPermissions 直接返回 allow 的。
  if (tool.isReadOnly(input)) {
    stop('2b 只读工具放行', '读操作可逆，没必要每次都问')
    return { behavior: 'allow', decidedAt: '2b 只读工具放行' }
  }

  // acceptEdits：编辑类操作自动接受，不再逐次确认。
  // 注意它照样拦不住 1g 的敏感路径，因为那一步早就 return 了。
  if (mode === 'acceptEdits') {
    stop('2b acceptEdits 模式', '编辑类操作自动接受')
    return { behavior: 'allow', decidedAt: '2b acceptEdits 模式' }
  }

  // 工具自己说了 allow。
  if (toolResult.behavior === 'allow') {
    stop('2b 工具自身 allow', '工具明确放行')
    return { ...toolResult, decidedAt: toolResult.decidedAt ?? '2b 工具自身 allow' }
  }
  pass('2b 各种 allow 规则', '都没命中')

  // 3. passthrough 落到「问用户」。默认是保守的。
  stop('3 默认落到 ask', '没人放行也没人拦，保守起见问一下')
  return {
    behavior: 'ask',
    decidedAt: '3 默认落到 ask',
    message: `是否允许 ${tool.name}？`,
  }
}
