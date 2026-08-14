/**
 * mini-cc v0 —— 模型适配器（DeepSeek）
 *
 * 对照真实源码：src/services/api/claude.ts（3420 行）
 * 那 3420 行里绝大部分在处理 v0 还不关心的事：cache 断点、betas 拼接、
 * 流式事件解析、fallback 模型、provider 差异。v0 只做最朴素的一次请求。
 *
 * ── 为什么这个文件是整个项目里唯一知道「DeepSeek」这三个字的地方 ──
 *
 * loop.ts 只依赖 ModelAdapter 接口，不依赖任何 SDK。所以换 provider 时
 * 循环、工具、类型定义一行都不用改——只有这个文件需要动。
 *
 * ── 为什么用 OpenAI 格式而不是 Anthropic 格式 ──
 *
 * DeepSeek 同时提供两种兼容端点：
 *   https://api.deepseek.com            OpenAI 格式
 *   https://api.deepseek.com/anthropic  Anthropic 格式
 *
 * 后者看起来更省事（能直接沿用 @anthropic-ai/sdk 和 Anthropic 的消息结构），
 * 但官方文档在「不支持的字段」里明确列出了 tool use。这门课整个建立在
 * 工具调用上，所以只能走 OpenAI 格式端点——它的 Tool Calls 有完整文档和示例。
 *   https://api-docs.deepseek.com/zh-cn/guides/tool_calls
 *
 * 代价是：内部消息结构（Anthropic 式的 content blocks，与被研究的
 * claude-code-source 保持一致）和 DeepSeek 要的 OpenAI 式结构对不上，
 * 需要在这里做双向转换。转换代码就在下面，是这个文件里唯一有点绕的部分。
 */

import OpenAI from 'openai'
import type {
  AssistantContent,
  AssistantMessage,
  Message,
  ModelAdapter,
  Tool,
  ToolUseBlock,
} from './types.js'

/** DeepSeek 的 OpenAI 兼容端点。 */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * deepseek-v4-flash：1M 上下文、384K 最大输出，便宜。课程默认用它。
 * deepseek-v4-pro：同样规格，推理更强，贵 3 倍。
 * 价格见 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

// ── 转换：内部结构 → DeepSeek（OpenAI 格式）─────────────

/**
 * 我们内部用 Anthropic 式的 content blocks（跟 claude-code-source 一致），
 * DeepSeek 要的是 OpenAI 式。两处结构性差异：
 *
 *   1. 工具调用：我们放在 assistant 的 content 数组里（tool_use 块）；
 *      OpenAI 放在 assistant 消息的 tool_calls 字段上，content 只留文字。
 *
 *   2. 工具结果：我们塞进一条 user 消息的 content 数组（N 个 tool_result 块）；
 *      OpenAI 要求【每个结果一条独立消息】，role 是 'tool'。
 *      —— 所以这里是一对多展开，不是一对一映射。
 */
function toOpenAIMessages(
  system: string,
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ]

  for (const message of messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        out.push({ role: 'user', content: message.content })
        continue
      }
      // 差异 2：一条 user 消息里的 N 个 tool_result → N 条 role:'tool' 消息
      for (const result of message.content) {
        out.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: result.content,
        })
      }
      continue
    }

    // 差异 1：把 content 数组拆成「文字」和「工具调用」两部分
    const text = message.content
      .filter((b): b is Extract<AssistantContent, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const toolCalls = message.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }))

    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    })
  }

  return out
}

function toOpenAITools(tools: Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }))
}

// ── 转换：DeepSeek 响应 → 内部结构 ──────────────────────

function fromOpenAIMessage(
  message: OpenAI.ChatCompletionMessage,
): AssistantMessage {
  const content: AssistantContent[] = []

  if (message.content) {
    content.push({ type: 'text', text: message.content })
  }

  for (const call of message.tool_calls ?? []) {
    if (call.type !== 'function') continue
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      // 参数是模型生成的字符串，可能不是合法 JSON。
      // 这里【不抛异常】——照样产出 tool_use 块，让参数留空。
      // 后续 tool.call() 的参数校验会失败，转成一条 is_error 结果回给模型。
      // 这就是 fail-closed：解析不了不等于可以跳过，而是走「安全的失败路径」。
      input: safeParseJSON(call.function.arguments),
    })
  }

  return { role: 'assistant', content }
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// ── 真实模型 ────────────────────────────────────────────

export function createDeepSeekModel(
  model = DEFAULT_MODEL,
  /** 可覆盖，便于走代理或在测试里指向本地假服务器。 */
  baseURL = process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL,
): ModelAdapter {
  const client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL,
  })

  return {
    async complete({ system, messages, tools }) {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        messages: toOpenAIMessages(system, messages),
        tools: toOpenAITools(tools),
      })

      const choice = response.choices[0]
      if (!choice) {
        throw new Error('DeepSeek 返回了空的 choices 数组')
      }
      return fromOpenAIMessage(choice.message)
    },
  }
}

// ── Mock 模型（离线剧本）────────────────────────────────

/**
 * 按剧本逐轮返回预设响应，用来在没有 API key 时观察循环行为。
 *
 * 它证明了一件事：循环的形状与模型无关。
 * 换掉 ModelAdapter，loop.ts 一行不用改——刚才从 Anthropic 换成 DeepSeek，
 * 动的也只有这个文件。
 */
export function createMockModel(script: AssistantMessage[]): ModelAdapter {
  let turn = 0

  return {
    async complete({ messages }) {
      const step = script[turn]
      turn += 1

      if (!step) {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: '（剧本演完了）' }],
        }
      }

      // 模拟网络延迟，让事件流在终端里肉眼可见地逐条出现。
      await new Promise((r) => setTimeout(r, 250))

      // 打印这一轮模型「看见」了多少条消息 —— 这是本课最关键的观察点。
      console.log(
        `\x1b[90m      [mock] 本轮模型收到 ${messages.length} 条消息\x1b[0m`,
      )

      return step
    },
  }
}

/**
 * v4 剧本：模型跑测试，结果太大被落盘，然后【自己把全文取回来】。
 *
 * 最后那一步是整个设计的兑现。截断做不到这件事：被截掉的内容
 * 从此不存在了，模型再想看也没办法。落盘只是换了个寻址方式，
 * 全文一直在，模型缺什么自己去取。
 *
 * 第二轮那个路径是硬编码的，因为落盘文件名就是 tool_use_id。
 * 真实运行里模型不需要猜——路径明明白白写在它收到的那段
 * <persisted-output> 里。
 */
export const DEMO_SCRIPT: AssistantMessage[] = [
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我并行跑三个测试套件。' },
      { type: 'tool_use', id: 'call_1', name: 'run_tests', input: { suite: 'unit', lines: 1200 } },
      { type: 'tool_use', id: 'call_2', name: 'run_tests', input: { suite: 'e2e', lines: 900 } },
      { type: 'tool_use', id: 'call_3', name: 'run_tests', input: { suite: 'smoke', lines: 120 } },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'unit 的日志太长被落盘了，预览不够，我把全文取回来。' },
      {
        type: 'tool_use',
        id: 'call_4',
        name: 'read_file',
        input: { path: '.mini-cc/tool-results/call_1.txt' },
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '拿到了。预览够用就不用取，不够用我自己去读一次。',
      },
    ],
  },
]

/**
 * v5 剧本：多跑几轮，每轮只加一点点内容。
 *
 * 第 0005 课那个剧本一上来就取回 44KB 全文，历史暴涨，
 * 缓存命中率被稀释得看不出趋势。这里反过来，让每轮的增量都很小，
 * 好看清「历史越长、能复用的比例越高」这条曲线。
 */
export const CACHE_SCRIPT: AssistantMessage[] = [
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '先看看根目录。' },
      { type: 'tool_use', id: 'k1', name: 'list_dir', input: { path: '.' } },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '看下 src 下面有什么。' },
      { type: 'tool_use', id: 'k2', name: 'list_dir', input: { path: 'src' } },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '再看 v5。' },
      { type: 'tool_use', id: 'k3', name: 'list_dir', input: { path: 'src/v5' } },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '读一下 package.json。' },
      { type: 'tool_use', id: 'k4', name: 'read_file', input: { path: 'package.json' } },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '等一下，确认没有后台任务。' },
      { type: 'tool_use', id: 'k5', name: 'sleep', input: { ms: 10, label: 'settle' } },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '看完了，这是一个按版本分目录的教学项目。' }],
  },
]

// ── 选择器 ──────────────────────────────────────────────

export function pickModel(): { model: ModelAdapter; label: string } {
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      model: createDeepSeekModel(),
      label: `DeepSeek (${DEFAULT_MODEL})`,
    }
  }
  return {
    model: createMockModel(DEMO_SCRIPT),
    label: 'Mock 剧本（未检测到 DEEPSEEK_API_KEY）',
  }
}
