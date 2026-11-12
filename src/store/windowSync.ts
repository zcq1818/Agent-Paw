import { useEffect } from "react";
import { chatStorageKeys, useChatStore } from "./chat";
import { ACTIVITY_STORAGE_KEYS, useActivityStore } from "./activity";
import { PET_CONFIG_KEY, usePetStore } from "./pet";
import { CHAT_HOTKEY_KEY, useShortcutStore } from "./shortcut";

/**
 * 宠物窗口和工作台窗口是两个独立的 WebView，各自有一份 zustand 状态，
 * 但共用同一个 localStorage。一个窗口写入后，另一个窗口收到 storage 事件再重新载入，
 * 否则：两边的聊天记录互相覆盖、设置页改的宠物配置/热键要重启才生效、
 * 关闭“活动观察”后宠物窗口仍在记录。
 *
 * storage 事件只会发给“其他”窗口，所以不会自己触发自己。
 */
export function useCrossWindowSync() {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const key = event.key;
      // key 为 null 表示 localStorage.clear()，全部重载。
      if (key === null || chatStorageKeys().includes(key)) {
        useChatStore.getState().syncFromStorage();
      }
      if (key === null || ACTIVITY_STORAGE_KEYS.includes(key)) {
        useActivityStore.getState().syncFromStorage(key);
      }
      if (key === null || key === PET_CONFIG_KEY) {
        usePetStore.getState().syncFromStorage();
      }
      if (key === null || key === CHAT_HOTKEY_KEY) {
        useShortcutStore.getState().syncFromStorage();
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}
