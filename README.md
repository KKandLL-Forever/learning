# Learning · 学习课程总览

本目录收录三门自学课程：一门 **Python 基础**，两门围绕**构建可投产的 AI Agent 系统**。课程均以中文授课（专业名词保留英文），网页课件为纯静态 HTML，AI 相关课程的代码示例统一使用 **DeepSeek**（OpenAI 兼容接口）。

---

## 三门课

| 课程 | 目录 | 学什么 | 一句话 |
|---|---|---|---|
| **Python 基础** | [`python/`](./python/) | 变量、类型、循环、条件、函数等基本语法 | 打好编程语言地基 |
| **Harness Engineering** | [`harness-engineering/`](./harness-engineering/) | 构建、编排、控制 Agent 系统的"骨架" | 教你搭引擎线束 |
| **Prompt Engineering** | [`prompt-engineering/`](./prompt-engineering/) | 系统地设计、评估、迭代 prompt 的工程方法 | 教你写并打磨指令 |

后两门互补：Harness 是骨架，Prompt 是指令，合起来才是能投产的 Agent；课件之间已双向交叉链接。Python 课则是更基础的一条独立学习线。

---

## 课程零：Python 基础

面向有其他语言基础、想把 Python 作为职业技能系统掌握的学习者。课程短小、可随时中断恢复，目标是能读懂并写出含变量、条件、循环、函数的脚本，通过初级笔试题（FizzBuzz、字符串处理、简单数据统计）。

### 课件（`python/lessons/`）

| # | 课程 | 内容 |
|---|---|---|
| 0001 | 变量与类型 | 变量、基本数据类型、f-string |
| 0002 | 列表与 for 循环 | list 基础、遍历 |
| 0003 | 条件语句 | if / elif / else |

### 速查与记录

- `python/reference/python-basics-cheatsheet.html` — 基础语法速查
- `python/learning-records/` — 每课 Insight 笔记（0001 变量与 f-string、0002 循环与条件）

> 课程配套 `python/assets/`（quiz.js + style.css）为独立样式，与 AI 课程的 Tufte 样式不同。范围暂不含 Web 框架与数据科学库，语法过关后再进阶。

---

## 课程一：Harness Engineering

从"30 行最小循环"一路搭到"多 Agent 系统"，每课都有可运行的 TypeScript 代码。

### 课件（`harness-engineering/lessons/`）

| # | 课程 | 内容 |
|---|---|---|
| 0001 | 什么是 Harness Engineering | Agentic Loop 核心模式、最小可运行 Harness、三个层次 |
| 0002 | 构建单 Agent 循环 | 三个边界：Model Adapter / Tool Registry / Agent Loop；流式输出；错误隔离；接 DeepSeek |
| 0003 | 多 Agent 系统 | Orchestrator–Workers 架构、消息传递协议、上下文隔离、路由 |

### 速查参考（`harness-engineering/reference/`）

- **agentic-loop-pattern.html** — Agentic Loop 模式速查
- **design-patterns.html** — 项目中用到的 11 个设计模式与范式（适配器 / 策略 / 注册表 / 依赖注入 / 迭代器 / 标签联合 / 错误隔离 / 中介者 / 工厂 / 外观 …）

### 可运行代码（`harness-engineering/src/`）

- `0002-single-agent-loop/` — MockModel + DeepSeekModel、ToolRegistry、Agent 循环
- `0003-multi-agent/` — Orchestrator、Worker、KeywordRouter

```bash
cd harness-engineering
npm install
npm run lesson-0002   # 运行单 Agent 循环（MockModel，无需 API Key）
npm run lesson-0003   # 运行多 Agent 系统（ScriptedModel，无需 API Key）
```

> 用真实 DeepSeek：把示例里的 MockModel/ScriptedModel 换成 `DeepSeekModel`，并配置 `.env`（`DEEPSEEK_API_KEY`），入口需 `import "dotenv/config"`。详见第 0002 课「用真实的 DeepSeek 运行」。

### 学习记录

`harness-engineering/learning-records/` 收录每课的 Insight 笔记（0001～0003）。

---

## 课程二：Prompt Engineering

强调 **Engineering**——不只是"写 prompt"，而是设计→测试→评估→迭代→版本管理的完整工程闭环。

### 目录（[`prompt-engineering/index.html`](./prompt-engineering/index.html)）

四个阶段：

- **阶段一 · 基础**
  - 0000 什么是 Prompt Engineering ✅
  - 0001 Prompt 的解剖学 ✅
- **阶段二 · 核心技巧（做对）**
  - 0002 清晰与具体 · 0003 少样本 · 0004 思维链 CoT · 0005 结构化输出 —— 规划中
- **阶段三 · 工程方法（做稳）⭐**
  - 0006 评估 · 0007 迭代循环 · 0008 失败模式与防御 · 0009 模板化与版本管理 —— 规划中
- **阶段四 · 落地**
  - 0010 接入 Agent —— 规划中

### 已完成课件（`prompt-engineering/lessons/`）

| # | 课程 | 内容 |
|---|---|---|
| 0000 | 什么是 Prompt Engineering | prompt 与 prompt engineering 的区别、五环节工程循环、最小可度量评估雏形 |
| 0001 | Prompt 的解剖学 | 一个 prompt 的五个部件、system / user 分工 |

---

## 目录结构

```
learning/
├── README.md                         ← 本文件
├── python/
│   ├── assets/         quiz.js · style.css
│   ├── lessons/        0001 / 0002 / 0003
│   ├── reference/      python-basics-cheatsheet
│   ├── learning-records/
│   └── MISSION.md · NOTES.md · RESOURCES.md
├── harness-engineering/
│   ├── assets/styles.css
│   ├── lessons/        0001 / 0002 / 0003
│   ├── reference/      agentic-loop-pattern / design-patterns
│   ├── src/            0002-single-agent-loop / 0003-multi-agent
│   ├── learning-records/
│   ├── package.json · tsconfig.json · .env.example
│   └── MISSION.md · NOTES.md · RESOURCES.md
└── prompt-engineering/
    ├── assets/styles.css
    ├── index.html                    ← 课程目录
    └── lessons/        0000 / 0001
```

---

## 约定

- **语言**：除专业名词外全部中文。
- **模型**：示例以 DeepSeek 为准（OpenAI 兼容），但工程原则与厂商无关。
- **课件**：纯静态 HTML，浏览器直接打开即可；代码高亮走 highlight.js CDN（需联网）。

---

## 进度速览

- Python 基础：0001–0003 已完成（变量 / 列表循环 / 条件），下一步函数与 dict。
- Harness Engineering：0001–0003 已完成（含可运行代码 + 设计模式速查），下一步 0004 Memory（记忆）。
- Prompt Engineering：0000–0001 已完成，下一步建议优先做阶段三的 0006 评估——它是本课区别于普通 prompt 教程的关键一课。
