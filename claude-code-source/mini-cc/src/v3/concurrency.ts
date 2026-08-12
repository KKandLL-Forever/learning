/**
 * mini-cc v2 —— 带上限的并发生成器合流
 *
 * 对照真实源码：src/utils/generators.ts:32 `all()`
 *
 * 这个函数解决的问题：有 N 个异步生成器（每个是一次工具调用，
 * 持续往外吐进度事件），要同时跑，但同时在跑的不能超过 cap 个，
 * 而且谁先吐出事件就先交付谁。
 *
 * 为什么不能用 Promise.all：
 *   Promise.all 等的是【最终结果】，中途的进度事件全丢了。
 *   工具执行要往终端实时推进度，所以必须逐个事件地合流。
 *   Promise.all 也没有并发上限，100 个工具会一起冲出去。
 */

/** 一次 next() 的结果，连同它来自哪个生成器、以及这次等待用的 promise。 */
type Queued<A> = {
  done: boolean | undefined
  // 生成器结束时 next() 给的是 void，所以这里必须容纳 void
  value: A | void
  generator: AsyncGenerator<A, void>
  promise: Promise<Queued<A>>
}

export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Number.POSITIVE_INFINITY,
): AsyncGenerator<A, void> {
  // 向某个生成器要下一个值。注意 promise 把自己也放进了结果里，
  // 这样下面 race 出来之后能精确地从 Set 里删掉这一个（而不是重新找）。
  const next = (generator: AsyncGenerator<A, void>): Promise<Queued<A>> => {
    const promise: Promise<Queued<A>> = generator
      .next()
      .then(({ done, value }) => ({ done, value, generator, promise }))
    return promise
  }

  const waiting = [...generators]
  const inflight = new Set<Promise<Queued<A>>>()

  // 先启动一批，填满到上限为止。
  while (inflight.size < concurrencyCap && waiting.length > 0) {
    inflight.add(next(waiting.shift()!))
  }

  while (inflight.size > 0) {
    // race 拿到「最先有动静的那一个」。这是滑动窗口的关键：
    // 不等所有人，谁先出结果就先处理谁，然后立刻补位。
    const { done, value, generator, promise } = await Promise.race(inflight)
    inflight.delete(promise)

    if (!done) {
      // 这个生成器还没完，继续向它要下一个，窗口占用数不变。
      inflight.add(next(generator))
      if (value !== undefined) {
        yield value as Awaited<A>
      }
    } else if (waiting.length > 0) {
      // 这个生成器跑完了，腾出一个名额，从队列里拉一个新的进来。
      inflight.add(next(waiting.shift()!))
    }
  }
}
