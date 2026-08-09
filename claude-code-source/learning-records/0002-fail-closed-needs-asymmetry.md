# Learning Record 0002：fail-closed 不是「默认值都往保守写」

## 日期

2026-08-08

## 上下文

第 0002 课「工具契约」。在 `mini-cc/src/v1/` 加入 `buildTool()` + `TOOL_DEFAULTS` + 第一个写工具，对照 `src/Tool.ts`（792 行，`Tool` 接口 47 个成员）。

## Insight

### 一、「为什么这么多成员」是错的问题

正确的问题是**「同一次工具调用，有几种消费者在看它？」**——五种：模型、权限系统、调度器、终端 UI、安全分类器。每种看到的形态完全不同，所以成员按消费者分组而不是按功能分组。

这个框架能替代死记硬背：拿到任何一个陌生成员，先问它服务于哪种消费者，就知道它为什么存在。

**推论（本课最反直觉的观察）：** 工具契约从 4 个成员膨胀到 47 个，但 `loop.ts` 几乎没动。因为复杂度是给*其它消费者*的，循环只关心 `call()` 和 `validateInput()`。这恰恰证明了把它们塞进同一个接口是对的——各取所需，互不知情。

### 二、fail-closed 的成立条件是「后果不对称」

这是本课真正的收获，而且它修正了一个容易形成的教条。

`isConcurrencySafe` 默认 `false` 之所以对，是因为两个方向的代价严重不对称：

| 默认 | 猜错的代价 |
|---|---|
| `true` | 难以复现的数据竞争 |
| `false` | 慢一点 |

存在一个明确的「猜错了也不会出事」的方向，所以能设安全默认值。

**但 `isDestructive: () => false` 不属于这一类。** 它的含义不是「保守假设」，而是「大多数工具确实不具破坏性」——是*统计常见值*，不是*安全值*。默认 `true` 会让几乎所有工具被当成危险操作，系统没法用。所以这里根本不存在安全方向，源码的做法是把责任显式还给作者：

> Only set when the tool performs irreversible operations (delete, overwrite, send). — `Tool.ts:405`

`toAutoClassifierInput` 默认 `''`（＝跳过安全分类器）是同一类，注释专门写了「security-relevant tools must override」。默认值是「不参与」，而不是「按最严处理」。

**提炼成可迁移的原则（服务用户目标 3）：**
> fail-closed 只在后果不对称时成立。当两个方向代价相当、或无法从缺省推断时，正确做法是把责任显式还给作者（注释 + code review），而不是假装有个安全默认值。

### 三、已核实的源码事实（非转述报告）

- `Tool` 接口顶层成员 **47 个**，其中 `render*` 方法 **8 个**（架构报告写的是「40+」和「10 个」，是约数）
- `src/tools/FileEditTool/FileEditTool.ts:86` 用了 `buildTool`，但**通篇未声明** `isConcurrencySafe`/`isReadOnly`/`isDestructive` —— grep 确认，报告的说法属实
- `src/tools/BashTool/BashTool.tsx:434` 逐次委托：`isConcurrencySafe(input) { return this.isReadOnly?.(input) ?? false }`
- `buildTool` 的三层展开顺序（`Tool.ts:787`）有讲究：`userFacingName` 必须夹在 `TOOL_DEFAULTS` 和 `...def` 中间

## 引申

- **第 0003 课的前置已就位**：v1 有了会写的工具 + 能回答「谁能并发」的契约，分批算法才有东西可分。
- `isConcurrencySafe` **接收 input** 这个细节要在第 0003 课再强调一次——BashTool 的逐次判定是它的唯一理由，容易被抄成无参版本。
- 教学模式确认有效：第 0001 课用「demo 版 → 指出具体失败模式 → 生产版」，本课用「错的问题 → 对的问题 → 框架」。两者都是先立锚点再给答案，比直接罗列有效。
- 「反教条细节」这个栏目连续两课都成了最有价值的部分（0001 是 `taskBudgetRemaining` 刻意不进 State，0002 是 `isDestructive` 不适用 fail-closed）。**应固定为每课的常设环节**——它是目标 3 的主要载体。

## 相关

- [第 0002 课：工具契约](../lessons/0002-tool-contract.html)
- [第 0001 课：极简内核](../lessons/0001-minimal-kernel.html)
- [速查：架构术语表](../reference/glossary.html)
- 代码：`mini-cc/src/v1/`（`buildTool.ts` 为新增）
