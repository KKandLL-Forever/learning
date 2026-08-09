/**
 * mini-cc v0 —— 两个最小工具
 *
 * 对照真实源码：src/tools/ 下约 45 个工具目录，每个目录含
 * schema + 执行 + 权限 + 渲染组件。v0 只留「执行」这一维。
 *
 * 注意这两个工具都是【只读】的——v0 还没有权限系统（第 0004 课），
 * 所以现在不给循环任何写盘能力。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Tool } from './types.js'

/** v0 的临时护栏：所有路径必须落在这个根目录里。真正的路径校验在第 0004 课。 */
const ROOT = process.cwd()

function resolveInside(rawPath: string): string {
  const target = isAbsolute(rawPath) ? rawPath : join(ROOT, rawPath)
  const full = resolve(target)
  if (full !== ROOT && !full.startsWith(ROOT + '\\') && !full.startsWith(ROOT + '/')) {
    throw new Error(`路径越界：${rawPath} 不在 ${ROOT} 之内`)
  }
  return full
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`参数 "${key}" 必须是非空字符串，收到：${JSON.stringify(value)}`)
  }
  return value
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取一个文本文件的内容。路径可以是相对于工作目录的相对路径。返回带行号的文件内容。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
    },
    required: ['path'],
  },
  async call(input) {
    const full = resolveInside(requireString(input, 'path'))
    const info = await stat(full)
    if (!info.isFile()) {
      throw new Error(`${full} 不是一个文件`)
    }
    const text = await readFile(full, 'utf-8')
    return text
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
      .join('\n')
  },
}

export const listDirTool: Tool = {
  name: 'list_dir',
  description: '列出一个目录下的条目。目录名结尾带 /。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要列出的目录路径，默认为工作目录' },
    },
  },
  async call(input) {
    const raw = typeof input.path === 'string' && input.path ? input.path : '.'
    const full = resolveInside(raw)
    const entries = await readdir(full, { withFileTypes: true })
    if (entries.length === 0) {
      return '（空目录）'
    }
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n')
  },
}

export const TOOLS: Tool[] = [readFileTool, listDirTool]
