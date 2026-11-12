import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { applyTimelineConfig, clearTimeline } from "../agent/timeline";

export type ActiveWindowInfo = {
  title: string;
  processPath: string;
  processName: string;
};

export type ActivityEntry = {
  id: string;
  title: string;
  processName: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
};

export type TypingSample = {
  id: string;
  source: "chat" | "mini_chat" | "other";
  chars: number;
  timestamp: string;
};

export type AppUsage = {
  name: string;
  category: string;
  durationMs: number;
  sessions: number;
  percent: number;
};

export type ActivityStats = {
  totalActiveMs: number;
  switchCount: number;
  longestFocusMs: number;
  focusScore: number;
  topApps: AppUsage[];
  categories: AppUsage[];
  activeHours: Array<{ hour: number; durationMs: number }>;
  typing: {
    chars: number;
    messages: number;
    avgChars: number;
    peakHour?: number;
    bySource: Array<{ source: TypingSample["source"]; chars: number; messages: number }>;
  };
};

interface ActivityState {
  enabled: boolean;
  entries: ActivityEntry[];
  current?: ActivityEntry;
  typingSamples: TypingSample[];
  setEnabled: (enabled: boolean) => void;
  recordWindow: (info: ActiveWindowInfo) => void;
  recordTyping: (chars: number, source?: TypingSample["source"]) => void;
  getStats: (dateStr?: string) => ActivityStats;
  getCompactSummary: (dateStr?: string) => string;
  getSummary: (dateStr?: string) => string;
  getBehaviorReport: (dateStr?: string) => string;
  clear: () => void;
  /** 另一个窗口改了开关或记录：重新载入。 */
  syncFromStorage: (key: string | null) => void;
}

export const ACTIVITY_STORAGE_KEYS = ["paw_activity_enabled", "paw_activity_entries", "paw_typing_samples"];

const ENABLED_KEY = "paw_activity_enabled";
const ENTRIES_KEY = "paw_activity_entries";
const TYPING_KEY = "paw_typing_samples";
const MAX_ENTRIES = 420;
const MAX_TYPING = 1000;

function loadEnabled() {
  return localStorage.getItem(ENABLED_KEY) === "1";
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return fallback;
    return JSON.parse(saved) as T;
  } catch {
    return fallback;
  }
}

function saveEntries(entries: ActivityEntry[]) {
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
}

function saveTyping(samples: TypingSample[]) {
  localStorage.setItem(TYPING_KEY, JSON.stringify(samples.slice(-MAX_TYPING)));
}

function normalizeInfo(raw: any): ActiveWindowInfo {
  return {
    title: raw?.title || "",
    processPath: raw?.process_path || raw?.processPath || "",
    processName: raw?.process_name || raw?.processName || "",
  };
}

function filterByDate<T extends { startedAt?: string; timestamp?: string }>(items: T[], dateStr: string) {
  return items.filter((item) => new Date(item.startedAt || item.timestamp || 0).toDateString() === dateStr);
}

function todayOnly<T extends { startedAt?: string; timestamp?: string }>(items: T[]) {
  return filterByDate(items, new Date().toDateString());
}

function appName(name: string) {
  return name || "未知应用";
}

function categoryFor(processName: string, title = "") {
  const text = `${processName} ${title}`.toLowerCase();
  if (/code|cursor|webstorm|idea|studio|devenv|terminal|cmd|powershell|node|python/.test(text)) return "开发";
  if (/chrome|edge|firefox|browser|wechat|weixin|qq|telegram|discord|slack|lark|feishu|teams/.test(text)) return "沟通/浏览";
  if (/word|excel|powerpnt|wps|notion|obsidian|onenote|typora/.test(text)) return "文档";
  if (/photoshop|figma|sketch|blender|paint|mspaint|canva/.test(text)) return "设计";
  if (/explorer|everything|7z|winrar/.test(text)) return "文件";
  if (/steam|game|bilibili|youtube|music|spotify|vlc|potplayer/.test(text)) return "娱乐";
  return "其他";
}

function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function buildStats(entries: ActivityEntry[], typingSamples: TypingSample[], dateStr?: string): ActivityStats {
  const targetDate = dateStr || new Date().toDateString();
  const dayEntries = filterByDate(entries.filter((entry) => entry.durationMs > 1000), targetDate);
  const dayTyping = filterByDate(typingSamples, targetDate);
  const totalActiveMs = dayEntries.reduce((sum, entry) => sum + entry.durationMs, 0);
  const appMap = new Map<string, AppUsage>();
  const categoryMap = new Map<string, AppUsage>();
  const hourMap = new Map<number, number>();

  for (const entry of dayEntries) {
    const name = appName(entry.processName);
    const category = categoryFor(entry.processName, entry.title);
    const current = appMap.get(name) || { name, category, durationMs: 0, sessions: 0, percent: 0 };
    current.durationMs += entry.durationMs;
    current.sessions += 1;
    appMap.set(name, current);

    const categoryUsage = categoryMap.get(category) || { name: category, category, durationMs: 0, sessions: 0, percent: 0 };
    categoryUsage.durationMs += entry.durationMs;
    categoryUsage.sessions += 1;
    categoryMap.set(category, categoryUsage);

    const hour = new Date(entry.startedAt).getHours();
    hourMap.set(hour, (hourMap.get(hour) || 0) + entry.durationMs);
  }

  const withPercent = (items: AppUsage[]) =>
    items
      .map((item) => ({ ...item, percent: totalActiveMs > 0 ? Math.round((item.durationMs / totalActiveMs) * 100) : 0 }))
      .sort((a, b) => b.durationMs - a.durationMs);

  const chars = dayTyping.reduce((sum, item) => sum + item.chars, 0);
  const sourceMap = new Map<TypingSample["source"], { chars: number; messages: number }>();
  const typingByHour = new Map<number, number>();
  for (const sample of dayTyping) {
    const source = sourceMap.get(sample.source) || { chars: 0, messages: 0 };
    source.chars += sample.chars;
    source.messages += 1;
    sourceMap.set(sample.source, source);

    const hour = new Date(sample.timestamp).getHours();
    typingByHour.set(hour, (typingByHour.get(hour) || 0) + sample.chars);
  }
  const peakTyping = [...typingByHour.entries()].sort((a, b) => b[1] - a[1])[0];
  const longestFocusMs = dayEntries.reduce((max, entry) => Math.max(max, entry.durationMs), 0);
  const switchCount = Math.max(0, dayEntries.length - 1);
  const focusScore = totalActiveMs === 0 ? 0 : Math.max(0, Math.min(100, Math.round(100 - switchCount * 1.8 + longestFocusMs / 60000)));

  return {
    totalActiveMs,
    switchCount,
    longestFocusMs,
    focusScore,
    topApps: withPercent([...appMap.values()]).slice(0, 8),
    categories: withPercent([...categoryMap.values()]).slice(0, 6),
    activeHours: [...hourMap.entries()].map(([hour, durationMs]) => ({ hour, durationMs })).sort((a, b) => a.hour - b.hour),
    typing: {
      chars,
      messages: dayTyping.length,
      avgChars: dayTyping.length ? Math.round(chars / dayTyping.length) : 0,
      peakHour: peakTyping?.[0],
      bySource: [...sourceMap.entries()]
        .map(([source, value]) => ({ source, ...value }))
        .sort((a, b) => b.chars - a.chars),
    },
  };
}

function behaviorLabel(stats: ActivityStats) {
  const topCategory = stats.categories[0]?.name || "未知";
  if (stats.totalActiveMs < 10 * 60_000) return "今天记录还少，暂时不下结论。";
  if (stats.focusScore > 78 && stats.longestFocusMs > 45 * 60_000) return `偏专注型：你今天在「${topCategory}」上有较长连续投入。`;
  if (stats.switchCount > 35) return `高切换型：你今天窗口切换较多，可能在多任务处理，也可能被打断比较多。`;
  if (stats.typing.chars > 1200) return "输出型：你今天文字输入量比较高，适合做总结和沉淀。";
  return `均衡型：主要时间花在「${topCategory}」，切换和输入都比较适中。`;
}

function summarize(stats: ActivityStats) {
  if (stats.totalActiveMs === 0 && stats.typing.chars === 0) {
    return "## 今日电脑活动分析\n\n今天还没有足够的活动记录（可能刚开启不久，或电脑一直处于锁屏 / 离开状态）。";
  }

  const topApps = stats.topApps.length
    ? stats.topApps.map((item, index) => `${index + 1}. **${item.name}**：${formatDuration(item.durationMs)}（${item.percent}%）`).join("\n")
    : "暂无应用排行";
  const categories = stats.categories.length
    ? stats.categories.map((item) => `- ${item.name}：${formatDuration(item.durationMs)}（${item.percent}%）`).join("\n")
    : "- 暂无分类";

  return [
    "## 今日电脑活动分析",
    "",
    `- 总活跃时长：${formatDuration(stats.totalActiveMs)}`,
    `- 窗口切换：${stats.switchCount} 次`,
    `- 最长连续专注：${formatDuration(stats.longestFocusMs)}`,
    `- 专注评分：${stats.focusScore}/100`,
    "",
    "### 软件使用排行",
    topApps,
    "",
    "### 类型分布",
    categories,
    "",
    "### 输入统计",
    `- 已统计输入字符：${stats.typing.chars} 个`,
    `- 输入消息数：${stats.typing.messages} 条`,
    `- 平均每条：${stats.typing.avgChars} 字`,
    stats.typing.peakHour !== undefined ? `- 输入高峰：${stats.typing.peakHour}:00` : "- 输入高峰：暂无",
    stats.typing.bySource.length
      ? `- 来源分布：${stats.typing.bySource.map((item) => `${item.source} ${item.chars} 字`).join("、")}`
      : "- 来源分布：暂无",
    "",
    `### 行为画像\n${behaviorLabel(stats)}`,
    "",
    stats.focusScore < 45
      ? "> 建议：今天切换偏多，可以选一个任务专注 25 分钟。"
      : "> 建议：保持现在节奏，结束前做一次简短复盘。",
  ].join("\n");
}

function summarizeCompact(stats: ActivityStats) {
  if (stats.totalActiveMs === 0 && stats.typing.chars === 0) {
    return "今天暂无足够活动记录";
  }

  const topApps = stats.topApps.slice(0, 3).map((item) => item.name).join("、") || "暂无";
  const topCategory = stats.categories[0]?.name || "未知";
  const typingSources = stats.typing.bySource
    .slice(0, 2)
    .map((item) => `${item.source} ${item.chars} 字`)
    .join("、");

  return [
    `总活跃时长 ${formatDuration(stats.totalActiveMs)}`,
    `专注评分 ${stats.focusScore}/100`,
    `主要软件 ${topApps}`,
    `主类目 ${topCategory}`,
    `输入 ${stats.typing.chars} 字${stats.typing.messages ? ` / ${stats.typing.messages} 条` : ""}`,
    typingSources ? `来源 ${typingSources}` : "",
    behaviorLabel(stats),
  ]
    .filter(Boolean)
    .join("；");
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  enabled: loadEnabled(),
  entries: readJson<ActivityEntry[]>(ENTRIES_KEY, []),
  typingSamples: readJson<TypingSample[]>(TYPING_KEY, []),
  current: undefined,

  setEnabled: (enabled) => {
    localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
    set({ enabled });
    void applyTimelineConfig();
  },

  recordWindow: (info) => {
    if (!info.title && !info.processName) return;
    // 锁屏界面不是在用软件：结束当前计时，不把锁屏时间算成 LockApp 的使用时长
    if (/^(lockapp|logonui)\.exe$/i.test(info.processName)) {
      const current = get().current;
      if (!current) return;
      const closed = {
        ...current,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(current.startedAt).getTime(),
      };
      const entries = [...get().entries, closed].slice(-MAX_ENTRIES);
      saveEntries(entries);
      set({ entries, current: undefined });
      return;
    }
    const state = get();
    const current = state.current;
    const same = current && current.title === info.title && current.processName === info.processName;
    const now = Date.now();

    if (same) {
      const updatedCurrent = { ...current, durationMs: now - new Date(current.startedAt).getTime() };
      set({ current: updatedCurrent });
      return;
    }

    const closedCurrent = current
      ? { ...current, endedAt: new Date().toISOString(), durationMs: now - new Date(current.startedAt).getTime() }
      : undefined;
    const next: ActivityEntry = {
      id: `act_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: info.title,
      processName: info.processName,
      startedAt: new Date().toISOString(),
      durationMs: 0,
    };
    const entries = closedCurrent ? [...state.entries, closedCurrent].slice(-MAX_ENTRIES) : state.entries;
    saveEntries(entries);
    set({ current: next, entries });
  },

  recordTyping: (chars, source = "other") => {
    const safeChars = Math.max(0, Math.min(20000, Math.round(chars)));
    if (safeChars <= 0) return;
    const typingSamples = [
      ...get().typingSamples,
      {
        id: `type_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        source,
        chars: safeChars,
        timestamp: new Date().toISOString(),
      },
    ].slice(-MAX_TYPING);
    saveTyping(typingSamples);
    set({ typingSamples });
  },

  getStats: (dateStr?: string) => {
    const state = get();
    return buildStats(state.current ? [...state.entries, state.current] : state.entries, state.typingSamples, dateStr);
  },

  getCompactSummary: (dateStr?: string) => summarizeCompact(get().getStats(dateStr)),

  getSummary: (dateStr?: string) => summarize(get().getStats(dateStr)),

  getBehaviorReport: (dateStr?: string) => summarize(get().getStats(dateStr)),

  clear: () => {
    localStorage.removeItem(ENTRIES_KEY);
    localStorage.removeItem(TYPING_KEY);
    set({ entries: [], typingSamples: [], current: undefined });
    // 时间线（窗口 / 文件 / 剪贴板）一起清掉
    void clearTimeline().catch(() => {});
  },

  syncFromStorage: (key) => {
    if (key === null || key === ENABLED_KEY) {
      const enabled = loadEnabled();
      // 关闭观察时丢弃正在计时的条目，避免关闭后还继续记录。
      set(enabled ? { enabled } : { enabled, current: undefined });
    }
    if (key === null || key === ENTRIES_KEY) {
      const entries = readJson<ActivityEntry[]>(ENTRIES_KEY, []);
      // 记录被另一个窗口清空时，正在计时的条目也一起作废。
      set(entries.length === 0 ? { entries, current: undefined } : { entries });
    }
    if (key === null || key === TYPING_KEY) {
      set({ typingSamples: readJson<TypingSample[]>(TYPING_KEY, []) });
    }
  },
}));

export function useActivityMonitor(onInsight?: (summary: string) => void) {
  const enabled = useActivityStore((state) => state.enabled);
  const recordWindow = useActivityStore((state) => state.recordWindow);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;

    const tick = async () => {
      try {
        const raw = await invoke("get_active_window_info");
        if (disposed) return;
        recordWindow(normalizeInfo(raw));
      } catch {
        // Unsupported platform or permission issue.
      }
    };

    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [enabled, recordWindow]);
}

/**
 * Check if yesterday's activity summary has already been delivered today.
 * If not, generate and deliver it, then mark as done.
 */
export function checkAndDeliverYesterdaySummary(
  getSummary: (dateStr?: string) => string,
  addMessage: (msg: { role: "user" | "assistant" | "system"; content: string }) => void,
  speak: (message: string, duration?: number) => void
) {
  const todayKey = `paw_yesterday_summary_${new Date().toDateString()}`;
  if (localStorage.getItem(todayKey)) return;

  const store = useActivityStore.getState();
  if (!store.enabled) return;

  // Check if there are entries from yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();
  const hasYesterdayData = store.entries.some(
    (entry) => new Date(entry.startedAt).toDateString() === yesterdayStr
  );

  if (!hasYesterdayData) return;

  // Generate summary for yesterday's data
  const stats = store.getStats(yesterdayStr);
  if (stats.totalActiveMs === 0 && stats.typing.chars === 0) return;
  const summary = getSummary(yesterdayStr);
  if (!summary) return;

  addMessage({ role: "assistant", content: summary.replace("## 今日电脑活动分析", "## 昨日电脑活动回顾") });
  speak("我整理了一下你昨天的电脑活动，已经放到聊天里了。", 5200);
  localStorage.setItem(todayKey, "1");
}
