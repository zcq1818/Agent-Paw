import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

/**
 * 本地活动时间线（“记录所有”）前端部分。
 *
 * 真正的采样在 Rust（src-tauri/src/timeline.rs）后台线程里：前台窗口、离开 / 锁屏、
 * 打开的文件、剪贴板。这里负责：把设置同步给 Rust、查询、整理成人能读的文字，
 * 以及给模型用的两个只读工具（搜索记录 / 某天的活动报告）。
 *
 * 总开关沿用「本地活动观察」（paw_activity_enabled），细项存在 paw_timeline_config。
 */

export type TimelineKind = "app" | "file" | "clip" | "away";

export interface TimelineEvent {
  ts: number;
  kind: TimelineKind;
  app: string;
  title: string;
  detail: string;
  dur: number;
}

export interface TimelineSettings {
  files: boolean;
  clipboard: boolean;
  retentionDays: number;
  exclude: string[];
}

export interface TimelineStatus {
  enabled: boolean;
  days: number;
  bytes: number;
  oldestDay: string;
  dir: string;
}

export const TIMELINE_CONFIG_KEY = "paw_timeline_config";
const ACTIVITY_ENABLED_KEY = "paw_activity_enabled";

export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  files: true,
  clipboard: false,
  retentionDays: 30,
  exclude: [],
};

export function loadTimelineSettings(): TimelineSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(TIMELINE_CONFIG_KEY) || "null");
    if (saved && typeof saved === "object") {
      return {
        files: saved.files !== false,
        clipboard: saved.clipboard === true,
        retentionDays: Math.max(1, Math.min(365, Number(saved.retentionDays) || 30)),
        exclude: Array.isArray(saved.exclude) ? saved.exclude.map(String).filter(Boolean) : [],
      };
    }
  } catch {}
  return { ...DEFAULT_TIMELINE_SETTINGS };
}

export function timelineEnabled() {
  return localStorage.getItem(ACTIVITY_ENABLED_KEY) === "1";
}

/** 把当前开关和细项推给 Rust 记录器。任何窗口调用都行，Rust 端是全局的。 */
export async function applyTimelineConfig() {
  const settings = loadTimelineSettings();
  try {
    await invoke("timeline_configure", {
      config: { enabled: timelineEnabled(), ...settings },
    });
  } catch {
    // 浏览器预览 / 非 Tauri 环境
  }
}

export async function saveTimelineSettings(patch: Partial<TimelineSettings>) {
  const next = { ...loadTimelineSettings(), ...patch };
  localStorage.setItem(TIMELINE_CONFIG_KEY, JSON.stringify(next));
  await applyTimelineConfig();
  return next;
}

export async function queryTimeline(query: {
  from?: number;
  to?: number;
  kinds?: TimelineKind[];
  keyword?: string;
  limit?: number;
}): Promise<TimelineEvent[]> {
  try {
    return await invoke<TimelineEvent[]>("timeline_query", { query });
  } catch {
    return [];
  }
}

export async function timelineStatus(): Promise<TimelineStatus | null> {
  try {
    return await invoke<TimelineStatus>("timeline_status");
  } catch {
    return null;
  }
}

export async function clearTimeline(before?: number) {
  return invoke<number>("timeline_clear", { before: before ?? null });
}

// ───────────────────────── 格式化 ─────────────────────────

const APP_NAMES: Record<string, string> = {
  "chrome.exe": "Chrome",
  "msedge.exe": "Edge",
  "firefox.exe": "Firefox",
  "winword.exe": "Word",
  "excel.exe": "Excel",
  "powerpnt.exe": "PowerPoint",
  "outlook.exe": "Outlook",
  "olk.exe": "Outlook",
  "onenote.exe": "OneNote",
  "ms-teams.exe": "Teams",
  "teams.exe": "Teams",
  "code.exe": "VS Code",
  "cursor.exe": "Cursor",
  "devenv.exe": "Visual Studio",
  "explorer.exe": "文件资源管理器",
  "notepad.exe": "记事本",
  "windowsterminal.exe": "终端",
  "wechat.exe": "微信",
  "weixin.exe": "微信",
  "qq.exe": "QQ",
  "dingtalk.exe": "钉钉",
  "feishu.exe": "飞书",
  "lark.exe": "飞书",
  "wps.exe": "WPS",
  "et.exe": "WPS 表格",
  "wpp.exe": "WPS 演示",
  "slack.exe": "Slack",
  "notion.exe": "Notion",
  "obsidian.exe": "Obsidian",
  "blender.exe": "Blender",
  "paw.exe": "Paw",
};

export function friendlyApp(app: string) {
  if (!app) return "";
  const known = APP_NAMES[app.toLowerCase()];
  if (known) return known;
  return app.replace(/\.exe$/i, "");
}

/** 浏览器 / Office 标题末尾的“ - Google Chrome”之类去掉，只留内容部分。 */
export function cleanTitle(title: string) {
  return title
    // Edge：“标题 和另外 3 个页面 - 个人 - Microsoft Edge”，先去掉配置文件名
    .replace(/\s*-\s*(个人|工作|Personal|Work)\s*-\s*Microsoft\u200B?\s*Edge\s*$/i, "")
    .replace(/\s*[-—|]\s*(Google Chrome|Microsoft\u200B?\s*Edge|Mozilla Firefox|Visual Studio Code|Cursor|Word|Excel|PowerPoint|记事本|Notepad)\s*$/i, "")
    .replace(/\s*和另外\s*\d+\s*个页面/g, "")
    .trim();
}

export function formatDur(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function hhmm(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function startOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 解析“today / yesterday / 前天 / 2026-11-10 / 11-10”。 */
export function parseDay(value?: string): number {
  const now = new Date();
  const text = String(value || "today").trim().toLowerCase();
  if (!text || text === "today" || text === "今天") return startOfDay(now);
  if (text === "yesterday" || text === "昨天") return startOfDay(new Date(now.getTime() - 86_400_000));
  if (text === "前天") return startOfDay(new Date(now.getTime() - 2 * 86_400_000));
  const full = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (full) return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3])).getTime();
  const short = text.match(/^(\d{1,2})[-/.月](\d{1,2})/);
  if (short) return new Date(now.getFullYear(), Number(short[1]) - 1, Number(short[2])).getTime();
  const daysAgo = text.match(/^(\d+)\s*(天前|days? ago)$/);
  if (daysAgo) return startOfDay(new Date(now.getTime() - Number(daysAgo[1]) * 86_400_000));
  return startOfDay(now);
}

/** 把 “14:30” 解析成某天的时间戳。 */
function atTime(dayStart: number, value?: string) {
  const match = String(value || "").match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return undefined;
  return dayStart + Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000;
}

export function describeEvent(event: TimelineEvent, withDay = false) {
  const time = `${withDay ? `${dayLabel(event.ts)} ` : ""}${hhmm(event.ts)}`;
  const app = friendlyApp(event.app);
  switch (event.kind) {
    case "app":
      return `${time}（${formatDur(event.dur)}）${app}：${cleanTitle(event.title) || "（无标题）"}`;
    case "file":
      return `${time} 打开 ${event.title}${event.detail ? `（${event.detail}）` : ""}`;
    case "clip": {
      const body = event.detail && event.detail !== event.title ? `：${event.detail.slice(0, 300)}` : `：${event.title}`;
      return `${time} 在${app || "某软件"}里复制${body}`;
    }
    case "away":
      return `${time}（${formatDur(event.dur)}）${event.title}`;
    default:
      return `${time} ${event.title}`;
  }
}

/** 合并同一软件同一标题的连续片段（中途切走不到 1 分钟也算连续）。 */
function mergeAppEvents(events: TimelineEvent[]) {
  const merged: TimelineEvent[] = [];
  for (const event of events) {
    if (event.kind !== "app") continue;
    const last = merged[merged.length - 1];
    if (last && last.app === event.app && last.title === event.title && event.ts - (last.ts + last.dur) < 60_000) {
      last.dur = event.ts + event.dur - last.ts;
    } else {
      merged.push({ ...event });
    }
  }
  return merged;
}

export interface DayDigest {
  dayStart: number;
  activeMs: number;
  first?: number;
  last?: number;
  apps: Array<{ app: string; ms: number; titles: Array<{ title: string; ms: number }> }>;
  files: TimelineEvent[];
  clips: TimelineEvent[];
  away: TimelineEvent[];
  hours: Array<{ hour: number; app: string; title: string; ms: number }>;
}

export function digestDay(events: TimelineEvent[], dayStart: number): DayDigest {
  const appEvents = events.filter((e) => e.kind === "app");
  const activeMs = appEvents.reduce((sum, e) => sum + e.dur, 0);
  const byApp = new Map<string, { ms: number; titles: Map<string, number> }>();
  const byHour = new Map<number, Map<string, number>>();
  for (const event of appEvents) {
    const item = byApp.get(event.app) || { ms: 0, titles: new Map() };
    item.ms += event.dur;
    const title = cleanTitle(event.title);
    if (title) item.titles.set(title, (item.titles.get(title) || 0) + event.dur);
    byApp.set(event.app, item);

    const hour = new Date(event.ts).getHours();
    const hourMap = byHour.get(hour) || new Map<string, number>();
    const key = `${event.app}\u0000${title}`;
    hourMap.set(key, (hourMap.get(key) || 0) + event.dur);
    byHour.set(hour, hourMap);
  }
  const apps = [...byApp.entries()]
    .map(([app, value]) => ({
      app,
      ms: value.ms,
      titles: [...value.titles.entries()]
        .map(([title, ms]) => ({ title, ms }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 4),
    }))
    .sort((a, b) => b.ms - a.ms);
  const hours = [...byHour.entries()]
    .map(([hour, map]) => {
      const total = [...map.values()].reduce((s, v) => s + v, 0);
      const [key] = [...map.entries()].sort((a, b) => b[1] - a[1])[0];
      const [app, title] = key.split("\u0000");
      return { hour, app, title, ms: total };
    })
    .sort((a, b) => a.hour - b.hour);
  return {
    dayStart,
    activeMs,
    first: appEvents[0]?.ts,
    last: appEvents.length ? appEvents[appEvents.length - 1].ts + appEvents[appEvents.length - 1].dur : undefined,
    apps,
    files: events.filter((e) => e.kind === "file"),
    clips: events.filter((e) => e.kind === "clip"),
    away: events.filter((e) => e.kind === "away" && e.dur >= 10 * 60_000),
    hours,
  };
}

export function formatDigest(digest: DayDigest) {
  const label = dayLabel(digest.dayStart);
  if (!digest.activeMs && !digest.files.length && !digest.clips.length) {
    const away = digest.away.reduce((sum, item) => sum + item.dur, 0);
    return `${label}没有软件使用记录（记录功能是开着的${away ? `，这天电脑主要处于锁屏 / 离开状态，共 ${formatDur(away)}` : "，可能这天还没开始记录或没用电脑"}）。`;
  }
  const lines = [`## ${label}电脑活动`, ""];
  lines.push(
    `- 使用时段：${digest.first ? hhmm(digest.first) : "?"} – ${digest.last ? hhmm(digest.last) : "?"}，前台活跃共 ${formatDur(digest.activeMs)}`
  );
  if (digest.away.length) {
    lines.push(`- 离开电脑：${digest.away.map((a) => `${hhmm(a.ts)}（${formatDur(a.dur)}）`).join("、")}`);
  }
  lines.push("", "### 时间花在哪");
  for (const item of digest.apps.slice(0, 10)) {
    const titles = item.titles.map((t) => `${t.title}（${formatDur(t.ms)}）`).join("；");
    lines.push(`- **${friendlyApp(item.app)}** ${formatDur(item.ms)}${titles ? `：${titles}` : ""}`);
  }
  if (digest.hours.length) {
    lines.push("", "### 按小时");
    for (const hour of digest.hours) {
      lines.push(`- ${String(hour.hour).padStart(2, "0")}:00 主要在 ${friendlyApp(hour.app)}${hour.title ? `「${hour.title}」` : ""}`);
    }
  }
  if (digest.files.length) {
    lines.push("", "### 打开的文件");
    const seen = new Set<string>();
    for (const file of digest.files) {
      if (seen.has(file.title)) continue;
      seen.add(file.title);
      lines.push(`- ${hhmm(file.ts)} ${file.title}${file.detail ? `（${file.detail}）` : ""}`);
      if (seen.size >= 30) break;
    }
  }
  if (digest.clips.length) {
    lines.push("", `### 复制过的内容（${digest.clips.length} 次，最近 8 条）`);
    for (const clip of digest.clips.slice(-8)) {
      lines.push(`- ${hhmm(clip.ts)} ${clip.title}`);
    }
  }
  return lines.join("\n");
}

export async function dayReport(day?: string) {
  const dayStart = parseDay(day);
  const events = await queryTimeline({ from: dayStart, to: dayStart + 86_400_000 - 1, limit: 5000 });
  return formatDigest(digestDay(events, dayStart));
}

// ───────────────────────── 工具 ─────────────────────────

const NOT_ENABLED = "本地活动记录没有开启。请到「设置 → AI 能力 → 本地活动观察」打开，之后我才能记录和回顾你的电脑使用情况。";

export function getTimelineTools(): Tool[] {
  return [
    {
      name: "timeline_search",
      description:
        "搜索本机的活动时间线（用过哪些软件、窗口标题、打开过的文件、复制过的内容、离开电脑的时间）。用于回答“我昨天下午在干嘛”“上周打开过的那个报价单叫什么”“我刚才复制的链接是什么”。只读。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "关键词，匹配软件名、窗口标题、文件路径、复制内容；可空" },
          kind: { type: "string", enum: ["all", "app", "file", "clip", "away"], description: "记录类型：app 窗口，file 文件，clip 复制，away 离开" },
          day: { type: "string", description: "哪天：today / yesterday / 前天 / 2026-11-10；与 days_back 二选一" },
          days_back: { type: "number", description: "往前搜几天（含今天），默认 1，最多 90" },
          from_time: { type: "string", description: "当天开始时间，如 14:00（配合 day）" },
          to_time: { type: "string", description: "当天结束时间，如 18:00（配合 day）" },
          limit: { type: "number", description: "最多返回几条，默认 60" },
        },
      },
      execute: async (args) => {
        if (!timelineEnabled()) return NOT_ENABLED;
        let from: number;
        let to: number;
        if (args.day) {
          const dayStart = parseDay(args.day);
          from = atTime(dayStart, args.from_time) ?? dayStart;
          to = atTime(dayStart, args.to_time) ?? dayStart + 86_400_000 - 1;
        } else {
          const daysBack = Math.max(1, Math.min(90, Number(args.days_back) || 1));
          to = Date.now();
          from = startOfDay(new Date()) - (daysBack - 1) * 86_400_000;
        }
        const kind = String(args.kind || "all");
        const limit = Math.max(1, Math.min(300, Number(args.limit) || 60));
        const raw = await queryTimeline({
          from,
          to,
          kinds: kind === "all" ? undefined : [kind as TimelineKind],
          keyword: args.keyword ? String(args.keyword) : undefined,
          limit: 5000,
        });
        const events = [
          ...mergeAppEvents(raw).filter((e) => e.dur >= 20_000 || args.keyword),
          ...raw.filter((e) => e.kind !== "app"),
        ].sort((a, b) => a.ts - b.ts);
        if (!events.length) return "时间线里没有找到符合条件的记录。";
        const multiDay = to - from > 86_400_000;
        const shown = events.slice(-limit);
        const header = events.length > shown.length ? `共 ${events.length} 条，显示最近 ${shown.length} 条：\n` : "";
        return header + shown.map((e) => describeEvent(e, multiDay)).join("\n");
      },
    },
    {
      name: "timeline_day_report",
      description:
        "生成某一天的电脑活动报告：时间花在哪些软件和窗口、按小时的主要工作、打开的文件、复制次数、离开时段。适合写工作日志、日报、回顾“昨天做到哪了”。只读。",
      parameters: {
        type: "object",
        properties: {
          day: { type: "string", description: "today / yesterday / 前天 / 2026-11-10，默认 today" },
        },
      },
      execute: async (args) => {
        if (!timelineEnabled()) return NOT_ENABLED;
        return dayReport(args.day);
      },
    },
  ];
}

export const TIMELINE_PROMPT = [
  "## 本地活动记录",
  "用户开启了本地活动记录：软件使用、窗口标题、打开的文件、复制内容、离开时间都按时间线存在本机。",
  "用户问起过去做过什么、找某个文件 / 网页 / 复制过的内容、写日报周报时，先用 timeline_search 或 timeline_day_report 查记录再回答，不要凭空编。",
  "记录只用来帮用户，回答时不要大段复述隐私内容（如聊天窗口标题），按需引用。",
].join("\n");
