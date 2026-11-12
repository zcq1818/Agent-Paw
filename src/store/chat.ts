import { create } from "zustand";
import type { SurfaceSpec } from "../agent/surfaces";
import { getActiveBotId, scopeKey, scopeKeyFor } from "../agent/scope";
import type { ToolRun } from "../agent/toolEvents";

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  surface?: SurfaceSpec;
  /** 这条回复期间发生的结构化工具调用。 */
  toolRuns?: ToolRun[];
};

export type ChatTarget = { botId: string; conversationId: string };

export type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string;
  messages: Message[];
  addMessage: (msg: Omit<Message, "id" | "createdAt">) => void;
  /**
   * 把消息写进指定 Bot 的指定会话。回复生成期间用户可能切换了 Bot 或会话，
   * 回复必须落回发起时的那个会话，而不是“当前打开的”会话。
   */
  addMessageTo: (target: ChatTarget, msg: Omit<Message, "id" | "createdAt">) => void;
  updateLastAssistant: (content: string) => void;
  removeMessage: (id: string) => void;
  removeLastAssistant: () => void;
  clear: () => void;
  createConversation: (title?: string) => string;
  switchConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  /** 切换 Bot 后重新载入该 Bot 的会话分区。 */
  hydrateForBot: () => void;
  /** 另一个窗口写入了会话数据：重新载入，但尽量保持本窗口当前打开的会话。 */
  syncFromStorage: () => void;
}

/** 当前 Bot 分区下会话相关的 localStorage key，供跨窗口同步判断。 */
export function chatStorageKeys(): string[] {
  const keys = getKeys();
  return [keys.storage, keys.active];
}

const LEGACY_KEY = "paw_messages";
const STORAGE_KEY = "paw_conversations";
const ACTIVE_KEY = "paw_active_conversation";

/** 默认 Bot 沿用原始 key；其他 Bot 各用一份独立分区。 */
function getKeys() {
  return {
    storage: scopeKey(STORAGE_KEY),
    active: scopeKey(ACTIVE_KEY),
    legacy: scopeKey(LEGACY_KEY),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createEmptyConversation(title = "新对话"): Conversation {
  const now = nowIso();
  return {
    id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function inferTitle(messages: Message[]) {
  const firstUser = messages.find((message) => message.role === "user")?.content.trim();
  if (!firstUser) return "新对话";
  return firstUser.length > 18 ? `${firstUser.slice(0, 18)}...` : firstUser;
}

function saveConversations(conversations: Conversation[], activeConversationId: string) {
  try {
    const keys = getKeys();
    localStorage.setItem(keys.storage, JSON.stringify(conversations));
    localStorage.setItem(keys.active, activeConversationId);
    const active = conversations.find((conversation) => conversation.id === activeConversationId);
    localStorage.setItem(keys.legacy, JSON.stringify(active?.messages || []));
  } catch {}
}

function loadState(): Pick<ChatState, "conversations" | "activeConversationId" | "messages"> {
  const keys = getKeys();
  try {
    const saved = localStorage.getItem(keys.storage);
    const activeId = localStorage.getItem(keys.active);
    if (saved) {
      const parsed = JSON.parse(saved) as Conversation[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const active = parsed.find((conversation) => conversation.id === activeId) || parsed[0];
        return { conversations: parsed, activeConversationId: active.id, messages: active.messages || [] };
      }
    }
  } catch {}

  try {
    const legacy = localStorage.getItem(keys.legacy);
    const messages = legacy ? JSON.parse(legacy) : [];
    if (Array.isArray(messages) && messages.length > 0) {
      const conversation = createEmptyConversation(inferTitle(messages));
      conversation.messages = messages;
      conversation.updatedAt = nowIso();
      return { conversations: [conversation], activeConversationId: conversation.id, messages };
    }
  } catch {}

  const conversation = createEmptyConversation();
  return { conversations: [conversation], activeConversationId: conversation.id, messages: [] };
}

function withActiveConversation(
  state: ChatState,
  updater: (conversation: Conversation) => Conversation
): Pick<ChatState, "conversations" | "messages"> {
  let activeMessages: Message[] = state.messages;
  const conversations = state.conversations.map((conversation) => {
    if (conversation.id !== state.activeConversationId) return conversation;
    const updated = updater(conversation);
    activeMessages = updated.messages;
    return updated;
  });
  saveConversations(conversations, state.activeConversationId);
  return { conversations, messages: activeMessages };
}

const initialState = loadState();

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: initialState.conversations,
  activeConversationId: initialState.activeConversationId,
  messages: initialState.messages,

  addMessage: (msg) => {
    const newMsg: Message = {
      ...msg,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: nowIso(),
    };
    set((state) =>
      withActiveConversation(state, (conversation) => {
        const messages = [...conversation.messages, newMsg];
        const shouldRename = conversation.title === "新对话" && newMsg.role === "user";
        return {
          ...conversation,
          title: shouldRename ? inferTitle(messages) : conversation.title,
          messages,
          updatedAt: nowIso(),
        };
      })
    );
  },

  addMessageTo: (target, msg) => {
    const newMsg: Message = {
      ...msg,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: nowIso(),
    };
    const append = (conversation: Conversation): Conversation => ({
      ...conversation,
      messages: [...conversation.messages, newMsg],
      updatedAt: nowIso(),
    });

    if (target.botId === getActiveBotId()) {
      const state = get();
      if (!state.conversations.some((conversation) => conversation.id === target.conversationId)) {
        // 会话已被删除：退回到当前会话，避免回复丢失。
        get().addMessage(msg);
        return;
      }
      const conversations = state.conversations.map((conversation) =>
        conversation.id === target.conversationId ? append(conversation) : conversation
      );
      saveConversations(conversations, state.activeConversationId);
      const active = conversations.find((conversation) => conversation.id === state.activeConversationId);
      set({ conversations, messages: active?.messages || [] });
      return;
    }

    // 发起时的 Bot 已不是当前 Bot：直接写进它自己的存储分区，不打扰当前界面。
    try {
      const storageKey = scopeKeyFor(STORAGE_KEY, target.botId);
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]") as Conversation[];
      if (!Array.isArray(parsed)) return;
      const exists = parsed.some((conversation) => conversation.id === target.conversationId);
      const conversations = exists
        ? parsed.map((conversation) => (conversation.id === target.conversationId ? append(conversation) : conversation))
        : [append({ ...createEmptyConversation("后台回复"), id: target.conversationId }), ...parsed];
      localStorage.setItem(storageKey, JSON.stringify(conversations));
    } catch {}
  },

  updateLastAssistant: (content) => {
    set((state) =>
      withActiveConversation(state, (conversation) => {
        const last = conversation.messages[conversation.messages.length - 1];
        if (!last || last.role !== "assistant") return conversation;
        return {
          ...conversation,
          messages: conversation.messages.map((message) => (message.id === last.id ? { ...message, content } : message)),
          updatedAt: nowIso(),
        };
      })
    );
  },

  removeMessage: (id) => {
    set((state) =>
      withActiveConversation(state, (conversation) => ({
        ...conversation,
        messages: conversation.messages.filter((message) => message.id !== id),
        updatedAt: nowIso(),
      }))
    );
  },

  removeLastAssistant: () => {
    set((state) =>
      withActiveConversation(state, (conversation) => {
        // 删掉末尾连续的所有助手消息：一轮回复后面可能还跟着自动推送（如今日新闻），
        // 只删最后一条会让“重新生成”留下旧回复。
        let keep = conversation.messages.length;
        while (keep > 0 && conversation.messages[keep - 1].role === "assistant") keep -= 1;
        if (keep === conversation.messages.length) return conversation;
        return {
          ...conversation,
          messages: conversation.messages.slice(0, keep),
          updatedAt: nowIso(),
        };
      })
    );
  },

  clear: () => {
    set((state) =>
      withActiveConversation(state, (conversation) => ({
        ...conversation,
        messages: [],
        title: "新对话",
        updatedAt: nowIso(),
      }))
    );
  },

  createConversation: (title = "新对话") => {
    const conversation = createEmptyConversation(title);
    const conversations = [conversation, ...get().conversations];
    saveConversations(conversations, conversation.id);
    set({ conversations, activeConversationId: conversation.id, messages: [] });
    return conversation.id;
  },

  switchConversation: (id) => {
    const conversation = get().conversations.find((item) => item.id === id);
    if (!conversation) return;
    saveConversations(get().conversations, id);
    set({ activeConversationId: id, messages: conversation.messages || [] });
  },

  renameConversation: (id, title) => {
    const nextTitle = title.trim() || "新对话";
    const conversations = get().conversations.map((conversation) =>
      conversation.id === id ? { ...conversation, title: nextTitle, updatedAt: nowIso() } : conversation
    );
    saveConversations(conversations, get().activeConversationId);
    set({ conversations });
  },

  deleteConversation: (id) => {
    const state = get();
    if (state.conversations.length <= 1) {
      state.clear();
      return;
    }
    const conversations = state.conversations.filter((conversation) => conversation.id !== id);
    const active = id === state.activeConversationId ? conversations[0] : conversations.find((item) => item.id === state.activeConversationId) || conversations[0];
    saveConversations(conversations, active.id);
    set({ conversations, activeConversationId: active.id, messages: active.messages || [] });
  },

  hydrateForBot: () => set(loadState()),

  syncFromStorage: () => {
    const loaded = loadState();
    const currentId = get().activeConversationId;
    const keep = loaded.conversations.find((conversation) => conversation.id === currentId);
    set(
      keep
        ? { conversations: loaded.conversations, activeConversationId: keep.id, messages: keep.messages || [] }
        : loaded
    );
  },
}));
