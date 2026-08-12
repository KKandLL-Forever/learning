/**
 * mini-cc v3 —— 驱动程序
 *
 * 运行：
 *   bun run src/v3/main.ts                      默认模式跑一遍 agent
 *   bun run src/v3/main.ts --mode=bypassPermissions
 *   bun run src/v3/main.ts --matrix             打印判定矩阵（本课重点）
 */

import { query } from './loop.js'
import { pickModel } from './model.js'
import { canUseTool } from './permissions.js'
import { TOOLS } from './tools.js'
import type { PermissionContext, PermissionMode, Terminal } from './types.js'

const SYSTEM = `你是 mini-cc，一个极简的编码助手。
你可以使用 read_file、list_dir、write_file、sleep 四个工具。
回答简洁，用中文。`

const DIM = '\x1b[90m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

const MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'plan',
]

function makeContext(mode: PermissionMode): PermissionContext {
  return {
    mode,
    // 用户配的规则。这里留空，让判定过程只由模式和安全检查驱动，
    // 便于观察。真实场景里 deny/ask/allow 来自 settings.json。
    rules: { deny: [], ask: [], allow: [] },
    root: process.cwd(),
  }
}

function colorFor(behavior: string): string {
  if (behavior === 'allow') return GREEN
  if (behavior === 'deny') return RED
  return YELLOW
}

const CASES: Array<{ label: string; tool: string; input: Record<string, unknown> }> = [
  { label: '读普通文件', tool: 'read_file', input: { path: 'package.json' } },
  { label: '写普通文件', tool: 'write_file', input: { path: 'scratch/a.md', content: 'x' } },
  { label: '写 .git/config', tool: 'write_file', input: { path: '.git/config', content: 'x' } },
]

/** 中文字符按两格宽算，否则表格对不齐。 */
function width(s: string): number {
  let n = 0
  for (const ch of s) n += /[一-鿿　-〿＀-￯]/.test(ch) ? 2 : 1
  return n
}
function padTo(s: string, target: number): string {
  return s + ' '.repeat(Math.max(0, target - width(s)))
}

/**
 * 判定矩阵：一张真正的二维表。
 *
 * 行是「你要干什么」，列是「你设了什么模式」，格子里是结果。
 * 只看一件事：最后一行在五种模式下几乎不变。
 */
async function printMatrix() {
  console.log(`${BOLD}权限判定矩阵${RESET}`)
  console.log(`${DIM}行 = 你要干什么　列 = 你设的模式　格子 = 判定结果${RESET}\n`)

  const rowLabelWidth = 18
  const colWidth = 20

  let header = padTo('', rowLabelWidth)
  for (const m of MODES) header += padTo(m, colWidth)
  console.log(`${DIM}${header}${RESET}`)

  for (const c of CASES) {
    const tool = TOOLS.find((t) => t.name === c.tool)!
    let line = padTo(c.label, rowLabelWidth)
    for (const mode of MODES) {
      const d = await canUseTool(tool, c.input, makeContext(mode))
      const cell = padTo(d.behavior, colWidth)
      line += `${colorFor(d.behavior)}${cell}${RESET}`
    }
    console.log(line)
  }

  console.log()
  console.log(`${YELLOW}看最后一行。${RESET}${DIM}五种模式从严到松排开，写 .git/config 的结论几乎没动。${RESET}`)
  console.log(`${DIM}想知道为什么，用 --trace 把判定过程一步步打出来。${RESET}`)
}

/**
 * 走廊追踪：把一次判定走过的每个关卡都打出来。
 *
 * 矩阵只给结论，这个给过程。对照着看两次追踪，
 * 「顺序即语义」这件事就不需要解释了。
 */
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
    if (stopped) {
      console.log(`  ${DIM}${'　'.repeat(1)}↓ 后面的关卡根本没走到${RESET}`)
    }
    console.log(`  ${DIM}结果：${RESET}${colorFor(d.behavior)}${d.behavior}${RESET}\n`)
  }

  console.log(`${YELLOW}对比这两次：${RESET}`)
  console.log(`${DIM}  第一次走到了 2a（全放行），所以放行。${RESET}`)
  console.log(`${DIM}  第二次在 1g 就被拦下，2a 那句「全放行」压根没机会执行。${RESET}`)
  console.log(`${DIM}  bypass 拦不住敏感路径，不是因为它做了例外判断，是因为它排在后面。${RESET}`)
}

async function runAgent(mode: PermissionMode) {
  const prompt = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') || '权限演示'
  const { model, label } = pickModel()

  console.log(`${DIM}模型来源：${label}${RESET}`)
  console.log(`${DIM}权限模式：${RESET}${CYAN}${mode}${RESET}`)
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
        const text = tool
          ? tool.renderToolUse(event.input as Record<string, unknown>)
          : JSON.stringify(event.input)
        console.log(`${CYAN}    ⚙ ${event.name}${RESET} ${DIM}${text}${RESET}`)
        break
      }
      case 'permission': {
        const color = colorFor(event.behavior)
        console.log(`      ${color}🔒 ${event.behavior}${RESET} ${DIM}← ${event.decidedAt}${RESET}`)
        break
      }
      case 'tool_end': {
        const color = event.isError ? RED : DIM
        console.log(`${color}    → ${(event.preview.split('\n')[0] ?? '').slice(0, 76)}${RESET}`)
        break
      }
    }
    result = await generator.next()
  }

  const terminal: Terminal = result.value
  console.log(`\n${DIM}终止原因：${terminal.reason}${RESET}`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--matrix')) {
    await printMatrix()
    return
  }

  if (args.includes('--trace')) {
    await printTrace()
    return
  }

  const modeArg = args.find((a) => a.startsWith('--mode='))?.slice('--mode='.length)
  const mode = (MODES as string[]).includes(modeArg ?? '')
    ? (modeArg as PermissionMode)
    : 'default'

  await runAgent(mode)
}

main().catch((error) => {
  console.error(`${RED}崩了：${RESET}`, error)
  process.exit(1)
})
