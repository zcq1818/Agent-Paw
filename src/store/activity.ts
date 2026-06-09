import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

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

interface ActivityState {
  enabled: boolean;
  entries: ActivityEntry[];
  current?: ActivityEntry;
  setEnabled: (enabled: boolean) => void;
  recordWindow: (info: ActiveWindowInfo) => void;
  getSummary: () => string;
  clear: () => void;
}

const ENABLED_KEY = "paw_activity_enabled";
const ENTRIES_KEY = "paw_activity_entries";
const MAX_ENTRIES = 240;

function loadEnabled() {
  return localStorage.getItem(ENABLED_KEY) === "1";
}

function loadEntries(): ActivityEntry[] {
  try {
    const saved = localStorage.getItem(ENTRIES_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function saveEntries(entries: ActivityEntry[]) {
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
}

function normalizeInfo(raw: any): ActiveWindowInfo {
  return {
    title: raw?.title || "",
    processPath: raw?.process_path || raw?.processPath || "",
    processName: raw?.process_name || raw?.processName || "",
  };
}

function summarize(entries: ActivityEntry[]) {
  const today = new Date().toDateString();
  const todayEntries = entries.filter((entry) => new Date(entry.startedAt).toDateString() === today);
  const totals = new Map<string, number>();
  for (const entry of todayEntries) {
    const key = entry.processName || "未知应用";
    totals.set(key, (totals.get(key) || 0) + entry.durationMs);
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) return "今天还没有足够活动记录。";
  return [
    "## 今日电脑活动分析",
    "",
    ...top.map(([name, ms], index) => `${index + 1}. **${name}**：${Math.round(ms / 60000)} 分钟`),
    "",
    top[0][1] > 50 * 60_000 ? `> 你在 ${top[0][0]} 上连续投入较久，可以考虑休息或总结一下当前任务。` : "> 当前活动节奏比较分散，我会继续观察并帮你整理。",
  ].join("\n");
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  enabled: loadEnabled(),
  entries: loadEntries(),
  current: undefined,

  setEnabled: (enabled) => {
    localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
    set({ enabled });
  },

  recordWindow: (info) => {
    if (!info.title && !info.processName) return;
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

  getSummary: () => {
    const state = get();
    return summarize(state.current ? [...state.entries, state.current] : state.entries);
  },

  clear: () => {
    localStorage.removeItem(ENTRIES_KEY);
    set({ entries: [], current: undefined });
  },
}));

export function useActivityMonitor(onInsight?: (summary: string) => void) {
  const enabled = useActivityStore((state) => state.enabled);
  const recordWindow = useActivityStore((state) => state.recordWindow);
  const getSummary = useActivityStore((state) => state.getSummary);
  const lastInsightRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;

    const tick = async () => {
      try {
        const raw = await invoke("get_active_window_info");
        if (disposed) return;
        recordWindow(normalizeInfo(raw));

        const now = Date.now();
        if (onInsight && now - lastInsightRef.current > 45 * 60_000) {
          lastInsightRef.current = now;
          onInsight(getSummary());
        }
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
  }, [enabled, getSummary, onInsight, recordWindow]);
}
