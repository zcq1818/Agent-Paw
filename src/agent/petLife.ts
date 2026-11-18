import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { loadInitiativeMode } from "./initiative";
import { cleanTitle, digestDay, friendlyApp, queryTimeline, timelineEnabled, type TimelineEvent } from "./timeline";
import { todoStore } from "./tools";
import { loadMcpServers, loadMcpState } from "./mcpServers";
import type { BotRole } from "../store/bots";

/**
 * 桌宠的“生活”：专注陪伴 + 成长等级、下班小结、按你打开的软件搭话。
 * 都只用本机数据，不上传；主动出现的东西都能一键关掉。
 */

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// ───────────────────────── 专注 + 成长 ─────────────────────────

// 等级、称号、专注解锁都在 bond.ts（陪伴成长）；这里只管专注计时和按天的专注分钟数。

interface FocusSession {
  startedAt: number;
  endsAt: number;
  minutes: number;
}

interface GrowthData {
  totalFocusMin: number;
  sessions: number;
  days: Record<string, number>;
  focus: FocusSession | null;
}

interface GrowthStore extends GrowthData {
  startFocus: (minutes: number) => void;
  cancelFocus: () => void;
  /** 专注完成：记分钟数（成长经验由 bond.ts 加） */
  finishFocus: () => { minutes: number } | null;
}

const GROWTH_KEY = "paw_growth";
const EMPTY_GROWTH: GrowthData = { totalFocusMin: 0, sessions: 0, days: {}, focus: null };

function saveGrowth(state: GrowthData) {
  const { totalFocusMin, sessions, days, focus } = state;
  // 只留最近 90 天的按天记录
  const kept = Object.fromEntries(Object.entries(days).sort().slice(-90));
  writeJson(GROWTH_KEY, { totalFocusMin, sessions, days: kept, focus });
}

export const useGrowthStore = create<GrowthStore>((set, get) => ({
  ...readJson<GrowthData>(GROWTH_KEY, EMPTY_GROWTH),
  startFocus: (minutes) => {
    const now = Date.now();
    set({ focus: { startedAt: now, endsAt: now + minutes * 60_000, minutes } });
    saveGrowth(get());
  },
  cancelFocus: () => {
    set({ focus: null });
    saveGrowth(get());
  },
  finishFocus: () => {
    const { focus, totalFocusMin, days, sessions } = get();
    if (!focus) return null;
    const key = dayKey();
    set({ focus: null, totalFocusMin: totalFocusMin + focus.minutes, sessions: sessions + 1, days: { ...days, [key]: (days[key] || 0) + focus.minutes } });
    saveGrowth(get());
    return { minutes: focus.minutes };
  },
}));

export function todayFocusMinutes() {
  return useGrowthStore.getState().days[dayKey()] || 0;
}

// ───────────────────────── 已连上的服务 ─────────────────────────

/** 某个服务（slack / atlassian…）是否已经连上并有工具可用 */
export function connectorReady(keyword: string) {
  const states = loadMcpState();
  return loadMcpServers().some(
    (server) =>
      server.enabled &&
      `${server.id} ${server.name} ${server.url || ""}`.toLowerCase().includes(keyword) &&
      (states[server.id]?.tools?.length || 0) > 0
  );
}

// ───────────────────────── 下班小结 ─────────────────────────

export interface DailyWrap {
  /** null = 没开活动记录 */
  activeMs: number | null;
  topApps: Array<{ name: string; ms: number }>;
  files: number;
  todosDone: string[];
  todosOpen: number;
  overdue: number;
  focusMin: number;
}

export interface WrapSettings {
  enabled: boolean;
  time: string;
}

const WRAP_KEY = "paw_daily_wrap";
const WRAP_SHOWN_KEY = "paw_daily_wrap_shown";
export const DEFAULT_WRAP_SETTINGS: WrapSettings = { enabled: true, time: "18:00" };

export function loadWrapSettings(): WrapSettings {
  return readJson<WrapSettings>(WRAP_KEY, DEFAULT_WRAP_SETTINGS);
}

export function saveWrapSettings(settings: WrapSettings) {
  writeJson(WRAP_KEY, settings);
}

export async function buildDailyWrap(): Promise<DailyWrap> {
  const todayStart = new Date().setHours(0, 0, 0, 0);
  let activeMs: number | null = null;
  let topApps: DailyWrap["topApps"] = [];
  let files = 0;
  if (timelineEnabled()) {
    try {
      const events: TimelineEvent[] = await queryTimeline({ from: todayStart, to: Date.now(), limit: 5000 });
      const digest = digestDay(events, todayStart);
      activeMs = digest.activeMs;
      topApps = digest.apps
        .filter((item) => !/^(explorer|paw|searchhost|shellexperiencehost|lockapp)\.exe$/i.test(item.app))
        .slice(0, 3)
        .map((item) => ({ name: friendlyApp(item.app), ms: item.ms }));
      files = digest.files.length;
    } catch {}
  }
  const todos = todoStore.getAll();
  const isToday = (value?: string) => Boolean(value && new Date(value).getTime() >= todayStart);
  const todosDone = todos.filter((todo) => todo.completed && isToday(todo.updatedAt)).map((todo) => todo.text);
  const open = todos.filter((todo) => !todo.completed);
  const overdue = open.filter((todo) => todo.dueDate && new Date(todo.dueDate).getTime() < Date.now()).length;
  return { activeMs, topApps, files, todosDone, todosOpen: open.length, overdue, focusMin: todayFocusMinutes() };
}

const DAILY_REPORT_BRIEF =
  "根据我今天的电脑活动记录（先查今天的活动报告）、今天完成和没完成的待办，写一份简洁的工作日报：今天做了什么（按事情归纳，不按软件罗列）、进展到哪、遇到的问题、明天先做什么。只写有依据的内容，聊天和娱乐一笔带过。";

export function wrapPrompt(target: "report" | "slack" | "jira") {
  if (target === "slack")
    return `${DAILY_REPORT_BRIEF}\n\n写好后先给我看，我确认了再用 Slack 发出去（问我发到哪个频道或发给谁）。`;
  if (target === "jira")
    return `${DAILY_REPORT_BRIEF}\n\n然后用 Jira 查一下今天跟我有关、有进展的单子，建议在哪些单子下补一条进展评论，把要写的评论给我看，我确认了再写进去。`;
  return DAILY_REPORT_BRIEF;
}

function minutesOfDay(value: string) {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 到了下班时间（默认 18:00），一天弹一次下班小结。 */
export function useDailyWrap({ isBusy, show }: { isBusy: () => boolean; show: (wrap: DailyWrap) => void }) {
  const ref = useRef({ isBusy, show });
  ref.current = { isBusy, show };

  useEffect(() => {
    const check = async () => {
      const settings = loadWrapSettings();
      if (!settings.enabled || loadInitiativeMode() === "off") return;
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      // 过了下班时间 4 小时就不补了，免得半夜弹出来
      if (minutes < minutesOfDay(settings.time) || minutes > minutesOfDay(settings.time) + 240) return;
      if (localStorage.getItem(WRAP_SHOWN_KEY) === dayKey()) return;
      if (ref.current.isBusy()) return;
      const wrap = await buildDailyWrap();
      // 今天几乎没用电脑、也没做事，就不打扰了
      const worked = (wrap.activeMs ?? 0) >= 30 * 60_000 || wrap.todosDone.length > 0 || wrap.focusMin > 0;
      if (!worked) return;
      localStorage.setItem(WRAP_SHOWN_KEY, dayKey());
      ref.current.show(wrap);
    };
    const first = window.setTimeout(check, 20_000);
    const timer = window.setInterval(check, 5 * 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
}

// ───────────────────────── 按打开的软件搭话 ─────────────────────────

export type HintAction = { type: "bot"; role: BotRole; opener: string } | { type: "prompt"; prompt: string };

export interface AppHint {
  id: string;
  text: string;
  actionLabel: string;
  action: HintAction;
  role?: BotRole;
}

interface HintRule {
  id: string;
  apps?: RegExp;
  title?: RegExp;
  needs?: string;
  hint: Omit<AppHint, "id">;
}

const RULES: HintRule[] = [
  {
    id: "jira",
    title: /jira|atlassian/i,
    needs: "atlassian",
    hint: {
      text: "在看 Jira？要我把分给你、还没做完的单子按优先级理一下吗？",
      actionLabel: "理一下",
      action: { type: "prompt", prompt: "用 Jira 查一下分配给我、还没完成的单子，按优先级和截止时间列出来，标出今天最该先做的三个。" },
    },
  },
  {
    id: "slack",
    apps: /^slack\.exe$/i,
    needs: "slack",
    hint: {
      text: "打开 Slack 了，要我先看看有没有 @你、需要你回的消息？",
      actionLabel: "看看",
      action: { type: "prompt", prompt: "用 Slack 看看最近一天有没有 @我、私信我或者需要我回复的消息，按重要程度列出来，每条一句话说清楚要我做什么。" },
    },
  },
  {
    id: "code",
    apps: /^(code|cursor|devenv|idea64|pycharm64|webstorm64|goland64|rider64|trae|windsurf)\.exe$/i,
    hint: {
      text: "开始写代码啦，卡住了随时叫代码员。",
      actionLabel: "叫代码员",
      role: "coder",
      action: { type: "bot", role: "coder", opener: "我在写代码，有问题待会儿问你。" },
    },
  },
  {
    id: "word",
    apps: /^(winword|wps)\.exe$/i,
    hint: {
      text: "在写文档？要改稿、润色、写提纲可以叫笔杆子。",
      actionLabel: "叫笔杆子",
      role: "writer",
      action: { type: "bot", role: "writer", opener: "我在写文档，待会儿请你帮忙看看。" },
    },
  },
  {
    id: "excel",
    apps: /^(excel|et)\.exe$/i,
    hint: {
      text: "表格要算指标、找原因，数据分析师在线。",
      actionLabel: "叫数据分析师",
      role: "analyst",
      action: { type: "bot", role: "analyst", opener: "我在看一份表格，待会儿请你帮忙分析。" },
    },
  },
  {
    id: "ppt",
    apps: /^(powerpnt|wpp)\.exe$/i,
    hint: {
      text: "做 PPT？排版、配色、讲稿可以找设计师。",
      actionLabel: "叫设计师",
      role: "designer",
      action: { type: "bot", role: "designer", opener: "我在做 PPT，待会儿请你帮忙看排版和配色。" },
    },
  },
  {
    id: "mail",
    apps: /^(outlook|olk|foxmail|thunderbird)\.exe$/i,
    hint: {
      text: "要写邮件的话，告诉我写给谁、什么事，我来起草。",
      actionLabel: "帮我写",
      action: { type: "prompt", prompt: "帮我起草一封邮件。先问我写给谁、要说什么事、语气正式还是随意，问清楚再写。" },
    },
  },
];

const HINT_SETTINGS_KEY = "paw_app_hints";
const HINT_LOG_KEY = "paw_app_hint_log";
const HINT_GAP_MS = 10 * 60_000;

export function appHintsEnabled() {
  return localStorage.getItem(HINT_SETTINGS_KEY) !== "off";
}

export function setAppHintsEnabled(enabled: boolean) {
  localStorage.setItem(HINT_SETTINGS_KEY, enabled ? "on" : "off");
}

type HintLog = { shown: Record<string, string>; muted: Record<string, number>; last: number };

function loadHintLog(): HintLog {
  return readJson<HintLog>(HINT_LOG_KEY, { shown: {}, muted: {}, last: 0 });
}

/** “不用了”：这类提示 7 天不再出现 */
export function muteHint(id: string) {
  const log = loadHintLog();
  log.muted[id] = Date.now() + 7 * 86_400_000;
  writeJson(HINT_LOG_KEY, log);
}

export function matchHint(app: string, title: string): AppHint | null {
  for (const rule of RULES) {
    const appOk = rule.apps ? rule.apps.test(app) : true;
    const titleOk = rule.title ? rule.title.test(title) : true;
    if (!rule.apps && !rule.title) continue;
    if (!appOk || !titleOk) continue;
    if (rule.needs && !connectorReady(rule.needs)) continue;
    return { id: rule.id, ...rule.hint };
  }
  return null;
}

/**
 * 前台切到某个软件时（来自本地活动记录），按规则冒一句提示。
 * 每类一天一次、两次提示至少隔 10 分钟；没开活动记录就什么也不做。
 */
export function useAppHints({ isBusy, show }: { isBusy: () => boolean; show: (hint: AppHint) => void }) {
  const ref = useRef({ isBusy, show });
  ref.current = { isBusy, show };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<TimelineEvent>("timeline-event", (event) => {
      const item = event.payload;
      if (!item || item.kind !== "app" || !appHintsEnabled() || loadInitiativeMode() === "off") return;
      const hint = matchHint(item.app || "", cleanTitle(item.title || ""));
      if (!hint) return;
      const log = loadHintLog();
      const today = dayKey();
      if (log.shown[hint.id] === today || (log.muted[hint.id] || 0) > Date.now() || Date.now() - log.last < HINT_GAP_MS) return;
      if (ref.current.isBusy()) return;
      log.shown[hint.id] = today;
      log.last = Date.now();
      writeJson(HINT_LOG_KEY, log);
      ref.current.show(hint);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
