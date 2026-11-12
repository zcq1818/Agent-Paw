import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { describeDays, useAutomationStore, type AutomationAction } from "./automations";
import { cleanTitle, formatDur, friendlyApp, queryTimeline, timelineEnabled, type TimelineEvent } from "./timeline";

/**
 * 主动引擎（“主动干”的决策层）：根据本地时间线和剪贴板，发现可以帮忙的时机，
 * 在桌宠旁边弹一张提议卡片，用户点“好呀”才动手。
 *
 * 触发来源：
 * - 剪贴板（实时）：复制了报错 → 分析；外文 → 翻译；长文 → 提炼；含时间的会议信息 → 加日程；
 * - 规律（每 20 分钟看一次时间线）：每天固定时间打开某软件 → 提议设成自动任务；
 *   早上 → 回顾昨天停在哪；傍晚 → 写今天的工作日志；连续用电脑太久 → 提醒休息；
 *   下载文件夹堆了很多旧文件 → 提议整理。
 *
 * 用户连续拒绝同一类提议会自动降频（3 天 → 14 天不再提），接受会恢复。
 */

export type InitiativeMode = "off" | "suggest";
export const INITIATIVE_KEY = "paw_initiative";
const FEEDBACK_KEY = "paw_initiative_feedback";
const OFFERED_KEY = "paw_initiative_offered";

export type OfferAccept =
  | { type: "prompt"; prompt: string }
  | { type: "automation"; name: string; time: string; days: number[]; action: AutomationAction }
  | { type: "none" };

export interface Offer {
  id: string;
  kind: string;
  title: string;
  message: string;
  accept: OfferAccept;
  acceptLabel?: string;
  declineLabel?: string;
}

export function loadInitiativeMode(): InitiativeMode {
  return localStorage.getItem(INITIATIVE_KEY) === "off" ? "off" : "suggest";
}

export function saveInitiativeMode(mode: InitiativeMode) {
  localStorage.setItem(INITIATIVE_KEY, mode);
}

// ───────────────────────── 反馈与去重 ─────────────────────────

type Feedback = Record<string, { declines: number; streak: number; accepts: number; mutedUntil?: number }>;

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function isMuted(kind: string) {
  const entry = readJson<Feedback>(FEEDBACK_KEY, {})[kind];
  return Boolean(entry?.mutedUntil && entry.mutedUntil > Date.now());
}

export function recordOfferFeedback(kind: string, accepted: boolean) {
  const feedback = readJson<Feedback>(FEEDBACK_KEY, {});
  const entry = feedback[kind] || { declines: 0, streak: 0, accepts: 0 };
  if (accepted) {
    entry.accepts += 1;
    entry.streak = 0;
    entry.mutedUntil = undefined;
  } else {
    entry.declines += 1;
    entry.streak += 1;
    if (entry.streak >= 3) entry.mutedUntil = Date.now() + 14 * 86_400_000;
    else if (entry.streak >= 2) entry.mutedUntil = Date.now() + 3 * 86_400_000;
  }
  feedback[kind] = entry;
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(feedback));
}

/** 记一下某个提议今天 / 某个 key 已经提过，避免重复。 */
function alreadyOffered(key: string, withinMs: number) {
  const offered = readJson<Record<string, number>>(OFFERED_KEY, {});
  return Boolean(offered[key] && Date.now() - offered[key] < withinMs);
}

function markOffered(key: string) {
  const offered = readJson<Record<string, number>>(OFFERED_KEY, {});
  offered[key] = Date.now();
  // 只留最近 30 天
  for (const [k, v] of Object.entries(offered)) if (Date.now() - v > 30 * 86_400_000) delete offered[k];
  localStorage.setItem(OFFERED_KEY, JSON.stringify(offered));
}

function hash(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

function newOffer(kind: string, title: string, message: string, accept: OfferAccept, labels: Partial<Offer> = {}): Offer {
  return { id: `offer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, kind, title, message, accept, ...labels };
}

// ───────────────────────── 剪贴板 ─────────────────────────

const ERROR_PATTERN =
  /(traceback \(most recent call last\)|exception|error[:\s]|err!|fatal|panic|failed|cannot find|not found|undefined is not|is not defined|segmentation fault|报错|错误|异常|失败)/i;
const STACK_PATTERN = /(\n\s+at\s+\S+.*[:(]\d+|\bline \d+\b|:\d+:\d+|File ".*", line \d+)/i;
const DATE_PATTERN =
  /(\d{1,2}\s*[月/.-]\s*\d{1,2}|周[一二三四五六日天]|星期[一二三四五六日天]|明天|后天|下周|今晚|\d{1,2}\s*[:：]\s*\d{2}|[上下]午\s*\d{1,2}\s*[点:：])/;
const EVENT_PATTERN = /(会议|开会|例会|面试|截止|deadline|ddl|提交|评审|汇报|约了|见面|拜访|电话会|培训|讲座|meeting|interview|call\b)/i;

const OWN_APPS = /^(paw\.exe|paw)$/i;

export function classifyClip(text: string, app = ""): Offer | null {
  const trimmed = text.trim();
  if (trimmed.length < 12 || OWN_APPS.test(app)) return null;
  const cjk = (trimmed.match(/[一-鿿]/g) || []).length;
  const latin = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const lines = trimmed.split(/\n/).length;
  const preview = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n…（后面省略）` : trimmed;

  if (ERROR_PATTERN.test(trimmed) && (STACK_PATTERN.test(trimmed) || (lines >= 2 && trimmed.length >= 40) || /error|exception/i.test(trimmed.slice(0, 80)))) {
    return newOffer(
      "clip_error",
      "看到你复制了一段报错",
      "要我帮你分析原因、给出解决办法吗？",
      { type: "prompt", prompt: `帮我分析这段报错的原因，并给出具体解决步骤：\n\n\`\`\`\n${preview}\n\`\`\`` },
      { acceptLabel: "帮我分析" }
    );
  }

  if (DATE_PATTERN.test(trimmed) && EVENT_PATTERN.test(trimmed) && trimmed.length <= 600) {
    return newOffer(
      "clip_event",
      "这像是一个时间安排",
      "要我把它加到日程里吗？",
      {
        type: "prompt",
        prompt: `根据下面这段内容帮我添加日程（用 add_event，时间按原文理解，今天是 ${new Date().toLocaleDateString("zh-CN")}；有需要准备的事项再加一个待办）：\n\n${preview}`,
      },
      { acceptLabel: "加到日程" }
    );
  }

  const words = trimmed.split(/\s+/).length;
  if (cjk === 0 && latin >= 60 && latin / trimmed.length > 0.6 && words >= 10 && !/^https?:\/\//i.test(trimmed)) {
    return newOffer(
      "clip_translate",
      "复制了一段外文",
      "要我翻译成中文吗？",
      { type: "prompt", prompt: `把下面这段翻译成中文，保持原意和格式，专业术语括注原文：\n\n${preview}` },
      { acceptLabel: "翻译" }
    );
  }

  if (cjk >= 300) {
    return newOffer(
      "clip_summary",
      "这段内容挺长的",
      "要我帮你提炼要点吗？",
      { type: "prompt", prompt: `帮我提炼下面这段内容的要点（3-6 条），有需要我跟进的事项单独列出：\n\n${preview}` },
      { acceptLabel: "提炼要点" }
    );
  }
  return null;
}

// ───────────────────────── 规律发现 ─────────────────────────

const SYSTEM_APPS =
  /^(explorer|paw|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|lockapp|applicationframehost|textinputhost|systemsettings|taskmgr|rundll32|dwm|ctfmon|openwith|pickerhost|shellhost|widgets|msedgewebview2|consent)\.exe$/i;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function minutesToHHMM(minutes: number) {
  const rounded = Math.round(minutes / 5) * 5;
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

/** 最近 10 天里，在 ≥3 个不同日子、差不多同一时间（前后 25 分钟内）第一次打开的软件。 */
export function findRoutines(events: TimelineEvent[]) {
  const firstOpen = new Map<string, Map<string, { minutes: number; path: string; weekday: number }>>();
  for (const event of events) {
    if (event.kind !== "app" || !event.app || SYSTEM_APPS.test(event.app)) continue;
    const date = new Date(event.ts);
    if (date.getHours() < 5) continue;
    const day = date.toDateString();
    const perApp = firstOpen.get(event.app) || new Map();
    if (!perApp.has(day)) {
      perApp.set(day, { minutes: date.getHours() * 60 + date.getMinutes(), path: event.detail, weekday: date.getDay() });
    }
    firstOpen.set(event.app, perApp);
  }
  const routines: Array<{ app: string; path: string; time: string; days: number[]; count: number }> = [];
  for (const [app, perDay] of firstOpen) {
    const samples = [...perDay.values()];
    if (samples.length < 3) continue;
    const mid = median(samples.map((s) => s.minutes));
    const close = samples.filter((s) => Math.abs(s.minutes - mid) <= 25);
    if (close.length < 3 || close.length / samples.length < 0.6) continue;
    const weekdaysOnly = close.every((s) => s.weekday >= 1 && s.weekday <= 5);
    routines.push({
      app,
      path: close[close.length - 1].path,
      time: minutesToHHMM(Math.max(0, median(close.map((s) => s.minutes)) - 2)),
      days: weekdaysOnly ? [1, 2, 3, 4, 5] : [],
      count: close.length,
    });
  }
  return routines.sort((a, b) => b.count - a.count);
}

/** 当前这一段连续使用电脑的时长（遇到 ≥5 分钟的离开就断开）。 */
function continuousUseMs(events: TimelineEvent[]) {
  const now = Date.now();
  let start = now;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === "away" && event.dur >= 5 * 60_000) {
      // 正在离开中：不算连续使用
      if (event.ts + event.dur >= now - 60_000) return 0;
      break;
    }
    if (event.kind === "app") start = event.ts;
  }
  return now - start;
}

async function downloadsBacklog(): Promise<number> {
  try {
    const listing = await invoke<{ entries: Array<{ is_dir: boolean; modified: number; name: string }> }>("fs_list", {
      path: "~/Downloads",
    });
    const weekAgo = Date.now() / 1000 - 7 * 86_400;
    return listing.entries.filter((e) => !e.is_dir && e.modified < weekAgo && !/\.(crdownload|part|tmp)$/i.test(e.name)).length;
  } catch {
    return 0;
  }
}

async function computerControlOn() {
  try {
    const { loadConfig } = await import("./kernel");
    return loadConfig().computerControl !== "off";
  } catch {
    return false;
  }
}

export async function findPatternOffer(): Promise<Offer | null> {
  if (!timelineEnabled()) return null;
  const now = new Date();
  const hour = now.getHours();
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const dayKey = now.toDateString();
  const today = await queryTimeline({ from: todayStart, to: Date.now(), limit: 5000 });
  const activeToday = today.filter((e) => e.kind === "app").reduce((s, e) => s + e.dur, 0);

  // 1. 连续用电脑太久
  const continuous = continuousUseMs(today);
  if (continuous >= 100 * 60_000 && !isMuted("break") && !alreadyOffered("break", 2 * 3_600_000)) {
    markOffered("break");
    return newOffer("break", "休息一下吧", `你已经连续用电脑 ${formatDur(continuous)} 了，起来走走、喝口水，眼睛也歇一歇。`, { type: "none" }, {
      acceptLabel: "好的",
      declineLabel: "等会儿",
    });
  }

  // 2. 早上回顾昨天
  if (hour >= 6 && hour < 11 && !isMuted("morning_recap") && !alreadyOffered(`morning_recap_${dayKey}`, 86_400_000)) {
    const yStart = todayStart - 86_400_000;
    const yesterday = await queryTimeline({ from: yStart, to: todayStart - 1, kinds: ["app"], limit: 3000 });
    const yActive = yesterday.reduce((s, e) => s + e.dur, 0);
    if (yActive >= 60 * 60_000) {
      markOffered(`morning_recap_${dayKey}`);
      const last = [...yesterday].reverse().find((e) => e.dur >= 60_000 && !SYSTEM_APPS.test(e.app));
      const hint = last ? `昨天最后在 ${friendlyApp(last.app)}「${cleanTitle(last.title).slice(0, 24)}」` : "昨天的记录";
      return newOffer(
        "morning_recap",
        "早，接着昨天的活？",
        `${hint}。要我帮你回顾一下昨天做到哪了吗？`,
        {
          type: "prompt",
          prompt: "根据我昨天的电脑活动记录（先用 timeline_day_report 查 yesterday），告诉我昨天主要做了什么、最后停在哪个文件或页面、有哪些可能没做完的事，帮我快速接上今天的工作。简洁一点。",
        },
        { acceptLabel: "回顾一下" }
      );
    }
  }

  // 3. 傍晚写工作日志
  if (hour >= 17 && hour < 23 && activeToday >= 2 * 3_600_000 && !isMuted("daily_log") && !alreadyOffered(`daily_log_${dayKey}`, 86_400_000)) {
    markOffered(`daily_log_${dayKey}`);
    return newOffer(
      "daily_log",
      "今天辛苦啦",
      `今天在电脑前活跃了 ${formatDur(activeToday)}，要我根据记录帮你写一份工作日志吗？`,
      {
        type: "prompt",
        prompt:
          "根据我今天的电脑活动记录（先用 timeline_day_report 查 today）帮我写一份简洁的工作日志：按时间段归纳做了哪些事、涉及的主要文件和项目、时间花得最多的工作，最后给一句明天的建议。只写记录里有依据的内容，聊天和娱乐类窗口一笔带过。",
      },
      { acceptLabel: "写日志" }
    );
  }

  // 4. 固定时间打开的软件 → 自动任务
  if (!isMuted("routine")) {
    const history = await queryTimeline({ from: todayStart - 10 * 86_400_000, to: Date.now(), kinds: ["app"], limit: 5000 });
    const existing = useAutomationStore.getState().items;
    for (const routine of findRoutines(history)) {
      const key = `routine_${routine.app.toLowerCase()}`;
      if (alreadyOffered(key, 14 * 86_400_000)) continue;
      const covered = existing.some(
        (item) => item.action.type === "open" && item.action.target.toLowerCase().includes(routine.app.toLowerCase())
      );
      if (covered || !routine.path) continue;
      markOffered(key);
      const name = friendlyApp(routine.app);
      return newOffer(
        "routine",
        "发现一个小规律",
        `你最近 ${routine.count} 天都在 ${routine.time} 左右打开 ${name}。要我以后${describeDays(routine.days)} ${routine.time} 自动帮你打开吗？`,
        {
          type: "automation",
          name: `打开 ${name}`,
          time: routine.time,
          days: routine.days,
          action: { type: "open", target: routine.path, label: name },
        },
        { acceptLabel: "好，自动打开" }
      );
    }
  }

  // 5. 下载文件夹整理（一周最多问一次）
  if (!isMuted("downloads") && !alreadyOffered("downloads", 7 * 86_400_000) && (await computerControlOn())) {
    const backlog = await downloadsBacklog();
    if (backlog >= 40) {
      markOffered("downloads");
      return newOffer(
        "downloads",
        "下载文件夹有点满",
        `里面有 ${backlog} 个文件放了一周以上，要我按类型帮你整理一下吗？`,
        {
          type: "prompt",
          prompt:
            "帮我整理下载文件夹（~/Downloads）：把放了一周以上的文件按类型（文档、表格、演示、图片、安装包、压缩包、视频音频、其它）移动到 ~/Downloads/已整理/<类型>/ 下。先列出各类型数量和计划给我看，确认后用一条 PowerShell 命令批量移动，不要删除任何文件。",
        },
        { acceptLabel: "帮我整理" }
      );
    }
  }
  return null;
}

// ───────────────────────── Hook ─────────────────────────

interface InitiativeOptions {
  enabled: boolean;
  /** 现在不适合打扰（聊天中、拖动中、免打扰时段……） */
  isBusy: () => boolean;
  showOffer: (offer: Offer) => void;
  hasOffer: () => boolean;
}

const CLIP_COOLDOWN_MS = 90_000;
const PATTERN_INTERVAL_MS = 20 * 60_000;

export function useInitiative({ enabled, isBusy, showOffer, hasOffer }: InitiativeOptions) {
  const optionsRef = useRef({ isBusy, showOffer, hasOffer });
  optionsRef.current = { isBusy, showOffer, hasOffer };

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let lastClipOffer = 0;
    let unlisten: (() => void) | undefined;

    const offer = (item: Offer) => {
      if (disposed || loadInitiativeMode() === "off" || optionsRef.current.isBusy() || optionsRef.current.hasOffer()) return false;
      optionsRef.current.showOffer(item);
      return true;
    };

    listen<{ text: string; app: string }>("timeline-clip", (event) => {
      const text = event.payload?.text || "";
      if (!text || Date.now() - lastClipOffer < CLIP_COOLDOWN_MS) return;
      const item = classifyClip(text, event.payload?.app);
      if (!item || isMuted(item.kind)) return;
      const key = `clip_${hash(text)}`;
      if (alreadyOffered(key, 86_400_000)) return;
      if (offer(item)) {
        lastClipOffer = Date.now();
        markOffered(key);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    const check = async () => {
      if (disposed || loadInitiativeMode() === "off" || optionsRef.current.isBusy() || optionsRef.current.hasOffer()) return;
      try {
        const item = await findPatternOffer();
        if (item) offer(item);
      } catch {}
    };
    const first = window.setTimeout(check, 60_000);
    const timer = window.setInterval(check, PATTERN_INTERVAL_MS);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled]);
}
