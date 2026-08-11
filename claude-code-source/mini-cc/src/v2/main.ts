/**
 * mini-cc v2 —— 驱动程序
 *
 * 对照真实源码：src/screens/REPL.tsx（交互式）、src/cli/print.ts（pipe / headless）
 *
 * v2 的界面多了两样东西：分批方案，以及每批的耗时。
 * 耗时是这一课唯一能【证明】并发真的发生了的证据，所以专门打出来。
 *
 * 运行：
 *   bun run src/v2/main.ts "并发演示"
 */

import { describeSafety } from './buildTool.js'
import { query } from './loop.js'
import { pickModel } from './model.js'
import { TOOLS } from './tools.js'
import type { BatchSummary, Terminal } from './types.js'

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

function describeTerminal(terminal: Terminal): string {
  switch (terminal.reason) {
    case 'completed':
      return '正常结束'
    case 'max_turns':
      return `撞上轮次上限（跑了 ${terminal.turnCount} 轮）`
    case 'aborted':
      return '被用户中断'
  }
}

/** 把分批方案画成一行一批，标出哪批并发、哪批串行。 */
function renderPlan(batches: BatchSummary[]): string[] {
  return batches.map((b, i) => {
    const mark = b.isConcurrencySafe ? `${GREEN}并发${RESET}` : `${YELLOW}串行${RESET}`
    return `${DIM}  [${i + 1}/${batches.length}]${RESET} ${mark} ${DIM}${b.names.join(' + ')}${RESET}`
  })
}

async function main() {
  const prompt = process.argv.slice(2).join(' ') || '并发演示'
  const { model, label } = pickModel()

  console.log(`${DIM}模型来源：${label}${RESET}`)
  console.log(`${DIM}并发上限：${process.env.MINI_CC_MAX_CONCURRENCY || 10}${RESET}`)

  console.log(`${DIM}工具清单：${RESET}`)
  for (const tool of TOOLS) {
    console.log(`${DIM}  ${tool.name.padEnd(11)}${RESET}${CYAN}${describeSafety(tool)}${RESET}`)
  }

  console.log(`\n${BOLD}> ${prompt}${RESET}\n`)

  const controller = new AbortController()
  process.on('SIGINT', () => {
    console.log(`\n${DIM}收到中断信号…${RESET}`)
    controller.abort()
  })

  const generator = query({
    messages: [{ role: 'user', content: prompt }],
    system: SYSTEM,
    tools: TOOLS,
    model,
    maxTurns: 10,
    signal: controller.signal,
  })

  let batchStartedAt = 0
  const turnStartedAt = new Map<number, number>()

  let result = await generator.next()
  while (!result.done) {
    const event = result.value
    switch (event.type) {
      case 'turn_start':
        turnStartedAt.set(event.turn, Date.now())
        console.log(`${DIM}── 第 ${event.turn} 轮 ──────────────${RESET}`)
        break

      case 'assistant_message':
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text.trim()) console.log(block.text)
        }
        break

      case 'batch_plan':
        console.log(`${DIM}  分批方案（共 ${event.batches.length} 批）：${RESET}`)
        for (const line of renderPlan(event.batches)) console.log(line)
        break

      case 'batch_start':
        batchStartedAt = Date.now()
        break

      case 'tool_start': {
        const tool = TOOLS.find((t) => t.name === event.name)
        const label = tool
          ? tool.renderToolUse(event.input as Record<string, unknown>)
          : JSON.stringify(event.input)
        console.log(`${CYAN}    ⚙ ${event.name}${RESET} ${DIM}${label}${RESET}`)
        break
      }

      case 'tool_end': {
        const color = event.isError ? RED : DIM
        const firstLine = event.preview.split('\n')[0] ?? ''
        console.log(`${color}    → ${firstLine.slice(0, 70)}${RESET}`)
        break
      }

      case 'batch_end':
        console.log(
          `${DIM}  第 ${event.index + 1} 批完成，耗时 ${Date.now() - batchStartedAt}ms${RESET}`,
        )
        break
    }
    result = await generator.next()
  }

  const terminal: Terminal = result.value
  console.log(`\n${DIM}终止原因：${describeTerminal(terminal)}${RESET}`)
}

main().catch((error) => {
  console.error(`${RED}崩了：${RESET}`, error)
  process.exit(1)
})
