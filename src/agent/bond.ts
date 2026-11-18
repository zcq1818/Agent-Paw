import { create } from "zustand";
import { dayKey } from "./petLife";

/**
 * 陪伴成长：桌宠和你待在一起就会长大。
 *
 * 经验来源（每天有上限，挂机刷不了太多）：
 * - 陪伴：电脑前有人（5 分钟内动过键盘鼠标）时，每 5 分钟 +2，每天最多 96（4 小时）
 * - 聊天：你每发一条消息 +3，每天最多 60
 * - 互动：摸摸、喂食、陪玩、训练 +1～2，每天最多 20
 * - 专注：每专注 1 分钟 +1，不封顶
 * - 签到：每天第一次见面 +10，连续天数每天再 +2（最多 +20）
 *
 * 等级 1～30，升一级需要的经验逐级增加；普通使用一天大约 120～180 经验。
 * 只在桌宠窗口里写（其他窗口发事件过来），避免两个窗口同时写把数据覆盖掉。
 */

export type BondSource = "presence" | "chat" | "interact" | "focus" | "signin";

const DAILY_CAP: Record<BondSource, number> = {
  presence: 96,
  chat: 60,
  interact: 20,
  focus: Infinity,
  signin: Infinity,
};

export const SOURCE_LABELS: Record<BondSource, string> = {
  presence: "陪伴",
  chat: "聊天",
  interact: "互动",
  focus: "专注",
  signin: "签到",
};

export const MAX_LEVEL = 30;

const STAGES: Array<{ level: number; title: string }> = [
  { level: 1, title: "刚来的小家伙" },
  { level: 3, title: "熟悉起来了" },
  { level: 5, title: "贴心小伙伴" },
  { level: 8, title: "默契搭子" },
  { level: 11, title: "得力助手" },
  { level: 15, title: "老朋友" },
  { level: 20, title: "灵魂伴侣" },
  { level: 25, title: "传说中的搭子" },
  { level: 30, title: "一生挚友" },
];

/** 专注时长随等级解锁 */
export const FOCUS_UNLOCKS = [
  { minutes: 25, level: 1 },
  { minutes: 45, level: 3 },
  { minutes: 60, level: 5 },
];

/** 从 Lv(n-1) 升到 Lv(n) 需要的经验 */
function stepFor(level: number) {
  return 60 + 40 * (level - 2);
}

/** 到达某一级需要的累计经验 */
export function xpForLevel(level: number) {
  let total = 0;
  for (let n = 2; n <= level; n += 1) total += stepFor(n);
  return total;
}

export function titleOf(level: number) {
  let title = STAGES[0].title;
  for (const stage of STAGES) if (level >= stage.level) title = stage.title;
  return title;
}

export function levelInfo(xp: number) {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level += 1;
  const floor = xpForLevel(level);
  const ceil = level < MAX_LEVEL ? xpForLevel(level + 1) : floor;
  return {
    level,
    title: titleOf(level),
    current: xp - floor,
    needed: ceil - floor,
    progress: level < MAX_LEVEL ? (xp - floor) / (ceil - floor) : 1,
    toNext: Math.max(0, ceil - xp),
  };
}

/** 升到某一级解锁了什么 */
export function unlocksAtLevel(level: number) {
  const items: string[] = [];
  const stage = STAGES.find((item) => item.level === level);
  if (stage) items.push(`称号「${stage.title}」`);
  FOCUS_UNLOCKS.filter((item) => item.level === level).forEach((item) => items.push(`${item.minutes} 分钟专注`));
  return items;
}

interface BondData {
  xp: number;
  /** 第一次见面的日期 */
  since: string;
  /** 一起度过的天数（有互动的天） */
  daysTogether: number;
  /** 连续见面天数 */
  streak: number;
  lastDay: string;
  today: { day: string } & Partial<Record<BondSource, number>>;
  totals: { chats: number; interactions: number; focusMin: number; presenceMin: number };
}

const BOND_KEY = "paw_bond";

function emptyBond(): BondData {
  return {
    xp: 0,
    since: dayKey(),
    daysTogether: 0,
    streak: 0,
    lastDay: "",
    today: { day: dayKey() },
    totals: { chats: 0, interactions: 0, focusMin: 0, presenceMin: 0 },
  };
}

/** 老用户第一次升级到这个版本：按以前的专注时长和聊天条数折算一点经验，不从零开始。 */
function migrate(): BondData {
  const data = emptyBond();
  try {
    const growth = JSON.parse(localStorage.getItem("paw_growth") || "{}");
    const focusMin = Number(growth.totalFocusMin) || 0;
    data.xp += focusMin;
    data.totals.focusMin = focusMin;
  } catch {}
  try {
    let chats = 0;
    let earliest = "";
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || "";
      if (!key.startsWith("paw_conversations")) continue;
      const conversations = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(conversations)) continue;
      for (const conversation of conversations) {
        for (const message of conversation?.messages || []) {
          if (message?.role !== "user") continue;
          chats += 1;
          const day = String(message.createdAt || "").slice(0, 10);
          if (day && (!earliest || day < earliest)) earliest = day;
        }
      }
    }
    data.xp += Math.min(chats * 3, 1500);
    data.totals.chats = chats;
    if (earliest) data.since = earliest;
  } catch {}
  return data;
}

function load(): BondData {
  try {
    const saved = localStorage.getItem(BOND_KEY);
    if (saved) return { ...emptyBond(), ...JSON.parse(saved) };
  } catch {}
  const migrated = migrate();
  save(migrated);
  return migrated;
}

function save(data: BondData) {
  try {
    localStorage.setItem(BOND_KEY, JSON.stringify(data));
  } catch {}
}

export interface GainResult {
  gained: number;
  leveledUp: boolean;
  level: number;
}

interface BondStore extends BondData {
  /** 加经验；返回实际加了多少、是否升级 */
  gain: (source: BondSource, amount?: number) => GainResult;
  /** 每天第一次见面：记天数和连续天数，返回签到该加的经验（由调用方 gain，好统一庆祝升级） */
  checkIn: () => { streak: number; bonus: number } | null;
  /** 别的窗口改了数据，重新读 */
  reload: () => void;
}

const DEFAULT_AMOUNT: Record<BondSource, number> = { presence: 2, chat: 3, interact: 1, focus: 1, signin: 10 };

function dataOf(state: BondData): BondData {
  const { xp, since, daysTogether, streak, lastDay, today, totals } = state;
  return { xp, since, daysTogether, streak, lastDay, today, totals };
}

function yesterdayKey() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return dayKey(date);
}

export const useBondStore = create<BondStore>((set, get) => ({
  ...load(),
  gain: (source, amount = DEFAULT_AMOUNT[source]) => {
    const state = get();
    const day = dayKey();
    const today = state.today.day === day ? { ...state.today } : { day };
    const used = today[source] || 0;
    const gained = Math.max(0, Math.min(amount, DAILY_CAP[source] - used));
    const before = levelInfo(state.xp).level;
    const totals = { ...state.totals };
    if (source === "chat") totals.chats += 1;
    if (source === "interact") totals.interactions += 1;
    if (source === "focus") totals.focusMin += amount;
    if (source === "presence") totals.presenceMin += 5;
    today[source] = used + gained;
    const next: BondData = { ...dataOf(state), xp: state.xp + gained, today, totals };
    set(next);
    save(next);
    const after = levelInfo(next.xp).level;
    return { gained, leveledUp: after > before, level: after };
  },
  checkIn: () => {
    const state = get();
    const day = dayKey();
    if (state.lastDay === day) return null;
    const streak = state.lastDay === yesterdayKey() ? state.streak + 1 : 1;
    const next: BondData = { ...dataOf(state), lastDay: day, streak, daysTogether: state.daysTogether + 1 };
    set(next);
    save(next);
    return { streak, bonus: DEFAULT_AMOUNT.signin + Math.min(20, (streak - 1) * 2) };
  },
  reload: () => set(load()),
}));

/** 认识多少天了 */
export function daysSince(since: string) {
  const start = new Date(`${since}T00:00:00`).getTime();
  if (!Number.isFinite(start)) return 1;
  return Math.max(1, Math.floor((Date.now() - start) / 86_400_000) + 1);
}

/** 给系统提示用的一句话：让它知道你们处到什么程度了 */
export function bondPrompt(): string {
  try {
    const data = JSON.parse(localStorage.getItem(BOND_KEY) || "null") as BondData | null;
    if (!data) return "";
    const info = levelInfo(data.xp);
    return `你和用户已经认识 ${daysSince(data.since)} 天，关系等级 Lv${info.level}「${info.title}」。等级越高说话越熟络自然，可以偶尔提起你们一起做过的事，但不要刻意强调等级。`;
  } catch {
    return "";
  }
}

/** 其他窗口（工作台）发消息时通知桌宠窗口加经验 */
export const BOND_GAIN_EVENT = "pet-bond-gain";
