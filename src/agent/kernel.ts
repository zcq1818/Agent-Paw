/**
 * Paw Agent Kernel
 * 核心 AI 对话引擎 — 流式输出 + 工具调用
 */

// ============ 配置 ============

export interface AgentConfig {
  provider: "openai" | "deepseek" | "anthropic" | "openrouter";
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

export function loadConfig(): AgentConfig {
  try {
    const saved = localStorage.getItem("paw_config");
    if (saved) return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
  } catch {}
  return DEFAULT_CONFIG;
}

export function saveConfig(config: Partial<AgentConfig>) {
  const current = loadConfig();
  localStorage.setItem("paw_config", JSON.stringify({ ...current, ...config }));
}

// ============ 系统提示词 ============

const SYSTEM_PROMPT = `你是一只住在用户桌面的皮卡丘宠物助手，名叫"皮卡"。

性格特点：
- 活泼可爱，喜欢用"皮卡~"、"皮卡皮卡~"作为语气词
- 聪明能干，能帮用户解决各种问题
- 偶尔卖萌，但做事认真靠谱
- 回复简洁有力，不要过度卖萌影响效率

能力：
- 回答问题、写代码、分析文件
- 网页搜索、天气查询
- 提醒和待办管理
- 播放音乐/视频推荐

当用户让你执行工具时，直接去做。完成后再用皮卡丘的语气回复结果。
回复使用 Markdown 格式。`;

// ============ 工具定义 ============

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

const tools: Tool[] = [
  {
    name: "web_search",
    description: "搜索网页获取信息",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = args.query as string;
      // 使用 DuckDuckGo HTML 版搜索
      try {
        const resp = await fetch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          { headers: { "User-Agent": "Paw/1.0" } }
        );
        const html = await resp.text();
        // 简单提取结果
        const results: string[] = [];
        const matches = html.matchAll(
          /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gs
        );
        for (const m of matches) {
          const text = m[1].replace(/<[^>]+>/g, "").trim();
          if (text) results.push(text);
          if (results.length >= 5) break;
        }
        return results.length
          ? `搜索结果:\n${results.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
          : "没有找到相关结果";
      } catch (e) {
        return `搜索失败: ${e}`;
      }
    },
  },
  {
    name: "get_weather",
    description: "查询指定城市的天气",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名" },
      },
      required: ["city"],
    },
    execute: async (args) => {
      const city = args.city as string;
      try {
        const resp = await fetch(
          `https://wttr.in/${encodeURIComponent(city)}?format=%C+%t+%h+%w&lang=zh`
        );
        const text = await resp.text();
        return `${city}天气: ${text}`;
      } catch {
        return "天气查询失败，请稍后再试";
      }
    },
  },
  {
    name: "get_time",
    description: "获取当前日期和时间",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const now = new Date();
      return `当前时间: ${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;
    },
  },
  {
    name: "calculate",
    description: "数学计算",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "数学表达式" },
      },
      required: ["expression"],
    },
    execute: async (args) => {
      try {
        // 安全的数学计算
        const expr = (args.expression as string).replace(/[^0-9+\-*/().%\s]/g, "");
        const result = Function(`"use strict"; return (${expr})`)();
        return `计算结果: ${expr} = ${result}`;
      } catch {
        return "计算表达式有误，请检查";
      }
    },
  },
];

export function getTools(): Tool[] {
  return tools;
}

// ============ 流式对话 ============

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  userMessage: string;
}

export async function streamChat(
  request: ChatRequest,
  onChunk: (text: string) => void
): Promise<string> {
  const config = loadConfig();

  if (!config.apiKey) {
    throw new Error("请先在设置中配置 API Key");
  }

  // 构建消息
  const apiMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  // 工具定义（OpenAI 格式）
  const toolDefs = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const url = `${config.baseUrl}/chat/completions`;

  let fullText = "";
  let maxRounds = 3; // 最多 3 轮工具调用

  let currentMessages = [...apiMessages];

  while (maxRounds > 0) {
    maxRounds--;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: currentMessages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`API 错误 (${resp.status}): ${errBody.slice(0, 200)}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("无法读取响应流");

    const decoder = new TextDecoder();
    let buffer = "";
    let roundText = "";
    const toolCalls: Array<{
      id: string;
      name: string;
      arguments: string;
    }> = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") break;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // 文本内容
          if (delta.content) {
            roundText += delta.content;
            onChunk(delta.content);
          }

          // 工具调用
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || "", name: "", arguments: "" };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) {
                toolCalls[idx].arguments += tc.function.arguments;
              }
            }
          }
        } catch {}
      }
    }

    fullText += roundText;

    // 如果没有工具调用，结束
    if (toolCalls.length === 0) break;

    // 执行工具调用
    currentMessages.push({
      role: "assistant",
      content: roundText || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    } as never);

    for (const tc of toolCalls) {
      const tool = tools.find((t) => t.name === tc.name);
      if (!tool) continue;

      onChunk(`\n🔧 ${tc.name}...\n`);

      try {
        const args = JSON.parse(tc.arguments);
        const result = await tool.execute(args);
        onChunk(`✅ ${result}\n`);

        currentMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        } as never);
      } catch (e) {
        const err = `工具执行失败: ${e}`;
        onChunk(`❌ ${err}\n`);
        currentMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: err,
        } as never);
      }
    }
  }

  return fullText;
}
