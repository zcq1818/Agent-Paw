import { create } from "zustand";
import { useEffect } from "react";

/**
 * 上下文用量：每次发给模型前，按类别估算各部分占了多少 token，存起来给聊天页的“上下文”面板看。
 * 估算按字符算（中日韩文字 1 字约 1 token，其他约 4 字符 1 token），和真实计数会有出入；
 * 接口返回了真实的 prompt_tokens 时一并记下来。
 */

export type UsagePartKey =
  | "messages"
  | "summary"
  | "toolResults"
  | "builtinTools"
  | "mcpTools"
  | "toolIndex"
  | "system"
  | "memory"
  | "skills"
  | "deferredBuiltin"
  | "deferredMcp";

export interface UsagePart {
  key: UsagePartKey;
  tokens: number;
  /** 按需加载、没有发给模型的部分（只展示，不计入总数） */
  deferred?: boolean;
  /** 条目数，比如工具个数、消息条数 */
  count?: number;
}

export interface ContextUsage {
  at: number;
  model: string;
  window: number;
  /** 估算的总输入 token（不含 deferred 部分） */
  total: number;
  /** 接口返回的真实输入 token（最后一轮） */
  actual?: number;
  /** 预留给回复的 token */
  reserve: number;
  parts: UsagePart[];
  /** 已经压缩进摘要的消息条数 */
  compacted?: number;
}

export const PART_LABELS: Record<UsagePartKey, string> = {
  messages: "消息",
  summary: "对话摘要",
  toolResults: "本轮工具结果",
  builtinTools: "内置工具",
  mcpTools: "MCP 工具",
  toolIndex: "可加载工具目录",
  system: "系统提示词",
  memory: "记忆",
  skills: "技能目录",
  deferredBuiltin: "内置工具（按需加载）",
  deferredMcp: "MCP 工具（按需加载）",
};

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;

export function estimateTokens(input: unknown): number {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (!text) return 0;
  const cjk = text.match(CJK)?.length || 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

const WINDOW_KEY = "paw_context_windows";

/** 用户在面板里手动设的窗口大小（按模型名记） */
export function loadWindowOverrides(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(WINDOW_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function setWindowOverride(model: string, value: number | null) {
  const next = loadWindowOverrides();
  if (value) next[model] = value;
  else delete next[model];
  localStorage.setItem(WINDOW_KEY, JSON.stringify(next));
}

/** 按模型名猜上下文窗口；猜不准的可以在面板里手动改 */
export function guessContextWindow(model: string): number {
  const name = (model || "").toLowerCase();
  if (/gemini/.test(name)) return 1_000_000;
  if (/claude|opus|sonnet|haiku/.test(name)) return 200_000;
  if (/gpt-4\.1|gpt-5|o[134](-|$)|o[134]-mini/.test(name)) return 400_000;
  if (/gpt-4o|gpt-4-turbo|deepseek|glm-4|kimi|moonshot|qwen-(plus|max|long|turbo)|qwen3|doubao|hunyuan|agnes|mistral-large|llama-3\.[13]/.test(name)) return 128_000;
  if (/max-32k|32k/.test(name)) return 32_000;
  if (/pro-128k|128k/.test(name)) return 128_000;
  if (/^lite$|spark|generalv3$|4\.0ultra|x1/.test(name)) return 8_000;
  if (/qwen|yi-|baichuan|ernie/.test(name)) return 32_000;
  return 32_000;
}

export function contextWindowFor(model: string): number {
  return loadWindowOverrides()[model] || guessContextWindow(model);
}

/* ------------------------------ 按会话保存 ------------------------------ */

const USAGE_KEY = "paw_context_usage";
const MAX_KEYS = 40;

function loadAll(): Record<string, ContextUsage> {
  try {
    const parsed = JSON.parse(localStorage.getItem(USAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

interface UsageState {
  byKey: Record<string, ContextUsage>;
  record: (key: string, usage: ContextUsage) => void;
  patch: (key: string, patch: Partial<ContextUsage>) => void;
  reload: () => void;
}

function persist(byKey: Record<string, ContextUsage>) {
  const entries = Object.entries(byKey)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_KEYS);
  const trimmed = Object.fromEntries(entries);
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* 存不下就只留在内存里 */
  }
  return trimmed;
}

export const useContextUsageStore = create<UsageState>((set) => ({
  byKey: loadAll(),
  record: (key, usage) => set({ byKey: persist({ ...loadAll(), [key]: usage }) }),
  patch: (key, patch) => {
    const all = loadAll();
    if (!all[key]) return;
    set({ byKey: persist({ ...all, [key]: { ...all[key], ...patch } }) });
  },
  reload: () => set({ byKey: loadAll() }),
}));

export function useContextUsageSync() {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === USAGE_KEY) useContextUsageStore.getState().reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}

export function usageKey(botId: string, conversationId: string) {
  return `${botId || "default"}:${conversationId}`;
}

/** 把同一类的条目合并，丢掉 0 的 */
export function buildUsage(input: { model: string; reserve: number; parts: UsagePart[]; compacted?: number; window?: number }): ContextUsage {
  const parts = input.parts.filter((part) => part.tokens > 0 || part.key === "messages");
  const total = parts.filter((part) => !part.deferred).reduce((sum, part) => sum + part.tokens, 0);
  return {
    at: Date.now(),
    model: input.model,
    window: input.window || contextWindowFor(input.model),
    total,
    reserve: input.reserve,
    parts,
    compacted: input.compacted,
  };
}

/** 13.7万 / 9,745 */
export function formatTokens(value: number) {
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 1_000_000 ? 0 : 1)}万`;
  return value.toLocaleString("en-US");
}
