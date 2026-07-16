# Learning Record 0002：Harness 的三个边界

## 日期

2026-07-10

## 上下文

第 0002 课将第 1 课的最小循环扩展为一个可运行的 TypeScript 项目。

## Insight

一个好的 Harness 必须拆出清晰边界：

1. **Model Adapter**：隔离不同 LLM 的 API 差异，让 Agent Loop 只看到统一的数据结构
2. **Tool Registry**：把工具当作可插拔组件，负责注册、查询、执行和错误隔离
3. **Agent Loop**：只负责编排（Orchestration），不处理具体模型或工具细节

这种分层让系统在不改核心循环的前提下换模型、加工具、改 UI。Mock Model 的存在让学习和测试不需要真实 API Key，这是工程上很重要的设计。

另一个关键点是错误处理：工具执行失败不应直接终止循环，而是把错误信息作为 tool_result 返回给模型，让模型参与决策。这提高了 Harness 的韧性。

## 引申

- 这个三边界结构是未来多 Agent 系统的基础
- Model Adapter 抽象也可以扩展到支持多模态、reasoning 模型等
- Tool Registry 的 execute 返回 string，未来可扩展为返回结构化数据

## 相关

- [第 0002 课：构建单 Agent 循环](../lessons/0002-single-agent-loop.html)
- [速查：Agentic Loop 模式](../reference/agentic-loop-pattern.html)