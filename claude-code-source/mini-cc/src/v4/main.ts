/**
 * mini-cc v4 —— 驱动程序
 *
 * 运行：
 *   bun run src/v4/main.ts --thresholds    每个工具的实际落盘阈值
 *   bun run src/v4/main.ts --budget        第一层：单个结果太大
 *   bun run src/v4/main.ts --aggregate     第二层：一条消息里加起来太大
 *   bun run src/v4/main.ts --stability     冻结语义：为什么见过就不能改了
 *   bun run src/v4/main.ts --matrix        权限矩阵（第 0004 课）
 *   bun run src/v4/main.ts --trace         权限走廊（第 0004 课）
 *   bun run src/v4/main.ts "跑一下测试"     正常跑一遍 agent
 */

import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
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
import { pickModel } from './model.js'
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
  console.log(`${DIM}工具声明的值不是最终值，全局上限 ${num(DEFAULT_MAX_RESULT_SIZE_CHARS)} 会把它夹住。${RESET}\n`)

  console.log(
    `${DIM}${padTo('工具', 14)}${padLeft('声明值', 12)}${padLeft('全局上限', 12)}${padLeft('实际阈值', 12)}   说明${RESET}`,
  )
  for (const tool of TOOLS) {
    const declared = tool.maxResultSizeChars
    const effective = getPersistenceThreshold(declared)
    const infinite = !Number.isFinite(declared)
    const note = infinite
      ? '硬退出，不参与夹取'
      : declared < DEFAULT_MAX_RESULT_SIZE_CHARS
        ? '自己调得更严，生效'
        : '被全局上限夹住'
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
  console.log(`${DIM}唯一的例外是 Infinity，它走另一条分支，在夹取【之前】就返回了。${RESET}`)
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
  console.log(`${BOLD}冻结语义 · 为什么「见过就不能改了」${RESET}`)
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
