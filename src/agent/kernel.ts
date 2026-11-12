import { buildContext } from "./context";
import { memoryStore } from "./memory";
import { getAllTools, todoStore, calendarStore } from "./tools";
import { getMultimodalTools } from "./multimodal";
import { personalityStore } from "./personality";
import { securityManager } from "./security";
import { getSkillsContext } from "./customSkills";
import type { ToolEvent } from "./toolEvents";
import { BROWSER_USER_AGENT, fetchExternal } from "./http";
import { getActiveBot, useBotStore, type BotModelOverride } from "../store/bots";

export type ProviderId = "agnes" | "openai" | "deepseek" | "openrouter" | "custom" | string;

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
  stream: boolean;
  enableTools: boolean;
  temperature: number;
  maxTokens: number;
  apiKeyPlaceholder?: string;
  notes?: string;
}

export interface AgentConfig {
  provider: ProviderId;
  providerLabel?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  stream?: boolean;
  enableTools?: boolean;
  temperature?: number;
  maxTokens?: number;
  embeddingModel?: string;
  extraHeaders?: string;
  extraBody?: string;
  enableMemory?: boolean;
  enablePersonality?: boolean;
  enableSecurity?: boolean;
  enableMultimodal?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "agnes",
    label: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    model: "agnes-2.0-flash",
    stream: false,
    enableTools: true,
    temperature: 0.7,
    maxTokens: 4096,
    apiKeyPlaceholder: "Agnes API Key",
    notes: "OpenAI Chat Completions compatible. Defaults to non-streaming because the official Agnes example returns normal JSON.",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    stream: true,
    enableTools: true,
    temperature: 0.7,
    maxTokens: 4096,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    stream: true,
    enableTools: true,
    temperature: 0.7,
    maxTokens: 4096,
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-20241022",
    stream: false,
    enableTools: false,
    temperature: 0.7,
    maxTokens: 4096,
    apiKeyPlaceholder: "Anthropic API Key",
    notes: "Uses the Anthropic Messages API (/v1/messages), not OpenAI Chat Completions.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    stream: true,
    enableTools: true,
    temperature: 0.7,
    maxTokens: 4096,
  },
  {
    id: "custom",
    label: "Custom OpenAI Compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    stream: false,
    enableTools: false,
    temperature: 0.7,
    maxTokens: 4096,
    notes: "Use this for Ollama, vLLM, LM Studio, gateway services, or any OpenAI-compatible endpoint.",
  },
];

const DEFAULT_CONFIG: AgentConfig = {
  provider: "agnes",
  providerLabel: "Agnes AI",
  apiKey: "",
  baseUrl: "https://apihub.agnes-ai.com/v1",
  model: "agnes-2.0-flash",
  stream: false,
  enableTools: true,
  temperature: 0.7,
  maxTokens: 4096,
  embeddingModel: "text-embedding-3-small",
  extraHeaders: "",
  extraBody: "",
  enableMemory: true,
  enablePersonality: true,
  enableSecurity: true,
  enableMultimodal: true,
};

export function getProviderPreset(provider: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS.find((item) => item.id === provider) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function normalizeConfig(config: Partial<AgentConfig>): AgentConfig {
  const provider = config.provider || DEFAULT_CONFIG.provider;
  const preset = getProviderPreset(provider);
  return {
    ...DEFAULT_CONFIG,
    ...preset,
    ...config,
    provider,
    providerLabel: config.providerLabel || preset.label,
    baseUrl: normalizeBaseUrl(config.baseUrl || preset.baseUrl),
    model: config.model || preset.model,
    stream: config.stream ?? preset.stream,
    enableTools: config.enableTools ?? preset.enableTools,
    temperature: Number(config.temperature ?? preset.temperature),
    maxTokens: Number(config.maxTokens ?? preset.maxTokens),
  };
}

/** 全局配置：不含任何 Bot 覆盖，供设置页保存时使用。 */
function loadGlobalConfig(): AgentConfig {
  try {
    const saved = localStorage.getItem("paw_config");
    if (saved) return normalizeConfig(JSON.parse(saved));
  } catch {}
  return normalizeConfig(DEFAULT_CONFIG);
}

/** 取指定 Bot 的生效配置：全局配置 + 该 Bot 的模型覆盖。Rooms 按 Bot 分别调用时使用。 */
export function configForBot(bot?: { modelOverride?: BotModelOverride }): AgentConfig {
  const patch: Partial<AgentConfig> = {};
  const override = bot?.modelOverride;
  if (override) {
    if (override.provider) patch.provider = override.provider;
    if (override.model) patch.model = override.model;
    if (override.baseUrl) patch.baseUrl = override.baseUrl;
    if (override.apiKey) patch.apiKey = override.apiKey;
  }
  return normalizeConfig({ ...loadGlobalConfig(), ...patch });
}

/** 生效配置 = 全局配置 + 当前 Bot 的模型覆盖。 */
export function loadConfig(): AgentConfig {
  return configForBot(getActiveBot(useBotStore.getState()));
}

export function saveConfig(config: Partial<AgentConfig>) {
  // 刻意不用 loadConfig()，否则会把当前 Bot 的覆盖写进全局配置。
  const current = loadGlobalConfig();
  localStorage.setItem("paw_config", JSON.stringify(normalizeConfig({ ...current, ...config })));
}

export function buildChatCompletionsUrl(config: Pick<AgentConfig, "baseUrl">): string {
  return `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
}

export function parseConfigJson(input?: string): Record<string, unknown> {
  if (!input?.trim()) return {};
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("额外配置必须是 JSON 对象，例如 {\"top_p\":0.9}");
  }
  return parsed as Record<string, unknown>;
}

export function buildRequestHeaders(config: AgentConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  Object.assign(headers, parseConfigJson(config.extraHeaders) as Record<string, string>);
  return headers;
}

/** Anthropic 用的是 Messages API，与 OpenAI Chat Completions 不兼容。 */
export function isAnthropicProvider(config: Pick<AgentConfig, "provider" | "baseUrl">): boolean {
  return config.provider === "anthropic" || /api\.anthropic\.com/i.test(config.baseUrl || "");
}

export function buildAnthropicRequest(config: AgentConfig, system: string, prompt: string) {
  return {
    url: `${normalizeBaseUrl(config.baseUrl)}/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      temperature: config.temperature ?? 0.7,
      system,
      messages: [{ role: "user", content: prompt }],
    },
  };
}

export function getEmbeddingModel(config = loadConfig()): string {
  return config.embeddingModel || "text-embedding-3-small";
}

export async function testConnection(configOverride?: Partial<AgentConfig>): Promise<string> {
  const config = normalizeConfig({ ...loadConfig(), ...configOverride });
  if (!config.apiKey) throw new Error("请先填写 API Key");

  const resp = await fetch(buildChatCompletionsUrl(config), {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify({
      ...parseConfigJson(config.extraBody),
      model: config.model,
      messages: [
        { role: "system", content: "You are a connection test endpoint." },
        { role: "user", content: "Reply with OK." },
      ],
      temperature: 0,
      max_tokens: 8,
    }),
  });

  if (!resp.ok) {
    const errorBody = await resp.text();
    throw new Error(`连接失败 (${resp.status}): ${errorBody.slice(0, 220)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "OK";
}

function buildSystemPrompt(): string {
  const config = loadConfig();
  let prompt = `你是一只住在用户桌面上的皮卡丘宠物助手，名字叫“皮卡丘”。

性格特点：
- 活泼、温暖、可靠，偶尔用“皮卡~”做轻微语气词。
- 回答简洁有用，不要过度卖萌影响效率。
- 用户要求你使用工具时，直接执行；完成后用自然语言说明结果。

核心能力：
1. 回答问题、写代码、分析内容。
2. 网页搜索、天气查询、时间和计算。
3. 待办事项、日程、快捷命令、剪贴板、系统信息。
4. 在启用时支持语音、图片分析和屏幕捕获。

回复使用 Markdown 格式。

Agent 行为准则：
- 你是一个常驻桌面宠物 Agent，不只是聊天机器人。能用工具完成的事情，优先调用工具并给出结果。
- 像 OpenClaw 一样，把能力拆成可审计 Skill、工具、记忆三层：重复任务沉淀为 Skill，长期偏好沉淀为记忆。
- 当用户说“以后都这样”“记住”“下次自动”时，主动保存为本地记忆。
- 当发现用户反复提出同一类任务时，可以建议或创建一个自定义 Skill。
- 新闻、提醒、简报可以用宠物气泡短句播报，但详细内容放在聊天窗口。
- 打开应用、系统动作、网页跳转等外部动作执行前必须确认。`;

  if (config.enablePersonality !== false) {
    prompt += personalityStore.getPersonalizedContext();
  }

  const activeBot = getActiveBot(useBotStore.getState());
  if (activeBot) {
    prompt += `\n\n## 当前 Bot 身份\n你现在的身份是「${activeBot.name}」${activeBot.tagline ? `（${activeBot.tagline}）` : ""}。\n${activeBot.instructions || "沿用上方默认人设与行为准则。"}\n权限级别：${activeBot.approvalLevel}。当 Bot 指令与上方默认人设冲突时，以本节 Bot 指令为准。`;
  }

  prompt += `

## 记忆使用指南
- 对用户明确表达的重要信息，可以使用 add_memory 工具保存。
- 用户询问此前聊过的话题时，可以搜索相关记忆。
- 只保存长期有帮助的信息，不保存无意义闲聊。`;

  return prompt;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

type SearchItem = { title: string; link?: string; snippet?: string };

function htmlToText(input: string): string {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

/** 先用 Bing 的 RSS 搜索（结构化、稳定），失败再退回 DuckDuckGo HTML 版。 */
async function searchWeb(query: string): Promise<{ items: SearchItem[]; error?: string }> {
  const headers = { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" };
  let lastError = "";

  try {
    const resp = await fetchExternal(`https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const doc = new DOMParser().parseFromString(await resp.text(), "text/xml");
    const items = Array.from(doc.querySelectorAll("item"))
      .slice(0, 5)
      .map((item) => ({
        title: htmlToText(item.querySelector("title")?.textContent || ""),
        link: item.querySelector("link")?.textContent?.trim() || undefined,
        snippet: htmlToText(item.querySelector("description")?.textContent || "").slice(0, 160) || undefined,
      }))
      .filter((item) => item.title);
    if (items.length) return { items };
  } catch (error) {
    lastError = String(error);
  }

  try {
    const resp = await fetchExternal(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const doc = new DOMParser().parseFromString(await resp.text(), "text/html");
    const items = Array.from(doc.querySelectorAll("a.result__a"))
      .slice(0, 5)
      .map((node) => ({ title: (node.textContent || "").trim(), link: node.getAttribute("href") || undefined }))
      .filter((item) => item.title);
    return { items };
  } catch (error) {
    return { items: [], error: lastError || String(error) };
  }
}

const baseTools: Tool[] = [
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
      const query = String(args.query || "").trim();
      if (!query) return "请提供搜索关键词";
      const results = await searchWeb(query);
      if (results.error) return `搜索失败: ${results.error}`;
      return results.items.length
        ? `搜索结果:\n${results.items
            .map((item, index) => `${index + 1}. ${item.title}${item.link ? ` (${item.link})` : ""}${item.snippet ? `\n   ${item.snippet}` : ""}`)
            .join("\n")}`
        : "没有找到相关结果";
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
        const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=%C+%t+%h+%w&lang=zh`);
        return `${city} 天气: ${await resp.text()}`;
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
        const expr = (args.expression as string).replace(/[^0-9+\-*/().%\s]/g, "");
        const result = Function(`"use strict"; return (${expr})`)();
        return `计算结果: ${expr} = ${result}`;
      } catch {
        return "计算表达式有误，请检查后重试";
      }
    },
  },
  {
    name: "add_memory",
    description: "保存重要信息到记忆库",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的内容" },
        type: { type: "string", enum: ["preference", "fact", "habit", "important", "task"], description: "记忆类型" },
        importance: { type: "number", description: "重要性 0-10" },
      },
      required: ["content"],
    },
    execute: async (args) => {
      const importance = (args.importance as number) || 5;
      await memoryStore.add({
        type: (args.type as any) || "fact",
        content: args.content as string,
        tags: [],
        priority: importance >= 8 ? "high" : importance >= 5 ? "medium" : "low",
        importance,
      });
      return `已记住：${args.content}`;
    },
  },
  {
    name: "search_memory",
    description: "搜索记忆库中的相关信息",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const memories = await memoryStore.search(args.query as string, 5);
      if (memories.length === 0) return "没有找到相关记忆";
      return `相关记忆:\n${memories.map((mem) => `- [${mem.type}] ${mem.content}`).join("\n")}`;
    },
  },
  {
    name: "get_todo_stats",
    description: "获取待办事项统计",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const stats = todoStore.getStats();
      return [
        "待办统计:",
        `- 总计: ${stats.total} 项`,
        `- 已完成: ${stats.completed} 项`,
        `- 待完成: ${stats.total - stats.completed} 项`,
        `- 已过期: ${stats.overdue} 项`,
        `- 高优先级: ${stats.byPriority.high} 项`,
      ].join("\n");
    },
  },
  {
    name: "get_upcoming_schedule",
    description: "获取即将到来的日程",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "天数，默认 7 天" },
      },
    },
    execute: async (args) => {
      // days 是时间范围而不是条数；之前直接当 limit 传，导致“未来 7 天”只返回 7 条。
      const days = Math.max(1, Number(args.days) || 7);
      const horizon = Date.now() + days * 24 * 60 * 60 * 1000;
      const events = calendarStore.getUpcoming(200).filter((event) => new Date(event.startTime).getTime() <= horizon);
      if (events.length === 0) return `接下来 ${days} 天暂无日程`;
      return `即将到来的日程:\n${events
        .map((event) => {
          const start = new Date(event.startTime);
          return `- ${start.toLocaleString("zh-CN")} - ${event.title}`;
        })
        .join("\n")}`;
    },
  },
];

export function getTools(): Tool[] {
  const config = loadConfig();
  const tools: Tool[] = [...baseTools, ...getAllTools()];
  if (config.enableMultimodal !== false) {
    tools.push(...getMultimodalTools());
  }
  return tools;
}

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  userMessage: string;
}

type RuntimeToolCall = { id: string; name: string; arguments: string };

async function executeRuntimeToolCalls(
  toolCalls: RuntimeToolCall[],
  tools: Tool[],
  currentMessages: any[],
  onToolEvent?: (event: ToolEvent) => void
) {
  for (const [index, tc] of toolCalls.entries()) {
    const tool = tools.find((item) => item.name === tc.name);
    const runId = tc.id || `${tc.name}-${index}-${Date.now()}`;
    const startedAt = Date.now();
    onToolEvent?.({
      type: "start",
      id: runId,
      name: tc.name,
      args: tc.arguments || "{}",
      at: startedAt,
    });
    securityManager.log("info", "tool", `Executing tool: ${tc.name}`);

    let result = "";
    let status: "done" | "error" = "done";
    try {
      const args = JSON.parse(tc.arguments || "{}");
      const executed = await securityManager.safeExecuteTool(tc.name, async () => {
        if (!tool) throw new Error(`未找到工具 ${tc.name}`);
        return await tool.execute(args);
      });
      result = executed.result;
      status = executed.success ? "done" : "error";
    } catch (e) {
      result = `工具执行失败: ${e}`;
      status = "error";
      securityManager.log("error", "tool", `Tool execution failed: ${tc.name}`, { error: String(e) });
    }

    onToolEvent?.({
      type: "finish",
      id: runId,
      name: tc.name,
      status,
      result,
      at: Date.now(),
    });
    currentMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
  }
}

export async function streamChat(
  request: ChatRequest,
  onChunk: (text: string) => void,
  options: { signal?: AbortSignal; onToolEvent?: (event: ToolEvent) => void } = {}
): Promise<string> {
  const config = loadConfig();
  if (!config.apiKey) throw new Error("请先在设置中配置 API Key");

  const userText = request.userMessage;
  if (config.enableSecurity !== false) {
    const validation = securityManager.validateInput(userText);
    if (!validation.valid) throw new Error(validation.error);

    if (!securityManager.checkRateLimit()) {
      const status = securityManager.getRateLimitStatus();
      throw new Error(`操作过于频繁，请在 ${Math.ceil(status.resetIn / 1000)} 秒后重试`);
    }
  }

  let systemPrompt = buildSystemPrompt();
  if (config.enableMemory !== false) {
    const memoryContext = await buildContext({ userText, history: request.messages });
    systemPrompt += "\n\n" + memoryContext;
  }

  const skillsContext = getSkillsContext();
  if (skillsContext) systemPrompt += "\n\n" + skillsContext;

  if (config.enablePersonality !== false) {
    personalityStore.learnFromConversation(userText, true);
    personalityStore.trackEvent("message", "user_sent");
  }

  const currentMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...request.messages.map((message) => ({
      role: message.role as "user" | "assistant" | "system",
      content: message.content,
    })),
  ];

  const tools = getTools();
  const toolDefs = tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  const url = buildChatCompletionsUrl(config);
  const shouldStream = config.stream !== false;
  // 接口拒绝 tools 字段后置为 false，后续轮次不再重复“带 tools 失败 → 重试”。
  let shouldSendTools = config.enableTools !== false;
  let fullText = "";
  let maxRounds = 5;
  let ranOutOfRounds = true;

  while (maxRounds > 0) {
    maxRounds -= 1;
    securityManager.log("debug", "api", "Sending request to API", {
      provider: config.provider,
      model: config.model,
      stream: shouldStream,
      toolCount: shouldSendTools ? toolDefs.length : 0,
      messageCount: currentMessages.length,
    });

    const requestBody: Record<string, unknown> = {
      ...parseConfigJson(config.extraBody),
      model: config.model,
      messages: currentMessages,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
    };

    if (shouldSendTools && toolDefs.length > 0) requestBody.tools = toolDefs;
    if (shouldStream) requestBody.stream = true;

    if (options.signal?.aborted) throw new DOMException("生成已停止", "AbortError");

    let resp = await fetch(url, {
      method: "POST",
      headers: buildRequestHeaders(config),
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    if (!resp.ok && shouldSendTools && requestBody.tools) {
      const errBody = await resp.text();
      if (/tool|tools|function|unsupported|unknown|invalid/i.test(errBody)) {
        securityManager.log("warn", "api", "API rejected tools, retrying without tools", {
          status: resp.status,
          error: errBody.slice(0, 220),
        });
        delete requestBody.tools;
        shouldSendTools = false;
        resp = await fetch(url, {
          method: "POST",
          headers: buildRequestHeaders(config),
          body: JSON.stringify(requestBody),
          signal: options.signal,
        });
      } else {
        throw new Error(`API 错误 (${resp.status}): ${errBody.slice(0, 220)}`);
      }
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      securityManager.log("error", "api", "API request failed", {
        status: resp.status,
        error: errBody.slice(0, 220),
      });
      throw new Error(`API 错误 (${resp.status}): ${errBody.slice(0, 220)}`);
    }

    if (!shouldStream) {
      const data = await resp.json();
      const message = data.choices?.[0]?.message;
      const content = message?.content || "";
      const nonStreamToolCalls: RuntimeToolCall[] = (message?.tool_calls || [])
        .map((tc: any) => ({
          id: tc.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        }))
        .filter((tc: RuntimeToolCall) => tc.name);

      if (!content && nonStreamToolCalls.length === 0) throw new Error("API 返回为空，请检查模型名称、Base URL 或接口格式");
      fullText += content;
      if (content) onChunk(content);

      if (!shouldSendTools || nonStreamToolCalls.length === 0) {
        ranOutOfRounds = false;
        break;
      }

      currentMessages.push({
        role: "assistant",
        content: content || null,
        tool_calls: nonStreamToolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      await executeRuntimeToolCalls(nonStreamToolCalls, tools, currentMessages, options.onToolEvent);
      continue;
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("无法读取响应流");

    const decoder = new TextDecoder();
    let buffer = "";
    let roundText = "";
    const rawToolCalls: RuntimeToolCall[] = [];
    let streamDone = false;

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      // SSE 规范里 "data:" 后的空格可有可无，部分网关不带空格。
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        streamDone = true;
        return;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) return;

        if (delta.content) {
          roundText += delta.content;
          onChunk(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!rawToolCalls[idx]) rawToolCalls[idx] = { id: tc.id || "", name: "", arguments: "" };
            if (tc.id) rawToolCalls[idx].id = tc.id;
            if (tc.function?.name) rawToolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) rawToolCalls[idx].arguments += tc.function.arguments;
          }
        }
      } catch {}
    };

    while (!streamDone) {
      if (options.signal?.aborted) throw new DOMException("生成已停止", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        handleLine(line);
        if (streamDone) break;
      }
    }
    // 最后一段可能没有换行结尾，之前会被直接丢掉。
    if (!streamDone) {
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);
    } else {
      reader.cancel().catch(() => {});
    }

    // tool_calls 的 index 不一定从 0 连续，去掉空洞；缺 id 时补一个，
    // 否则 assistant.tool_calls[].id 与 tool.tool_call_id 对不上，下一轮请求会被拒。
    const toolCalls = rawToolCalls
      .filter((tc): tc is RuntimeToolCall => Boolean(tc && tc.name))
      .map((tc, index) => ({ ...tc, id: tc.id || `tool_${Date.now()}_${index}` }));

    fullText += roundText;
    if (!shouldSendTools || toolCalls.length === 0) {
      ranOutOfRounds = false;
      break;
    }

    currentMessages.push({
      role: "assistant",
      content: roundText || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    await executeRuntimeToolCalls(toolCalls, tools, currentMessages, options.onToolEvent);
  }

  if (ranOutOfRounds && !fullText.trim()) {
    // 连续 5 轮都只在调工具、没有给出文字回复，避免最后落一条空消息。
    const note = "（工具调用轮次已用完，模型没有给出最终答复。可以换个问法或让我继续。）";
    fullText = note;
    onChunk(note);
  }

  if (config.enableMemory !== false && (fullText.length > 30 || userText.length > 8)) {
    const conversation = request.messages
      .slice(-5)
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    setTimeout(() => {
      memoryStore.extractAndSaveMemories(`${conversation}\nassistant: ${fullText}`).catch(() => {});
    }, 0);
  }

  const lastCleanup = localStorage.getItem("paw_memory_cleanup");
  const now = Date.now();
  if (!lastCleanup || now - parseInt(lastCleanup) > 24 * 60 * 60 * 1000) {
    setTimeout(() => {
      memoryStore.cleanupExpired().catch(() => {});
      localStorage.setItem("paw_memory_cleanup", now.toString());
    }, 0);
  }

  return fullText;
}

export function getMemoryStats() {
  return memoryStore.getStats();
}

export function getUserProfile() {
  return personalityStore.getProfile();
}

export function getSmartSuggestions() {
  return personalityStore.getSmartSuggestions();
}

export function getSecurityLogs(filter?: { level?: string; category?: string }) {
  return securityManager.getLogs(filter as any);
}
