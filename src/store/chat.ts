import { create } from "zustand";

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  surface?: unknown;
};

interface ChatState {
  messages: Message[];
  addMessage: (msg: Omit<Message, "id" | "createdAt">) => void;
  updateLastAssistant: (content: string) => void;
  clear: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],

  addMessage: (msg) => {
    const newMsg: Message = {
      ...msg,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, newMsg] }));
  },

  updateLastAssistant: (content) => {
    const msgs = get().messages;
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant") {
      set({
        messages: msgs.map((m) =>
          m.id === last.id ? { ...m, content } : m
        ),
      });
    }
  },

  clear: () => set({ messages: [] }),
}));
