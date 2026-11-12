import { useEffect } from "react";
import { useBotStore } from "../store/bots";
import { useChatStore } from "../store/chat";
import { personalityStore } from "./personality";
import { usePetStore } from "../store/pet";
import { DEFAULT_BOT_ID } from "./scope";

/**
 * 切换 Bot 后把会话与用户画像重新指向该 Bot 的分区。
 * 记忆库名由 scopeKey 动态决定，每次 open 时自动落到对应库，无需显式重载。
 * 放在 App 顶层，保证团队页、设置页、聊天页切换时都会生效。
 */
export function useBotScopeSync() {
  const activeBotId = useBotStore((state) => state.activeBotId);

  useEffect(() => {
    useChatStore.getState().hydrateForBot();
    personalityStore.reloadForActiveBot();
  }, [activeBotId]);

  // 默认 Bot 就是桌宠本身：名字跟着桌宠走（设置里改了桌宠名，聊天、确认卡片上也跟着变）。
  // 用户在团队里给默认 Bot 另起过名字的，不覆盖。
  const petName = usePetStore((state) => state.name);
  useEffect(() => {
    const name = petName.trim();
    if (!name) return;
    const bot = useBotStore.getState().bots.find((item) => item.id === DEFAULT_BOT_ID);
    const previous = lastPetName.current;
    lastPetName.current = name;
    if (!bot || bot.name === name) return;
    if (bot.name === "皮卡丘" || bot.name === previous) useBotStore.getState().updateBot(DEFAULT_BOT_ID, { name });
  }, [petName]);
}

const lastPetName = { current: "" };
