import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type AppTheme = "cozy" | "pixel" | "neon" | "clean";

export const THEME_OPTIONS: Array<{
  id: AppTheme;
  label: string;
  description: string;
}> = [
  { id: "cozy", label: "柔和桌宠", description: "更像轻松陪伴型桌宠，暖色、圆角、轻阴影。" },
  { id: "pixel", label: "像素复古", description: "保留游戏机窗口感，但作为可选风格。" },
  { id: "neon", label: "霓虹代理", description: "偏 AI Agent 控制台，深色、高对比、发光线条。" },
  { id: "clean", label: "清爽助手", description: "更像专业桌面助手，浅色、克制、信息清楚。" },
];

interface ThemeState {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  syncTheme: (theme: AppTheme) => void;
}

const STORAGE_KEY = "paw_ui_theme";

function isTheme(value: unknown): value is AppTheme {
  return value === "cozy" || value === "pixel" || value === "neon" || value === "clean";
}

function loadTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch {}
  return "cozy";
}

function saveTheme(theme: AppTheme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {}
}

export function getThemeClass(theme: AppTheme) {
  return `themed-ui theme-${theme}${theme === "pixel" ? " pixel-ui" : ""}`;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: loadTheme(),
  setTheme: (theme) => {
    saveTheme(theme);
    set({ theme });
    try {
      emit("theme-changed", { theme });
    } catch {
      // Browser dev fallback.
    }
  },
  syncTheme: (theme) => {
    saveTheme(theme);
    set({ theme });
  },
}));

export function useThemeClass() {
  const theme = useThemeStore((state) => state.theme);
  const syncTheme = useThemeStore((state) => state.syncTheme);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && isTheme(event.newValue)) {
        syncTheme(event.newValue);
      }
    };

    window.addEventListener("storage", onStorage);
    let unlisten: (() => void) | undefined;
    listen<{ theme?: unknown }>("theme-changed", (event) => {
      if (isTheme(event.payload?.theme)) syncTheme(event.payload.theme);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      window.removeEventListener("storage", onStorage);
      unlisten?.();
    };
  }, [syncTheme]);

  return getThemeClass(theme);
}
