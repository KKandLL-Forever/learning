/**
 * mini-cc v2 —— 四个工具，全部走 buildTool
 *
 * 对照真实源码：src/tools/ 下约 50 个工具目录
 *
 * v1 加进来的 write_file 是第一个【会写】的工具，
 * v2 又加了 sleep。这两个工具凑齐了分批算法要处理的两种情况：
 * 可并发的（sleep、read_file、list_dir）和必须串行的（write_file）。
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { buildTool } from './buildTool.js'
import type { ValidationResult } from './types.js'

const ROOT = process.cwd()

function resolveInside(rawPath: string): string {
  const target = isAbsolute(rawPath) ? rawPath : join(ROOT, rawPath)
  const full = resolve(target)
  if (full !== ROOT && !full.startsWith(ROOT + '\\') && !full.startsWith(ROOT + '/')) {
    throw new Error(`路径越界：${rawPath} 不在 ${ROOT} 之内`)
  }
  return full
}

/** 复用的输入校验：path 必须是非空字符串，且不能越界。 */
function validatePath(input: Record<string, unknown>): ValidationResult {
  const value = input.path
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, message: '参数 "path" 必须是非空字符串。' }
  }
  try {
    resolveInside(value)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

// ── 只读工具：把安全性【明确声明】出来 ─────────────────

export const readFileTool = buildTool({
  name: 'read_file',
  description: '读取一个文本文件的内容。返回带行号的内容。',
  searchHint: 'read view open file contents',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '要读取的文件路径' } },
    required: ['path'],
  },
  validateInput: validatePath,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // 真实源码里 Read 工具设 Infinity —— 否则结果落盘后模型又要 Read 那个文件，
  // 形成 Read→落盘→再 Read 的死循环。第 0005 课展开。
  maxResultSizeChars: Number.POSITIVE_INFINITY,

  renderToolUse: (input) => `读取 ${input.path}`,

  async call(input) {
    const full = resolveInside(input.path as string)
    const info = await stat(full)
    if (!info.isFile()) throw new Error(`${full} 不是一个文件`)
    const text = await readFile(full, 'utf-8')
    return text
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
      .join('\n')
  },
})

export const listDirTool = buildTool({
  name: 'list_dir',
  description: '列出一个目录下的条目。目录名结尾带 /。',
  searchHint: 'list directory folder entries',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '目录路径，默认工作目录' } },
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  renderToolUse: (input) => `列出 ${input.path ?? '.'}`,

  async call(input) {
    const raw = typeof input.path === 'string' && input.path ? input.path : '.'
    const full = resolveInside(raw)
    const entries = await readdir(full, { withFileTypes: true })
    if (entries.length === 0) return '（空目录）'
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n')
  },
})

// ── 写工具：故意【什么安全声明都不写】───────────────────

/**
 * 注意这个工具【没有】声明 isReadOnly，也【没有】声明 isConcurrencySafe。
 *
 * 这不是偷懒，是在复现真实源码里的一个真实情况：
 *
 *   src/tools/FileEditTool/FileEditTool.ts:86 用了 buildTool，
 *   但通篇没有声明 isConcurrencySafe / isReadOnly / isDestructive。
 *
 * 它靠 TOOL_DEFAULTS 兜住，被正确地判定为「会写 · 须串行」。
 * 假如默认值反过来是 true，那么「读 A、改 A、再读 A」就会三个一起并行，
 * 产生一个只在时序不巧时才复现的数据竞争——
 * 而这一切只因为有人少写了一行。
 *
 * 这里唯一显式声明的是 isDestructive：覆盖写是不可逆的，
 * 而这一条【没有】安全的默认方向可以依赖——默认 false 只是说
 * 「大多数工具不具破坏性」，具体到覆盖文件，作者必须自己说。
 */
export const writeFileTool = buildTool({
  name: 'write_file',
  description: '把内容写入一个文件。文件已存在时【覆盖】原内容。',
  searchHint: 'write save create overwrite file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },

  validateInput(input) {
    const pathResult = validatePath(input)
    if (!pathResult.ok) return pathResult
    if (typeof input.content !== 'string') {
      return { ok: false, message: '参数 "content" 必须是字符串。' }
    }
    return { ok: true }
  },

  isDestructive: () => true,

  renderToolUse: (input) =>
    `写入 ${input.path}（${String(input.content ?? '').length} 字符）`,

  async call(input) {
    const full = resolveInside(input.path as string)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, input.content as string, 'utf-8')
    return `已写入 ${full}（${(input.content as string).length} 字符）`
  },
})

// ── 演示工具：让并发肉眼可见 ──────────────────────────

/**
 * 单纯等待一段时间。
 *
 * 读本地文件太快了（一次几毫秒），并行和串行的差别根本看不出来。
 * 这个工具的存在就是为了把时间轴拉长，让你能直接从耗时上确认
 * 「这一批真的是同时跑的」。
 *
 * 真实源码里也有一个 SleepTool（src/tools/SleepTool/），
 * 用途是让模型主动等待外部状态就绪。
 *
 * 它声明为可并发：等待互不影响，几个一起等和一个一个等，
 * 前者花的是最长的那个，后者花的是总和。
 */
export const sleepTool = buildTool({
  name: 'sleep',
  description: '等待指定的毫秒数。用于演示并发调度。',
  searchHint: 'sleep wait delay pause',
  inputSchema: {
    type: 'object',
    properties: {
      ms: { type: 'number', description: '等待的毫秒数' },
      label: { type: 'string', description: '这次等待的标签，方便看日志' },
    },
    required: ['ms'],
  },

  validateInput(input) {
    if (typeof input.ms !== 'number' || input.ms < 0) {
      return { ok: false, message: '参数 "ms" 必须是非负数字。' }
    }
    return { ok: true }
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  renderToolUse: (input) => `等待 ${input.ms}ms${input.label ? `（${input.label}）` : ''}`,

  async call(input) {
    const ms = input.ms as number
    await new Promise((r) => setTimeout(r, ms))
    return `等了 ${ms}ms${input.label ? `，标签 ${input.label}` : ''}`
  },
})

export const TOOLS = [readFileTool, listDirTool, writeFileTool, sleepTool]
