/** @ 提及解析：纯逻辑、零依赖，方便单独测试。 */

export interface MentionableBot {
  id: string;
  name: string;
}

const ALL_ALIASES = new Set(["all", "全体", "全部", "everyone"]);

/** 没有 @ 时默认派给全体成员；@all / @全体 同理；@名字 只指派命中的 Bot。 */
export function resolveTargets<T extends MentionableBot>(
  text: string,
  memberBots: T[],
  defaultToAll = true
): T[] {
  const mentions: string[] = [];
  const pattern = /@([^\s@,，。!！?？:：]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) mentions.push(match[1]);

  if (mentions.some((name) => ALL_ALIASES.has(name.toLowerCase()))) return memberBots;

  const named = memberBots.filter((bot) =>
    mentions.some((name) => name === bot.name || name.toLowerCase() === bot.name.toLowerCase())
  );
  if (named.length > 0) return named;
  return defaultToAll ? memberBots : [];
}

/** 抽出真正被 @ 命中的 bot id（不含「无 @ 默认全体」）。 */
export function mentionIds<T extends MentionableBot>(text: string, memberBots: T[]): string[] {
  return resolveTargets(text, memberBots, false).map((bot) => bot.id);
}
