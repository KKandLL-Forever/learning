# Learning Record 0003：调度器不敢贪心，因为它读不懂意图

## 日期

2026-08-11

## 上下文

第 0003 课「并发分批」。在 `mini-cc/src/v2/` 加入 `partition.ts`、`runTools.ts`、`concurrency.ts` 和一个 `sleep` 工具，对照 `src/services/tools/toolOrchestration.ts`（188 行）与 `src/utils/generators.ts:32`。

## Insight

### 一、「相邻」是这个算法唯一需要记住的字

分批规则只合并**位置上相邻**的安全调用，碰到不安全的就断开。判断条件只回头看一格：

```ts
if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) { ... }
```

直觉上更优的做法是「扫一遍把所有只读的收集起来一起跑」，并行度更高。但那样会破坏因果。

**关键推理：调度器不知道模型的意图，它唯一能依靠的信息就是模型给出的顺序。** 「读 A、改 A、再读 A」里第三次读，语义上就是要读改完之后的内容。把它提前，拿到旧内容，而且**不会报错**，只会让模型基于过时信息继续推理。这类 bug 没有任何信号。

所以规则保守到只敢合并相邻项，少赚一点并行度，换「顺序永远不会被悄悄改写」。

### 二、并发上限和分批方案是两件事

实测确认过：`MINI_CC_MAX_CONCURRENCY=1` 时分批方案完全不变（仍是 3 批），变的只是批内实际并发度（第 1 批从 608ms 变成约 1200ms）。

这两个旋钮容易被混为一谈。分批解决的是**正确性**（因果顺序），上限解决的是**资源**（句柄、限流）。做成了第 3 课测验第 2 题的干扰项。

### 三、`Promise.all` 在这里根本用不了

两个理由，第一个更本质：

1. **合的必须是生成器，不是 promise。** 工具执行期间要往终端实时推进度，那些是逐个 yield 的事件。`Promise.all` 只在全部结束时给一个数组，中间事件没有出口。
2. 没有并发上限。

`all()` 的办法是把 `Promise.race` 当**滑动窗口**用：维持一个固定大小的 `Set`，race 出最先有动静的那个，处理完立刻补位。

实现细节值得单记：`next()` 返回的对象里**装着 promise 自己**，race 出来后可以精确 `delete` 这一个，池子进出 O(1)。否则得遍历找是谁赢了。

### 四、fail-closed 在这一课有了第二个落点

第 0002 课讲的是**默认值**层面的 fail-closed（`TOOL_DEFAULTS`）。这一课看到**取值处**还包了第二层：

```ts
const isConcurrencySafe = parsedInput?.success
  ? (() => { try { return Boolean(tool?.isConcurrencySafe(parsedInput.data)) }
             catch { return false } })()
  : false
```

两条路径都倒向 `false`：schema 没过、以及 `isConcurrencySafe` 自己抛异常（源码注释点名 `BashTool` 解析 shell 引号可能炸）。

**提炼：**「不知道安不安全」必须当成「不安全」，而不是「再想办法猜一下」。一个看似聪明的错误答案是「回退到 `isReadOnly` 判断」，但 `BashTool` 的 `isConcurrencySafe` 本来就是转交给 `isReadOnly` 的，同一个解析同样会炸。

### 五、加模块反而让循环变短了

v2 改动最大的是 `loop.ts`，它**变短了**。那段挨个跑工具的 `for` 循环整个搬进 `runTools.ts`，循环里只剩 `yield* runTools(...)`。

循环从此不知道谁能并发。这兑现了第 0002 课那个说法：`isConcurrencySafe` 是给**调度器**这个消费者准备的，循环从头到尾没读过它。

## 已实测验证的事实

- 「读 A、改 A、再读 A」→ 3 批（不是 2 批）
- `Read A · Read B · Edit C · Read D · Read E` → `[R,R] [W] [R,R]`
- 工具不存在 → 判为不安全；缺必填参数（schema 不过）→ 判为不安全
- `all()` 上限生效：4 个各 120ms 的生成器，cap=2 耗时 250ms，cap=10 耗时 123ms
- v2 演示：两个 600ms 的 sleep 一批跑完耗时 **608ms**（串行应为 1200ms）

## 引申

- **「让抽象变成可测量的数字」这个教学手段很有效。** 读文件太快看不出并发，加一个 `sleep` 工具把时间轴拉长，608ms 这个数字本身就是证据，比任何解释都直接。后续讲缓存命中率、压缩前后 token 数时可以复用同一手法。
- 第 0004 课（权限）的切入点已经清楚：v2 的工具仍是**无条件执行**的，模型说写就写。真实系统在 `call()` 之前夹着 10 个检查点，而**次序本身就是安全语义**。这和本课「顺序决定正确性」正好呼应，可以接着讲。
- 「反教条环节」连续三课都是最有价值的部分，继续保留（0001 `taskBudgetRemaining` 刻意不进 State，0002 `isDestructive` 不适用 fail-closed，0003 不敢贪心合并）。

## 相关

- [第 0003 课：并发分批](../lessons/0003-tool-batching.html)
- [第 0002 课：工具契约](../lessons/0002-tool-contract.html)
- [速查：架构术语表](../reference/glossary.html)
- 代码：`mini-cc/src/v2/`（`partition.ts`、`runTools.ts`、`concurrency.ts` 为新增）
