/**
 * 上下文构建器 — 组装发给模型的上下文
 */

import { memoryStore } from "./memory";

export interface ContextOptions {
  userText: string;
  history: Array<{ role: string; content: string }>;
}

export async function buildContext(options: ContextOptions): Promise<string> {
  const { userText, history } = options;

  // 搜索相关记忆
  let memoryContext = "";
  try {
    const memories = await memoryStore.search(userText);
    if (memories.length > 0) {
      memoryContext = "\n\n## 记忆中的相关信息\n" +
        memories.map((m) => `- [${m.type}] ${m.content}`).join("\n");
    }
  } catch {}

  // 当前时间
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

  return `当前时间: ${now}${memoryContext}`;
}
