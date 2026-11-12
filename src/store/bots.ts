import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { Message } from "./chat";
import { ACTIVE_BOT_KEY, DEFAULT_BOT_ID } from "../agent/scope";
import { migrateAvatar, type PetAvatar, type PetSkin } from "./pet";

/**
 * Bot roster — 多 Bot 通讯录的数据地基。
 *
 * 设计目标：把「每个 Bot 有独立人设、独立上下文、独立权限级别」这件事
 * 和现有全局单例的 chat / memory / personality 解耦，先落数据结构与持久化，
 * 后续再逐层把单例改成按 botId 分区。此文件为纯新增，不改动现有调用方。
 */

export type BotRole =
  | "chief"
  | "coder"
  | "research"
  | "ops"
  | "review"
  | "writer"
  | "translator"
  | "analyst"
  | "product"
  | "tester"
  | "designer"
  | "tutor"
  | "life"
  | "custom";
export type ApprovalLevel = "ask" | "edits" | "auto";
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";
export type ApprovalKind = "shell" | "file_edit" | "network" | "tool";

export interface BotModelOverride {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface BotProfile {
  id: string;
  name: string;
  avatar: string;
  /** 复用桌宠的真实形象；留空则回落到 emoji 头像。 */
  petAvatar?: PetAvatar;
  /** 形象配色（皮卡丘系生效）。 */
  petSkin?: PetSkin;
  role: BotRole;
  tagline: string;
  instructions: string;
  skills: string[];
  approvalLevel: ApprovalLevel;
  pinned: boolean;
  archived: boolean;
  modelOverride?: BotModelOverride;
  createdAt: string;
  updatedAt: string;
}

export interface BotThread {
  id: string;
  botId: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  botId: string;
  threadId: string;
  kind: ApprovalKind;
  summary: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  /** “一直允许”记住的范围（一般是工具名），以及给用户看的名字 */
  scope?: string;
  scopeLabel?: string;
  /** 高风险操作不提供“一直允许” */
  allowAlways?: boolean;
}

const BOTS_KEY = "paw_bots_v1";
const THREADS_KEY = "paw_bot_threads_v1";
const APPROVALS_KEY = "paw_approvals_v1";
const ACTIVE_THREAD_KEY = "paw_active_bot_thread_v1";

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 可复用的角色模板：在通讯录里「新建 Bot」时直接套用。 */
export const ROLE_PRESETS: Array<{
  role: BotRole;
  name: string;
  avatar: string;
  petAvatar: PetAvatar;
  petSkin: PetSkin;
  tagline: string;
  instructions: string;
  skills: string[];
  approvalLevel: ApprovalLevel;
}> = [
  {
    role: "chief",
    name: "皮卡丘",
    avatar: "pikachu",
    petAvatar: "fox",
    petSkin: "yellow",
    tagline: "默认陪伴型桌宠，负责日常对话与分派",
    instructions: "你是用户的桌面宠物助手，语气轻快、简洁。遇到专业任务时建议用户切换到对应专精 Bot。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "coder",
    name: "代码员",
    avatar: "coder",
    petAvatar: "robot",
    petSkin: "blue",
    tagline: "读代码、查问题、准备改动方案",
    instructions: "你是代码审查与实现助手。回答前先确认文件路径与上下文，改动方案要给出具体文件与行。",
    skills: [],
    approvalLevel: "edits",
  },
  {
    role: "research",
    name: "资料员",
    avatar: "research",
    petAvatar: "cat",
    petSkin: "green",
    tagline: "检索、核对来源、整理结论",
    instructions: "你是资料研究助手。结论必须标注来源，无法核实的要明确说明，不要猜测。",
    skills: ["weather"],
    approvalLevel: "ask",
  },
  {
    role: "ops",
    name: "运营",
    avatar: "ops",
    petAvatar: "toon_pikachu",
    petSkin: "pink",
    tagline: "待办、日程、提醒与日常事务",
    instructions: "你是事务助手。优先使用待办与日程工具，输出可执行的清单。",
    skills: ["todo"],
    approvalLevel: "edits",
  },
  {
    role: "review",
    name: "复核",
    avatar: "review",
    petAvatar: "fox",
    petSkin: "pink",
    tagline: "用不同视角复查另一个 Bot 的结论",
    instructions: "你是复核助手。只检查给定结论中的事实、遗漏与风险，不重复原任务。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "writer",
    name: "笔杆子",
    avatar: "writer",
    petAvatar: "cat",
    petSkin: "pink",
    tagline: "写文案、周报、邮件，改稿润色",
    instructions:
      "你是写作助手。先问清用途、读者和长度（用户没说就按常见场景给一版），直接给能用的成稿，不写空话套话；改稿时保留原意，说明改了哪里。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "translator",
    name: "翻译官",
    avatar: "translator",
    petAvatar: "penguin",
    petSkin: "blue",
    tagline: "中英日互译，保留语气和术语",
    instructions:
      "你是翻译助手。中文默认译成英文，其他语言默认译成中文；保留原文格式、语气和专有名词，术语有歧义时在译文后用一行注明。只输出译文，除非用户要求解释。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "analyst",
    name: "数据分析师",
    avatar: "analyst",
    petAvatar: "robot",
    petSkin: "green",
    tagline: "看表格、算指标、找原因",
    instructions:
      "你是数据分析助手。先说清数据口径和假设，再给结论；数字要能复算，能用表格就用表格；数据不足以下结论时直说缺什么。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "product",
    name: "产品经理",
    avatar: "product",
    petAvatar: "fox",
    petSkin: "blue",
    tagline: "梳理需求、写 PRD、排优先级",
    instructions:
      "你是产品经理助手。把模糊想法拆成用户、场景、问题、方案和验收标准；给优先级时说明理由；输出用清单和表格，避免空泛的方法论。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "tester",
    name: "测试员",
    avatar: "tester",
    petAvatar: "dino",
    petSkin: "yellow",
    tagline: "想测试用例、找边界情况、复现 bug",
    instructions:
      "你是测试助手。针对给定功能列出正常、边界、异常三类用例；复现问题时给出最小步骤、预期和实际结果；不确定的地方标出来。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "designer",
    name: "设计师",
    avatar: "designer",
    petAvatar: "toon_pikachu",
    petSkin: "pink",
    tagline: "界面、配色、排版建议",
    instructions:
      "你是 UI / 视觉设计助手。给建议时说明理由（层级、对比、间距、一致性），配色给出具体色值，尽量给可以直接用的 CSS 或布局描述。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "tutor",
    name: "学习搭子",
    avatar: "tutor",
    petAvatar: "penguin",
    petSkin: "green",
    tagline: "讲概念、出练习、陪你复习",
    instructions:
      "你是学习助手。先用一句话讲清核心，再举例子；讲完出 1-2 道小题检验理解；用户答错时指出错在哪，不直接甩答案。",
    skills: [],
    approvalLevel: "ask",
  },
  {
    role: "life",
    name: "生活管家",
    avatar: "life",
    petAvatar: "cat",
    petSkin: "yellow",
    tagline: "天气、出行、吃饭、购物清单",
    instructions:
      "你是生活助手。回答要具体可执行：给出时间、地点、清单或步骤；涉及天气、日程时优先调用对应工具，不凭印象回答。",
    skills: ["weather", "todo"],
    approvalLevel: "ask",
  },
];

function defaultBots(): BotProfile[] {
  const preset = ROLE_PRESETS[0];
  const now = nowIso();
  return [
    {
      id: DEFAULT_BOT_ID,
      name: preset.name,
      avatar: preset.avatar,
      petAvatar: preset.petAvatar,
      petSkin: preset.petSkin,
      role: preset.role,
      tagline: preset.tagline,
      instructions: preset.instructions,
      skills: [],
      approvalLevel: "ask",
      pinned: true,
      archived: false,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function readArray<T>(key: string, fallback: T[]): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function readString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_RESOLVED_APPROVALS = 50;

function normalizeApprovals(list: ApprovalRequest[]): ApprovalRequest[] {
  const now = Date.now();
  const normalized = list.map((request) =>
    request.status === "pending" && now - new Date(request.createdAt).getTime() > APPROVAL_TIMEOUT_MS + 10_000
      ? { ...request, status: "expired" as const, resolvedAt: new Date(now).toISOString() }
      : request
  );
  const pending = normalized.filter((request) => request.status === "pending");
  const resolved = normalized.filter((request) => request.status !== "pending").slice(-MAX_RESOLVED_APPROVALS);
  return [...resolved, ...pending];
}

function loadState() {
  const bots = readArray<BotProfile>(BOTS_KEY, defaultBots());
  const validBots = bots.filter((bot) => bot && typeof bot.id === "string" && typeof bot.name === "string");
  // 兼容旧数据：早期 Bot 没有 petAvatar，按角色补一个默认形象，避免通讯录还是 emoji。
  const roster = (validBots.length ? validBots : defaultBots()).map((bot) => {
    const petAvatar = migrateAvatar(bot.petAvatar);
    if (petAvatar) return petAvatar === bot.petAvatar ? bot : { ...bot, petAvatar };
    const preset = ROLE_PRESETS.find((item) => item.role === bot.role) || ROLE_PRESETS[0];
    return { ...bot, petAvatar: preset.petAvatar, petSkin: bot.petSkin || preset.petSkin };
  });
  const threads = readArray<BotThread>(THREADS_KEY, []);
  const approvals = normalizeApprovals(readArray<ApprovalRequest>(APPROVALS_KEY, []));
  const activeBotId = roster.some((bot) => bot.id === readString(ACTIVE_BOT_KEY, ""))
    ? readString(ACTIVE_BOT_KEY, "")
    : roster[0].id;
  const candidateThread = readString(ACTIVE_THREAD_KEY, "");
  const activeThreadId = threads.some((thread) => thread.id === candidateThread && thread.botId === activeBotId)
    ? candidateThread
    : threads.find((thread) => thread.botId === activeBotId)?.id || "";
  return { bots: roster, threads, approvals, activeBotId, activeThreadId };
}

function persist(state: Pick<BotState, "bots" | "threads" | "approvals" | "activeBotId" | "activeThreadId">) {
  try {
    localStorage.setItem(BOTS_KEY, JSON.stringify(state.bots));
    localStorage.setItem(THREADS_KEY, JSON.stringify(state.threads));
    localStorage.setItem(APPROVALS_KEY, JSON.stringify(state.approvals));
    localStorage.setItem(ACTIVE_BOT_KEY, state.activeBotId);
    localStorage.setItem(ACTIVE_THREAD_KEY, state.activeThreadId);
  } catch {}
}

function notify() {
  try {
    emit("bots-changed", { at: Date.now() });
  } catch {
    // Browser dev fallback: the storage event below still syncs other tabs.
  }
}

function makeThread(botId: string, title = "新对话"): BotThread {
  const now = nowIso();
  return { id: uid("thread"), botId, title, messages: [], createdAt: now, updatedAt: now };
}

export interface BotState {
  bots: BotProfile[];
  threads: BotThread[];
  approvals: ApprovalRequest[];
  activeBotId: string;
  activeThreadId: string;
  /** activate 默认 true：新建后切换为当前 Bot；批量添加时传 false。 */
  createBot: (input: Partial<BotProfile> & { name: string }, options?: { activate?: boolean }) => string;
  createBotFromRole: (role: BotRole, options?: { activate?: boolean }) => string | undefined;
  updateBot: (id: string, patch: Partial<BotProfile>) => void;
  archiveBot: (id: string) => void;
  switchBot: (id: string) => void;
  createThread: (botId: string, title?: string) => string;
  switchThread: (id: string) => void;
  appendMessage: (threadId: string, msg: Omit<Message, "id" | "createdAt">) => void;
  requestApproval: (input: Omit<ApprovalRequest, "id" | "status" | "createdAt" | "resolvedAt">) => string;
  resolveApproval: (id: string, status: "allowed" | "denied") => void;
  replaceState: (snapshot: ReturnType<typeof loadState>) => void;
}

export const useBotStore = create<BotState>((set, get) => {
  const commit = (patch: Partial<Pick<BotState, "bots" | "threads" | "approvals" | "activeBotId" | "activeThreadId">>) => {
    set(patch as Partial<BotState>);
    const next = get();
    persist({
      bots: next.bots,
      threads: next.threads,
      approvals: next.approvals,
      activeBotId: next.activeBotId,
      activeThreadId: next.activeThreadId,
    });
    notify();
  };

  return {
    ...loadState(),

    createBot: (input, options) => {
      const now = nowIso();
      const bot: BotProfile = {
        id: uid("bot"),
        avatar: "custom",
        role: "custom",
        tagline: "",
        instructions: "",
        skills: [],
        approvalLevel: "ask",
        pinned: false,
        archived: false,
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      if (options?.activate === false) commit({ bots: [...get().bots, bot] });
      else commit({ bots: [...get().bots, bot], activeBotId: bot.id, activeThreadId: "" });
      return bot.id;
    },

    createBotFromRole: (role, options) => {
      const preset = ROLE_PRESETS.find((item) => item.role === role);
      if (!preset) return undefined;
      return get().createBot({
        name: preset.name,
        avatar: preset.avatar,
        petAvatar: preset.petAvatar,
        petSkin: preset.petSkin,
        role: preset.role,
        tagline: preset.tagline,
        instructions: preset.instructions,
        skills: [...preset.skills],
        approvalLevel: preset.approvalLevel,
      }, options);
    },

    updateBot: (id, patch) => {
      commit({
        bots: get().bots.map((bot) =>
          bot.id === id ? { ...bot, ...patch, id: bot.id, updatedAt: nowIso() } : bot
        ),
      });
    },

    archiveBot: (id) => {
      const state = get();
      if (state.bots.length <= 1) return;
      const bots = state.bots.map((bot) =>
        bot.id === id ? { ...bot, archived: true, updatedAt: nowIso() } : bot
      );
      const nextActive = state.activeBotId === id ? bots.find((bot) => !bot.archived)?.id || bots[0].id : state.activeBotId;
      const nextThread = nextActive === state.activeBotId
        ? state.activeThreadId
        : state.threads.find((thread) => thread.botId === nextActive)?.id || "";
      commit({ bots, activeBotId: nextActive, activeThreadId: nextThread });
    },

    switchBot: (id) => {
      const state = get();
      if (!state.bots.some((bot) => bot.id === id)) return;
      let threadId = state.threads.find((thread) => thread.botId === id)?.id || "";
      let threads = state.threads;
      if (!threadId) {
        const thread = makeThread(id);
        threads = [...threads, thread];
        threadId = thread.id;
      }
      commit({ activeBotId: id, activeThreadId: threadId, threads });
    },

    createThread: (botId, title) => {
      const thread = makeThread(botId, title);
      commit({ threads: [...get().threads, thread], activeBotId: botId, activeThreadId: thread.id });
      return thread.id;
    },

    switchThread: (id) => {
      const thread = get().threads.find((item) => item.id === id);
      if (!thread) return;
      commit({ activeThreadId: id, activeBotId: thread.botId });
    },

    appendMessage: (threadId, msg) => {
      const now = nowIso();
      const message: Message = { ...msg, id: uid("msg"), createdAt: now };
      commit({
        threads: get().threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                messages: [...thread.messages, message],
                title:
                  thread.messages.length === 0 && msg.role === "user" && msg.content.trim()
                    ? msg.content.trim().slice(0, 18)
                    : thread.title,
                updatedAt: now,
              }
            : thread
        ),
      });
    },

    requestApproval: (input) => {
      const request: ApprovalRequest = { ...input, id: uid("approval"), status: "pending", createdAt: nowIso() };
      commit({ approvals: normalizeApprovals([...get().approvals, request]) });
      return request.id;
    },

    resolveApproval: (id, status) => {
      commit({
        approvals: get().approvals.map((request) =>
          request.id === id ? { ...request, status, resolvedAt: nowIso() } : request
        ),
      });
    },

    replaceState: (snapshot) => {
      set(snapshot as Partial<BotState>);
    },
  };
});

export function getActiveBot(state: BotState): BotProfile | undefined {
  return state.bots.find((bot) => bot.id === state.activeBotId);
}

export function getThreadsForBot(state: BotState, botId: string): BotThread[] {
  return state.threads
    .filter((thread) => thread.botId === botId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getPendingApprovals(state: BotState, botId?: string): ApprovalRequest[] {
  return state.approvals.filter(
    (request) => request.status === "pending" && (!botId || request.botId === botId)
  );
}

/** 多窗口 / 多标签页同步，写法与 useThemeClass 保持一致。 */
export function useBotRosterSync() {
  const replaceState = useBotStore((state) => state.replaceState);

  useEffect(() => {
    const watchedKeys = new Set([
      BOTS_KEY,
      THREADS_KEY,
      APPROVALS_KEY,
      ACTIVE_BOT_KEY,
      ACTIVE_THREAD_KEY,
    ]);
    const onStorage = (event: StorageEvent) => {
      if (event.key && watchedKeys.has(event.key)) replaceState(loadState());
    };
    window.addEventListener("storage", onStorage);
    // listen() 是异步注册：如果 cleanup 先于注册完成（StrictMode 双挂载），要在注册完成后立刻注销。
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen("bots-changed", () => replaceState(loadState()))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      unlisten?.();
    };
  }, [replaceState]);
}
