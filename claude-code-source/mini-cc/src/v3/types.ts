/**
 * mini-cc v3 —— 类型契约（工具契约展开）
 *
 * 对照真实源码：src/Tool.ts（792 行，Tool 接口 47 个成员）
 *
 * v0 的 Tool 只有 4 个成员：name / description / inputSchema / call。
 * v1 开始回答那个真正的问题——【同一次工具调用，有几种消费者在看它？】
 * 每多一种消费者，就多几个成员。
 */

// ── 消息内容块（与 v0 相同）────────────────────────────

export type TextBlock = { type: 'text'; text: string }

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AssistantContent = TextBlock | ToolUseBlock

export type UserMessage = {
  role: 'user'
  content: string | ToolResultBlock[]
}

export type AssistantMessage = {
  role: 'assistant'
  content: AssistantContent[]
}

export type Message = UserMessage | AssistantMessage

// ── 终止原因（与 v0 相同）──────────────────────────────

export type Terminal =
  | { reason: 'completed' }
  | { reason: 'max_turns'; turnCount: number }
  | { reason: 'aborted' }

// ── 事件流 ──────────────────────────────────────────────

/** 分批方案里的一批，只留 UI 要画的信息。 */
export type BatchSummary = {
  isConcurrencySafe: boolean
  names: string[]
}

export type QueryEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_end'; name: string; preview: string; isError: boolean }
  // v2 新增：把调度决策也交付出去，否则并发是个黑盒，看不出它做了什么
  | { type: 'batch_plan'; batches: BatchSummary[] }
  | { type: 'batch_start'; index: number; total: number; batch: BatchSummary }
  | { type: 'batch_end'; index: number }
  // v3 新增：把权限判定结果也交付出去，包括【是哪一步做的决定】
  | {
      type: 'permission'
      name: string
      behavior: 'allow' | 'deny' | 'ask' | 'passthrough'
      decidedAt: string
    }

// ── 模型适配器（与 v0 相同）────────────────────────────

export type JSONSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export type ModelAdapter = {
  complete(params: {
    system: string
    messages: Message[]
    tools: Tool[]
  }): Promise<AssistantMessage>
}

// ══════════════════════════════════════════════════════════
//  工具契约 —— 这一课的主角
// ══════════════════════════════════════════════════════════

/** 输入校验的结果。失败时带一句给模型看的话，让它自己改。 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string }

// ══════════════════════════════════════════════════════════
//  权限（v3 新增）
// ══════════════════════════════════════════════════════════

/**
 * 权限模式。对照真实源码的 PermissionMode。
 *
 * default            只读放行，每个写操作都问
 * acceptEdits        编辑类操作自动接受，不再逐次确认
 * bypassPermissions  全放行，但拦不住 1d–1g
 * dontAsk            所有 ask 一律转成 deny（无人值守场景）
 * plan               规划模式，写工具在权限层被系统性拒绝
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'plan'

export type PermissionRules = {
  deny: string[]
  ask: string[]
  allow: string[]
}

/**
 * 判定结果。
 *
 * passthrough 表示「我不表态」，交给后面的通用规则接手。
 * 它和 allow 的区别很重要：工具 schema 解析失败时保持 passthrough，
 * 既不放行也不拒绝。
 */
export type PermissionDecision = {
  behavior: 'allow' | 'deny' | 'ask' | 'passthrough'
  /** 哪一步做的决定。真实源码里对应 decisionReason，用途一样。 */
  decidedAt?: string
  /** 供 1f/1g 区分「用户配的规则」和「内置安全检查」。 */
  reason?: 'rule' | 'safetyCheck'
  message?: string
}

export type PermissionContext = {
  mode: PermissionMode
  rules: PermissionRules
  root: string
}

export type Tool = {
  // ── 组一：身份 ──────────────────────────────────────
  //  谁在看：工具注册表、ToolSearch
  readonly name: string
  /** 重命名后的向后兼容。真实源码：Tool.ts:371 */
  readonly aliases?: string[]
  /** 给 ToolSearch 做关键词匹配的一句话。3–10 词。真实源码：Tool.ts:378 */
  readonly searchHint?: string

  // ── 组二：契约 ──────────────────────────────────────
  //  谁在看：【模型】。它只能看到这两样东西。
  description: string
  readonly inputSchema: JSONSchema

  // ── 组三：执行 ──────────────────────────────────────
  //  谁在看：调度器
  call(input: Record<string, unknown>): Promise<string>
  /** 工具自己的输入合法性检查。失败不抛异常，返回消息给模型。 */
  validateInput?(input: Record<string, unknown>): ValidationResult
  /**
   * 能不能和相邻的工具并行跑。
   *
   * 【注意它接收 input】——同一个工具的安全性可能取决于具体调用。
   * 真实源码里 BashTool 就是把这个问题转交给 isReadOnly：
   *   BashTool.tsx:434  isConcurrencySafe(input) { return this.isReadOnly?.(input) ?? false }
   * `ls` 安全，`rm x` 不安全。
   *
   * 第 0003 课会真正用到它。
   */
  isConcurrencySafe(input: Record<string, unknown>): boolean

  // ── 组四：权限 ──────────────────────────────────────
  //  谁在看：权限系统
  /**
   * 工具专属的权限逻辑，在判定链的第 1c 步被调用。
   * 不表态就返回 passthrough，交给通用规则接手。
   */
  checkPermissions?(
    input: Record<string, unknown>,
    ctx: PermissionContext,
  ): Promise<PermissionDecision> | PermissionDecision
  /** 声明这个工具必须人工确认，bypass 模式下也拦得住（第 1e 步）。 */
  requiresUserInteraction?(): boolean
  isReadOnly(input: Record<string, unknown>): boolean
  /** 只在不可逆操作上设 true：删除、覆盖、发送。 */
  isDestructive(input: Record<string, unknown>): boolean
  isEnabled(): boolean

  // ── 组五：预算 ──────────────────────────────────────
  //  谁在看：结果预算裁剪器（第 0005 课）
  /**
   * 结果超过多少字符就落盘，模型只拿预览 + 路径。
   * 设 Infinity = 永不落盘（真实源码里 Read 工具就这么干，
   * 否则会形成 Read→落盘→再 Read 的循环）。
   */
  maxResultSizeChars: number

  // ── 组六：呈现 ──────────────────────────────────────
  //  谁在看：终端 UI
  /** 界面上显示的名字。默认等于 name。 */
  userFacingName(input: Record<string, unknown>): string
  /** 把这次调用压成一行给人看。真实源码有 8 个 render* 方法分管不同状态。 */
  renderToolUse(input: Record<string, unknown>): string
}

/**
 * 可以省略的成员 —— buildTool 会填上安全默认值。
 *
 * 对照真实源码：Tool.ts:707 `DefaultableToolKeys`
 */
export type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'maxResultSizeChars'
  | 'userFacingName'
  | 'renderToolUse'

/**
 * 写工具时用的类型：可默认的成员变成可选。
 * 对照真实源码：Tool.ts:721 `ToolDef`
 */
export type ToolDef = Omit<Tool, DefaultableToolKeys> &
  Partial<Pick<Tool, DefaultableToolKeys>>
