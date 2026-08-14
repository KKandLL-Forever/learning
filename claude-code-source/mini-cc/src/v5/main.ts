/**
 * mini-cc v5 —— 驱动程序
 *
 * 本课（0006）：
 *   bun run src/v5/main.ts --cache         逐轮看命中率和花费
 *   bun run src/v5/main.ts --break         六种改动，各自打穿多少
 *
 * 往期：
 *   bun run src/v5/main.ts --thresholds    每个工具的实际落盘阈值（0005）
 *   bun run src/v5/main.ts --budget        第一层：单个结果太大（0005）
 *   bun run src/v5/main.ts --aggregate     第二层：一条消息里加起来太大（0005）
 *   bun run src/v5/main.ts --stability     冻结：为什么判过就不再改判（0005）
 *   bun run src/v5/main.ts --matrix        权限矩阵（0004）
 *   bun run src/v5/main.ts --trace         权限走廊（0004）
 *   bun run src/v5/main.ts "跑一下测试"     正常跑一遍 agent
 */

import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BYTES_PER_TOKEN,
  CACHE_BLOCK_TOKENS,
  createCacheObserver,
  PRICE_PER_MTOK,
  serializeRequest,
  simulateCache,
} from './cache.js'
import {
  applyToolResultBudget,
  createContentReplacementState,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  getPerMessageBudgetLimit,
  getPersistenceThreshold,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  maybePersistLargeToolResult,
} from './budget.js'
import { query } from './loop.js'
import { CACHE_SCRIPT, createMockModel, DEFAULT_MODEL, pickModel } from './model.js'
import { canUseTool } from './permissions.js'
import { TOOLS } from './tools.js'
import type {
  Message,
  PermissionContext,
  PermissionMode,
  Terminal,
  ToolResultBlock,
} from './types.js'

const SYSTEM = `你是 mini-cc，一个极简的编码助手。
你可以使用 read_file、list_dir、write_file、sleep、run_tests 五个工具。
回答简洁，用中文。`

const DIM = '\x1b[90m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']

function makeContext(mode: PermissionMode): PermissionContext {
  return { mode, rules: { deny: [], ask: [], allow: [] }, root: process.cwd() }
}

function colorFor(behavior: string): string {
  if (behavior === 'allow') return GREEN
  if (behavior === 'deny') return RED
  return YELLOW
}

/** 中文字符按两格宽算，否则表格对不齐。 */
function width(s: string): number {
  let n = 0
  for (const ch of s) n += /[一-鿿　-〿＀-￯]/.test(ch) ? 2 : 1
  return n
}
function padTo(s: string, target: number): string {
  return s + ' '.repeat(Math.max(0, target - width(s)))
}
function padLeft(s: string, target: number): string {
  return ' '.repeat(Math.max(0, target - width(s))) + s
}
function kb(chars: number): string {
  return chars >= 1024 ? `${(chars / 1024).toFixed(1)}KB` : `${chars}B`
}
function num(n: number): string {
  return n.toLocaleString('en-US')
}

// ── 演示一：阈值是怎么算出来的 ──────────────────────────

function printThresholds() {
  console.log(`${BOLD}每个工具的实际落盘阈值${RESET}`)
  console.log(`${DIM}工具声明的值不是最终值，全局上限 ${num(DEFAULT_MAX_RESULT_SIZE_CHARS)} 给它封顶。${RESET}\n`)

  console.log(
    `${DIM}${padTo('工具', 14)}${padLeft('声明值', 12)}${padLeft('全局上限', 12)}${padLeft('实际阈值', 12)}   说明${RESET}`,
  )
  for (const tool of TOOLS) {
    const declared = tool.maxResultSizeChars
    const effective = getPersistenceThreshold(declared)
    const infinite = !Number.isFinite(declared)
    const note = infinite
      ? '硬退出，不参与封顶'
      : declared < DEFAULT_MAX_RESULT_SIZE_CHARS
        ? '自己调得更严，生效'
        : '已经顶到上限了'
    const color = infinite ? CYAN : declared < DEFAULT_MAX_RESULT_SIZE_CHARS ? GREEN : YELLOW
    console.log(
      padTo(tool.name, 14) +
        padLeft(infinite ? '∞' : num(declared), 12) +
        padLeft(num(DEFAULT_MAX_RESULT_SIZE_CHARS), 12) +
        `${color}${padLeft(infinite ? '∞' : num(effective), 12)}${RESET}` +
        `   ${DIM}${note}${RESET}`,
    )
  }

  console.log()
  console.log(`${YELLOW}工具只能往严了调。${RESET}${DIM}声明 100000 也没用，Math.min 会把它拉回 ${num(DEFAULT_MAX_RESULT_SIZE_CHARS)}。${RESET}`)
  console.log(`${DIM}唯一的例外是 Infinity，它走另一条分支，在封顶【之前】就返回了。${RESET}`)
}

// ── 演示二：第一层，单个结果太大 ────────────────────────

async function demoPerTool() {
  console.log(`${BOLD}第一层 · 单个结果的阈值${RESET}`)
  console.log(`${DIM}run_tests 声明 30000，所以它的阈值是 30000。跑两次，只有行数不同。${RESET}\n`)

  await rm(join(process.cwd(), '.mini-cc'), { recursive: true, force: true })

  const tool = TOOLS.find((t) => t.name === 'run_tests')!

  for (const [i, lines] of [400, 1200].entries()) {
    const content = await tool.call({ lines, suite: 'unit' })
    const outcome = await maybePersistLargeToolResult(
      { type: 'tool_result', tool_use_id: `demo_${i}`, content },
      tool.name,
      getPersistenceThreshold(tool.maxResultSizeChars),
    )
    const shrunk = outcome.persisted !== undefined
    console.log(
      `${BOLD}${lines} 行${RESET}${DIM} → 原始 ${RESET}${kb(content.length)}` +
        `${DIM} · 进消息的 ${RESET}${shrunk ? GREEN : DIM}${kb(outcome.block.content.length)}${RESET}` +
        `   ${shrunk ? `${GREEN}落盘${RESET}` : `${DIM}原样通过${RESET}`}`,
    )
    if (shrunk) {
      console.log(`${DIM}模型实际收到的开头：${RESET}`)
      for (const line of outcome.block.content.split('\n').slice(0, 4)) {
        console.log(`  ${DIM}│${RESET} ${line.slice(0, 96)}`)
      }
      console.log(`  ${DIM}│ …（预览 2KB，然后是收尾标签）${RESET}`)
      console.log(`${DIM}全文在 ${outcome.persisted!.filepath}，模型可以用 read_file 取回。${RESET}`)
    }
    console.log()
  }

  console.log(`${YELLOW}注意省下来的不是「被删掉的信息」。${RESET}${DIM}全文还在磁盘上，只是不占每轮的额度了。${RESET}`)
}

// ── 演示三：第二层，一条消息里加起来太大 ────────────────

/** 造一条约 29000 字符的日志，刚好卡在 run_tests 的 30000 阈值以下。 */
function makeLog(tag: string): string {
  const line = (i: number) => `[${String(i).padStart(5, '0')}] ${tag} · case_${i} ... ok (${(i % 37) + 1}ms)`
  let out = ''
  let i = 1
  while (out.length < 29_000) out += `${line(i++)}\n`
  return out
}

function fakeParallelTurn(count: number): Message[] {
  const ids = Array.from({ length: count }, (_, i) => `tu_${i + 1}`)
  return [
    {
      role: 'assistant',
      content: ids.map((id, i) => ({
        type: 'tool_use' as const,
        id,
        name: 'run_tests',
        input: { suite: `pkg_${i + 1}` },
      })),
    },
    {
      role: 'user',
      content: ids.map(
        (id, i): ToolResultBlock => ({
          type: 'tool_result',
          tool_use_id: id,
          content: makeLog(`pkg_${i + 1}`),
        }),
      ),
    },
  ]
}

async function demoAggregate() {
  console.log(`${BOLD}第二层 · 一条消息里的聚合体积${RESET}`)
  console.log(`${DIM}8 个 run_tests 并行，每个 29KB。单看谁都没超 30000 的阈值。${RESET}\n`)

  await rm(join(process.cwd(), '.mini-cc'), { recursive: true, force: true })

  const messages = fakeParallelTurn(8)
  const results = (messages[1]!.content as ToolResultBlock[])
  const total = results.reduce((sum, b) => sum + b.content.length, 0)

  console.log(`${DIM}第一层放行了全部 8 个（每个 ${kb(results[0]!.content.length)} < 30000）。${RESET}`)
  console.log(`${DIM}但它们在 wire 上是【同一条 user 消息】：${RESET}`)
  console.log(`  合计 ${BOLD}${num(total)}${RESET} 字符，每消息预算 ${num(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS)}，` +
    `${RED}超了 ${num(total - MAX_TOOL_RESULTS_PER_MESSAGE_CHARS)}${RESET}\n`)

  const state = createContentReplacementState()
  const { report } = await applyToolResultBudget(messages, state, new Set())

  if (!report) {
    console.log(`${RED}没有触发预算，检查一下常量。${RESET}`)
    return
  }
  console.log(`${BOLD}预算跑完${RESET}`)
  console.log(`  替换了 ${GREEN}${report.newlyReplaced}${RESET} 个（从大到小挑，挑到落回预算为止）`)
  console.log(`  ${num(report.before)} → ${GREEN}${num(report.after)}${RESET}，省下 ${kb(report.freed)}`)
  console.log()
  console.log(
    `${YELLOW}只挑了 ${report.newlyReplaced} 个，没有全替。${RESET}` +
      `${DIM}目标是落回预算，不是把消息榨干。`,
  )
  console.log(`剩下 ${results.length - report.newlyReplaced} 个的全文模型还看得见，能省几次 read_file。${RESET}`)
}

// ── 演示四：冻结语义 ────────────────────────────────────

function hashFirstMessage(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user' && typeof m.content !== 'string')!
  const text = (first.content as ToolResultBlock[]).map((b) => b.content).join('')
  return createHash('sha1').update(text).digest('hex').slice(0, 10)
}

/**
 * 同一段历史，中途把预算调小，看第一条消息的内容会不会变。
 *
 * 内容变了 = 请求前缀变了 = 那一处往后的缓存全部作废。
 */
async function demoStability() {
  console.log(`${BOLD}冻结语义 · 为什么判过一次就不再改判${RESET}`)
  console.log(`${DIM}场景：一条 227KB 的消息超了 200KB 预算，第 1 轮替掉几个之后落回预算。${RESET}`)
  console.log(`${DIM}然后第 3 轮之前，有人把预算调到 60KB（真实系统里就是改个特性开关）。${RESET}\n`)

  await rm(join(process.cwd(), '.mini-cc'), { recursive: true, force: true })

  const history = fakeParallelTurn(8)
  const shrinkAt = 3

  for (const label of ['带状态（真实行为）', '不带状态（假设没有冻结）']) {
    const keepState = label.startsWith('带状态')
    console.log(`${BOLD}${label}${RESET}`)
    delete process.env.MINI_CC_PER_MESSAGE_BUDGET
    const state = createContentReplacementState()
    let previous: string | undefined

    for (let turn = 1; turn <= 4; turn++) {
      if (turn === shrinkAt) process.env.MINI_CC_PER_MESSAGE_BUDGET = '60000'
      // 不带状态 = 每轮都用一个全新的 state，等于「不记得上一轮做过什么决定」
      const used = keepState ? state : createContentReplacementState()
      const { messages, report } = await applyToolResultBudget(history, used, new Set())
      const hash = hashFirstMessage(messages)
      const changed = previous !== undefined && hash !== previous
      const mark = changed ? `${RED}前缀变了 → 缓存作废${RESET}` : `${GREEN}前缀不变${RESET}`
      const budgetNote = turn === shrinkAt ? `${YELLOW}（预算改成 60000）${RESET}` : ''
      console.log(
        `  第 ${turn} 轮  ${DIM}hash ${RESET}${hash}  ` +
          `${DIM}新替 ${report?.newlyReplaced ?? 0} · 查表贴回 ${report?.reapplied ?? 0}${RESET}  ` +
          `${turn === 1 ? DIM + '基准' + RESET : mark} ${budgetNote}`,
      )
      previous = hash
    }
    console.log()
  }

  delete process.env.MINI_CC_PER_MESSAGE_BUDGET
  console.log(`${YELLOW}左边那列 hash 才是重点。${RESET}`)
  console.log(`${DIM}带状态：预算怎么改，历史消息的内容一个字节都不动，老决定是查表贴回去的。${RESET}`)
  console.log(`${DIM}不带状态：预算一改，同一条历史消息重新算了一遍，替换的个数变了，前缀跟着变。${RESET}`)
  console.log(`${DIM}这就是 seenIds 和 replacements 这两个字段存在的全部理由。${RESET}`)
}

// ══════════════════════════════════════════════════════════
//  第 0006 课：前缀缓存
// ══════════════════════════════════════════════════════════

function yuan(n: number): string {
  return `¥${n.toFixed(4)}`
}

/**
 * 演示用的长系统提示词。
 *
 * 真实的 Claude Code 系统提示词上万 token，这里凑到约 1500 token，
 * 目的是让「改动落在 system 里」和「落在工具区」的后果能区分开。
 * 系统提示词短的话，两者都会归零，看不出层次。
 */
const LONG_SYSTEM = [
  SYSTEM,
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `规则 ${i + 1}：回答保持简洁，先给结论再给依据；` +
      `涉及文件改动时先说清楚要改哪里、为什么改；` +
      `不确定的地方明确说不确定，不要编造路径或行号。`,
  ),
].join('\n\n')

/** 造一段有分量的历史，好让命中数字看得出层次。 */
function buildHistory(): Message[] {
  const log = (tag: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) => `[${String(i + 1).padStart(5, '0')}] ${tag} · case_${i + 1} ... ok (${(i % 37) + 1}ms)`,
    ).join('\n')

  return [
    { role: 'user', content: '帮我跑一下测试，然后看看目录结构' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先跑测试。' },
        { type: 'tool_use', id: 'c1', name: 'run_tests', input: { suite: 'unit', lines: 600 } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: log('unit', 600) }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '测试过了，看下目录。' },
        { type: 'tool_use', id: 'c2', name: 'run_tests', input: { suite: 'e2e', lines: 600 } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c2', content: log('e2e', 600) }],
    },
  ]
}

/**
 * 六种改动，各自打穿多少。
 *
 * 这个演示要说明的不是「改了就打穿」，而是【改在哪儿决定了赔多少】。
 * 前缀是从第一个字节开始比的，所以越靠前的改动越贵。
 */
async function demoBreak() {
  console.log(`${BOLD}同样是改一处，改在哪儿决定赔多少${RESET}`)
  console.log(`${DIM}请求在 wire 上的顺序是固定的：system → tools → messages。${RESET}`)
  console.log(`${DIM}前缀从第一个字节开始比，所以越靠前的改动，后面作废得越多。${RESET}\n`)

  const messages = buildHistory()
  const base = serializeRequest(LONG_SYSTEM, TOOLS, messages)
  const baseStats = simulateCache(base, base)

  const first = TOOLS[0]!.name
  const last = TOOLS[TOOLS.length - 1]!.name
  const tweak = (name: string) =>
    TOOLS.map((t) => (t.name === name ? { ...t, description: `${t.description} ` } : t))

  const inserted: Message[] = [
    ...messages.slice(0, 3),
    { role: 'user', content: '（插进来的一句话）' },
    ...messages.slice(3),
  ]
  // 和上面那条【插入的内容完全一样】，只是位置在末尾。
  // 这一对是整张表的重点：同样的操作，位置不同，代价差着数量级。
  const appended: Message[] = [
    ...messages,
    { role: 'user', content: '（插进来的一句话）' },
  ]

  const cases: Array<{ label: string; where: string; wire: string }> = [
    { label: '什么都不改', where: '—', wire: base },
    { label: '系统提示词改一个字', where: '最前面', wire: serializeRequest(LONG_SYSTEM.replace('你是', '你就是'), TOOLS, messages) },
    { label: `第一个工具（${first}）描述多个空格`, where: '工具区开头', wire: serializeRequest(LONG_SYSTEM, tweak(first), messages) },
    { label: `最后一个工具（${last}）描述多个空格`, where: '工具区末尾', wire: serializeRequest(LONG_SYSTEM, tweak(last), messages) },
    { label: '同一句话插在历史中间', where: '消息区中段', wire: serializeRequest(LONG_SYSTEM, TOOLS, inserted) },
    { label: '同一句话加在历史末尾', where: '最末尾', wire: serializeRequest(LONG_SYSTEM, TOOLS, appended) },
  ]

  const w = [40, 14, 12, 12, 12]
  console.log(
    `${DIM}${padTo('改动', w[0]!)}${padTo('改在哪', w[1]!)}${padLeft('命中', w[2]!)}${padLeft('未命中', w[3]!)}${padLeft('本次花费', w[4]!)}   多花${RESET}`,
  )

  for (const c of cases) {
    const s = simulateCache(base, c.wire)
    const extra = s.cost - baseStats.cost
    const color = extra <= 0 ? GREEN : extra < baseStats.costWithoutCache * 0.3 ? YELLOW : RED
    console.log(
      padTo(c.label, w[0]!) +
        `${DIM}${padTo(c.where, w[1]!)}${RESET}` +
        `${color}${padLeft(num(s.hitTokens), w[2]!)}${RESET}` +
        padLeft(num(s.missTokens), w[3]!) +
        padLeft(yuan(s.cost), w[4]!) +
        `   ${color}${extra <= 0 ? '—' : '+' + yuan(extra)}${RESET}`,
    )
  }

  console.log()
  console.log(`${YELLOW}最后两行放在一起看。${RESET}${DIM}同样是改一处内容，插在中间和加在末尾，代价差着数量级。${RESET}`)
  console.log(`${DIM}这就是「历史一旦发出去就别再动」的由来，也是第 0005 课冻结语义的全部理由。${RESET}`)
  console.log()
  console.log(`${DIM}注：命中按 ${CACHE_BLOCK_TOKENS} token 一块向下取整，${BYTES_PER_TOKEN} 个字符粗算 1 个 token（中文会低估，只求量级）。${RESET}`)
  console.log(`${DIM}    价格用 DeepSeek V4-Flash：命中 ¥${PRICE_PER_MTOK.hit}/M，未命中 ¥${PRICE_PER_MTOK.miss}/M，差 ${PRICE_PER_MTOK.miss / PRICE_PER_MTOK.hit} 倍。${RESET}`)

  // ── 第二半：让侦测器说出是谁干的 ──────────────────────
  console.log(`\n${BOLD}那么，谁打穿的${RESET}`)
  console.log(`${DIM}账单只告诉你命中掉了，不告诉你为什么。这一半模拟真实源码那 727 行在做的事。${RESET}\n`)

  const observer = createCacheObserver(DEFAULT_MODEL)
  const steps: Array<{ label: string; system: string; tools: typeof TOOLS }> = [
    { label: '第 1 次请求', system: LONG_SYSTEM, tools: TOOLS },
    { label: '第 2 次请求，什么都没改', system: LONG_SYSTEM, tools: TOOLS },
    { label: `第 3 次请求，${last} 的描述被改了`, system: LONG_SYSTEM, tools: tweak(last) },
    { label: '第 4 次请求，改回去了', system: LONG_SYSTEM, tools: TOOLS },
  ]

  for (const s of steps) {
    const { stats, broke } = observer.observe(s.system, s.tools, messages)
    const rate = `${(stats.hitRate * 100).toFixed(0)}%`
    console.log(
      `${padTo(s.label, 38)}${DIM}命中 ${RESET}${padLeft(num(stats.hitTokens), 8)}${DIM} / ${num(stats.totalTokens)}  (${rate})${RESET}`,
    )
    if (broke) {
      console.log(`  ${RED}⚡ 打穿了${RESET} ${DIM}掉 ${num(broke.drop)} token：${RESET}${YELLOW}${broke.reasons.join('；')}${RESET}`)
    }
  }

  console.log()
  console.log(`${YELLOW}第 4 次值得多看两眼。${RESET}${DIM}描述改回去了，命中却还是 832，一分钱没省回来。${RESET}`)
  console.log(`${DIM}因为上次写进缓存的是「改过的版本」，改回去只是又一次不一样。缓存不认对错，只认和上次一不一样。${RESET}`)
  console.log()
  console.log(`${YELLOW}而侦测器这一次没报警。${RESET}${DIM}它盯的是「命中比上次掉了」，第 4 次没再往下掉，所以它闭嘴了。${RESET}`)
  console.log(`${DIM}这是这类侦测的固有盲区：它抓得住【变坏的那一刻】，抓不住【一直很坏】。${RESET}`)
}

/** 跑一遍 agent，逐轮把缓存的账打出来。 */
async function demoCache() {
  console.log(`${BOLD}逐轮看命中率${RESET}`)
  console.log(`${DIM}历史越长，前缀里能复用的部分越多。第一轮必然全价，缓存要先写进去。${RESET}\n`)

  await rm(join(process.cwd(), '.mini-cc'), { recursive: true, force: true })

  // 没有 key 时用专门的剧本：每轮只加一点点内容，好看清命中率的走势。
  const real = pickModel()
  const usingMock = real.label.startsWith('Mock')
  const model = usingMock ? createMockModel(CACHE_SCRIPT) : real.model
  console.log(`${DIM}模型来源：${usingMock ? 'Mock 剧本（缓存专用）' : real.label}${RESET}`)
  console.log(`${DIM}系统提示词：${num(Math.ceil(LONG_SYSTEM.length / BYTES_PER_TOKEN))} token（真实的 Claude Code 上万）${RESET}\n`)

  const generator = query({
    messages: [{ role: 'user', content: '看看这个项目' }],
    system: LONG_SYSTEM,
    tools: TOOLS,
    model,
    maxTurns: 10,
    permissions: makeContext('default'),
    budgetState: createContentReplacementState(),
    observeCache: { model: DEFAULT_MODEL },
  })

  let totalCost = 0
  let totalWithout = 0
  console.log(
    `${DIM}${padTo('轮', 6)}${padLeft('总 token', 12)}${padLeft('命中', 10)}${padLeft('命中率', 10)}${padLeft('花费', 12)}${padLeft('不缓存要花', 14)}${RESET}`,
  )

  let result = await generator.next()
  while (!result.done) {
    const event = result.value
    if (event.type === 'cache') {
      const s = event.stats
      totalCost += s.cost
      totalWithout += s.costWithoutCache
      const color = s.hitRate > 0.5 ? GREEN : s.hitRate > 0 ? YELLOW : DIM
      console.log(
        padTo(String(event.turn), 6) +
          padLeft(num(s.totalTokens), 12) +
          `${color}${padLeft(num(s.hitTokens), 10)}${RESET}` +
          `${color}${padLeft((s.hitRate * 100).toFixed(0) + '%', 10)}${RESET}` +
          padLeft(yuan(s.cost), 12) +
          `${DIM}${padLeft(yuan(s.costWithoutCache), 14)}${RESET}`,
      )
    } else if (event.type === 'cache_break') {
      console.log(`      ${RED}⚡ 缓存被打穿${RESET} ${DIM}掉了 ${num(event.report.drop)} token：${event.report.reasons.join('；')}${RESET}`)
    }
    result = await generator.next()
  }

  console.log()
  console.log(`${BOLD}合计${RESET} ${yuan(totalCost)}${DIM}，不用缓存要 ${yuan(totalWithout)}，省了 ${((1 - totalCost / totalWithout) * 100).toFixed(0)}%${RESET}`)
  console.log()
  console.log(`${YELLOW}注意第 1 轮命中是 0。${RESET}${DIM}缓存要先写进去才谈得上命中，第一次一定全价。${RESET}`)
  console.log(`${DIM}这也是为什么「每轮都发完整历史」听着浪费，实际账单没那么难看。${RESET}`)
}

// ── 权限演示（第 0004 课，原样保留）──────────────────────

const CASES = [
  { label: '读普通文件', tool: 'read_file', input: { path: 'package.json' } },
  { label: '写普通文件', tool: 'write_file', input: { path: 'scratch/a.md', content: 'x' } },
  { label: '写 .git/config', tool: 'write_file', input: { path: '.git/config', content: 'x' } },
]

async function printMatrix() {
  console.log(`${BOLD}权限判定矩阵${RESET}`)
  console.log(`${DIM}行 = 你要干什么　列 = 你设的模式　格子 = 判定结果${RESET}\n`)
  let header = padTo('', 18)
  for (const m of MODES) header += padTo(m, 20)
  console.log(`${DIM}${header}${RESET}`)
  for (const c of CASES) {
    const tool = TOOLS.find((t) => t.name === c.tool)!
    let line = padTo(c.label, 18)
    for (const mode of MODES) {
      const d = await canUseTool(tool, c.input, makeContext(mode))
      line += `${colorFor(d.behavior)}${padTo(d.behavior, 20)}${RESET}`
    }
    console.log(line)
  }
}

async function printTrace() {
  console.log(`${BOLD}判定走廊${RESET}`)
  console.log(`${DIM}10 道关卡串成一条走廊，从上往下走，第一个拦住你的说了算。${RESET}\n`)
  const scenarios = [
    { title: '写普通文件 scratch/a.md，bypassPermissions 模式', case: CASES[1]!, mode: 'bypassPermissions' as PermissionMode },
    { title: '写 .git/config，同样是 bypassPermissions 模式', case: CASES[2]!, mode: 'bypassPermissions' as PermissionMode },
  ]
  for (const s of scenarios) {
    console.log(`${BOLD}${s.title}${RESET}`)
    const tool = TOOLS.find((t) => t.name === s.case.tool)!
    const trace: string[] = []
    const d = await canUseTool(tool, s.case.input, makeContext(s.mode), trace)
    let stopped = false
    for (const line of trace) {
      const [kind, step, why] = line.split('|') as [string, string, string]
      if (kind === 'PASS') {
        console.log(`  ${GREEN}✓${RESET} ${DIM}${padTo(step, 30)}${why}，继续往下${RESET}`)
      } else {
        console.log(`  ${RED}■${RESET} ${BOLD}${padTo(step, 30)}${RESET}${YELLOW}${why}${RESET}`)
        stopped = true
      }
    }
    if (stopped) console.log(`  ${DIM}　↓ 后面的关卡根本没走到${RESET}`)
    console.log(`  ${DIM}结果：${RESET}${colorFor(d.behavior)}${d.behavior}${RESET}\n`)
  }
}

// ── 正常跑一遍 ──────────────────────────────────────────

async function runAgent(mode: PermissionMode) {
  const prompt = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') || '跑一下测试'
  const { model, label } = pickModel()

  console.log(`${DIM}模型来源：${label}${RESET}`)
  console.log(`${DIM}权限模式：${RESET}${CYAN}${mode}${RESET}`)
  console.log(`${DIM}每消息预算：${RESET}${num(getPerMessageBudgetLimit())}`)
  console.log(`\n${BOLD}> ${prompt}${RESET}\n`)

  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  const generator = query({
    messages: [{ role: 'user', content: prompt }],
    system: SYSTEM,
    tools: TOOLS,
    model,
    maxTurns: 10,
    signal: controller.signal,
    permissions: makeContext(mode),
    budgetState: createContentReplacementState(),
  })

  let result = await generator.next()
  while (!result.done) {
    const event = result.value
    switch (event.type) {
      case 'turn_start':
        console.log(`${DIM}── 第 ${event.turn} 轮 ──────────────${RESET}`)
        break
      case 'assistant_message':
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text.trim()) console.log(block.text)
        }
        break
      case 'tool_start': {
        const tool = TOOLS.find((t) => t.name === event.name)
        const text = tool ? tool.renderToolUse(event.input as Record<string, unknown>) : JSON.stringify(event.input)
        console.log(`${CYAN}    ⚙ ${event.name}${RESET} ${DIM}${text}${RESET}`)
        break
      }
      case 'permission':
        console.log(`      ${colorFor(event.behavior)}🔒 ${event.behavior}${RESET} ${DIM}← ${event.decidedAt}${RESET}`)
        break
      case 'tool_end':
        console.log(`${event.isError ? RED : DIM}    → ${(event.preview.split('\n')[0] ?? '').slice(0, 76)}${RESET}`)
        break
      case 'result_persisted':
        console.log(
          `      ${YELLOW}📦 落盘${RESET} ${DIM}${kb(event.originalSize)} → ${kb(event.newSize)}，全文在 ${event.filepath}${RESET}`,
        )
        break
      case 'budget_enforced':
        console.log(
          `${DIM}    每消息预算：新替 ${event.report.newlyReplaced} · 查表贴回 ${event.report.reapplied} · 省下 ${kb(event.report.freed)}${RESET}`,
        )
        break
    }
    result = await generator.next()
  }

  const terminal: Terminal = result.value
  console.log(`\n${DIM}终止原因：${terminal.reason}${RESET}`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--cache')) return demoCache()
  if (args.includes('--break')) return demoBreak()
  if (args.includes('--thresholds')) return printThresholds()
  if (args.includes('--budget')) return demoPerTool()
  if (args.includes('--aggregate')) return demoAggregate()
  if (args.includes('--stability')) return demoStability()
  if (args.includes('--matrix')) return printMatrix()
  if (args.includes('--trace')) return printTrace()

  const modeArg = args.find((a) => a.startsWith('--mode='))?.slice('--mode='.length)
  const mode = (MODES as string[]).includes(modeArg ?? '') ? (modeArg as PermissionMode) : 'default'
  await runAgent(mode)
}

main().catch((error) => {
  console.error(`${RED}崩了：${RESET}`, error)
  process.exit(1)
})
