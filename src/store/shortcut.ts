import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { create } from "zustand";

const CHAT_HOTKEY_KEY = "paw_chat_hotkey";
export const DEFAULT_CHAT_HOTKEY = "CommandOrControl+Shift+P";

interface ShortcutState {
  chatHotkey: string;
  setChatHotkey: (shortcut: string) => void;
}

function loadChatHotkey() {
  return localStorage.getItem(CHAT_HOTKEY_KEY) || DEFAULT_CHAT_HOTKEY;
}

export function normalizeHotkey(value: string) {
  return value
    .trim()
    .replace(/\s+/g, "")
    .replace(/Ctrl/gi, "CommandOrControl")
    .replace(/CmdOrCtrl/gi, "CommandOrControl")
    .replace(/Command\+Control/gi, "CommandOrControl");
}

export const useShortcutStore = create<ShortcutState>((set) => ({
  chatHotkey: loadChatHotkey(),
  setChatHotkey: (shortcut) => {
    const normalized = normalizeHotkey(shortcut) || DEFAULT_CHAT_HOTKEY;
    localStorage.setItem(CHAT_HOTKEY_KEY, normalized);
    set({ chatHotkey: normalized });
  },
}));

export function useChatHotkeyRegistration(enabled: boolean) {
  const chatHotkey = useShortcutStore((state) => state.chatHotkey);
  const registeredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const shortcut = normalizeHotkey(chatHotkey);

    async function setup() {
      try {
        if (registeredRef.current && registeredRef.current !== shortcut) {
          await unregister(registeredRef.current);
          registeredRef.current = null;
        }

        if (!shortcut) return;
        const alreadyRegistered = await isRegistered(shortcut);
        if (!alreadyRegistered) {
          await register(shortcut, async () => {
            try {
              await invoke("toggle_main_window");
            } catch {
              // Browser dev fallback.
            }
          });
        }
        if (!disposed) registeredRef.current = shortcut;
      } catch (error) {
        console.warn("Global chat shortcut registration failed:", error);
      }
    }

    setup();

    return () => {
      disposed = true;
      const current = registeredRef.current;
      if (current) {
        unregister(current).catch(() => {});
        registeredRef.current = null;
      }
    };
  }, [chatHotkey, enabled]);
}
