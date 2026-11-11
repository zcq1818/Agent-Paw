/**
 * Bot 作用域：把本地存储按当前 Bot 分区。
 *
 * 关键约束：默认 Bot 永远使用「原始 key」，所以升级前已有的对话、
 * 画像与记忆库原样保留；只有新建的 Bot 才写到带后缀的独立分区。
 * 本模块不 import 任何项目模块，避免与 tools.ts → bots.ts 形成循环依赖。
 */

export const DEFAULT_BOT_ID = "bot_default_paw";
export const ACTIVE_BOT_KEY = "paw_active_bot_v1";

export function getActiveBotId(): string {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_BOT_ID;
    return localStorage.getItem(ACTIVE_BOT_KEY) || DEFAULT_BOT_ID;
  } catch {
    return DEFAULT_BOT_ID;
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 默认 Bot 返回原名，其他 Bot 返回带后缀的独立 key / 数据库名。 */
export function scopeKey(base: string): string {
  const id = getActiveBotId();
  return id === DEFAULT_BOT_ID ? base : `${base}__${safeId(id)}`;
}

export function isDefaultBot(): boolean {
  return getActiveBotId() === DEFAULT_BOT_ID;
}
