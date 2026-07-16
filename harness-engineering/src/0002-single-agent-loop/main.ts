// 第 0002 课：运行单 Agent 循环

import "dotenv/config"; // 必须最先执行：把 .env 里的变量加载进 process.env
import { Agent } from "./agent.ts";
import { MockModel,DeepSeekModel } from "./model.ts";
import { ToolRegistry, calcTool, getWeatherTool,getTime } from "./tools.ts";

async function main() {
  const tools = new ToolRegistry()
    .register(getWeatherTool)
    .register(calcTool)
    .register(getTime);

   const agent = new Agent(
    {
      model: new MockModel(),
      systemPrompt: "你是一个 helpful 助手。请用中文回答。",
      maxTurns: 5,
    },
    tools,
  );
     const agentDeepSeek = new Agent(
    {
      model: new DeepSeekModel(process.env.DEEPSEEK_API_KEY ?? ""),
      systemPrompt: "你是一个 helpful 助手。请用中文回答。",
      maxTurns: 5,
    },
    tools,
  );

  const userInput = "北京今天天气怎么样？";
  console.log("用户：", userInput);
  console.log("助手：");

  const generator = agent.run(userInput);
  const generatorDeepSeek = agentDeepSeek.run(userInput);

  for await (const chunk of generator) {
    if (chunk.type === "text") {
      process.stdout.write(chunk.text ?? "");
    }
    if (chunk.type === "tool_use") {
      console.log(`\n[调用工具] ${chunk.toolUse?.name}(${JSON.stringify(chunk.toolUse?.input)})`);
    }
    if (chunk.type === "done" && chunk.result) {
      console.log("\n\n--- 最终结果 ---");
      console.log(chunk.result.response);
      console.log(`\n总轮数：${chunk.result.turns}`);
    }
  }
  for await (const chunk of generatorDeepSeek) {
    if (chunk.type === "text") {
      process.stdout.write(chunk.text ?? "");
    }
    if (chunk.type === "tool_use") {
      console.log(`\n[调用工具] ${chunk.toolUse?.name}(${JSON.stringify(chunk.toolUse?.input)})`);
    }
    if (chunk.type === "done" && chunk.result) {
      console.log("\n\n--- 最终结果 ---");
      console.log(chunk.result.response);
      console.log(`\n总轮数：${chunk.result.turns}`);
         }
  }
}

main().catch((err) => {
  console.error("运行失败：", err);
  process.exit(1);
});
