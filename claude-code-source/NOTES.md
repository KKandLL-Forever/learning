# Notes

## 用户偏好

- **背景**：Web 前端工程师，熟悉 React/Next.js，TypeScript 优先
- **语言**：除专业名词外全部中文
- **学习风格**：动手派 —— 「目标产出是可运行的项目，而非纯理论」
- **已有基础**（来自 `D:\code\learning\harness-engineering`）：
  - 0001 Agentic Loop 是一切 harness 的内核
  - 0002 单 Agent 循环的三个边界（Agent 只依赖 ModelAdapter 接口）
  - 0003 Orchestrator–Workers：路由 → 分发 → 收集 → 汇总；上下文隔离是多 Agent 的真正价值
- **双目标**：既要写出生产级代码（目标 1），也要提炼设计原则（目标 3）。每节课两条线都要照顾到。

## 教学决策

- **课程位置**：`D:\code\learning\claude-code-source\`，与 `harness-engineering`、`prompt-engineering` <strong>同级</strong>。
  用户明确纠正过一次——课程属于 `learning` 工作区，**不放进被研究的源码仓库里**。源码仓库 `D:\code\claude-code-source` 保持只读、不受污染。
  所有指向源码的链接都是跨仓库相对路径：课程根用 `../../claude-code-source/…`，`lessons/` 和 `reference/` 深一层，用 `../../../claude-code-source/…`。
- **起点形态**：全新极简内核（用户明确选择），不复用 harness-engineering 的 `agent.ts`——避免旧结构约束
- **代码位置**：`mini-cc/`，按 `src/v0/`、`src/v1/`… 分版本目录，每节课一个版本，**旧版本保留**，方便回看演进
- **同栈原则**：用 Bun + TypeScript，与 `claude-code-source` 一致，降低对照源码时的心智负担
- **每节课结构**：知识（为什么）→ 动手（写代码）→ 对照（真实源码怎么写）→ 取舍题（判断力）

## 课程弧线（暂定，按需调整）

| 课 | 主题 | 加的模块 | 对应报告章节 |
|---|---|---|---|
| 0001 | 极简内核：循环、生成器、显式状态 | `loop.ts` | 00, 01 |
| 0002 | 工具契约：为什么一个工具要回答 40 个问题 | `Tool` 接口、fail-closed 默认值 | 03 |
| 0003 | 并发分批：只读并发、写入串行 | `partitionToolCalls` | 04 |
| 0004 | 权限顺序：顺序本身就是安全设计 | `canUseTool` 10 步 | 12, 14 |
| 0005 | 结果预算：800KB 日志怎么办 | `budget.ts`（两层闸 + 冻结） | 06 |
| 0006 | Prompt Caching：为缓存做的让步 | cache 断点 | 05 |
| 0007 | 三级压缩：清扫、搬家、救火 | micro/auto/reactive | 06 |
| 0008 | Attachment 回灌：状态写出去再读回来 | `<system-reminder>` | 06, 10 |
| 0009 | 子 Agent 与 fork：隔离 vs 缓存命中 | AgentTool / forkSubagent | 11 |

## Provider：DeepSeek

用户指定本课程用 DeepSeek（2026-08-07）。配置：

| 项 | 值 |
|---|---|
| base_url | `https://api.deepseek.com`（OpenAI 格式） |
| 环境变量 | `DEEPSEEK_API_KEY` |
| 默认模型 | `deepseek-v4-flash`（1M 上下文 / 384K 输出，比 pro 便宜 3 倍） |
| SDK | `openai` npm 包 |

**为什么没用 Anthropic 兼容端点**（`https://api.deepseek.com/anthropic`）：
官方文档的「不支持字段」里明确列出 **tool use**。整门课建立在工具调用上，所以只能走 OpenAI 格式端点。
代价是 `model.ts` 里有一层双向转换——内部保持 Anthropic 式 content blocks（与 `claude-code-source` 一致），出入口转成 OpenAI 式。
转换层已用本地假服务器做过端到端验证：一条 user 消息里的 N 个 `tool_result` 正确展开成 N 条 `role:'tool'` 消息；坏 JSON 参数降级成 `{}` 而非抛异常（保住配对）。

**这个决定反而成了教材**：换 provider 时 `loop.ts`/`tools.ts`/`types.ts` 一行没改，只动 `model.ts`——正好印证用户在 harness-engineering 学的「三个边界」。已写进第 0001 课的「接上真实模型」一节。

## 待办 / 观察

- 用户尚未确认是否已有 `DEEPSEEK_API_KEY` 环境变量（当前 shell 里没有）。第 0001 课设计了**离线 Mock 模式**兜底，无 key 也能跑通循环。
- **第 0006 课（Prompt Caching）需要重新设计**：DeepSeek 的上下文缓存是**自动**的，没有 `cache_control` 断点、没有 4 个断点上限、没有 TTL/scope 选择。所以那一课不能靠 `mini-cc` 动手复现断点落位。
  改法：把「DeepSeek 自动缓存 vs Claude 手动断点」的**对比**本身当成教材——手动断点换来的是什么（精确控制哪一段被缓存、fork 时移动标记让写入变 no-op），代价是什么（击穿归因要写 534 行模块）。这比单纯讲实现更贴近用户的目标 3（提炼设计原则）。
  DeepSeek 缓存价格差异很大（命中 ¥0.02 vs 未命中 ¥1/M，flash），所以「前缀稳定性」这个核心直觉仍然完全成立，动手部分可以改成**观测缓存命中率**。
- **第 0005 课留了一个真实漏洞**：`mini-cc` 的 `read_file` 声明 `Infinity`，两层预算都豁免它，但它自己没有任何边界（真实源码的 Read 有行数上限和 `maxTokens`）。所以演示里模型取回 44.4KB 全文时，那 44.4KB 原样进了历史。课程把它写成练习（加 `offset` / `limit`），如果用户做了，记得回来更新这条。
- **`--stability` 的手法值得复用**：用 sha1 指纹把「前缀稳定」这个抽象概念变成一列可直接对比的十六进制。第 0006 课（缓存命中率）、第 0007 课（压缩前后 token 数）都可以照这个思路把抽象量化。
- `mini-cc` 运行时会在 `mini-cc/.mini-cc/tool-results/` 落盘，已加进仓库根 `.gitignore`（连同 `scratch/`）。
- 报告里的「被否决的设计」（如 #21841 PDF 截断 A/B 结论）是训练目标 3 的绝佳素材，后续课程多用。
