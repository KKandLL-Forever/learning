# Learning Record 0003：多 Agent 与 Orchestrator–Workers

## 日期

2026-07-11

## 上下文

第 0003 课进入 Level 2，把单 Agent 拆成"编排者 + 多个专精 Worker"，并复用第 0002 课的 Agent。

## Insight

多 Agent 的价值不在"模型更多"，而在三个工程属性：

1. **上下文隔离**：每个 Worker 持有独立的 Agent 实例 → 独立的 messages 历史，互不污染。
2. **专精分工**：不同 system prompt / 工具集，各做各擅长的事。
3. **可并行**：相互独立的子任务用 `Promise.all` 同时跑，是单循环给不了的性能。

架构就四步：**路由 → 分发 → 收集 → 汇总**，各拆成一个小模块。

两个关键复用/设计点：

- **Agent 一行没改就被嵌进 Worker**——这是第 0002 课"三个边界"（Agent 只依赖 ModelAdapter 接口）的直接回报。
- **Router 是策略模式**：`KeywordRouter`（规则、离线）和未来的 `ModelRouter`（LLM 决策）实现同一接口，可无痛替换。
- **消息流（AgentMessage 日志）是多 Agent 系统最宝贵的可观测性**：每次路由/分发/回传都被记录，调试时一眼定位环节。

## 引申

- 顺序 for → Promise.all 并行是很自然的下一步优化
- Router 从关键词升级到模型路由，是从 demo 到生产的常见路径
- 下一课（Memory）会给 Agent 加跨轮次/跨会话记忆

## 相关

- [第 0003 课：多 Agent 系统](../lessons/0003-multi-agent-system.html)
- [第 0002 课：构建单 Agent 循环](../lessons/0002-single-agent-loop.html)
- [速查：设计模式与范式](../reference/design-patterns.html)
