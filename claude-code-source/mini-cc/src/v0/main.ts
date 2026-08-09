/**
 * mini-cc v0 —— 驱动程序
 *
 * 对照真实源码：src/screens/REPL.tsx（交互式）、src/cli/print.ts（pipe / headless）
 * 它们做的事跟这里一样：for await 消费 query()，把事件画到界面上。
 *
 * 运行：
 *   bun run src/v0/main.ts "帮我看看 src/v0 目录里有什么"
 */

import { query } from './loop.js'
import { pickModel } from './model.js'
import { TOOLS } from './tools.js'
import type { Terminal } from './types.js'

const SYSTEM = `你是 mini-cc，一个极简的编码助手。
你可以使用 read_file 和 list_dir 两个工具来探索当前项目。
回答简洁，用中文。`

const DIM = '\x1b[90m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
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

async function main() {
  const prompt = process.argv.slice(2).join(' ') || '这个项目的 src/v0 目录里有什么？'
  const { model, label } = pickModel()

  console.log(`${DIM}模型来源：${label}${RESET}`)
  console.log(`${BOLD}> ${prompt}${RESET}\n`)

  // Ctrl+C 中断 —— 生成器的 finally / using 清理会自动跑。
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
    maxTurns: 20,
    signal: controller.signal,
  })

  // for await 拿到的是 yield 出来的事件；
  // 循环自然结束时，.value 才是 return 的 Terminal。
  let result = await generator.next()
  while (!result.done) {
    const event = result.value
    switch (event.type) {
      case 'turn_start':
        console.log(`${DIM}── 第 ${event.turn} 轮 ──────────────${RESET}`)
        break
      case 'assistant_message':
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            console.log(`${block.text}`)
          }
        }
        break
      case 'tool_start':
        console.log(
          `${CYAN}  ⚙ ${event.name}${RESET} ${DIM}${JSON.stringify(event.input)}${RESET}`,
        )
        break
      case 'tool_end': {
        const color = event.isError ? RED : DIM
        const firstLine = event.preview.split('\n')[0] ?? ''
        console.log(`${color}  → ${firstLine.slice(0, 80)}…${RESET}`)
        break
      }
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
