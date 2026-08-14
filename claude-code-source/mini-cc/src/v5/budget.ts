/**
 * mini-cc v4 —— 结果预算
 *
 * 对照真实源码：src/utils/toolResultStorage.ts（1041 行）
 *              src/constants/toolLimits.ts
 *
 * ── 这个文件解决的问题 ──
 *
 * 一次 `npm test` 吐 800KB 日志。原样塞进 messages，下一轮请求就要
 * 把这 800KB 重新发一遍，之后每一轮都要再发一遍。
 *
 * 直觉解法是截断：留前 2000 字，剩下的扔掉。
 * 这个代码库选了另一条路：【全文落盘，模型拿预览 + 路径】。
 * 信息没有丢，只是换了个寻址方式——需要的时候用 read_file 取回来。
 *
 * 一共两层闸，各管各的：
 *   第一层  单个结果太大        → maxResultSizeChars（本文件 maybePersist）
 *   第二层  单条消息里加起来太大 → 每消息预算（本文件 enforceToolResultBudget）
 *
 * 只有第一层是不够的：10 个并行工具各吐 40K，每个都合规，
 * 但它们在 wire 上是【同一条 user 消息】，加起来 400K。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BudgetReport, Message, ToolResultBlock } from './types.js'

// ── 常量 ────────────────────────────────────────────────

/**
 * 单个结果的全局上限。工具可以声明比它更小的 maxResultSizeChars，
 * 但声明得再大也会被这个值封顶。
 * 真实源码：constants/toolLimits.ts:13 DEFAULT_MAX_RESULT_SIZE_CHARS
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

/**
 * 单条 user 消息里所有 tool_result 【加起来】的上限。
 * 真实源码：constants/toolLimits.ts:49 MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

/** 留给模型看的预览大小。真实源码：toolResultStorage.ts:109 */
export const PREVIEW_SIZE_BYTES = 2_000

/**
 * 落盘内容外面套的标签。它有个具体用途：判断一段内容【是不是本模块
 * 自己生成的】，避免对已经处理过的结果再处理一次。
 */
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

/**
 * 演示用的缩放开关。真实源码里这两个值可以被 GrowthBook 特性开关
 * 在运行时覆盖（tengu_satin_quoll / tengu_hawthorn_window），
 * 目的一样：不改代码就能调阈值。
 */
function envNumber(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export function getGlobalCap(): number {
  return envNumber('MINI_CC_PER_TOOL_CAP', DEFAULT_MAX_RESULT_SIZE_CHARS)
}

export function getPerMessageBudgetLimit(): number {
  return envNumber('MINI_CC_PER_MESSAGE_BUDGET', MAX_TOOL_RESULTS_PER_MESSAGE_CHARS)
}

// ── 第一层：单个结果的阈值 ──────────────────────────────

/**
 * 算出某个工具的实际落盘阈值。
 *
 * 【Infinity 是硬退出】，而且要排在封顶之前判断。
 * read_file 设 Infinity，因为把它的结果落盘会形成
 * read_file → 落盘 → 模型再 read_file 那个文件 的循环。
 *
 * 真实源码：toolResultStorage.ts:55 getPersistenceThreshold()
 * 那里的注释写着 "Checked before the GB override so tengu_satin_quoll
 * can't force it back on" —— 连特性开关都不许把它扳回来。
 */
export function getPersistenceThreshold(declaredMaxResultSizeChars: number): number {
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars
  }
  return Math.min(declaredMaxResultSizeChars, getGlobalCap())
}

export type PersistedInfo = {
  filepath: string
  originalSize: number
  preview: string
  hasMore: boolean
}

function toolResultsDir(): string {
  return join(process.cwd(), '.mini-cc', 'tool-results')
}

export function getToolResultPath(id: string): string {
  return join(toolResultsDir(), `${id}.txt`)
}

/**
 * 在换行处截断，别把一行劈成两半。
 *
 * 那个 0.5 的条件是在防一种退化情况：整段内容一个换行都没有
 * （压缩过的 JSON、单行的 minified 输出），这时 lastIndexOf 会返回
 * 一个很靠前的位置甚至 -1，照它切会白白丢掉大半预览。
 *
 * 真实源码：toolResultStorage.ts:339 generatePreview()
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false }
  }
  const truncated = content.slice(0, maxBytes)
  const lastNewline = truncated.lastIndexOf('\n')
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes
  return { preview: content.slice(0, cutPoint), hasMore: true }
}

/**
 * 落盘。
 *
 * 注意 flag: 'wx' —— 文件已存在就抛 EEXIST，不覆盖。
 * 这不是洁癖，是为了幂等：tool_use_id 唯一，同一个 id 的内容是确定的，
 * 所以第二次写没有意义。真实源码的注释说得更准：
 * "Use 'wx' instead of a stat-then-write race."
 * 先 stat 再写有竞态窗口，'wx' 把判断和写入合成一个原子操作。
 *
 * 真实源码：toolResultStorage.ts:137 persistToolResult()
 */
export async function persistToolResult(
  content: string,
  toolUseId: string,
): Promise<PersistedInfo | { error: string }> {
  const filepath = getToolResultPath(toolUseId)
  try {
    await mkdir(toolResultsDir(), { recursive: true })
    await writeFile(filepath, content, { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    // EEXIST = 之前的轮次已经写过了，直接往下走去生成预览。
    // 其它错误（磁盘满、只读文件系统）才算失败。
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { error: (error as Error).message }
    }
  }
  const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_BYTES)
  return { filepath, originalSize: content.length, preview, hasMore }
}

function formatSize(chars: number): string {
  return chars >= 1024 ? `${(chars / 1024).toFixed(1)}KB` : `${chars}B`
}

/**
 * 拼给模型看的那段文字。
 *
 * 三样东西缺一不可：原始大小（让模型知道自己错过了多少）、
 * 文件路径（让它能取回来）、预览（让它多半不用取回来）。
 *
 * 真实源码：toolResultStorage.ts:189 buildLargeToolResultMessage()
 */
export function buildLargeToolResultMessage(info: PersistedInfo): string {
  return (
    `${PERSISTED_OUTPUT_TAG}\n` +
    `Output too large (${formatSize(info.originalSize)}). ` +
    `Full output saved to: ${info.filepath}\n\n` +
    `Preview (first ${formatSize(PREVIEW_SIZE_BYTES)}):\n` +
    info.preview +
    (info.hasMore ? '\n...\n' : '\n') +
    PERSISTED_OUTPUT_CLOSING_TAG
  )
}

export function isAlreadyPersisted(content: string): boolean {
  return content.startsWith(PERSISTED_OUTPUT_TAG)
}

export type PersistOutcome = {
  block: ToolResultBlock
  persisted?: { originalSize: number; newSize: number; filepath: string }
}

/**
 * 第一层闸：单个结果超过自己的阈值就落盘。
 *
 * 开头那个空结果分支是个真实事故的补丁（真实源码 inc-4586）：
 * tool_result 内容为空时，某些模型会把 `</function_results>\n\n`
 * 误当成轮次边界，直接结束回合、一个字都不输出。
 * 而空输出是完全合法的——静默成功的 shell 命令就是。
 * 所以塞一句话进去，让模型总有东西可以反应。
 *
 * 真实源码：toolResultStorage.ts:272 maybePersistLargeToolResult()
 */
export async function maybePersistLargeToolResult(
  block: ToolResultBlock,
  toolName: string,
  threshold: number,
): Promise<PersistOutcome> {
  if (block.content.trim() === '') {
    return { block: { ...block, content: `(${toolName} completed with no output)` } }
  }
  if (block.content.length <= threshold) {
    return { block }
  }
  const info = await persistToolResult(block.content, block.tool_use_id)
  if ('error' in info) {
    // 落盘失败就原样返回。宁可这一轮多花点上下文，也不能把结果弄丢——
    // tool_use 必须有配对的 tool_result，这条约束比省钱重要。
    return { block }
  }
  const message = buildLargeToolResultMessage(info)
  return {
    block: { ...block, content: message },
    persisted: {
      originalSize: info.originalSize,
      newSize: message.length,
      filepath: info.filepath,
    },
  }
}

// ══════════════════════════════════════════════════════════
//  第二层：每消息聚合预算
// ══════════════════════════════════════════════════════════

/**
 * 跨轮次携带的替换状态。
 *
 * 它存在的唯一理由是【前缀稳定】。
 *
 * 每一轮都要把完整历史重新发一遍。如果这一轮把第 3 轮的某个结果
 * 换成了预览，而上一轮发的是全文，那么请求的前缀就变了——
 * 变了的那一处往后，全部缓存作废，整段重新计费。
 *
 * 所以规则定得很硬：【判过一次，就不再改判】。
 *   seenIds       已经过过一遍预算检查的（无论替没替）
 *   replacements  其中被替换掉的，连同当时给模型看的那串字一起存
 *
 * 存字符串而不是重新生成，是因为重新生成会随代码变化——
 * 改一下预览模板或者体积格式，前缀就悄悄变了。
 *
 * 真实源码：toolResultStorage.ts:390 ContentReplacementState
 */
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

type Candidate = {
  toolUseId: string
  content: string
  size: number
}

/**
 * 把候选按【上一轮的决定】分三堆。
 *
 *   mustReapply  之前替换过 → 原样再贴一次（纯 Map 查表，零 IO，不会失败）
 *   frozen       之前见过但没替 → 从此不许再替（替了就破坏前缀）
 *   fresh        没见过 → 这一轮唯一能动的
 *
 * 真实源码：toolResultStorage.ts:649 partitionByPriorDecision()
 */
function partitionByPriorDecision(candidates: Candidate[], state: ContentReplacementState) {
  const mustReapply: Array<Candidate & { replacement: string }> = []
  const frozen: Candidate[] = []
  const fresh: Candidate[] = []
  for (const c of candidates) {
    const replacement = state.replacements.get(c.toolUseId)
    if (replacement !== undefined) mustReapply.push({ ...c, replacement })
    else if (state.seenIds.has(c.toolUseId)) frozen.push(c)
    else fresh.push(c)
  }
  return { mustReapply, frozen, fresh }
}

/**
 * 从大到小挑，挑到总量落回预算以内为止。
 *
 * 为什么按体积排序而不是按时间：替换是有代价的（模型看不到全文了），
 * 所以要用最少的替换次数换回最多的额度。一个 300K 的结果换掉，
 * 抵得上三十个 10K 的。
 *
 * 注意 frozen 的体积算进 remaining 但不参与挑选——它们已经定型了。
 * 万一光是 frozen 就超了预算，这里认这个超支。
 *
 * 真实源码：toolResultStorage.ts:675 selectFreshToReplace()
 */
function selectFreshToReplace(
  fresh: Candidate[],
  frozenSize: number,
  limit: number,
): Candidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size)
  const selected: Candidate[] = []
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0)
  for (const c of sorted) {
    if (remaining <= limit) break
    selected.push(c)
    remaining -= c.size
  }
  return selected
}

/**
 * 按 wire 级别的 user 消息把候选分组。
 *
 * mini-cc 里一轮工具结果就是一条 user 消息，所以这里是一对一。
 * 真实源码要复杂得多：normalizeMessagesForAPI 会把【连续的】 user 消息
 * 合并成一条，只有 assistant 消息才制造边界。所以那边的分组函数必须
 * 用同样的规则走一遍，否则会把一条超预算的大消息看成 N 条不超预算的
 * 小消息，恰恰在最该生效的时候失效。
 *
 * 真实源码：toolResultStorage.ts:600 collectCandidatesByMessage()
 */
function collectCandidatesByMessage(messages: Message[]): Candidate[][] {
  const groups: Candidate[][] = []
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue
    const candidates = message.content
      .filter((block) => !isAlreadyPersisted(block.content))
      .map((block) => ({
        toolUseId: block.tool_use_id,
        content: block.content,
        size: block.content.length,
      }))
    if (candidates.length > 0) groups.push(candidates)
  }
  return groups
}

/**
 * 从 assistant 消息里的 tool_use 块建一张 id → 工具名的表。
 *
 * 预算拿到的是一堆 tool_result，上面只有 tool_use_id，没有工具名。
 * 而「read_file 不参与预算」这条豁免是按工具名配的，所以得先还原。
 * tool_use 一定先于它的 tool_result 出现，所以这张表总是查得到。
 *
 * 真实源码：toolResultStorage.ts:536 buildToolNameMap()
 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool_use') map.set(block.id, block.name)
    }
  }
  return map
}

function replaceContents(messages: Message[], map: Map<string, string>): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message
    if (!message.content.some((b) => map.has(b.tool_use_id))) return message
    return {
      ...message,
      content: message.content.map((block) => {
        const replacement = map.get(block.tool_use_id)
        return replacement === undefined ? block : { ...block, content: replacement }
      }),
    }
  })
}

/**
 * 第二层闸：对每条 user 消息里 tool_result 的【聚合】体积施加预算。
 *
 * 消息之间互相独立：这一轮 150K，下一轮 150K，两条都在预算内，
 * 谁也不动。预算管的是「一轮之内并行工具的总产出」，
 * 历史总量该由压缩去管（第 0007 课）。
 *
 * state 是【原地修改】的。真实源码的注释解释了为什么不返回新对象：
 * 调用方跨轮次持有同一个引用，每次 query 之后再去更新引用太容易漏。
 *
 * 真实源码：toolResultStorage.ts:769 enforceToolResultBudget()
 */
export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  skipToolNames: ReadonlySet<string> = new Set(),
): Promise<{ messages: Message[]; report: BudgetReport | undefined }> {
  // state 为 undefined = 特性关闭，整步是空操作。
  if (!state) return { messages, report: undefined }

  const nameById = buildToolNameMap(messages)
  const shouldSkip = (id: string) => skipToolNames.has(nameById.get(id) ?? '')
  const limit = getPerMessageBudgetLimit()
  const replacementMap = new Map<string, string>()
  const toPersist: Candidate[] = []
  let reapplied = 0
  let before = 0

  for (const candidates of collectCandidatesByMessage(messages)) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(candidates, state)

    for (const c of mustReapply) replacementMap.set(c.toolUseId, c.replacement)
    reapplied += mustReapply.length

    // 没有 fresh 说明这条消息之前处理过了，只补贴替换，不重新判断。
    if (fresh.length === 0) {
      candidates.forEach((c) => state.seenIds.add(c.toolUseId))
      continue
    }

    // maxResultSizeChars 为 Infinity 的工具（read_file）不参与。
    // 但要标记成 seen，让这个决定同样定型。
    fresh.filter((c) => shouldSkip(c.toolUseId)).forEach((c) => state.seenIds.add(c.toolUseId))
    const eligible = fresh.filter((c) => !shouldSkip(c.toolUseId))

    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0)
    const freshSize = eligible.reduce((sum, c) => sum + c.size, 0)
    const selected =
      frozenSize + freshSize > limit
        ? selectFreshToReplace(eligible, frozenSize, limit)
        : []

    const selectedIds = new Set(selected.map((c) => c.toolUseId))
    candidates
      .filter((c) => !selectedIds.has(c.toolUseId))
      .forEach((c) => state.seenIds.add(c.toolUseId))

    if (selected.length === 0) continue
    before += frozenSize + freshSize
    toPersist.push(...selected)
  }

  if (replacementMap.size === 0 && toPersist.length === 0) {
    return { messages, report: undefined }
  }

  let newlyReplaced = 0
  let freed = 0
  for (const candidate of toPersist) {
    const info = await persistToolResult(candidate.content, candidate.toolUseId)
    // 落盘失败的也标 seen：它的全文已经发给模型了，从此当 frozen 处理才对。
    state.seenIds.add(candidate.toolUseId)
    if ('error' in info) continue
    const message = buildLargeToolResultMessage(info)
    replacementMap.set(candidate.toolUseId, message)
    state.replacements.set(candidate.toolUseId, message)
    newlyReplaced++
    freed += candidate.size - message.length
  }

  if (replacementMap.size === 0) return { messages, report: undefined }

  return {
    messages: replaceContents(messages, replacementMap),
    report: {
      newlyReplaced,
      reapplied,
      freed,
      before,
      after: before - freed,
      limit,
    },
  }
}
