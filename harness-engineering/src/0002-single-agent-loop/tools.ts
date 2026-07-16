// 第 0002 课：工具注册与工具函数

import { Tool, ToolDefinition } from "./types.ts";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`未找到工具：${name}`);
    }

    try {
      const result = await tool.execute(input);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `工具执行失败：${message}`;
    }
  }
}

// 一个示例工具：查询天气
export const getWeatherTool: Tool = {
  definition: {
    name: "get_weather",
    description: "获取指定城市的当前天气",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称，例如 北京、上海" },
      },
      required: ["city"],
    },
  },
  execute: ({ city }) => {
    if (!city || typeof city !== "string") {
      throw new Error("必须提供城市名称");
    }
    return `${city}当前天气：晴天，25°C，湿度 45%`;
  },
};

// 另一个示例工具：计算
export const calcTool: Tool = {
  definition: {
    name: "calc",
    description: "计算数学表达式，例如 2 + 2 * 3",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "要计算的数学表达式" },
      },
      required: ["expression"],
    },
  },
  execute: ({ expression }) => {
    if (!expression || typeof expression !== "string") {
      throw new Error("必须提供表达式");
    }
    // 简单示例：实际项目中请用安全的表达式求值器
    try {
      const result = Function(`"use strict"; return (${expression})`)();
      return String(result);
    } catch {
      throw new Error("表达式格式错误");
    }
  },
};

export const getTime: Tool = {
  definition: {
    name: "get_time",
    description: "获取当前时间",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "时间格式，例如 2023-01-01 12:00:00" }
      },
      required: ['time']
    },
  },
  execute: ({ time }) => {
    if (!time || typeof time !== "string") {
      throw new Error("必须提供时间");
    }
    return `当前时间是：${time}`;
  }
}