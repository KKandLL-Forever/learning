# Resources

> 评级：⭐⭐⭐ = 必读　⭐⭐ = 有用　⭐ = 可选

## 一手资料（Primary Sources）

| 资源 | 类型 | 评级 | 说明 |
|------|------|------|------|
| [`docs/architecture-report.html`](../../claude-code-source/docs/architecture-report.html) | 源码仓库文档 | ⭐⭐⭐ | **本课程的主教材。** 16 章，从 query() 循环讲到防 Prompt 注入。每章都带真实文件路径与行号 |
| [`src/query.ts`](../../claude-code-source/src/query.ts)（1680 行） | 源码 | ⭐⭐⭐ | 循环骨架。`State` 类型在 :201，`queryLoop()` 在 :238 |
| [`src/Tool.ts`](../../claude-code-source/src/Tool.ts)（792 行） | 源码 | ⭐⭐⭐ | 工具契约，40+ 成员；`TOOL_DEFAULTS` 的 fail-closed 默认值 |
| [`src/services/tools/toolOrchestration.ts`](../../claude-code-source/src/services/tools/toolOrchestration.ts)（188 行） | 源码 | ⭐⭐⭐ | 并发分批策略。全课程最短的关键文件，适合完整精读 |
| [`src/utils/permissions/permissions.ts`](../../claude-code-source/src/utils/permissions/permissions.ts)（1486 行） | 源码 | ⭐⭐⭐ | 权限判定的 10 步固定顺序 |
| [`src/utils/attachments.ts`](../../claude-code-source/src/utils/attachments.ts)（3998 行） | 源码 | ⭐⭐ | 77 种上下文注入类型。体量大，按需查阅而非通读 |
| [`CLAUDE.md`](../../claude-code-source/CLAUDE.md) | 源码仓库文档 | ⭐⭐ | 仓库自身的约定，反映团队工程习惯 |

**报告作者建议的读码顺序：** `query.ts` → `Tool.ts` → `toolOrchestration.ts` → `permissions.ts` → `attachments.ts`。这五个文件覆盖 80% 的行为语义。

## Anthropic 官方工程博客

| 资源 | 类型 | 评级 | 说明 |
|------|------|------|------|
| [Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents) | 博客 | ⭐⭐⭐ | 区分 workflow 与 agent 的经典之作。读完第 0001 课后读它，能对上号 |
| [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 博客 | ⭐⭐⭐ | 「上下文是有限资源」的官方论述，对应报告第 06 章。含 context rot 概念 |
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 博客 | ⭐⭐⭐ | 长任务 harness 设计，与报告的预算/压缩章节直接呼应 |
| [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | 博客 | ⭐⭐ | 工具设计原则，第 0002 课的一手依据 |
| [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | 博客 | ⭐⭐ | 多 Agent 的真实教训（早期版本会为简单查询开 50 个子 agent）。第 0009 课用 |
| [Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 博客 | ⭐⭐ | Skill 系统的官方视角，对应报告第 09 章 |

## DeepSeek（`mini-cc` 实际调用的 provider）

| 资源 | 类型 | 评级 | 说明 |
|------|------|------|------|
| [DeepSeek API 文档首页](https://api-docs.deepseek.com/zh-cn/) | 官方文档 | ⭐⭐⭐ | base_url、鉴权、SDK 兼容性。中文 |
| [Tool Calls 指南](https://api-docs.deepseek.com/zh-cn/guides/tool_calls) | 官方文档 | ⭐⭐⭐ | `mini-cc` 转换层的依据。注意结果回传用 `role: 'tool'` 独立消息 |
| [模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) | 官方文档 | ⭐⭐⭐ | `deepseek-v4-flash` / `deepseek-v4-pro`，1M 上下文、384K 最大输出 |
| [Anthropic 格式兼容端点](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) | 官方文档 | ⭐⭐ | **本课程没有采用**——它的「不支持字段」里列了 tool use。读它是为了知道为什么绕开 |

**关键配置：**

| 项 | 值 |
|---|---|
| base_url | `https://api.deepseek.com`（OpenAI 格式） |
| 环境变量 | `DEEPSEEK_API_KEY` |
| 默认模型 | `deepseek-v4-flash`（课程默认，便宜） |
| SDK | `openai` npm 包，改 `baseURL` 即可 |
| 申请 key | <https://platform.deepseek.com/api_keys> |

## 参考文档（Reference）

| 资源 | 类型 | 评级 | 说明 |
|------|------|------|------|
| [Anthropic API：Tool use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview) | 官方文档 | ⭐⭐⭐ | `tool_use` / `tool_result` 的协议契约。**这是被研究的源码所用的格式**，也是 `mini-cc` 内部消息结构的形状 |
| [Anthropic API：Prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) | 官方文档 | ⭐⭐⭐ | 第 0006 课的前置知识：断点、前缀匹配、TTL。注意 DeepSeek 的缓存是**自动**的，没有 `cache_control` 断点——两者的对比本身就是第 0006 课的教材 |
| [OpenAI Node SDK](https://github.com/openai/openai-node) | 代码库 | ⭐⭐ | `mini-cc` 直接依赖它（指向 DeepSeek 的 baseURL） |
| [MDN：async function*](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function*) | 文档 | ⭐⭐ | 第 0001 课的语言机制基础 |

## 自己的前置课程

| 资源 | 类型 | 评级 | 说明 |
|------|------|------|------|
| [harness-engineering 课程](file:///D:/code/learning/harness-engineering/lessons/0002-single-agent-loop.html) | 自建课程 | ⭐⭐ | 第 0002 课的「三个边界」是本课程的起点前提 |

## 社区

| 社区 | 平台 | 说明 |
|------|------|------|
| [Anthropic Discord](https://www.anthropic.com/discord) | Discord | 官方社区，`#claude-code` 频道有大量 harness 实践讨论 |
| [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/) | Reddit | 用户视角的 Claude Code 用法与坑，信噪比中等 |
| [anthropics/claude-code Issues](https://github.com/anthropics/claude-code/issues) | GitHub | 官方 issue 区。看真实用户报的 bug 能反推架构约束 |

> **关于社区的说明：** 前 3–4 课以打基础为主，暂时不需要社区。等你开始移植模块进自己的项目、遇到「这样设计对不对」的判断题时，Discord 的 `#claude-code` 是最值得问的地方——那里有人真的在生产环境跑 harness。

---

*最后更新：2026-08-05*
