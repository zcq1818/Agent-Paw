import { useEffect } from "react";
import { useBotStore } from "../store/bots";
import { useChatStore } from "../store/chat";
import { personalityStore } from "./personality";

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
}
