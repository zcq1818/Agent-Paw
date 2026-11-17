/**
 * 上下文构建器 — 组装发给模型的上下文
 */

import { memoryStore } from "./memory";

export interface ContextOptions {
  userText: string;
  history: Array<{ role: string; content: string }>;
}

// 每轮最多带几条记忆、单条和总共多长（按字数算，中文大约 1 字 1 token）
const MAX_MEMORIES = 6;
const MAX_MEMORY_CHARS = 200;
const MAX_TOTAL_CHARS = 1200;

export async function buildContext(options: ContextOptions): Promise<string> {
  const { userText } = options;

  // 搜索相关记忆：只带最相关的几条，太长的截断，避免记忆一多每轮都很费 token
  let memoryContext = "";
  try {
    const memories = await memoryStore.search(userText, MAX_MEMORIES);
    const lines: string[] = [];
    let total = 0;
    for (const memory of memories) {
      const content = memory.content.length > MAX_MEMORY_CHARS ? `${memory.content.slice(0, MAX_MEMORY_CHARS)}…` : memory.content;
      const line = `- [${memory.type}] ${content}`;
      if (total + line.length > MAX_TOTAL_CHARS) break;
      lines.push(line);
      total += line.length;
    }
    if (lines.length > 0) memoryContext = "\n\n## 记忆中的相关信息\n" + lines.join("\n");
  } catch {}

  // 当前时间
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

  return `当前时间: ${now}${memoryContext}`;
}
