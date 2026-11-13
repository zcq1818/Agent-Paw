import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { create } from "zustand";

/**
 * 全局快捷键：在任何软件里按下就能叫出桌宠。
 *
 * 只在宠物窗口注册（它一直在后台跑）；设置页在工作台窗口，改完写 localStorage，
 * 宠物窗口收到 storage 事件后重新注册，并把每个热键是否注册成功写回 HOTKEY_STATUS_KEY 给设置页显示。
 * 录制新热键时设置页会发 hotkeys-pause，暂时注销全部热键，免得按下旧组合时触发动作。
 */

export type HotkeyAction = "workbench" | "chat" | "clipboard" | "screen" | "pet" | "stop";

export const HOTKEY_ACTIONS: Array<{ id: HotkeyAction; label: string; description: string; suggestion: string }> = [
  { id: "chat", label: "和桌宠聊天", description: "弹出桌宠的聊天框，光标直接在输入框里。", suggestion: "Alt+Shift+C" },
  {
    id: "clipboard",
    label: "处理刚复制的内容",
    description: "先 Ctrl+C 复制，再按它：报错帮你分析、外文帮你翻译、长文帮你总结。",
    suggestion: "Alt+Shift+V",
  },
  { id: "screen", label: "看看我的屏幕", description: "截屏发给桌宠，说说屏幕上是什么、有什么要注意。", suggestion: "Alt+Shift+S" },
  { id: "workbench", label: "显示 / 隐藏工作台", description: "打开或收起完整的工作台窗口。", suggestion: "CommandOrControl+Shift+P" },
  { id: "pet", label: "显示 / 隐藏桌宠", description: "临时把桌宠藏起来，再按一次出现。", suggestion: "Alt+Shift+H" },
  { id: "stop", label: "停止当前任务", description: "桌宠正在干活时立刻停下。", suggestion: "Alt+Shift+X" },
];

export const HOTKEYS_KEY = "paw_hotkeys";
export const HOTKEY_STATUS_KEY = "paw_hotkey_status";
/** 旧版只有“工作台”一个热键，存在这里；读取时迁移过来。 */
const LEGACY_CHAT_HOTKEY_KEY = "paw_chat_hotkey";

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  workbench: "CommandOrControl+Shift+P",
  chat: "Alt+Shift+C",
  clipboard: "Alt+Shift+V",
  screen: "",
  pet: "",
  stop: "",
};

/** 宠物窗口里各个动作的执行入口：Pet 组件挂载后填上需要界面配合的那几个。 */
export const HOTKEY_EVENT = "paw-hotkey";

export function normalizeHotkey(value: string) {
  return value
    .trim()
    .replace(/\s+/g, "")
    .replace(/\bCtrl\b/gi, "CommandOrControl")
    .replace(/CmdOrCtrl/gi, "CommandOrControl")
    .replace(/Command\+Control/gi, "CommandOrControl");
}

/** 给人看的写法：CommandOrControl+Shift+P → Ctrl + Shift + P */
export function displayHotkey(value: string) {
  if (!value) return "";
  return value
    .split("+")
    .map((part) => (part === "CommandOrControl" ? "Ctrl" : part === "Super" ? "Win" : part))
    .join(" + ");
}

function loadHotkeys(): Record<HotkeyAction, string> {
  let saved: Partial<Record<HotkeyAction, string>> = {};
  try {
    saved = JSON.parse(localStorage.getItem(HOTKEYS_KEY) || "{}") || {};
  } catch {}
  const legacy = localStorage.getItem(LEGACY_CHAT_HOTKEY_KEY);
  const merged = { ...DEFAULT_HOTKEYS, ...saved };
  if (legacy && saved.workbench === undefined) merged.workbench = legacy;
  return merged;
}

function loadStatus(): Partial<Record<HotkeyAction, string>> {
  try {
    return JSON.parse(localStorage.getItem(HOTKEY_STATUS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

interface ShortcutState {
  hotkeys: Record<HotkeyAction, string>;
  /** 每个热键的注册结果："ok" 或失败原因 */
  status: Partial<Record<HotkeyAction, string>>;
  setHotkey: (action: HotkeyAction, shortcut: string) => void;
  resetHotkeys: () => void;
  syncFromStorage: () => void;
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  hotkeys: loadHotkeys(),
  status: loadStatus(),
  setHotkey: (action, shortcut) => {
    const hotkeys = { ...get().hotkeys, [action]: normalizeHotkey(shortcut) };
    localStorage.setItem(HOTKEYS_KEY, JSON.stringify(hotkeys));
    set({ hotkeys });
  },
  resetHotkeys: () => {
    localStorage.setItem(HOTKEYS_KEY, JSON.stringify(DEFAULT_HOTKEYS));
    set({ hotkeys: { ...DEFAULT_HOTKEYS } });
  },
  syncFromStorage: () => set({ hotkeys: loadHotkeys(), status: loadStatus() }),
}));

async function showPetWindow() {
  const pet = getCurrentWindow();
  if (!(await pet.isVisible())) await pet.show();
  await pet.setFocus();
}

async function runAction(action: HotkeyAction) {
  if (action === "workbench") {
    await invoke("toggle_main_window");
    return;
  }
  if (action === "pet") {
    const pet = getCurrentWindow();
    if (await pet.isVisible()) await pet.hide();
    else await showPetWindow();
    return;
  }
  // 其余动作要宠物界面配合（打开聊天框、发消息、停止），交给 Pet 组件
  if (action !== "stop") await showPetWindow();
  window.dispatchEvent(new CustomEvent(HOTKEY_EVENT, { detail: action }));
}

function describeError(error: unknown) {
  const text = String(error instanceof Error ? error.message : error);
  if (/already|registered|in use|HotKey/i.test(text)) return "被别的软件占用了，换一个组合";
  if (/parse|invalid|unknown/i.test(text)) return "这个组合无法识别";
  return text.slice(0, 80);
}

// 注册 / 注销都是异步的，全局排队执行，免得前后两次注册交错导致“已被占用”
let chain: Promise<void> = Promise.resolve();
function queue(task: () => Promise<void>) {
  chain = chain.then(task).catch(() => {});
}

/** 宠物窗口里调用：按设置注册全部热键，设置变了就重新注册。 */
export function useChatHotkeyRegistration(enabled: boolean) {
  const hotkeys = useShortcutStore((state) => state.hotkeys);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let paused = false;
    let registered: string[] = [];

    const unregisterAll = async () => {
      const current = registered;
      registered = [];
      await Promise.all(current.map((shortcut) => unregister(shortcut).catch(() => {})));
    };

    const registerAll = async () => {
      await unregisterAll();
      const status: Partial<Record<HotkeyAction, string>> = {};
      const used = new Map<string, HotkeyAction>();
      for (const { id } of HOTKEY_ACTIONS) {
        const shortcut = normalizeHotkey(hotkeys[id] || "");
        if (!shortcut) continue;
        if (used.has(shortcut)) {
          status[id] = "和另一个快捷键重复了";
          continue;
        }
        used.set(shortcut, id);
        try {
          await register(shortcut, (event) => {
            // 按下和松开都会回调，只在按下时执行，否则会开了又关
            if (event.state !== "Pressed") return;
            runAction(id).catch((error) => console.warn("hotkey action failed", id, error));
          });
          registered.push(shortcut);
          status[id] = "ok";
        } catch (error) {
          status[id] = describeError(error);
        }
        if (disposed) break;
      }
      localStorage.setItem(HOTKEY_STATUS_KEY, JSON.stringify(status));
      useShortcutStore.setState({ status });
      emit("hotkeys-status", status).catch(() => {});
    };

    queue(registerAll);

    let unlistenPause: (() => void) | undefined;
    listen<boolean>("hotkeys-pause", (event) => {
      const pause = Boolean(event.payload);
      if (pause === paused) return;
      paused = pause;
      queue(pause ? unregisterAll : registerAll);
    })
      .then((fn) => (disposed ? fn() : (unlistenPause = fn)))
      .catch(() => {});

    return () => {
      disposed = true;
      unlistenPause?.();
      queue(unregisterAll);
    };
  }, [enabled, hotkeys]);
}

/** 设置页：注册结果更新时跟着刷新（宠物窗口发事件，storage 事件兜底）。 */
export function useHotkeyStatusSync() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<Partial<Record<HotkeyAction, string>>>("hotkeys-status", (event) => {
      useShortcutStore.setState({ status: event.payload || {} });
    })
      .then((fn) => (disposed ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

export function pauseHotkeys(pause: boolean) {
  emit("hotkeys-pause", pause).catch(() => {});
}
