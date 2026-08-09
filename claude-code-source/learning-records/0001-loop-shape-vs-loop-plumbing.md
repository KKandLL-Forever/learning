# Learning Record 0001：循环的形状不难，难的是循环的管道

## 日期

2026-08-05

## 上下文

课程开课。第 0001 课「极简内核」，在 `mini-cc/src/v0/` 写出约 150 行的 Agent 运行时，对照 `src/query.ts`（1680 行）。

学习者的前置基础来自 `D:\code\learning\harness-engineering`：已经手写过单 Agent 循环和 Orchestrator–Workers 多 Agent 编排。

## Insight

**`query.ts` 的 1680 行里，循环骨架只占几十行。剩下的全是「周边」。**

把 demo 循环和生产循环放在一起看，骨架（`while(true)` → 发请求 → 有 tool_use 就执行并塞回 → 没有就结束）完全相同。差别集中在三个接口上，而这三处都不是「功能」，是**可运维性**：

1. **返回终止原因而非答案** —— 答案已经通过 `yield` 交付了，`return` 的位置空出来回答「控制流为什么走到这里」。调用方需要区分「正常答完 / 撞轮次上限 / 用户中断 / stop hook 拒绝」，这四种情况 UI 表现完全不同。demo 返回一个字符串，把这个信息丢掉了。

2. **AsyncGenerator 的第三个理由** —— 流式交付和多轮事件是显而易见的两个理由，但**可取消**是最容易漏掉、也最难事后补上的那个：`.return()` 让生成器在当前 `yield` 处中断，`finally` / `using` 的清理自动跑。普通 async 函数一旦 await 出去，没有干净的办法「停在半路并清理现场」。

3. **State 整体重写** —— 9 个跨轮次变量 × 7 处 `continue`。散落赋值时，漏一行不报错，只在罕见分支上表现为诡异行为（比如重试计数没归零导致死循环）。打包成对象后，TypeScript 拒绝缺字段的对象字面量，漏字段从「运行时的罕见惊喜」变成「编译期的即时错误」。

   已实测验证：注释掉 `transition` 字段，`tsc` 报 `TS2741: Property 'transition' is missing`。

**贯穿性的观察（后续四课的引子）：** mini-cc 跑起来后，mock 打印的消息数是 `1 → 3 → 5`，每轮增加 2 条。模型没有记忆——它"记得"第 1 轮做过什么，只因为那条 `tool_result` 还躺在 `messages` 里，且**每轮完整重发**。这一个事实是结果预算、Prompt Caching、三级压缩三套机制共同的起因。

## 一个反教条的细节

`State` 不是「所有跨轮变量都该进去」。真实源码里 `taskBudgetRemaining` 被**刻意**放在循环内局部变量而非 `State`，注释写明理由：「以免改动那 7 处 continue」。

判断依据不是教条，而是：*这个变量在 `continue` 之后是否需要保持修改？* 需要就进 State，不需要就别去动那 7 个点。

这个细节被做成了第 0001 课的第 3 道测验题——它同时训练目标 1（写对代码）和目标 3（提炼原则时不要过度推广）。

## 教材边界（已确认，非推测）

- `src/` 下 2829 个 TS 文件中，**123 个含 `Auto-generated stub`**（约 4.3%）。`src/query/transitions.ts` 就是其一，整个文件只有 `export type Terminal = any`。
- 因此教学时凡涉及类型定义，要么从实际使用点反推（如从 `query.ts` 的 `return` 语句反推 `Terminal` 的形状），要么先确认该文件不是桩。
- `feature()` 恒为 `false`，feature-gated 分支是死代码（报告第 15 章自陈）。

## 引申

- 后续每课的开场都可以用同一个模式：**先展示 demo 版怎么写 → 指出它在哪个具体失败模式上会崩 → 再给生产版**。第 0001 课验证了这个模式好用，因为学习者已有 demo 级基础，直接讲生产版会缺少对照锚点。
- 学习者的双目标（造运行时 + 提炼原则）在一节课里可以同时照顾：正文和动手环节服务目标 1，测验的第 3 题和「反教条细节」服务目标 3。
- 第 0002 课（工具契约）的切入点已经找到：`mini-cc` 的 `Tool` 只有 4 个成员，`src/Tool.ts` 有 40+ 个。问题不该是「为什么这么多」，而该是「同一次工具调用有几种消费者在看它」——报告第 03 章给了五种，这个框架比逐个罗列成员好教得多。

## 相关

- [第 0001 课：极简内核](../lessons/0001-minimal-kernel.html)
- [速查：架构术语表](../reference/glossary.html)
- 代码：`mini-cc/src/v0/`
- 前置：[harness-engineering 第 0002 课：单 Agent 循环](file:///D:/code/learning/harness-engineering/lessons/0002-single-agent-loop.html)
