import {
  buildChatCompletionsUrl,
  buildRequestHeaders,
  configForBot,
  normalizeConfig,
} from "./kernel";
import type { BotProfile } from "../store/bots";

export { resolveTargets, mentionIds } from "./mentions";

/**
 * Rooms 调度层：把一条消息分派给房间里的 Bot，并让每个 Bot 用
 * 自己的模型配置（configForBot）与人设独立作答。
 * 刻意不复用 streamChat —— 那个流程绑定「当前 Bot」且带工具循环，
 * 不适合一次给多个 Bot 并发/串行调用。
 */

export interface RoomHistoryItem {
  role: "user" | "assistant";
  content: string;
  botName?: string;
}

function botSystemPrompt(bot: BotProfile, roomName: string): string {
  const parts = [
    `你是「${bot.name}」，正在团队房间「${roomName}」里与其他 Bot 协作回答用户的问题。`,
  ];
  if (bot.tagline) parts.push(`职责：${bot.tagline}`);
  parts.push(bot.instructions || "回答简洁、准确，用中文和 Markdown。");
  parts.push("只回答你确实知道的内容，不要假装执行过没有实际执行的操作。");
  return parts.join("\n");
}

/** 以指定 Bot 的身份调用一次 OpenAI 兼容端点（非流式）。 */
export async function askBot(
  bot: BotProfile,
  prompt: string,
  history: RoomHistoryItem[],
  roomName: string,
  signal?: AbortSignal
): Promise<string> {
  const config = normalizeConfig(configForBot(bot));
  if (!config.apiKey) {
    throw new Error(`Bot「${bot.name}」没有可用 API Key（全局设置和该 Bot 的模型覆盖都为空）`);
  }

  const messages = [
    { role: "system", content: botSystemPrompt(bot, roomName) },
    ...history.slice(-8).map((item) => ({
      role: item.role,
      content:
        item.role === "assistant" && item.botName
          ? `[${item.botName}] ${item.content}`
          : item.content,
    })),
    { role: "user", content: prompt },
  ];

  const resp = await fetch(buildChatCompletionsUrl(config), {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
    }),
    signal,
  });

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 180);
    throw new Error(`Bot「${bot.name}」请求失败 (${resp.status})：${detail}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`Bot「${bot.name}」返回了空内容`);
  }
  return content;
}
