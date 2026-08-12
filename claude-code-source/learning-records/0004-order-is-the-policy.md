# Learning Record 0004：顺序就是策略本身

## 日期

2026-08-12

## 上下文

第 0004 课「权限判定顺序」。在 `mini-cc/src/v3/` 加入 `permissions.ts`，把 `canUseTool()` 插进 `call()` 之前，对照 `src/utils/permissions/permissions.ts:1158` 的 `hasPermissionsToUseToolInner()`。

## Insight

### 一、安全属性可以完全寄生在语句顺序上

权限系统里有好几种规则会对同一次调用给出**互相矛盾**的判断。裁决方式就是「谁先 `return` 谁赢」。所以位置不是代码风格问题，是策略本身。

排序原则一句话：

> 越是「用户明确表达过的意图」和「不可挽回的破坏」越靠前，越是「图省事的全局开关」越靠后。

`bypassPermissions` 因此排在第 8 位（2a）而不是第 1 位。用户开「全放行」的本意是「常规操作别烦我」，不是「允许你改我的 git 配置」。

**已实测的证据：** 把 1g（敏感路径 safetyCheck）整段挪到 2a 之后，一个字符都不改，`bypassPermissions` 写 `.git/config` 立刻从 `ask` 变成 `allow`。

这个漏洞的性质值得记住：代码没有一处写错，逻辑没有一处矛盾，测试如果只覆盖「bypass 下普通写入能通过」也照样全绿。**类型系统对这个约束一无所知。**

这也解释了为什么源码这一段注释密度异常高，几乎每步都在说「必须在那一步之前/之后」。注释是唯一能记录这个约束的地方。

### 二、一个证明顺序是规格的硬证据

源码里有另一个函数 `checkRuleBasedPermissions()`，文档注释写着：

> Check only the rule-based steps of the permission pipeline, the subset that bypassPermissions mode respects (**everything that fires before step 2a**). — `permissions.ts:1062`

**这个函数的规格就是「第 2a 步之前的全部步骤」。** 如果顺序只是随手排的，这句话没法作为定义写下来。步骤编号在这里已经不是注释，是可被引用的契约。

### 三、passthrough 不等于 allow（这次的反教条点）

第 1c 步调用 `tool.checkPermissions()` 时如果抛异常，源码**保持 passthrough**，既不放行也不拒绝。

按第 0002、0003 课的 fail-closed 惯性，很容易以为应该直接 `deny`。但 `passthrough` 的含义是「我不表态」，之后 1f、1g 照常检查，最后第 3 步把它落到 `ask`。

**结果仍然是保守的，只是保守由通用规则兜底，而不是由工具自己下判断。** 直接拒绝反而会让 schema 稍微不常规的工具全线失灵。

提炼：fail-closed 的落点可以是「交给下一层」，不一定是「当场拒绝」。关键看**整条链路的终点**是否保守，而不是每一环都必须自己拒绝。

### 四、外层变换放在最后，是为了防早退

`dontAsk` 的 ask→deny、`auto` 的分类器，都没写进十步，而是包在外面。源码注释：

> This is done at the end so it can't be bypassed by early returns — `permissions.ts:504`

十步里有九个提前 `return` 的出口。放最外层，所有出口都必须先经过它。

### 五、权限层是防注入唯一不依赖模型的防线

前三层防御（系统提示词告知、`<system-reminder>` 结构隔离、输入净化）都在试图「别让模型上当」，但没人敢保证。

第四层思路完全不同：**就算它上当了，也执行不了。** 模型的「意图」根本不构成许可，权限判断只看这次调用本身要动什么。

无 UI 场景的降级也有讲究：后台 agent 把所有 ask 转成 deny 时，会附一句「是**没法问**，不是**被禁止**」。这个区分让模型换思路而不是反复重试到轮次耗尽。

## 已实测验证的事实

- 判定矩阵（4 种操作 × 5 种模式）全部符合预期
- `bypassPermissions` + `.git/config` → `ask`，判定于 1g
- 把 1g 挪到 2a 之后 → 同一格变成 `allow`（漏洞复现成功）
- agent 演示：bypass 模式下普通写入放行、`.git/config` 写入被拦

## 一处我自己写错又改正的地方

初版把 `acceptEdits` 实现成了「只读放行，写操作仍问」，语义正好写反。`acceptEdits` 的含义是**自动接受编辑类操作**。改正后矩阵才呈现出正确的递进：`default` 问写入 → `acceptEdits` 放行写入 → `bypass` 放行更多，而 `.git/` 那行在三种模式下**始终是 ask**。

改对之后这张表的教学效果反而更强了：三种越来越宽松的模式，敏感路径那一行纹丝不动。

## 引申

- **「亲手制造一个漏洞」比「解释为什么安全」有效得多。** 实验 A 让学习者把 1g 挪到 2a 后面，亲眼看到 `ask` 变 `allow`。这个手法可以复用到后面的课（比如第 0006 课让学习者亲手击穿一次缓存，看成本变化）。
- 第 0005 课（结果预算）的切入点：权限管住了「能不能做」，但做完之后的东西还要塞回对话。这是从「控制副作用」转向「控制上下文」的转折点，也是三级压缩那条线的起点。
- 报告第 12 章和第 14 章应该连着读，第 14 章的第四层就是第 12 章。已写进本课的推荐资料。

## 相关

- [第 0004 课：权限判定顺序](../lessons/0004-permission-order.html)
- [第 0003 课：并发分批](../lessons/0003-tool-batching.html)
- [速查：架构术语表](../reference/glossary.html)
- 代码：`mini-cc/src/v3/`（`permissions.ts` 为新增）
