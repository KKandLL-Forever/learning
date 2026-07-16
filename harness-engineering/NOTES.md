# Notes

## User Preferences

- 技术栈：TypeScript/JavaScript 优先
- 背景：Web 前端工程师，熟悉 React/Next.js 生态
- 语言偏好：除专业名词（如 Agentic Loop、Tool Use、Orchestration）外，所有文字使用中文
- 学习风格：偏向动手实践，希望从实际项目中学
- 当前工作环境：已有 Claude Code 和 browser-harness 使用经验

## Working Notes

- 用户已经在使用 Claude Code 的 agents、workflows、skills 等特性——这些本身就是 harness 的实例
- 可以从 "你已经在使用的东西" 出发，反向拆解 harness 的设计原理
- Vercel AI SDK 可能是最适合入口：TypeScript 原生、前端友好、支持工具调用和 Agent 循环