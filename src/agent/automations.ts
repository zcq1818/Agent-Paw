import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { confirmSystemAction, type Tool } from "./tools";

/**
 * 自动任务：到点自己干活（“主动干”的执行层）。
 *
 * 两种动作：
 * - open：直接打开某个软件 / 文件 / 网址，不经过模型，稳定可靠；
 * - agent：把一段指令交给桌宠自己执行（会用到电脑控制等工具，审批规则照常生效）。
 *
 * 来源：用户说“每天 9 点帮我打开邮箱”时由模型调用 create_automation 创建；
 * 或者主动引擎发现规律后提议、用户点“好呀”创建。
 * 调度在桌宠窗口里跑（桌宠窗口常驻），每 30 秒检查一次，错过 15 分钟以上的当天不补跑。
 */

export type AutomationAction =
  | { type: "open"; target: string; label?: string }
  | { type: "agent"; prompt: string };

export interface Automation {
  id: string;
  name: string;
  /** HH:MM */
  time: string;
  /** 0=周日 … 6=周六；空数组表示每天 */
  days: number[];
  action: AutomationAction;
  enabled: boolean;
  createdAt: string;
  lastRunDay?: string;
  source: "user" | "suggested";
}

export const AUTOMATIONS_KEY = "paw_automations";
const GRACE_MS = 15 * 60_000;
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

function load(): Automation[] {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTOMATIONS_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function persist(items: Automation[]) {
  localStorage.setItem(AUTOMATIONS_KEY, JSON.stringify(items));
}

function todayKey(date = new Date()) {
  return date.toDateString();
}

export function normalizeTime(value: string): string | null {
  const match = String(value || "").match(/(\d{1,2})\s*[:：点]\s*(\d{1,2})?/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] || 0);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** “工作日 / 周末 / 每天 / 周一,周三 / 1,3,5” → [1,3,5] */
export function parseDays(value: unknown): number[] {
  if (Array.isArray(value)) return [...new Set(value.map(Number).filter((n) => n >= 0 && n <= 6))].sort();
  const text = String(value || "").trim();
  if (!text || /每天|每日|daily|every\s*day/i.test(text)) return [];
  if (/工作日|weekday/i.test(text)) return [1, 2, 3, 4, 5];
  if (/周末|weekend/i.test(text)) return [0, 6];
  const days = new Set<number>();
  const map: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  for (const match of text.matchAll(/[周星期礼拜]*([日天一二三四五六])/g)) days.add(map[match[1]]);
  for (const match of text.matchAll(/\b([0-6])\b/g)) days.add(Number(match[1]));
  const english = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  english.forEach((name, index) => {
    if (new RegExp(`\\b${name}`, "i").test(text)) days.add(index);
  });
  return [...days].sort();
}

export function describeDays(days: number[]) {
  if (!days.length || days.length === 7) return "每天";
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "工作日";
  if (key === "0,6") return "周末";
  return days.map((d) => `周${WEEKDAY_NAMES[d]}`).join("、");
}

export function describeAutomation(item: Automation) {
  const what = item.action.type === "open" ? `打开 ${item.action.label || item.action.target}` : item.action.prompt;
  return `${describeDays(item.days)} ${item.time}：${what}`;
}

interface AutomationState {
  items: Automation[];
  add: (item: Omit<Automation, "id" | "createdAt" | "enabled"> & { enabled?: boolean }) => Automation;
  update: (id: string, patch: Partial<Automation>) => void;
  remove: (id: string) => void;
  reload: () => void;
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  items: load(),
  add: (item) => {
    const created: Automation = {
      ...item,
      id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      enabled: item.enabled ?? true,
    };
    // 创建时间已经过了今天的点：今天不再补跑
    const [h, m] = created.time.split(":").map(Number);
    const due = new Date();
    due.setHours(h, m, 0, 0);
    if (Date.now() > due.getTime()) created.lastRunDay = todayKey();
    const items = [...get().items, created];
    persist(items);
    set({ items });
    return created;
  },
  update: (id, patch) => {
    const items = get().items.map((item) => (item.id === id ? { ...item, ...patch } : item));
    persist(items);
    set({ items });
  },
  remove: (id) => {
    const items = get().items.filter((item) => item.id !== id);
    persist(items);
    set({ items });
  },
  reload: () => set({ items: load() }),
}));

function findAutomation(ref: string) {
  const text = String(ref || "").trim();
  const items = useAutomationStore.getState().items;
  return items.find((item) => item.id === text) || items.find((item) => item.name === text) || items.find((item) => item.name.includes(text));
}

/** 判断某个自动任务此刻是否该跑。 */
export function isDue(item: Automation, now = new Date()) {
  if (!item.enabled || item.lastRunDay === todayKey(now)) return false;
  if (item.days.length && !item.days.includes(now.getDay())) return false;
  const [h, m] = item.time.split(":").map(Number);
  const due = new Date(now);
  due.setHours(h, m, 0, 0);
  const diff = now.getTime() - due.getTime();
  return diff >= 0 && diff <= GRACE_MS;
}

interface RunnerOptions {
  runPrompt: (prompt: string) => Promise<void> | void;
  speak: (message: string, duration?: number) => void;
  isBusy: () => boolean;
}

/** 桌宠窗口里挂一个调度器。 */
export function useAutomationRunner({ runPrompt, speak, isBusy }: RunnerOptions) {
  const optionsRef = useRef({ runPrompt, speak, isBusy });
  optionsRef.current = { runPrompt, speak, isBusy };

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTOMATIONS_KEY || event.key === null) useAutomationStore.getState().reload();
    };
    window.addEventListener("storage", onStorage);

    const tick = async () => {
      const store = useAutomationStore.getState();
      const due = store.items.filter((item) => isDue(item));
      for (const item of due) {
        // agent 类任务要等当前对话结束，避免抢话；open 类直接执行
        if (item.action.type === "agent" && optionsRef.current.isBusy()) continue;
        store.update(item.id, { lastRunDay: todayKey() });
        if (item.action.type === "open") {
          try {
            await invoke("launch_app", { target: item.action.target });
            optionsRef.current.speak(`到点啦，按约定帮你打开了 ${item.action.label || item.action.target}。`, 5200);
          } catch (error) {
            optionsRef.current.speak(`自动任务「${item.name}」没打开：${error}`, 6500);
          }
        } else {
          optionsRef.current.speak(`到点了，我开始做「${item.name}」。`, 4200);
          try {
            await optionsRef.current.runPrompt(`【自动任务：${item.name}】${item.action.prompt}`);
          } catch {}
        }
      }
    };

    const timer = window.setInterval(tick, 30_000);
    const first = window.setTimeout(tick, 8_000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, []);
}

export function getAutomationTools(): Tool[] {
  return [
    {
      name: "create_automation",
      description:
        "创建定时自动任务，到点由桌宠自己执行。用户说“每天/每周X/工作日 几点 帮我做某事”时使用。简单打开软件、文件、网址用 open_target；需要多步操作（整理文件、查资料、写日报等）用 prompt 写清楚要做什么。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "任务名，简短，如“打开邮箱”" },
          time: { type: "string", description: "执行时间 HH:MM，24 小时制" },
          days: { type: "string", description: "每天 / 工作日 / 周末 / 周一,周五；默认每天" },
          open_target: { type: "string", description: "直接打开的软件名、exe 路径、文件路径或网址（与 prompt 二选一）" },
          prompt: { type: "string", description: "到点后交给桌宠执行的完整指令（与 open_target 二选一）" },
        },
        required: ["name", "time"],
      },
      execute: async (args) => {
        const time = normalizeTime(args.time);
        if (!time) return "时间格式不对，请用 HH:MM，例如 09:00。";
        const target = String(args.open_target || "").trim();
        const prompt = String(args.prompt || "").trim();
        if (!target && !prompt) return "需要 open_target 或 prompt 其中一个。";
        const days = parseDays(args.days);
        const action: AutomationAction = target ? { type: "open", target } : { type: "agent", prompt };
        const preview = describeAutomation({
          id: "",
          name: String(args.name),
          time,
          days,
          action,
          enabled: true,
          createdAt: "",
          source: "user",
        });
        if (!(await confirmSystemAction(`创建自动任务「${args.name}」\n${preview}`, "tool"))) return "用户取消了创建自动任务。";
        const created = useAutomationStore.getState().add({ name: String(args.name), time, days, action, source: "user" });
        return `已创建自动任务「${created.name}」：${describeAutomation(created)}。可以在「设置 → AI 能力 → 主动助手」里查看和关闭。`;
      },
    },
    {
      name: "list_automations",
      description: "列出所有定时自动任务。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const items = useAutomationStore.getState().items;
        if (!items.length) return "还没有自动任务。";
        return items
          .map((item) => `- [${item.enabled ? "开" : "关"}] ${item.name}（ID ${item.id}）${describeAutomation(item)}`)
          .join("\n");
      },
    },
    {
      name: "toggle_automation",
      description: "暂停或恢复一个自动任务（按 ID 或名称）。",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "任务 ID 或名称" },
          enabled: { type: "boolean", description: "true 恢复，false 暂停；不填则切换" },
        },
        required: ["ref"],
      },
      execute: async (args) => {
        const item = findAutomation(args.ref);
        if (!item) return `没找到自动任务「${args.ref}」。`;
        const enabled = typeof args.enabled === "boolean" ? args.enabled : !item.enabled;
        useAutomationStore.getState().update(item.id, { enabled });
        return `自动任务「${item.name}」已${enabled ? "恢复" : "暂停"}。`;
      },
    },
    {
      name: "delete_automation",
      description: "删除一个自动任务（按 ID 或名称）。",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "任务 ID 或名称" } },
        required: ["ref"],
      },
      execute: async (args) => {
        const item = findAutomation(args.ref);
        if (!item) return `没找到自动任务「${args.ref}」。`;
        useAutomationStore.getState().remove(item.id);
        return `已删除自动任务「${item.name}」。`;
      },
    },
  ];
}
