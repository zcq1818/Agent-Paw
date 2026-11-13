import {
  buildChatCompletionsUrl,
  buildRequestHeaders,
  configForBot,
  fetchModelApi,
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

/** 成员觉得这个问题和自己职责无关时回这个，界面上不显示。 */
export const ROOM_SKIP = "[跳过]";

function botSystemPrompt(bot: BotProfile, roomName: string, topic?: string): string {
  const parts = [
    `你是「${bot.name}」，正在团队房间「${roomName}」里和其他成员一起回答用户的问题。`,
  ];
  if (topic) parts.push(`房间话题：${topic}`);
  if (bot.tagline) parts.push(`你的职责：${bot.tagline}`);
  parts.push(bot.instructions || "回答简洁、准确。");
  parts.push(
    [
      "房间协作规则：",
      "- 只从你自己的职责角度回答，前面成员已经说过的不要重复，可以直接点名补充或反驳。",
      "- 默认简短：3~6 条要点或 200 字以内，用 Markdown（列表、粗体）排版；用户明确要详细时再展开。",
      "- 开头不要写自己的名字或 [名字] 标签，不要寒暄、不要自我介绍、不要描写动作（如“晃了晃尾巴”）、不要问“需要我帮你分派吗”。",
      `- 如果这个问题和你的职责基本无关，或你没有新的东西可补充，只回复 ${ROOM_SKIP}，不要写别的。`,
      "- 你不能上网或访问用户电脑，没有实际查过的数据不要编；需要数据时说清楚要用户提供什么。",
    ].join("\n")
  );
  return parts.join("\n");
}

/** 模型有时会学着历史记录在开头加“[自己的名字]”，界面上已经显示名字了，去掉。 */
function stripSelfLabel(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const label = new RegExp(`^\\s*(?:\\[${escaped}\\]|【${escaped}】|（${escaped} ?说）|${escaped}[:：])\\s*`);
  return text.replace(label, "").trim();
}

export function isRoomSkip(text: string) {
  const value = text.trim();
  return value === ROOM_SKIP || value === "跳过" || /^\[?跳过\]?[。.]?$/.test(value);
}

/** 以指定 Bot 的身份调用一次 OpenAI 兼容端点（非流式）。 */
export async function askBot(
  bot: BotProfile,
  prompt: string,
  history: RoomHistoryItem[],
  roomName: string,
  signal?: AbortSignal,
  topic?: string
): Promise<string> {
  const config = normalizeConfig(configForBot(bot));
  if (config.provider === "claude-local" || config.provider === "codebuddy-local") {
    const { askClaudeLocal, localAgentOf } = await import("./claudeLocal");
    const context = history
      .slice(-8)
      .map((item) => `${item.role === "assistant" ? item.botName || "助手" : "用户"}：${item.content}`)
      .join("\n\n");
    const reply = await askClaudeLocal(botSystemPrompt(bot, roomName, topic), context ? `${context}\n\n用户：${prompt}` : prompt, {
      model: config.model,
      agent: localAgentOf(config.provider) || "claude",
      signal,
    });
    return stripSelfLabel(reply, bot.name);
  }
  if (!config.apiKey) {
    throw new Error(`Bot「${bot.name}」没有可用 API Key（全局设置和该 Bot 的模型覆盖都为空）`);
  }

  const messages = [
    { role: "system", content: botSystemPrompt(bot, roomName, topic) },
    ...history.slice(-8).map((item) => ({
      role: item.role,
      content:
        item.role === "assistant" && item.botName
          ? `（${item.botName} 说）\n${item.content}`
          : item.content,
    })),
    { role: "user", content: prompt },
  ];

  const resp = await fetchModelApi(buildChatCompletionsUrl(config), {
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
  return stripSelfLabel(content, bot.name);
}
