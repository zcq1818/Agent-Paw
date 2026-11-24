/**
 * 长对话自动压缩：发给模型的历史快装不下（或超过条数上限）时，把较早的消息整理成一段摘要，
 * 之后只发“摘要 + 最近几条”。摘要存在会话里，下次接着用，不用每次重新总结。
 * 没有可用的 API 模型（比如用的是本机 Claude）或总结失败时，退回原来的做法：只保留最近的消息。
 */

import { estimateTokens } from "./contextUsage";
import { quickComplete, quickModelAvailable } from "./llm";

export interface HistoryMessage {
  id: string;
  role: string;
  content: string;
}

/** 超过这么多条就压缩一次（就算 token 还够，也避免每轮都发一大串） */
export const MAX_HISTORY_MESSAGES = 40;
/** 压缩后保留的最近消息条数 */
const KEEP_RECENT = 10;
/** 历史最多占上下文窗口的比例（剩下给系统提示、工具定义和回复） */
const HISTORY_SHARE = 0.8;
const CHUNK_CHARS = 30_000;
const MESSAGE_CHARS = 1500;

const SUMMARY_SYSTEM = `你负责把一段较早的聊天记录压缩成摘要，供 AI 助手之后接着聊时参考（助手之后只能看到摘要，看不到原文）。
要求：
- 用中文，按要点写，不寒暄，不评价
- 必须保留：用户的目标和需求、做过的决定和结论、关键事实和数字、提到的文件 / 网址 / 名字、还没做完的事、用户明确表达的偏好和要求
- 助手调用工具得到的重要结果写进去（比如查到了什么），过程不用写
- 如果给了“已有摘要”，把新内容合并进去，输出一份完整的新摘要，不要重复
- 控制在 1200 字以内，只输出摘要本身`;

function transcript(messages: HistoryMessage[]) {
  return messages
    .map((message) => {
      const who = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "系统";
      const text = message.content.length > MESSAGE_CHARS ? `${message.content.slice(0, MESSAGE_CHARS)}…（后略）` : message.content;
      return `${who}：${text}`;
    })
    .join("\n\n");
}

/** 分块滚动总结，避免一次塞太多 */
export async function summarizeMessages(previous: string, messages: HistoryMessage[]): Promise<string> {
  const chunks: HistoryMessage[][] = [];
  let current: HistoryMessage[] = [];
  let size = 0;
  for (const message of messages) {
    const length = Math.min(message.content.length, MESSAGE_CHARS) + 8;
    if (current.length && size + length > CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += length;
  }
  if (current.length) chunks.push(current);

  let summary = previous.trim();
  for (const chunk of chunks) {
    const prompt = `${summary ? `## 已有摘要\n${summary}\n\n` : ""}## 新的聊天记录\n${transcript(chunk)}`;
    const result = (await quickComplete(SUMMARY_SYSTEM, prompt, { maxTokens: 3000, temperature: 0.3 }))
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();
    if (!result) throw new Error("总结失败");
    summary = result;
  }
  return summary;
}

const tokensOf = (messages: HistoryMessage[]) => messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);

export interface PreparedHistory {
  /** 这次要发给模型的消息 */
  recent: HistoryMessage[];
  /** 放进系统提示的摘要 */
  summary?: string;
  /** 摘要里一共有多少条消息 */
  compacted: number;
  /** 这次新生成的摘要（需要存回会话） */
  updated?: { text: string; upTo: string; count: number };
  /** 因为没法总结而直接丢掉的旧消息条数 */
  dropped: number;
}

export async function prepareHistory(input: {
  messages: HistoryMessage[];
  summary?: string;
  summaryUpTo?: string;
  summarizedCount?: number;
  /** 上下文窗口（token） */
  window: number;
  /** 系统提示、工具定义等非消息部分的估算 */
  overhead: number;
  /** 留给回复的 token */
  reserve: number;
  /** 手动压缩：不管有没有超，都把最近几条之外的压缩掉 */
  force?: boolean;
  onCompacting?: () => void;
}): Promise<PreparedHistory> {
  const { messages } = input;
  let start = 0;
  if (input.summary && input.summaryUpTo) {
    const index = messages.findIndex((message) => message.id === input.summaryUpTo);
    start = index >= 0 ? index + 1 : Math.min(input.summarizedCount || 0, messages.length);
  }
  let pending = messages.slice(start);
  const summary = input.summary?.trim() || "";
  const compacted = summary ? input.summarizedCount || start : 0;

  const budget = Math.max(2000, Math.floor(input.window * HISTORY_SHARE) - input.overhead - input.reserve - estimateTokens(summary));
  const tooMany = pending.length > MAX_HISTORY_MESSAGES;
  const tooBig = tokensOf(pending) > budget;
  if (!input.force && !tooMany && !tooBig) return { recent: pending, summary: summary || undefined, compacted, dropped: 0 };

  // 留最近几条，太长就再少留一些；开头必须是用户的话
  let keepCount = Math.min(KEEP_RECENT, pending.length - 1);
  if (input.force) keepCount = Math.min(4, pending.length - 1);
  while (keepCount > 2 && tokensOf(pending.slice(-keepCount)) > budget * 0.5) keepCount -= 1;
  let splitAt = pending.length - Math.max(keepCount, 1);
  while (splitAt < pending.length - 1 && pending[splitAt].role !== "user") splitAt += 1;
  const toSummarize = pending.slice(0, splitAt);
  const keep = pending.slice(splitAt);

  if (toSummarize.length && quickModelAvailable()) {
    try {
      input.onCompacting?.();
      const text = await summarizeMessages(summary, toSummarize);
      const count = compacted + toSummarize.length;
      return {
        recent: keep,
        summary: text,
        compacted: count,
        updated: { text, upTo: toSummarize[toSummarize.length - 1].id, count },
        dropped: 0,
      };
    } catch {
      /* 总结失败：退回截断 */
    }
  }

  // 退回：只留最近的，超了就从最早的开始丢
  pending = pending.slice(-MAX_HISTORY_MESSAGES);
  while (pending.length > 2 && tokensOf(pending) > budget) pending = pending.slice(1);
  while (pending.length > 1 && pending[0].role !== "user") pending = pending.slice(1);
  return {
    recent: pending,
    summary: summary || undefined,
    compacted,
    dropped: messages.length - start - pending.length,
  };
}
