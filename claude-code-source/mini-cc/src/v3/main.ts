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

/**
 * 判定矩阵。本课最值得盯着看的一张表。
 *
 * 重点看 .git/config 那两行：无论开什么模式，结论都不是 allow，
 * 而且判定发生在第 1g 步，也就是 bypassPermissions（2a）之前。
 */
async function printMatrix() {
  const cases: Array<{ label: string; tool: string; input: Record<string, unknown> }> = [
    { label: '读普通文件', tool: 'read_file', input: { path: 'package.json' } },
    { label: '写普通文件', tool: 'write_file', input: { path: 'scratch/a.md', content: 'x' } },
    { label: '写 .git/config', tool: 'write_file', input: { path: '.git/config', content: 'x' } },
    { label: '写 .claude/settings.json', tool: 'write_file', input: { path: '.claude/settings.json', content: 'x' } },
  ]

  console.log(`${BOLD}权限判定矩阵${RESET}`)
  console.log(`${DIM}每格显示：判定结果 ← 由哪一步决定${RESET}\n`)

  for (const c of cases) {
    console.log(`${BOLD}${c.label}${RESET} ${DIM}(${c.tool})${RESET}`)
    const tool = TOOLS.find((t) => t.name === c.tool)!
    for (const mode of MODES) {
      const d = await canUseTool(tool, c.input, makeContext(mode))
      const color = colorFor(d.behavior)
      console.log(
        `  ${DIM}${mode.padEnd(19)}${RESET}${color}${d.behavior.padEnd(6)}${RESET}` +
          `${DIM}← ${d.decidedAt}${RESET}`,
      )
    }
    console.log()
  }

  console.log(`${YELLOW}注意 .git/ 和 .claude/ 那两组：${RESET}`)
  console.log(`${DIM}  bypassPermissions 是「全放行」，可它没能放行这两个。${RESET}`)
  console.log(`${DIM}  因为 safetyCheck 在第 1g 步，而 bypass 在第 2a 步，前者先 return。${RESET}`)
  console.log(`${DIM}  把 permissions.ts 里 1g 那段挪到 2a 后面，这张表立刻就变了。${RESET}`)
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
