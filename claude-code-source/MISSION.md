# 学习目标：Claude Code 源码架构

## 为什么要学这个

我是一名 Web 前端工程师（TypeScript 优先）。我已经手写过极简的 Agentic Loop 和多 Agent 编排（见 `D:\code\learning\harness-engineering`），但那些还停留在 demo 阶段：没有预算管理、没有权限控制、没有缓存策略、没有上下文压缩。

`D:\code\claude-code-source` 是 Anthropic 官方 Claude Code CLI 的反编译还原版——一个**真正在生产环境跑了很久**的 Agent 运行时。它把我 demo 里回避掉的所有难题都解决了一遍，而且注释里写满了「为什么这样设计」和「哪个方案被线上数据否决了」。

**核心驱动力（双目标）：**

1. **造自己的生产级 Agent 运行时** —— 把 Claude Code 的核心模式（工具契约、并发分批、权限顺序、结果预算、Prompt Caching、三级压缩、子 Agent 隔离）逐个移植进我自己的项目。
2. **提炼可迁移的设计原则** —— 理解「缓存优先于优雅」「默认 fail-closed」「状态写出去再读回来」这三条原则背后的推理，用于日常架构决策。

## 学成之后能做什么

- 我能从零写出一个具备生产级骨架的 Agent 运行时：显式状态机 + 错误恢复 + 终止原因
- 我能解释每一个模块**为什么存在**——它挡住了哪个具体的失败模式
- 面对一个 Agent 架构问题，我能判断该往哪个方向让步（缓存？安全？上下文额度？）
- 我能在 `claude-code-source` 里定位任意行为对应的文件，并读懂注释里的设计取舍

## 学习方式

**主线是动手：** 在 `mini-cc/` 里从一个约 150 行的极简内核起步，每节课加一个模块，逐步逼近真实源码。真实源码作为「答案参照」——先自己写，再对照 Anthropic 怎么写，差异处就是这节课的收获。

**副线是判断力：** 每节课结尾有一道「设计取舍题」，训练第 2 个目标。

## 约束条件

- 技术栈：TypeScript + Bun（与 `claude-code-source` 同栈）
- 语言：除专业名词（Agentic Loop、Prompt Caching、fail-closed 等）外全部中文
- 时间：工作之余，每节课控制在 20–30 分钟内可完成
- 前置：已掌握 Agentic Loop 基本概念、Tool Use、多 Agent 编排的朴素实现

## 已知的教材边界

这份源码是反编译还原版，读的时候要记住三件事（架构报告第 15 章）：

1. `feature()` 恒为 `false` —— 所有 feature-gated 分支在源码仓库是死代码，只反映官方架构意图
2. `src/` 下 2829 个 TS 文件中有 **123 个是 `Auto-generated stub`**（约 4%），比如 `src/query/transitions.ts` 只有 `export type Terminal = any`。读到这类文件要意识到它不是原貌
3. 最有价值的信息在注释里，写的是**为什么**而不是**是什么**

---

*最后更新：2026-08-05*
