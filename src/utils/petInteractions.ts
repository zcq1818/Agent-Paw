export type InteractionType = "greeting" | "reminder" | "news" | "joke" | "tip";

export interface Interaction {
  type: InteractionType;
  message: string;
  emoji: string;
}

const MORNING_GREETINGS: Interaction[] = [
  { type: "greeting", message: "早上好，今天也一起稳稳推进。", emoji: "☀️" },
  { type: "greeting", message: "皮卡皮卡，起床啦。我已经在桌面待命。", emoji: "⚡" },
  { type: "greeting", message: "先喝口水，再开始今天的第一件事。", emoji: "💧" },
  { type: "greeting", message: "早安，我会在旁边陪你开工。", emoji: "🙂" },
];

const AFTERNOON_GREETINGS: Interaction[] = [
  { type: "greeting", message: "下午好，眼睛累了可以看一会儿远处。", emoji: "🌤️" },
  { type: "greeting", message: "工作辛苦啦，记得补水。", emoji: "💧" },
  { type: "greeting", message: "我在桌面巡逻，有事叫我就行。", emoji: "⚡" },
];

const EVENING_GREETINGS: Interaction[] = [
  { type: "greeting", message: "晚上好，今天过得怎么样？", emoji: "🌙" },
  { type: "greeting", message: "辛苦一天了，可以慢慢收尾。", emoji: "✨" },
  { type: "greeting", message: "夜间陪伴模式启动，我会安静一点。", emoji: "⭐" },
];

const REMINDERS: Interaction[] = [
  { type: "reminder", message: "记得喝水，身体状态也需要充电。", emoji: "💧" },
  { type: "reminder", message: "坐久了，起来活动一下吧。", emoji: "🧘" },
  { type: "reminder", message: "眼睛累了吗？看看远处休息一下。", emoji: "👀" },
  { type: "reminder", message: "别忘了检查今天的待办事项。", emoji: "📋" },
  { type: "reminder", message: "可以伸个懒腰，再继续。", emoji: "⏱️" },
];

const JOKES: Interaction[] = [
  { type: "joke", message: "我今天电量满格，适合帮你处理大任务。", emoji: "⚡" },
  { type: "joke", message: "皮卡皮卡，翻译一下就是：今天也要元气满满。", emoji: "😄" },
  { type: "joke", message: "桌面有我守着，灵感一般不会迷路。", emoji: "💡" },
  { type: "joke", message: "我刚巡逻了一圈，发现你的任务还挺会排队。", emoji: "🧭" },
];

const TIPS: Interaction[] = [
  { type: "tip", message: "小建议：把桌面整理干净，思路会轻一点。", emoji: "✨" },
  { type: "tip", message: "推荐每工作一小时休息五分钟。", emoji: "⏱️" },
  { type: "tip", message: "深呼吸几次，注意力会重新回来。", emoji: "🧘" },
  { type: "tip", message: "任务太大时，可以先拆成一个 10 分钟能完成的小动作。", emoji: "📌" },
];

const NEWS: Interaction[] = [
  { type: "news", message: "今日公告：你已经很棒了，继续稳稳推进。", emoji: "📣" },
  { type: "news", message: "桌面观察报告：适合保持轻松但专注。", emoji: "🔎" },
  { type: "news", message: "系统提示：皮卡丘已就位。", emoji: "📡" },
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function getTimeBasedGreeting(): Interaction {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return pick(MORNING_GREETINGS);
  if (hour >= 12 && hour < 18) return pick(AFTERNOON_GREETINGS);
  return pick(EVENING_GREETINGS);
}

export function getRandomInteraction(): Interaction {
  return pick([...REMINDERS, ...JOKES, ...TIPS, ...NEWS]);
}

export function getInteractionByType(type: InteractionType): Interaction {
  const pools: Record<InteractionType, Interaction[]> = {
    greeting: [...MORNING_GREETINGS, ...AFTERNOON_GREETINGS, ...EVENING_GREETINGS],
    reminder: REMINDERS,
    news: NEWS,
    joke: JOKES,
    tip: TIPS,
  };

  return pick(pools[type]);
}
