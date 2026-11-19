import { create } from "zustand";
import { useEffect } from "react";
import { fetchExternal } from "./http";
import { extractJson, quickComplete, quickModelAvailable } from "./llm";

/**
 * CNB 协作：读 cnb.cool 上的仓库 → 提出问题建 Issue → @CodeBuddy（工作模式）去改 → Paw 审核它开的 PR。
 *
 * 只走 CNB 官方 OpenAPI（https://api.cnb.cool，Bearer 访问令牌）。
 * 令牌只存在本机 localStorage，只发给 api.cnb.cool，不会进模型的提示词或工具结果。
 * 合并 PR 永远由用户自己在 CNB 上点，Paw 不合并。
 */

const API = "https://api.cnb.cool";
const WEB = "https://cnb.cool";
const CONFIG_KEY = "paw_cnb";
const TASKS_KEY = "paw_cnb_tasks";
const MAX_TASKS = 80;
export const CNB_NPC = "CodeBuddy";

export interface CnbConfig {
  token: string;
  /** 组织/仓库，例如 zcq18/Agent-Paw */
  repo: string;
  /** NPC 开出 PR 后自动用当前模型审核并把意见发到 PR 上 */
  autoReview: boolean;
  /** 审核不通过时自动让 NPC 按意见再改的轮数上限（0 = 不自动返工） */
  maxRounds: number;
}

const DEFAULT_CONFIG: CnbConfig = { token: "", repo: "", autoReview: true, maxRounds: 2 };

export function loadCnbConfig(): CnbConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveCnbConfig(config: CnbConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...config, repo: normalizeRepo(config.repo), token: config.token.trim() }));
}

/** 接受 “组织/仓库”、仓库网址或带 .git 的地址 */
export function normalizeRepo(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/cnb\.cool\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/-\/.*$/, "")
    .replace(/^\/+|\/+$/g, "");
}

export function cnbReady(config = loadCnbConfig()) {
  return Boolean(config.token && config.repo);
}

export const repoUrl = (repo: string) => `${WEB}/${repo}`;
export const issueUrl = (repo: string, n: number) => `${WEB}/${repo}/-/issues/${n}`;
export const pullUrl = (repo: string, n: number) => `${WEB}/${repo}/-/pulls/${n}`;

function encodeRepo(repo: string) {
  return repo.split("/").map(encodeURIComponent).join("/");
}

export class CnbError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

async function cnbApi<T = any>(path: string, init: { method?: string; body?: unknown; config?: CnbConfig; accept?: string } = {}): Promise<T> {
  const config = init.config || loadCnbConfig();
  if (!config.token) throw new CnbError("还没填 CNB 访问令牌");
  let resp: Response;
  try {
    resp = await fetchExternal(`${API}${path}`, {
      method: init.method || "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: init.accept || "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    throw new CnbError(`连不上 CNB：${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    let message = text.slice(0, 200);
    try {
      const data = JSON.parse(text);
      message = data.errmsg || data.message || message;
    } catch {
      /* 非 JSON 错误体 */
    }
    if (resp.status === 401) message = "访问令牌无效或已过期";
    if (resp.status === 403) message = `令牌权限不够（${message}）`;
    if (resp.status === 404) message = `找不到（${message}）`;
    throw new CnbError(message || `HTTP ${resp.status}`, resp.status);
  }
  if (init.accept && init.accept !== "application/json") return text as T;
  return (text ? JSON.parse(text) : null) as T;
}

/* ------------------------------ 基础接口 ------------------------------ */

/** 以“能读这个仓库的 Issue 和代码”为准；用户信息要 account-profile 权限，拿不到也不算失败 */
export async function checkConnection(config: CnbConfig): Promise<string> {
  const repo = normalizeRepo(config.repo);
  if (!repo) throw new CnbError("还没填仓库");
  await cnbApi(`/${encodeRepo(repo)}/-/issues?page_size=1`, { config });
  await cnbApi(`/${encodeRepo(repo)}/-/git/contents`, { config });
  const user = await cnbApi<{ username?: string; nickname?: string }>("/user", { config }).catch(() => null);
  return `连接正常${user ? `：${user.nickname || user.username}` : ""} · ${repo}`;
}

interface ContentEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
}

async function listDir(repo: string, path = ""): Promise<ContentEntry[]> {
  const url = path ? `/${encodeRepo(repo)}/-/git/contents/${path.split("/").map(encodeURIComponent).join("/")}` : `/${encodeRepo(repo)}/-/git/contents`;
  const data = await cnbApi<{ entries?: ContentEntry[] }>(url);
  return Array.isArray(data?.entries) ? data.entries : [];
}

/** 文件超过 max_in_byte 时 CNB 直接返回 413 而不是截断，所以上限放宽，在本地截断 */
export async function readFile(repo: string, path: string, maxChars = 20000): Promise<string> {
  const text = await cnbApi<string>(`/${encodeRepo(repo)}/-/git/raw/HEAD/${path.split("/").map(encodeURIComponent).join("/")}?max_in_byte=1000000`, {
    accept: "text/plain",
  });
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text;
}

export interface CnbIssue {
  number: number;
  title: string;
  state: string;
  body?: string;
}

export async function listIssues(repo: string, state: "open" | "closed" = "open", pageSize = 30): Promise<CnbIssue[]> {
  const data = await cnbApi<any[]>(`/${encodeRepo(repo)}/-/issues?state=${state}&page_size=${pageSize}&order_by=-updated_at`);
  return (data || []).map((item) => ({ number: Number(item.number), title: item.title, state: item.state, body: item.body }));
}

const SKIP_DIRS = /^(node_modules|dist|build|target|\.git|vendor|\.next|out|coverage|public)$/i;
const KEY_FILES = /^(readme(\.[a-z]+)?|package\.json|cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|pom\.xml|composer\.json)$/i;

/** 仓库快照：两层目录 + README 和依赖清单，给模型找问题用 */
export async function repoSnapshot(repo: string): Promise<string> {
  const root = await listDir(repo);
  const lines: string[] = [];
  const keyFiles: string[] = [];
  for (const entry of root.slice(0, 80)) {
    const isDir = entry.type === "tree" || entry.type === "dir";
    lines.push(`${entry.path}${isDir ? "/" : ""}`);
    if (!isDir && KEY_FILES.test(entry.name)) keyFiles.push(entry.path);
    if (isDir && !SKIP_DIRS.test(entry.name) && !entry.name.startsWith(".")) {
      try {
        const children = await listDir(repo, entry.path);
        for (const child of children.slice(0, 40)) {
          const childDir = child.type === "tree" || child.type === "dir";
          lines.push(`  ${child.path}${childDir ? "/" : ""}`);
        }
      } catch {
        /* 子目录读不到就跳过 */
      }
    }
  }
  const parts = [`# 仓库 ${repo} 的目录（两层）\n${lines.join("\n")}`];
  for (const path of keyFiles.slice(0, 3)) {
    try {
      const text = await readFile(repo, path, 8000);
      parts.push(`# ${path}\n${text.slice(0, 6000)}`);
    } catch {
      /* 读不到就跳过 */
    }
  }
  return parts.join("\n\n");
}

/* ------------------------------ 任务 ------------------------------ */

export type CnbTaskStatus = "new" | "working" | "review" | "approved" | "done" | "failed";

export interface CnbReview {
  verdict: "approve" | "request_changes";
  summary: string;
  problems: string[];
  sha?: string;
  posted?: boolean;
  at: number;
}

export interface CnbTaskEvent {
  at: number;
  text: string;
}

export interface CnbTask {
  id: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  status: CnbTaskStatus;
  createdAt: number;
  updatedAt: number;
  prNumber?: number;
  prTitle?: string;
  /** NPC 最近一次回复（截断） */
  npcReply?: string;
  review?: CnbReview;
  /** 已经自动让 NPC 返工了几轮 */
  rounds: number;
  reviewing?: boolean;
  error?: string;
  events: CnbTaskEvent[];
}

function loadTasks(): CnbTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveTasks(tasks: CnbTask[]) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks.slice(0, MAX_TASKS)));
}

interface CnbTaskState {
  tasks: CnbTask[];
  reload: () => void;
  add: (task: CnbTask) => void;
  update: (id: string, patch: Partial<CnbTask> | ((task: CnbTask) => Partial<CnbTask>)) => CnbTask | undefined;
  remove: (id: string) => void;
}

export const useCnbStore = create<CnbTaskState>((set) => ({
  tasks: loadTasks(),
  reload: () => set({ tasks: loadTasks() }),
  add: (task) => {
    const tasks = [task, ...loadTasks()];
    saveTasks(tasks);
    set({ tasks });
  },
  // 宠物窗口和工作台都会写，每次先读最新的再改
  update: (id, patch) => {
    let updated: CnbTask | undefined;
    const tasks = loadTasks().map((task) => {
      if (task.id !== id) return task;
      const change = typeof patch === "function" ? patch(task) : patch;
      updated = { ...task, ...change, updatedAt: Date.now() };
      return updated;
    });
    saveTasks(tasks);
    set({ tasks });
    return updated;
  },
  remove: (id) => {
    const tasks = loadTasks().filter((task) => task.id !== id);
    saveTasks(tasks);
    set({ tasks });
  },
}));

export function useCnbSync() {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === TASKS_KEY) useCnbStore.getState().reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}

function addEvent(id: string, text: string) {
  useCnbStore.getState().update(id, (task) => ({ events: [...task.events, { at: Date.now(), text }].slice(-40) }));
}

function npcMention(request: string) {
  return `@${CNB_NPC} ${request}`;
}

/** 建 Issue；summon=true 时正文末尾 @CodeBuddy 并开工作模式，NPC 会直接开工 */
export async function createTask(input: { title: string; body: string; summon: boolean; repo?: string }): Promise<CnbTask> {
  const config = loadCnbConfig();
  const repo = normalizeRepo(input.repo || config.repo);
  if (!repo) throw new CnbError("还没选仓库");
  const body = input.summon
    ? `${input.body.trim()}\n\n${npcMention("帮我实现这个 Issue：新开分支修改，完成后发 PR 到默认分支，PR 描述里写上 Ref #本 Issue。")}`
    : input.body.trim();
  const issue = await cnbApi<{ number: string | number }>(`/${encodeRepo(repo)}/-/issues`, {
    method: "POST",
    body: { title: input.title.trim(), body, work_mode: input.summon },
  });
  const now = Date.now();
  const task: CnbTask = {
    id: `cnb_${now}_${Math.random().toString(36).slice(2, 7)}`,
    repo,
    issueNumber: Number(issue.number),
    title: input.title.trim(),
    body: input.body.trim(),
    status: input.summon ? "working" : "new",
    createdAt: now,
    updatedAt: now,
    rounds: 0,
    events: [{ at: now, text: input.summon ? `建了 Issue #${issue.number}，已召唤 ${CNB_NPC}（工作模式）` : `建了 Issue #${issue.number}` }],
  };
  useCnbStore.getState().add(task);
  return task;
}

/** 把已有 Issue 交给 NPC（在 Issue 下发一条 @CodeBuddy 评论，开工作模式） */
export async function summonNpc(taskId: string, extra = ""): Promise<void> {
  const task = useCnbStore.getState().tasks.find((item) => item.id === taskId);
  if (!task) return;
  const request = extra.trim() || "帮我实现这个 Issue：新开分支修改，完成后发 PR 到默认分支，PR 描述里写上 Ref 本 Issue。";
  await cnbApi(`/${encodeRepo(task.repo)}/-/issues/${task.issueNumber}/comments`, {
    method: "POST",
    body: { body: npcMention(request), work_mode: true },
  });
  useCnbStore.getState().update(taskId, { status: "working", error: undefined });
  addEvent(taskId, `已召唤 ${CNB_NPC} 开工`);
}

/** 关注已有 Issue（不建新的） */
export async function trackIssue(number: number, repo?: string): Promise<CnbTask> {
  const config = loadCnbConfig();
  const target = normalizeRepo(repo || config.repo);
  const existing = useCnbStore.getState().tasks.find((task) => task.repo === target && task.issueNumber === number);
  if (existing) return existing;
  const issue = await cnbApi<any>(`/${encodeRepo(target)}/-/issues/${number}`);
  const now = Date.now();
  const task: CnbTask = {
    id: `cnb_${now}_${Math.random().toString(36).slice(2, 7)}`,
    repo: target,
    issueNumber: number,
    title: issue.title,
    body: issue.body || "",
    status: issue.state === "closed" ? "done" : "new",
    createdAt: now,
    updatedAt: now,
    rounds: 0,
    events: [{ at: now, text: `开始跟进 Issue #${number}` }],
  };
  useCnbStore.getState().add(task);
  await refreshTask(task.id);
  return task;
}

const PR_LINK = /\/-\/pulls\/(\d+)/;

interface PullInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  sha: string;
}

async function getPull(repo: string, number: number): Promise<PullInfo> {
  const pr = await cnbApi<any>(`/${encodeRepo(repo)}/-/pulls/${number}`);
  return {
    number,
    title: pr.title || "",
    body: pr.body || "",
    state: pr.state || "",
    merged: Boolean(pr.is_merged),
    sha: pr.head?.sha || "",
  };
}

/** 找 NPC 为这个 Issue 开的 PR：先看 NPC 在 Issue 里的回复，再看 PR 描述里是否引用了本 Issue */
async function findLinkedPull(task: CnbTask): Promise<{ number?: number; npcReply?: string }> {
  const comments = await cnbApi<any[]>(`/${encodeRepo(task.repo)}/-/issues/${task.issueNumber}/comments?sort=-created&page_size=30`);
  let npcReply: string | undefined;
  for (const comment of comments || []) {
    if (!comment?.author?.is_npc) continue;
    npcReply ??= String(comment.body || "").slice(0, 600);
    const match = String(comment.body || "").match(PR_LINK);
    if (match) return { number: Number(match[1]), npcReply };
  }
  const pulls = await cnbApi<any[]>(`/${encodeRepo(task.repo)}/-/pulls?state=all&page_size=30&order_by=-created_at`);
  const ref = new RegExp(`(^|[^\\d])#${task.issueNumber}(?!\\d)`);
  const hit = (pulls || []).find((pr) => ref.test(String(pr.body || "")) || String(pr.body || "").includes(`/-/issues/${task.issueNumber}`));
  return { number: hit ? Number(hit.number) : undefined, npcReply };
}

const refreshing = new Set<string>();

/** 拉一次最新进展：Issue 状态、NPC 回复、PR、是否合并；需要时自动审核 */
export async function refreshTask(taskId: string): Promise<CnbTask | undefined> {
  if (refreshing.has(taskId)) return useCnbStore.getState().tasks.find((task) => task.id === taskId);
  refreshing.add(taskId);
  const store = useCnbStore.getState();
  try {
    let task = store.tasks.find((item) => item.id === taskId);
    if (!task || task.status === "done") return task;

    const linked = await findLinkedPull(task);
    if (task.error) task = store.update(taskId, { error: undefined }) || task;
    if (linked.npcReply && linked.npcReply !== task.npcReply) {
      task = store.update(taskId, { npcReply: linked.npcReply }) || task;
      if (!linked.number) addEvent(taskId, `${CNB_NPC} 回复了`);
    }

    const prNumber = task.prNumber || linked.number;
    if (!prNumber) {
      const issue = await cnbApi<any>(`/${encodeRepo(task.repo)}/-/issues/${task.issueNumber}`);
      if (issue?.state === "closed") {
        store.update(taskId, { status: "done" });
        addEvent(taskId, "Issue 已关闭");
      }
      return useCnbStore.getState().tasks.find((item) => item.id === taskId);
    }

    const pull = await getPull(task.repo, prNumber);
    if (!task.prNumber) {
      task = store.update(taskId, { prNumber, prTitle: pull.title, status: "review" }) || task;
      addEvent(taskId, `${CNB_NPC} 开了 PR #${prNumber}：${pull.title}`);
    }
    if (pull.merged) {
      store.update(taskId, { status: "done", reviewing: false });
      addEvent(taskId, `PR #${prNumber} 已合并`);
      return useCnbStore.getState().tasks.find((item) => item.id === taskId);
    }
    if (pull.state === "closed") {
      store.update(taskId, { status: "failed", error: `PR #${prNumber} 被关闭了，没有合并` });
      return useCnbStore.getState().tasks.find((item) => item.id === taskId);
    }

    // 有新提交（NPC 返工后推了代码）且还没审过这一版 → 回到待审核
    const reviewedThisVersion = task.review?.sha && task.review.sha === pull.sha;
    if (!reviewedThisVersion && (task.status === "working" || task.status === "approved")) {
      task = store.update(taskId, { status: "review" }) || task;
      if (task.review) addEvent(taskId, `PR #${prNumber} 有新提交，等待重新审核`);
    }

    const config = loadCnbConfig();
    if (task.status === "review" && !reviewedThisVersion && config.autoReview && quickModelAvailable() && !task.reviewing) {
      await reviewTask(taskId, { post: true, autoRework: true });
    }
    return useCnbStore.getState().tasks.find((item) => item.id === taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.update(taskId, { error: message });
    return useCnbStore.getState().tasks.find((item) => item.id === taskId);
  } finally {
    refreshing.delete(taskId);
  }
}

/* ------------------------------ 审核 ------------------------------ */

const REVIEW_SYSTEM = `你是严格但务实的代码审核人，审核 AI 助手为一个 Issue 提交的 PR。
只根据给出的 Issue 和改动判断：改动是否解决了 Issue、有没有明显的 bug / 安全问题 / 越界修改（改了 Issue 没要求的东西）。
不要挑代码风格之类的小毛病。拿不准的不算问题。
只输出 JSON：{"verdict":"approve" 或 "request_changes","summary":"一句话结论","problems":["需要改的具体问题，每条说清楚在哪、为什么、怎么改"]}
verdict 为 approve 时 problems 为空数组。`;

const MAX_PATCH_TOTAL = 24000;

async function pullDiff(repo: string, number: number): Promise<string> {
  const files = await cnbApi<any[]>(`/${encodeRepo(repo)}/-/pulls/${number}/files`);
  let budget = MAX_PATCH_TOTAL;
  const parts: string[] = [];
  for (const file of files || []) {
    const header = `### ${file.filename}（${file.status}，+${file.additions ?? "?"} -${file.deletions ?? "?"}）`;
    const patch = String(file.patch || "（没有文本差异，可能是二进制文件）");
    const slice = patch.slice(0, Math.max(0, Math.min(6000, budget)));
    budget -= slice.length;
    parts.push(`${header}\n\`\`\`diff\n${slice}${slice.length < patch.length ? "\n…（已截断）" : ""}\n\`\`\``);
    if (budget <= 0) {
      parts.push(`…还有 ${(files || []).length - parts.length} 个文件没列出`);
      break;
    }
  }
  return parts.join("\n\n") || "（PR 没有改动文件）";
}

function formatReviewBody(review: CnbReview) {
  const head = review.verdict === "approve" ? "✅ Paw 审核通过" : "🔧 Paw 审核：需要修改";
  const problems = review.problems.length ? `\n\n${review.problems.map((item, index) => `${index + 1}. ${item}`).join("\n")}` : "";
  return `${head}\n\n${review.summary}${problems}`;
}

/**
 * 用当前模型审核 PR。post=true 时把结论发到 PR；
 * autoRework=true 且不通过、还没超过返工轮数时，@CodeBuddy 按意见返工。
 */
export async function reviewTask(taskId: string, { post = true, autoRework = false } = {}): Promise<CnbReview | undefined> {
  const store = useCnbStore.getState();
  let task = store.tasks.find((item) => item.id === taskId);
  if (!task?.prNumber) throw new CnbError("还没有 PR 可以审核");
  if (!quickModelAvailable()) throw new CnbError("审核要用 API 模型（设置 → 模型），本机 Claude / CodeBuddy 不能用于自动审核");
  store.update(taskId, { reviewing: true, error: undefined });
  try {
    const pull = await getPull(task.repo, task.prNumber);
    const diff = await pullDiff(task.repo, task.prNumber);
    const prompt = `## Issue #${task.issueNumber}：${task.title}\n${task.body || "（无正文）"}\n\n## PR #${task.prNumber}：${pull.title}\n${pull.body.slice(0, 2000)}\n\n## 改动\n${diff}`;
    let parsed: any = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      parsed = extractJson(await quickComplete(REVIEW_SYSTEM, prompt, { maxTokens: 4000, temperature: 0.2 }));
    }
    if (!parsed || (parsed.verdict !== "approve" && parsed.verdict !== "request_changes")) {
      throw new CnbError("模型没有给出有效的审核结论，可以再审一次");
    }
    const review: CnbReview = {
      verdict: parsed.verdict,
      summary: String(parsed.summary || "").slice(0, 500),
      problems: Array.isArray(parsed.problems) ? parsed.problems.map(String).slice(0, 10) : [],
      sha: pull.sha,
      at: Date.now(),
    };

    if (post) {
      const body = formatReviewBody(review);
      try {
        await cnbApi(`/${encodeRepo(task.repo)}/-/pulls/${task.prNumber}/reviews`, {
          method: "POST",
          body: { event: review.verdict === "approve" ? "approve" : "request_changes", body },
        });
      } catch {
        // 有的仓库不允许给这个 PR 打审核结论，退回到普通评论
        await cnbApi(`/${encodeRepo(task.repo)}/-/pulls/${task.prNumber}/comments`, { method: "POST", body: { body } });
      }
      review.posted = true;
    }

    task = store.update(taskId, {
      review,
      reviewing: false,
      status: review.verdict === "approve" ? "approved" : "review",
    });
    addEvent(taskId, review.verdict === "approve" ? `审核通过：${review.summary}` : `审核不通过：${review.summary}`);

    const config = loadCnbConfig();
    if (task && review.verdict === "request_changes" && autoRework && task.rounds < config.maxRounds) {
      await requestRework(taskId, review);
    }
    return review;
  } catch (error) {
    store.update(taskId, { reviewing: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** 在 PR 下 @CodeBuddy（工作模式）按审核意见返工 */
export async function requestRework(taskId: string, review?: CnbReview, note = ""): Promise<void> {
  const store = useCnbStore.getState();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task?.prNumber) throw new CnbError("还没有 PR");
  const items = review?.problems.length ? review.problems.map((item, index) => `${index + 1}. ${item}`).join("\n") : "";
  const request = [note.trim(), items ? `请按下面的审核意见修改这个 PR，改完推到同一个分支：\n${items}` : "请按上面的审核意见修改这个 PR，改完推到同一个分支。"]
    .filter(Boolean)
    .join("\n\n");
  await cnbApi(`/${encodeRepo(task.repo)}/-/pulls/${task.prNumber}/comments`, {
    method: "POST",
    body: { body: npcMention(request), work_mode: true },
  });
  store.update(taskId, (current) => ({ status: "working", rounds: current.rounds + 1 }));
  addEvent(taskId, `已让 ${CNB_NPC} 按意见返工（第 ${task.rounds + 1} 轮）`);
}

/* ------------------------------ 找问题 ------------------------------ */

export interface IssueProposal {
  title: string;
  body: string;
  priority?: string;
}

const SCAN_SYSTEM = `你是资深工程师，帮用户为一个代码仓库整理值得做的改进，每条都要能直接作为 Issue 交给 AI 编程助手去改。
要求：
- 每条范围小、目标清楚、能在一个 PR 里完成；不要“重构整个项目”这类大而空的事
- 优先：明显的 bug 风险、文档缺失或过时、安全隐患、易用性问题、缺少的小功能
- 不要和“已有 Issue”重复
- body 用中文写清楚：现状 / 要改成什么样 / 涉及哪些文件（按目录推测即可）/ 验收标准
只输出 JSON：{"issues":[{"title":"","body":"","priority":"P1|P2|P3"}]}，最多 6 条。`;

export async function proposeIssues(focus = "", repo?: string): Promise<IssueProposal[]> {
  if (!quickModelAvailable()) throw new CnbError("找问题要用 API 模型（设置 → 模型），本机 Claude / CodeBuddy 不能用在这里");
  const target = normalizeRepo(repo || loadCnbConfig().repo);
  if (!target) throw new CnbError("还没选仓库");
  const [snapshot, open] = await Promise.all([repoSnapshot(target), listIssues(target, "open", 50).catch(() => [])]);
  const existing = open.length ? open.map((issue) => `#${issue.number} ${issue.title}`).join("\n") : "（没有）";
  const prompt = `${snapshot}\n\n# 已有 Issue\n${existing}\n\n# 用户关注的方向\n${focus.trim() || "（没指定，自己判断）"}`;
  let parsed: any = null;
  for (let attempt = 0; attempt < 2 && !parsed?.issues; attempt += 1) {
    parsed = extractJson(await quickComplete(SCAN_SYSTEM, prompt, { maxTokens: 6000, temperature: 0.4 }));
  }
  const list = Array.isArray(parsed?.issues) ? parsed.issues : [];
  if (!list.length) throw new CnbError("模型没有给出有效的问题清单，可以再试一次或换个关注方向");
  return list
    .filter((item: any) => item?.title)
    .slice(0, 6)
    .map((item: any) => ({ title: String(item.title).slice(0, 120), body: String(item.body || ""), priority: item.priority ? String(item.priority) : undefined }));
}

/* ------------------------------ 后台跟进 ------------------------------ */

const ACTIVE: CnbTaskStatus[] = ["working", "review", "approved"];

/** 在宠物窗口里挂着：每分钟跟进一次在做的任务（NPC 开 PR、自动审核、合并后收尾） */
export function useCnbWatcher() {
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped || !cnbReady()) return;
      useCnbStore.getState().reload();
      const active = useCnbStore.getState().tasks.filter((task) => ACTIVE.includes(task.status));
      for (const task of active) {
        if (stopped) return;
        await refreshTask(task.id).catch(() => undefined);
      }
    };
    const first = window.setTimeout(tick, 8000);
    const timer = window.setInterval(tick, 60_000);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
}

/* ------------------------------ 聊天工具 ------------------------------ */

type ToolLike = { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> };

const STATUS_TEXT: Record<CnbTaskStatus, string> = {
  new: "新建",
  working: "NPC 在做",
  review: "待审核",
  approved: "审核通过、待你合并",
  done: "已完成",
  failed: "失败",
};

export function describeTask(task: CnbTask) {
  const pr = task.prNumber ? ` · PR #${task.prNumber}` : "";
  const review = task.review ? ` · 审核：${task.review.verdict === "approve" ? "通过" : "要修改"}（${task.review.summary}）` : "";
  return `#${task.issueNumber} ${task.title} —— ${STATUS_TEXT[task.status]}${pr}${review}`;
}

export function getCnbTools(): ToolLike[] {
  if (!cnbReady()) return [];
  return [
    {
      name: "cnb_list_issues",
      description: "列出当前绑定的 CNB 仓库里的 Issue（只读）",
      parameters: { type: "object", properties: { state: { type: "string", enum: ["open", "closed"] } } },
      execute: async (args) => {
        const config = loadCnbConfig();
        const issues = await listIssues(config.repo, args.state === "closed" ? "closed" : "open");
        if (!issues.length) return `${config.repo} 没有${args.state === "closed" ? "已关闭" : "打开"}的 Issue。`;
        return issues.map((issue) => `#${issue.number} ${issue.title}`).join("\n");
      },
    },
    {
      name: "cnb_create_task",
      description:
        "在 CNB 仓库建一个 Issue；summon=true 时同时召唤 CodeBuddy NPC（工作模式）去改代码并开 PR，之后 Paw 会自动审核。会先请用户确认。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue 标题" },
          body: { type: "string", description: "现状、要改成什么样、验收标准" },
          summon: { type: "boolean", description: "是否立即交给 CodeBuddy 去改，默认 true" },
        },
        required: ["title", "body"],
      },
      execute: async (args) => {
        const { confirmSystemAction } = await import("./tools");
        const config = loadCnbConfig();
        const summon = args.summon !== false;
        const title = String(args.title || "").trim();
        if (!title) return "缺少标题。";
        const ok = await confirmSystemAction(
          `在 CNB 仓库 ${config.repo} 建 Issue「${title}」${summon ? `，并交给 ${CNB_NPC} 去改` : ""}（公开仓库所有人可见）`,
          "network",
          { scope: "cnb_create_task", label: "在 CNB 建 Issue" }
        );
        if (!ok) return "用户取消了。";
        const task = await createTask({ title, body: String(args.body || ""), summon });
        return `已建 Issue #${task.issueNumber}：${issueUrl(task.repo, task.issueNumber)}${summon ? `。${CNB_NPC} 开工了，进展在工作台「CNB 协作」里看。` : ""}`;
      },
    },
    {
      name: "cnb_task_status",
      description: "查看 CNB 协作任务的进展（Issue、NPC 开的 PR、审核结论）",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const tasks = useCnbStore.getState().tasks.slice(0, 15);
        if (!tasks.length) return "还没有 CNB 协作任务。";
        return tasks.map(describeTask).join("\n");
      },
    },
  ];
}
