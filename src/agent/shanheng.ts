import { useEffect } from "react";
import { create } from "zustand";
import { fetchExternal } from "./http";
import type { Tool } from "./kernel";
import { loadJobs, useJobStore, type Job } from "./jobs";

/**
 * 员工模式：这台电脑就是山衡里的一位 AI 员工（山衡「组织架构」里设成「外地电脑」的那位）。
 *
 * 常驻在桌宠窗口里：每 15 秒去山衡领一次活 → 领到就变成一项「工作」（工作台 →「工作」里能看到日志）→
 * 干完把报告交回山衡（派活人验收），出错就报卡住；干活期间每分钟报一次心跳，
 * 山衡那边取消了就停手。一次只干一件山衡的活。
 *
 * 干活时多两个工具：查同事通讯录、当场问同事一句（同事只读，几分钟内回答）。
 * 接入密钥只存在本机 localStorage，只发给填的山衡地址，不进模型的提示词或工具结果。
 *
 * 接口跟 @shan/ai 的 shanHengWorker 一样（/api/ai/worker/*）。Paw 现在是公开仓库，没法依赖私有包，
 * 这里先自带一个小客户端；Paw 改成私有后换成 @shan/ai 的 runWorker / shanHengWorker。
 */

const CONFIG_KEY = "paw_shanheng_worker";
const REPORTED_KEY = "paw_shanheng_reported";
const CLIENT = "Paw";
const POLL_MS = 15_000;
const HEARTBEAT_MS = 60_000;

export interface ShanHengConfig {
  /** 山衡地址，如 https://www.vipcc.cn */
  baseUrl: string;
  /** 「组织架构」里生成的接入密钥 */
  key: string;
  enabled: boolean;
}

const DEFAULT_CONFIG: ShanHengConfig = { baseUrl: "", key: "", enabled: false };

export function loadShanHengConfig(): ShanHengConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveShanHengConfig(config: ShanHengConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...config, baseUrl: config.baseUrl.trim().replace(/\/+$/, ""), key: config.key.trim() }));
  useShanHengStore.getState().set({ lastError: "" });
}

export function shanHengReady(config = loadShanHengConfig()) {
  return Boolean(config.baseUrl && config.key);
}

// ─────────────────────────── 接口 ───────────────────────────

export interface ShanHengTask {
  id: number;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  priority?: string;
  dueAt?: string | null;
  relatedTable?: string | null;
  relatedRecordId?: number | null;
  ownerName?: string | null;
  parentTaskId?: number | null;
  runCount?: number;
  instructions?: string[];
  previousResult?: string | null;
  reviewComment?: string | null;
}

export interface ShanHengProfile {
  agentId: number;
  name: string;
  department?: string | null;
  title?: string | null;
  duties?: string | null;
  systemPrompt?: string | null;
}

export class ShanHengError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

async function api<T = any>(method: string, path: string, body?: unknown, config = loadShanHengConfig(), timeoutMs = 30_000): Promise<T | null> {
  if (!shanHengReady(config)) throw new ShanHengError("还没填山衡地址和接入密钥");
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchExternal(`${config.baseUrl}/api/ai/worker${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", "X-Worker-Client": CLIENT },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (error) {
    throw new ShanHengError(ctrl.signal.aborted ? "连山衡超时了" : `连不上山衡：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    window.clearTimeout(timer);
  }
  if (resp.status === 204) return null;
  const text = await resp.text();
  if (!resp.ok) {
    let message = "";
    try {
      message = JSON.parse(text)?.message || "";
    } catch {}
    if (resp.status === 401) message = "接入密钥不对或已停用，到山衡「组织架构」里重新生成";
    throw new ShanHengError(message || `山衡返回 ${resp.status}`, resp.status);
  }
  return text ? (JSON.parse(text) as T) : null;
}

export const shanHeng = {
  me: (config?: ShanHengConfig) => api<ShanHengProfile>("GET", "/me", undefined, config),
  claim: () => api<ShanHengTask>("POST", "/claim"),
  heartbeat: async (taskId: number, progress?: string) =>
    (await api<{ status: string }>("POST", `/tasks/${taskId}/heartbeat`, { progress: progress ?? null })) ?? { status: "running" },
  submit: (taskId: number, result: string) => api("POST", `/tasks/${taskId}/submit`, { result }),
  fail: (taskId: number, reason: string) => api("POST", `/tasks/${taskId}/fail`, { reason: reason.slice(0, 480) }),
  colleagues: async () => (await api<any[]>("GET", "/colleagues")) ?? [],
  ask: async (agentId: number | null, question: string) =>
    (await api<{ colleague?: string; answer?: string; error?: string }>("POST", "/ask", { agentId, question }, undefined, 240_000)) ?? { error: "没有回答" },
};

/** 把领到的活写成交给桌宠的工作目标 */
export function briefOf(task: ShanHengTask, profile?: ShanHengProfile | null): string {
  const lines: string[] = [];
  if (profile) {
    const where = [profile.department, profile.title].filter(Boolean).join(" · ");
    lines.push(`你现在是山衡里的 AI 员工「${profile.name}」${where ? `（${where}）` : ""}，这是派给你的活。`);
    if (profile.duties) lines.push(`你的职责：${profile.duties}`);
    if (profile.systemPrompt) lines.push("", "你的人设：", profile.systemPrompt);
    lines.push("");
  }
  lines.push(`【山衡任务 #${task.id}】${task.title}`);
  const meta = [task.ownerName ? `派活人：${task.ownerName}` : "", task.dueAt ? `截止：${task.dueAt}` : ""].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  if (task.relatedTable) lines.push(`关联单据：${task.relatedTable} #${task.relatedRecordId ?? ""}`);
  if (task.description) lines.push("", "要做什么：", task.description);
  if (task.acceptanceCriteria) lines.push("", "验收标准：", task.acceptanceCriteria);
  if (task.previousResult) lines.push("", "你上次交付的内容：", task.previousResult);
  if (task.reviewComment) lines.push("", "派活人的意见：", task.reviewComment);
  const notes = (task.instructions ?? []).filter((s) => s.trim());
  if (notes.length) lines.push("", "派活人后来说的话：", ...notes);
  lines.push(
    "",
    "不归你管、同事更在行的事，可以用 list_colleagues 看同事通讯录、用 ask_colleague 当场问（同事只查不改）。",
    "最后的报告就是交给派活人的交付内容：写清结论、做了什么、依据；有验收标准的逐条对照。"
  );
  return lines.join("\n");
}

/** 干山衡的活时多给的两个工具（只读） */
export function shanHengColleagueTools(): Tool[] {
  return [
    {
      name: "list_colleagues",
      description: "山衡同事通讯录：每位同事（AI 员工）的编号、部门、岗位、职责。要问同事之前先看谁管这件事。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          return JSON.stringify(await shanHeng.colleagues());
        } catch (error) {
          return `查不到同事：${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "ask_colleague",
      description:
        "当场问一位山衡同事（另一位 AI 员工）一个问题，他查完马上回答。同事只能查、不能改数据，也不会替你办事。问题要写清楚、能独立看懂。不知道编号先用 list_colleagues。",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "integer", description: "问哪位同事（员工编号）" },
          question: { type: "string", description: "要问的问题，写清背景和要什么" },
        },
        required: ["agent_id", "question"],
      },
      execute: async (args) => {
        const id = Number(args.agent_id);
        try {
          return JSON.stringify(await shanHeng.ask(Number.isFinite(id) ? id : null, String(args.question || "")));
        } catch (error) {
          return `问不了：${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
  ];
}

// ─────────────────────────── 常驻循环 ───────────────────────────

interface ShanHengState {
  /** 最近一次跟山衡打交道的情况，设置页里显示 */
  status: "off" | "idle" | "working" | "error";
  lastError: string;
  lastSeenAt: number;
  currentTaskId: number | null;
  set: (patch: Partial<Omit<ShanHengState, "set">>) => void;
}

export const useShanHengStore = create<ShanHengState>((set) => ({
  status: "off",
  lastError: "",
  lastSeenAt: 0,
  currentTaskId: null,
  set: (patch) => set(patch),
}));

function loadReported(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(REPORTED_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function markReported(jobId: string) {
  const all = loadReported();
  all[jobId] = true;
  // 只留最近的，别越攒越多
  const keys = Object.keys(all).slice(-200);
  localStorage.setItem(REPORTED_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, true]))));
}

const isShanHengJob = (job: Job) => job.external?.kind === "shanheng";
const isOpen = (job: Job) => job.status === "queued" || job.status === "running";

/** 干完 / 失败 / 被这台电脑上的人停下的山衡活：交回山衡（每件只交一次） */
async function reportFinished() {
  const reported = loadReported();
  for (const job of loadJobs()) {
    if (!isShanHengJob(job) || isOpen(job) || reported[job.id]) continue;
    const taskId = job.external!.taskId;
    try {
      if (job.external!.stoppedByShanHeng || /Paw 被关掉了/.test(job.error || "")) {
        // 山衡那边取消了 / 被别的电脑领走了：不用回报。
        // Paw 被关掉时中断的：也不报卡住，山衡 15 分钟没心跳会让这台（或别的）电脑重新领
      } else if (job.status === "done") {
        await shanHeng.submit(taskId, (job.report || "").trim() || "（没有写报告）");
        useJobStore.getState().log(job.id, { kind: "system", text: "报告已交回山衡，等派活人验收" });
      } else {
        const reason = job.status === "cancelled" ? "这台电脑上的人让它停下了" : job.error || "中途出错了";
        await shanHeng.fail(taskId, reason);
        useJobStore.getState().log(job.id, { kind: "system", text: `已告诉山衡没干完：${reason}` });
      }
      markReported(job.id);
    } catch (error) {
      // 任务在山衡那边已经不是「进行中」了（取消了、被退回重领了）：不用再报
      if (error instanceof ShanHengError && error.status === 400) markReported(job.id);
      else useShanHengStore.getState().set({ status: "error", lastError: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function tick() {
  const config = loadShanHengConfig();
  const state = useShanHengStore.getState();
  if (!config.enabled || !shanHengReady(config)) {
    if (state.status !== "off") state.set({ status: "off", currentTaskId: null });
    return;
  }
  await reportFinished();
  const open = loadJobs().find((job) => isShanHengJob(job) && isOpen(job));
  if (open) return;
  try {
    const task = await shanHeng.claim();
    state.set({ lastSeenAt: Date.now(), lastError: "" });
    if (!task) {
      state.set({ status: "idle", currentTaskId: null });
      return;
    }
    const profile = await shanHeng.me().catch(() => null);
    const job = useJobStore.getState().create(briefOf(task, profile), `山衡 #${task.id} ${task.title}`.slice(0, 40), "shanheng");
    useJobStore.getState().update(job.id, { external: { kind: "shanheng", taskId: task.id } });
    useJobStore.getState().log(job.id, { kind: "system", text: `从山衡领到的活（任务 #${task.id}）` });
    state.set({ status: "working", currentTaskId: task.id });
  } catch (error) {
    state.set({ status: "error", lastError: error instanceof Error ? error.message : String(error) });
  }
}

async function beat() {
  const config = loadShanHengConfig();
  if (!config.enabled || !shanHengReady(config)) return;
  for (const job of loadJobs()) {
    if (!isShanHengJob(job) || !isOpen(job)) continue;
    try {
      const { status } = await shanHeng.heartbeat(job.external!.taskId);
      if (status !== "running") {
        useJobStore.getState().update(job.id, (current) => ({ external: { ...current.external!, stoppedByShanHeng: true } }));
        useJobStore.getState().log(job.id, { kind: "system", text: "山衡那边这件活已经不用干了（取消了或者换人了），停下" });
        useJobStore.getState().cancel(job.id);
      }
    } catch {
      // 暂时连不上不打断干活：山衡 15 分钟没心跳才会让别的电脑重新领
    }
  }
}

/** 在桌宠窗口里挂一个（工作任务也在那里跑） */
export function useShanHengWorker() {
  useEffect(() => {
    const poll = window.setInterval(() => void tick(), POLL_MS);
    const first = window.setTimeout(() => void tick(), 5_000);
    const heart = window.setInterval(() => void beat(), HEARTBEAT_MS);
    // 工作干完马上交，不用等下一次轮询
    const unsubscribe = useJobStore.subscribe((state, prev) => {
      const finished = state.jobs.some((job) => isShanHengJob(job) && !isOpen(job) && prev.jobs.find((p) => p.id === job.id && isOpen(p)));
      if (finished) window.setTimeout(() => void tick(), 300);
    });
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(first);
      window.clearInterval(heart);
      unsubscribe();
    };
  }, []);
}
