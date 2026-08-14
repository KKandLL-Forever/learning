# Learning Record 0006：改在哪儿，决定赔多少

## 日期

2026-08-14

## 上下文

第 0006 课「Prompt Caching」。在 `mini-cc/src/v5/` 加入 `cache.ts`（本地前缀缓存模拟器 + 打穿侦测器），对照 `src/services/api/promptCacheBreakDetection.ts`（727 行）、`src/services/api/claude.ts:359` 的 `getCacheControl()`、`src/utils/api.ts:321` 的 `splitSysPromptPrefix()`。

## Insight

### 一、这是课程里第一个「只能观测、不能控制」的东西

前五课的每样东西都在手上：循环、工具、权限顺序、预算阈值。缓存整个发生在服务端，客户端只有账单上两个数字（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）。

但**「为什么没命中」完全是客户端的责任**，因为前缀是客户端拼的。这个错位是本课所有复杂度的来源，也是那 727 行存在的理由。

### 二、位置决定成本，而越靠前的东西越像「配置」

wire 顺序固定：`system → tools → messages`。前缀从第一个字节比，所以：

| 改动位置 | 命中 | 多花 |
|---|---|---|
| 系统提示词（最前） | 0 | +¥0.0122 |
| 第一个工具描述 | 704 | +¥0.0115 |
| 最后一个工具描述 | 832 | +¥0.0114 |
| 同一句话插在历史中段 | 6,720 | +¥0.0056 |
| **同一句话加在历史末尾** | 12,416 | **+¥0.0000** |

最后两行是同一个操作，只有位置不同，差近二十倍，而这才 12K token 的历史。

**危险在于：越靠前的东西越像配置，改起来心理负担最轻。**系统提示词加时间戳、工具列表按 `Object.keys()` 拼、根据分支名改一句提示，全都落在最前面。真实源码里 `AgentTool`/`SkillTool` 的 description 嵌着动态清单，就是这个坑。

### 三、两阶段侦探：先看结果，再找原因

`promptCacheBreakDetection.ts` 的顺序不能反：

- Phase 1（请求前）：给所有「本来不该变」的东西记 hash
- Phase 2（响应后）：**先看命中掉没掉**，掉了才回头翻指纹

不能一发现 system 变了就报警，因为变了不等于打穿（可能变在最后、可能这次本来就是首次调用）。**指纹是用来解释事实的，不是用来预测的。**

判据是两个条件同时成立（`:484`）：掉幅 >5% **且** 绝对量 > `MIN_CACHE_MISS_TOKENS`（2000）。只看比例小会话天天误报，只看绝对量大会话天天误报，两个条件在滤两种不同的噪音。

### 四、`PreviousState` 的 20 个字段是一份事故清单

值得单独记的几个：

- `perToolHashes` —— 工具没增没减但描述变了，占工具类打穿的 **77%**（注释里 `BQ 2026-03-22` 的数据）
- `cacheControlHash` —— 专抓 scope/TTL 翻转，这类变化被普通 systemHash 抹掉
- `autoModeActive` / `isUsingOverage` / `cachedMCEnabled` —— 注释都写着 *should NOT break cache anymore*，**是已修复 bug 的回归哨兵**
- `cacheDeletionsPending` —— 压缩主动删缓存时命中下降是预期的，用它让侦测器闭嘴

**每个字段背后都是一次真的打穿过缓存的改动。**读这个类型比读任何原则都有用。

### 五、稳定 > 正确（TTL latch）

1h TTL 的资格取决于订阅和额度，而额度状态**会在会话中途翻转**。翻转 → TTL 变 → `cache_control` 内容变 → 打穿，注释说约 2 万 token 一次。

源码的做法是把资格**锁进进程状态，整个会话只算一次**（`claude.ts:404`）。

> Latch eligibility in bootstrap state for session stability — prevents mid-session overage flips from changing the cache_control TTL

**一个本来正确的动态值，因为会变，所以被故意冻住了。** 这和第 0005 课的 `seenIds` 是同一个手法。提炼成一句：**凡是进入请求前缀的东西，稳定比正确重要。**

### 六、手动断点买到的是「下判断的资格」

| | DeepSeek 自动 | Claude 手动 |
|---|---|---|
| 要写的代码 | 零 | getCacheControl + splitSysPromptPrefix + 标记落位 + 727 行归因 |
| 能控制 | 只能控制前缀写得稳不稳 | 缓存哪几段、给谁复用、存多久 |
| 代价 | 范围和时长说了不算 | 十几种打穿方式，都不报错只涨账单 |

硬约束：`cache_control` 块最多 4 个，源码注释是 *IMPORTANT: Do not add any more blocks for caching or you will get a 400*（`claude.ts:3222`），已经用满。

`scope: 'global'` 让系统提示词静态部分**跨用户复用**，切分靠一个哨兵字符串 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`。它是数组里的普通字符串，插错位置静态区就混进动态内容，缓存范围默默缩水，**没有任何报错**。又一次「位置即语义」。

消息级只打一个标记，注释引用了推理服务端的 Rust 文件路径（`page_manager/index.rs: Index::insert`）。**一个 TypeScript CLI 的注释在引用服务端内存回收逻辑**，说明这不是从 API 文档推出来的，是有人真去读了服务端代码。

**值不值取决于规模。**Claude Code 系统提示词上万 token + 海量用户，`global` 省的是全球所有人的首次调用，727 行很便宜。自己的小 agent 多半不值，而「把前缀写稳」两种 provider 下都成立且免费。

### 七、侦测器的盲区

`--break` 第 4 行：把工具描述改回原样，命中仍是 832（没恢复），而侦测器**不报警**。

因为它盯的是「比上次掉了」，第 4 次没再往下掉。**这类侦测抓得住变坏的那一刻，抓不住一直很坏。**要发现后者得看命中率绝对水平，是另一套指标。

这条对做监控有普适价值：**差分告警和水位告警是两件事，只做前者会漏掉稳态劣化。**

## 已实测验证的事实

- `--cache`：6 轮 mock 会话，第 1 轮命中 0%，之后 82%~94%，合计 ¥0.0016 vs 不缓存 ¥0.0067，省 76%
- `--break`：六种改动的命中/花费如上表，最后两行同操作差近 20 倍
- 侦测器正确报出「工具描述变了：run_tests」，掉 11,584 token
- 第 4 次（改回去）命中不恢复且侦测器不报警，盲区复现成功
- DeepSeek 文档与价格已核对（命中 ¥0.02/M、未命中 ¥1/M、输出 ¥2/M，V4-Flash；2026-08-17 起改分时定价，倍数降到约 30）

## 引申

- 第 0005 课的「量出来」手法继续奏效：这次量的是钱。**把抽象约束换算成一列人民币，比讲十遍「前缀不能变」都管用。**
- 第 0007 课（三级压缩）的接口已铺好：压缩会**主动改写历史**，也就是主动打穿缓存，所以它必须挑时机。这一课的表正好是压缩要付的代价表。
- 第 0009 课（fork）会用到这一课埋的一个点：fork 子 agent 时把消息级标记挪到倒数第二条，缓存写入变成 no-op。
- `mini-cc` 的 token 估算是「字符数 ÷ 4」，对中文低估约 4 倍。课程里已注明只求量级。真要准就得引 tokenizer，不值得。

## 相关

- [第 0006 课：Prompt Caching](../lessons/0006-prompt-caching.html)
- [第 0005 课：结果预算](../lessons/0005-result-budget.html)
- [速查：架构术语表](../reference/glossary.html)
- 代码：`mini-cc/src/v5/`（`cache.ts` 为新增）
