import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type AppTheme = "light" | "dark" | "system";

export const THEME_OPTIONS: Array<{
  id: AppTheme;
  label: string;
  description: string;
}> = [
  { id: "light", label: "浅色", description: "白底深色文字，信息清楚。" },
  { id: "dark", label: "深色", description: "深蓝底色，夜间更护眼。" },
  { id: "system", label: "跟随系统", description: "随 Windows 的浅色 / 深色模式切换。" },
];

interface ThemeState {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  syncTheme: (theme: AppTheme) => void;
}

const STORAGE_KEY = "paw_ui_theme";

function isTheme(value: unknown): value is AppTheme {
  return value === "light" || value === "dark" || value === "system";
}

/** 旧版的四种风格迁移到新主题：霓虹 / 像素是深色系，其余用浅色。 */
function migrateLegacyTheme(value: string | null): AppTheme | null {
  if (value === "neon" || value === "pixel") return "dark";
  if (value === "clean" || value === "cozy") return "light";
  return null;
}

function loadTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
    const migrated = migrateLegacyTheme(saved);
    if (migrated) {
      localStorage.setItem(STORAGE_KEY, migrated);
      return migrated;
    }
  } catch {}
  return "light";
}

function saveTheme(theme: AppTheme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {}
}

export function getThemeClass(theme: AppTheme) {
  return `themed-ui theme-${theme}`;
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
    // listen() 是异步注册：cleanup 先于注册完成时，要在注册完成后立刻注销，避免重复监听。
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<{ theme?: unknown }>("theme-changed", (event) => {
      if (isTheme(event.payload?.theme)) syncTheme(event.payload.theme);
    })
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
  }, [syncTheme]);

  return getThemeClass(theme);
}
