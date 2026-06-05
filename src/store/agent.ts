import { create } from "zustand";
import { useChatStore } from "./chat";
import { streamChat, type ChatRequest } from "../agent/kernel";

interface AgentState {
  isStreaming: boolean;
  streamText: string;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  isStreaming: false,
  streamText: "",
  error: null,

  sendMessage: async (text: string) => {
    set({ isStreaming: true, streamText: "", error: null });

    const addMessage = useChatStore.getState().addMessage;
    const messages = useChatStore.getState().messages;

    // 构建历史消息
    const history = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const fullText = await streamChat(
        { messages: history, userMessage: text },
        (chunk) => {
          set((s) => ({ streamText: s.streamText + chunk }));
        }
      );

      addMessage({ role: "assistant", content: fullText });
      set({ streamText: "" });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "未知错误";
      set({ error: errorMsg });
      addMessage({
        role: "assistant",
        content: `❌ 出错了: ${errorMsg}\n\n请检查 API Key 和网络连接。`,
      });
    } finally {
      set({ isStreaming: false });
    }
  },
}));
