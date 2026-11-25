import { useEffect } from "react";
import { create } from "zustand";
import { loadJobs, useJobStore, type Job } from "./jobs";
import { callMcpToolJson, isWorkerServer, loadMcpServers, loadMcpState, newMcpServerId, useMcpStore } from "./mcpServers";

/**
 * 员工模式：这台电脑给别的系统当 AI 员工。活经 MCP 来，不绑哪一家：
 * 各家（山衡、见山、移山……）在自己的 MCP 里提供约定好名字的员工协议工具（claim_task、submit_task……），
 * 在「MCP 服务」里接上它们，这里勾成工作来源就行，接几家都行。
 *
 * 常驻在桌宠窗口里：每 15 秒挨个问一圈勾上的来源（从上次轮到的下一家开始），领到就变成一项「工作」
 * （工作台 →「工作」里能看到日志），干完用同一个 MCP 把报告交回去（派活人验收），出错报卡住；
 * 干活期间每分钟报一次心跳，那边取消了就停手。一次只干一件。
 *
 * 找同事（list_colleagues、ask_colleague）是那个 MCP 服务的普通只读工具，模型本来就能用；
 * 领活、交付这几个工具不给模型（见 mcpServers.ts 的 WORKER_LOOP_TOOLS）。
 * 跟 @shan/ai 的 runWorker / mcpWorkerSource 是同一个协议。
 */

const CONFIG_KEY = "paw_worker_mode";
const REPORTED_KEY = "paw_worker_reported";
/** 0.2.2 只能连山衡时的设置，升级后自动转成一个 MCP 服务 */
const LEGACY_KEY = "paw_shanheng_worker";
const POLL_MS = 15_000;
const HEARTBEAT_MS = 60_000;

export interface WorkerModeConfig {
  enabled: boolean;
  /** 勾上当工作来源的 MCP 服务 */
  serverIds: string[];
}

export function loadWorkerConfig(): WorkerModeConfig {
  migrateLegacy();
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { enabled: Boolean(saved.enabled), serverIds: Array.isArray(saved.serverIds) ? saved.serverIds : [] };
  } catch {
    return { enabled: false, serverIds: [] };
  }
}

export function saveWorkerConfig(config: WorkerModeConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/** 0.2.2 的「山衡地址 + 接入密钥」转成一个 MCP 服务并勾上（只转一次） */
function migrateLegacy() {
  let legacy: { baseUrl?: string; key?: string; enabled?: boolean } | null = null;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
  } catch {}
  if (!legacy) return;
  localStorage.removeItem(LEGACY_KEY);
  const baseUrl = String(legacy.baseUrl || "").trim().replace(/\/+$/, "");
  const key = String(legacy.key || "").trim();
  if (!baseUrl || !key) return;
  const id = newMcpServerId();
  useMcpStore.getState().save({
    id,
    name: "山衡",
    transport: "http",
    enabled: true,
    url: `${baseUrl}/api/mcp`,
    headers: { Authorization: `Bearer ${key}` },
  });
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ enabled: Boolean(legacy.enabled), serverIds: [id] }));
  void useMcpStore.getState().refresh(id);
}

/** 现在能当工作来源的服务：接好了、开着、带员工协议 */
export function workerCapableServers() {
  const state = loadMcpState();
  return loadMcpServers().filter((server) => server.enabled && isWorkerServer(state[server.id]));
}

// ─────────────────────────── 协议 ───────────────────────────

export interface WorkerTask {
  id: number;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  priority?: string;
  dueAt?: string | null;
  relatedTable?: string | null;
  relatedRecordId?: number | null;
  ownerName?: string | null;
  instructions?: string[];
  previousResult?: string | null;
  reviewComment?: string | null;
}

interface WorkerProfile {
  name: string;
  department?: string | null;
  title?: string | null;
  duties?: string | null;
  systemPrompt?: string | null;
}

/** 把领到的活写成交给桌宠的工作目标 */
export function briefOf(task: WorkerTask, serverName: string, profile?: WorkerProfile | null): string {
  const lines: string[] = [];
  if (profile) {
    const where = [profile.department, profile.title].filter(Boolean).join(" · ");
    lines.push(`你现在是「${serverName}」里的员工「${profile.name}」${where ? `（${where}）` : ""}，这是派给你的活。`);
    if (profile.duties) lines.push(`你的职责：${profile.duties}`);
    if (profile.systemPrompt) lines.push("", "你的人设：", profile.systemPrompt);
    lines.push("");
  }
  lines.push(`【${serverName} 任务 #${task.id}】${task.title}`);
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
    `不归你管、同事更在行的事，可以用 ${serverName} 的 list_colleagues 看同事通讯录、ask_colleague 当场问（同事只查不改；只问 ${serverName} 的同事）。`,
    "最后的报告就是交给派活人的交付内容：写清结论、做了什么、依据；有验收标准的逐条对照。"
  );
  return lines.join("\n");
}

// ─────────────────────────── 常驻循环 ───────────────────────────

interface SourceStatus {
  status: "idle" | "working" | "error";
  error?: string;
  taskId?: number;
  at: number;
}

interface WorkerModeState {
  /** 每个来源最近的情况，设置页里显示 */
  sources: Record<string, SourceStatus>;
  setSource: (id: string, status: SourceStatus) => void;
}

export const useWorkerModeStore = create<WorkerModeState>((set) => ({
  sources: {},
  setSource: (id, status) => set((state) => ({ sources: { ...state.sources, [id]: status } })),
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
  const keys = Object.keys(all).slice(-200);
  localStorage.setItem(REPORTED_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, true]))));
}

const isWorkerJob = (job: Job) => job.external?.kind === "mcp";
const isOpen = (job: Job) => job.status === "queued" || job.status === "running";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 干完 / 失败 / 被这台电脑上的人停下的活：交回领它的那一家（每件只交一次） */
async function reportFinished() {
  const reported = loadReported();
  for (const job of loadJobs()) {
    if (!isWorkerJob(job) || isOpen(job) || reported[job.id]) continue;
    const ext = job.external!;
    try {
      if (ext.stoppedByOwner || /Paw 被关掉了/.test(job.error || "")) {
        // 那边取消了 / 收回了：不用回报。Paw 被关掉中断的也不报卡住，那边 15 分钟没心跳会把活收回去重新派
      } else if (job.status === "done") {
        await callMcpToolJson(ext.serverId, "submit_task", { task_id: ext.taskId, result: (job.report || "").trim() || "（没有写报告）" });
        useJobStore.getState().log(job.id, { kind: "system", text: `报告已交回${ext.serverName}，等派活人验收` });
      } else {
        const reason = job.status === "cancelled" ? "这台电脑上的人让它停下了" : job.error || "中途出错了";
        await callMcpToolJson(ext.serverId, "report_task_stuck", { task_id: ext.taskId, reason: reason.slice(0, 480) });
        useJobStore.getState().log(job.id, { kind: "system", text: `已告诉${ext.serverName}没干完：${reason}` });
      }
      markReported(job.id);
    } catch (error) {
      const message = errorText(error);
      // 任务在那边已经不是「进行中」了（取消了、被收回重派了）、或者服务已经删掉了：不用再报
      if (/现在是「|没有这个任务|不是派给你|找不到这个 MCP 服务/.test(message)) markReported(job.id);
      else useWorkerModeStore.getState().setSource(ext.serverId, { status: "error", error: message, at: Date.now() });
    }
  }
}

let nextIndex = 0;

async function tick() {
  const config = loadWorkerConfig();
  if (!config.enabled) return;
  await reportFinished();
  if (loadJobs().some((job) => isWorkerJob(job) && isOpen(job))) return;
  const sources = workerCapableServers().filter((server) => config.serverIds.includes(server.id));
  const store = useWorkerModeStore.getState();
  for (let i = 0; i < sources.length; i++) {
    const server = sources[(nextIndex + i) % sources.length];
    try {
      const { task } = (await callMcpToolJson<{ task?: WorkerTask | null }>(server.id, "claim_task")) || {};
      if (!task) {
        store.setSource(server.id, { status: "idle", at: Date.now() });
        continue;
      }
      nextIndex = (nextIndex + i + 1) % sources.length;
      const profile = await callMcpToolJson<WorkerProfile>(server.id, "worker_profile").catch(() => null);
      const job = useJobStore.getState().create(briefOf(task, server.name, profile), `${server.name} #${task.id} ${task.title}`.slice(0, 40), "worker");
      useJobStore.getState().update(job.id, { external: { kind: "mcp", serverId: server.id, serverName: server.name, taskId: task.id } });
      useJobStore.getState().log(job.id, { kind: "system", text: `从${server.name}领到的活（任务 #${task.id}）` });
      store.setSource(server.id, { status: "working", taskId: task.id, at: Date.now() });
      return;
    } catch (error) {
      store.setSource(server.id, { status: "error", error: errorText(error), at: Date.now() });
    }
  }
}

async function beat() {
  if (!loadWorkerConfig().enabled) return;
  for (const job of loadJobs()) {
    if (!isWorkerJob(job) || !isOpen(job)) continue;
    const ext = job.external!;
    try {
      const { status } = (await callMcpToolJson<{ status?: string }>(ext.serverId, "report_task_progress", { task_id: ext.taskId })) || {};
      if (status && status !== "running") {
        useJobStore.getState().update(job.id, (current) => ({ external: { ...current.external!, stoppedByOwner: true } }));
        useJobStore.getState().log(job.id, { kind: "system", text: `${ext.serverName}那边这件活已经不用干了（取消了或者收回了），停下` });
        useJobStore.getState().cancel(job.id);
      }
    } catch {
      // 暂时连不上不打断干活：那边 15 分钟没心跳才会收回去
    }
  }
}

/** 在桌宠窗口里挂一个（工作任务也在那里跑） */
export function useWorkerMode() {
  useEffect(() => {
    const poll = window.setInterval(() => void tick(), POLL_MS);
    const first = window.setTimeout(() => void tick(), 5_000);
    const heart = window.setInterval(() => void beat(), HEARTBEAT_MS);
    // 工作干完马上交，不用等下一次轮询
    const unsubscribe = useJobStore.subscribe((state, prev) => {
      const finished = state.jobs.some((job) => isWorkerJob(job) && !isOpen(job) && prev.jobs.find((p) => p.id === job.id && isOpen(p)));
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
