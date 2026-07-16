// 第 0003 课：运行多 Agent 系统

import "dotenv/config"; // 若要把 ScriptedModel 换成 DeepSeekModel，需要它加载 .env
import { makeWorker } from "./worker.ts";
import { KeywordRouter } from "./router.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ScriptedModel } from "./types.ts";

async function main() {
  // 三个专精 Worker：各自独立的 system prompt 和上下文
  const weatherWorker = makeWorker({
    name: "weather",
    description: "回答天气相关问题",
    systemPrompt: "你是天气助手，只回答天气问题。",
    model: new ScriptedModel("北京今天晴，25°C，湿度 45%。"),
  });

  const mathWorker = makeWorker({
    name: "math",
    description: "做数学计算",
    systemPrompt: "你是计算助手，只做数学计算。",
    model: new ScriptedModel("2 + 3 × 4 = 14。"),
  });

  const writerWorker = makeWorker({
    name: "writer",
    description: "润色和总结文字",
    systemPrompt: "你是文字编辑，负责润色。",
    model: new ScriptedModel("（已润色）这是一段更通顺的文字。"),
  });

  // 关键词路由规则
  const router = new KeywordRouter([
    { keywords: ["天气", "气温", "下雨"], worker: "weather" },
    { keywords: ["算", "计算", "等于"], worker: "math" },
    { keywords: ["润色", "总结", "改写"], worker: "writer" },
  ]);

  const orchestrator = new Orchestrator(
    [weatherWorker, mathWorker, writerWorker],
    router,
  );

  const task = "北京今天天气怎么样？顺便算一下 2 + 3 × 4";
  console.log("用户任务：", task, "\n");

  const { answer, log } = await orchestrator.run(task);

  console.log("=== 消息流（Message Passing）===");
  for (const m of log) {
    console.log(`${m.from} → ${m.to}：${m.content}`);
  }

  console.log("\n=== 最终答案 ===");
  console.log(answer);
}

main().catch((err) => {
  console.error("运行失败：", err);
  process.exit(1);
});
