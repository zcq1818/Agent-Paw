import { useEffect, useRef } from "react";
import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./kernel";
import { reduceToolRuns, toolActionLabel, summarizeArgs, type ToolEvent, type ToolRun } from "./toolEvents";
import { extractJson, quickComplete, quickModelAvailable } from "./llm";
import { allSkills, buildSkillMarkdown, parseSkillMarkdown, useSkillLibrary } from "./skillLibrary";
import { customSkillsStore } from "./customSkills";

/**
 * 工作任务：你交代一件事，桌宠在后台自己干，边干边记工作日志，干完写报告，再自己复盘。
 *
 * - 任务存在本机（localStorage），工作台“工作”页和桌宠窗口共用
 * - 只在桌宠窗口里执行（它一直开着），一次干一件，其他排队
 * - 复盘：干完后让模型回顾过程，提炼“下次怎么做更好”，写回用到的技能（没有就新建一个）
 */

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type StepStatus = "todo" | "doing" | "done" | "skipped";

export interface JobStep {
  text: string;
  status: StepStatus;
  note?: string;
}

export interface JobLogEntry {
  at: number;
  kind: "plan" | "step" | "note" | "tool" | "error" | "system";
  text: string;
  /** 工具结果等详细内容（截断保存） */
  detail?: string;
  ok?: boolean;
}

export interface JobReview {
  score: number;
  summary: string;
  wentWell: string[];
  problems: string[];
  lessons: string[];
  /** 经验写到了哪个技能 */
  skill?: { name: string; action: "updated" | "created" };
  /** 写技能失败或跳过的原因 */
  skillNote?: string;
  at: number;
}

export interface Job {
  id: string;
  title: string;
  goal: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  steps: JobStep[];
  log: JobLogEntry[];
  report?: string;
  error?: string;
  /** 用过的技能名 */
  skillsUsed?: string[];
  review?: JobReview;
  reviewing?: boolean;
  feedback?: { good: boolean; comment?: string; at: number };
  /** 从哪儿来的：工作台 / 聊天里交代的 */
  source?: "panel" | "chat";
}

const JOBS_KEY = "paw_jobs";
const MAX_JOBS = 60;
const MAX_LOG = 300;
const DETAIL_CHARS = 1500;
export const JOB_QUEUED_EVENT = "paw-job-queued";
export const JOB_FINISHED_EVENT = "paw-job-finished";

function loadJobs(): Job[] {
  try {
    const value = JSON.parse(localStorage.getItem(JOBS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveJobs(jobs: Job[]) {
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, MAX_JOBS)));
  } catch {}
}

interface JobStore {
  jobs: Job[];
  reload: () => void;
  create: (goal: string, title?: string, source?: Job["source"]) => Job;
  update: (id: string, patch: Partial<Job> | ((job: Job) => Partial<Job>)) => void;
  log: (id: string, entry: Omit<JobLogEntry, "at">) => void;
  remove: (id: string) => void;
  cancel: (id: string) => void;
  /** 照原样再干一次 */
  retry: (id: string) => Job | null;
}

function guessTitle(goal: string) {
  const first = goal.split(/\n/)[0].replace(/^(帮我|请|麻烦|你)/, "").trim();
  return first.length > 24 ? `${first.slice(0, 24)}…` : first || "未命名任务";
}

export const useJobStore = create<JobStore>((set, get) => ({
  jobs: loadJobs(),
  reload: () => set({ jobs: loadJobs() }),
  create: (goal, title, source = "panel") => {
    const job: Job = {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: title?.trim() || guessTitle(goal),
      goal: goal.trim(),
      status: "queued",
      createdAt: Date.now(),
      steps: [],
      log: [{ at: Date.now(), kind: "system", text: "任务已创建，排队等着开工" }],
      source,
    };
    const jobs = [job, ...loadJobs()];
    saveJobs(jobs);
    set({ jobs });
    emit(JOB_QUEUED_EVENT, { id: job.id }).catch(() => {});
    return job;
  },
  update: (id, patch) => {
    // 每次从 localStorage 读最新的再改：工作台和桌宠两个窗口都会写
    const jobs = loadJobs().map((job) => (job.id === id ? { ...job, ...(typeof patch === "function" ? patch(job) : patch) } : job));
    saveJobs(jobs);
    set({ jobs });
  },
  log: (id, entry) => {
    get().update(id, (job) => ({ log: [...job.log, { ...entry, at: Date.now() }].slice(-MAX_LOG) }));
  },
  remove: (id) => {
    const jobs = loadJobs().filter((job) => job.id !== id);
    saveJobs(jobs);
    set({ jobs });
  },
  cancel: (id) => {
    const job = loadJobs().find((item) => item.id === id);
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    get().update(id, { status: "cancelled", finishedAt: Date.now() });
    get().log(id, { kind: "system", text: "你让它停下了" });
  },
  retry: (id) => {
    const job = loadJobs().find((item) => item.id === id);
    return job ? get().create(job.goal, job.title, job.source) : null;
  },
}));

/** 其他窗口改了任务，重新读 */
export function useJobSync() {
  useEffect(() => {
    // 页面打开时先读一遍最新的：桌宠窗口在这之前可能已经改过
    useJobStore.getState().reload();
    const onStorage = (event: StorageEvent) => {
      if (event.key === JOBS_KEY || event.key === null) useJobStore.getState().reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}

export function jobProgress(job: Job) {
  const total = job.steps.length;
  const done = job.steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  const current = job.steps.find((step) => step.status === "doing");
  return { total, done, current };
}

// ───────────────────────── 执行 ─────────────────────────

const WORK_PROMPT = `## 工作模式
你现在在后台独立完成一项工作。用户不在旁边看，做完后会看你的工作日志和报告。

做法：
1. 先调用 work_plan 列出 3～8 个具体步骤（每步一句话，写清要做什么）。
2. 按步骤用工具实际去做，不要只写计划不动手。开始一步时 work_progress(状态 doing)，做完时 work_progress(状态 done，写一句做了什么、结果如何)。
3. 遇到问题先自己想办法：换方法、换关键词、查资料、读网页。不要原样重试同一个失败的操作。确实做不了的步骤标 skipped 并写原因。
4. 发现值得记下的信息（中间结论、找到的数据、重要链接）用 work_note 记一笔。
5. 会改动东西的操作（写文件、运行命令、发消息等）按应用的确认流程来；被拒绝就换一个不需要它的办法，或在报告里说明。
6. 不要停下来问用户问题等回答（用户看不到）：按最合理的假设去做，并在报告里写明假设。
7. 有相关技能时先用 use_skill 读说明，照着做。
8. 写报告这一步也要先 work_progress 标成 done。
9. 全部做完后，你最后的回复就是工作报告（Markdown），直接从“## 结果”开始，前面不要写过渡的话，按这个结构写：
## 结果
一两句话：做成了什么，结论是什么。
## 过程
按步骤说做了什么、用了什么、发现了什么。
## 产出
文件路径、链接、数据、成品内容（没有就省略这一节）。
## 没做完 / 需要你决定
（没有就省略这一节）`;

function workTools(jobId: string): Tool[] {
  const store = () => useJobStore.getState();
  return [
    {
      name: "work_plan",
      description: "工作模式：列出这项工作的步骤计划（开工前先调用；计划有变时可以再调用一次重排）。",
      parameters: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "string" }, description: "3～8 个步骤，每步一句话" },
        },
        required: ["steps"],
      },
      execute: async (args) => {
        const steps = (Array.isArray(args.steps) ? args.steps : [])
          .map((item: unknown) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 12);
        if (steps.length === 0) return "步骤不能为空。";
        const previous = loadJobs().find((job) => job.id === jobId)?.steps || [];
        store().update(jobId, {
          steps: steps.map((text: string) => {
            const old = previous.find((step) => step.text === text);
            return old ? old : { text, status: "todo" as StepStatus };
          }),
        });
        store().log(jobId, { kind: "plan", text: `定了 ${steps.length} 步计划`, detail: steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n") });
        return `计划已记下（${steps.length} 步）。现在开始第 1 步，记得用 work_progress 更新进度。`;
      },
    },
    {
      name: "work_progress",
      description: "工作模式：更新某一步的状态。开始做时 doing，做完 done（写一句结果），做不了 skipped（写原因）。",
      parameters: {
        type: "object",
        properties: {
          step: { type: "number", description: "第几步，从 1 开始" },
          status: { type: "string", enum: ["doing", "done", "skipped"] },
          note: { type: "string", description: "一句话：做了什么、结果如何，或跳过的原因" },
        },
        required: ["step", "status"],
      },
      execute: async (args) => {
        const index = Math.round(Number(args.step)) - 1;
        const status = String(args.status) as StepStatus;
        const note = String(args.note || "").trim();
        const job = loadJobs().find((item) => item.id === jobId);
        if (!job) return "任务不存在。";
        if (index < 0 || index >= job.steps.length) return `没有第 ${index + 1} 步，计划一共 ${job.steps.length} 步。`;
        if (!["doing", "done", "skipped"].includes(status)) return "状态只能是 doing / done / skipped。";
        store().update(jobId, (current) => ({
          steps: current.steps.map((step, i) => (i === index ? { ...step, status, note: note || step.note } : step)),
        }));
        const label = status === "doing" ? "开始" : status === "done" ? "完成" : "跳过";
        store().log(jobId, { kind: "step", text: `${label}第 ${index + 1} 步：${job.steps[index].text}${note ? ` —— ${note}` : ""}`, ok: status !== "skipped" });
        return "好。";
      },
    },
    {
      name: "work_note",
      description: "工作模式：在工作日志里记一笔（中间结论、找到的数据、重要链接、做的假设）。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "要记下的内容" } },
        required: ["text"],
      },
      execute: async (args) => {
        const text = String(args.text || "").trim();
        if (!text) return "内容不能为空。";
        store().log(jobId, { kind: "note", text: text.slice(0, 600) });
        return "记下了。";
      },
    },
  ];
}

const WORK_TOOL_NAMES = new Set(["work_plan", "work_progress", "work_note"]);

function trimDetail(text: string) {
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}

async function runJob(job: Job, signal: AbortSignal, onEvent: (job: Job) => void): Promise<Job> {
  const store = useJobStore.getState();
  store.update(job.id, { status: "running", startedAt: Date.now(), error: undefined });
  store.log(job.id, { kind: "system", text: "开工" });
  onEvent(loadJobs().find((item) => item.id === job.id) || job);

  let runs: ToolRun[] = [];
  const skillsUsed = new Set<string>();
  const onToolEvent = (event: ToolEvent) => {
    runs = reduceToolRuns(runs, event);
    if (event.type === "start" && event.name === "use_skill") {
      try {
        const name = String(JSON.parse(event.args || "{}").name || "").trim();
        if (name) skillsUsed.add(name);
      } catch {}
    }
    if (event.type === "finish" && !WORK_TOOL_NAMES.has(event.name)) {
      const run = runs.find((item) => item.id === event.id);
      const args = summarizeArgs(run?.args);
      useJobStore.getState().log(job.id, {
        kind: "tool",
        text: `${toolActionLabel(event.name)}${args ? `：${args}` : ""}`,
        detail: trimDetail(event.result || ""),
        ok: event.status === "done",
      });
    }
    if (event.type === "approval" && event.status !== "pending") {
      useJobStore.getState().log(job.id, { kind: "system", text: event.status === "done" ? "你批准了一个操作" : "你拒绝了一个操作", ok: event.status === "done" });
    }
  };

  const { streamChat } = await import("./kernel");
  const prompt = `【工作任务】${job.title}\n\n${job.goal}`;
  let report = "";
  try {
    report = await streamChat(
      { messages: [{ role: "user", content: prompt }], userMessage: job.goal },
      () => {},
      {
        signal,
        onToolEvent,
        background: true,
        systemExtra: WORK_PROMPT,
        extraTools: workTools(job.id),
        excludeTools: ["start_job"],
        maxRounds: 40,
      }
    );
    const latest = loadJobs().find((item) => item.id === job.id);
    if (latest?.status === "cancelled") return latest;
    // 报告前面常夹着干活时的过渡话（“我去查一下…”），只留从“## 结果”开始的正式报告
    const text = report.trim();
    const start = text.search(/^##\s*结果/m);
    const cleanReport = start > 0 ? text.slice(start) : text;
    useJobStore.getState().update(job.id, (current) => {
      const lastDone = current.steps.reduce((last, step, i) => (step.status === "done" ? i : last), -1);
      return {
        status: "done",
        finishedAt: Date.now(),
        report: cleanReport,
        skillsUsed: [...skillsUsed],
        steps: current.steps.map((step, i) => {
          if (step.status === "doing") return { ...step, status: "done" };
          // 收尾的“写报告 / 汇总”这类步骤，报告交出来就算做完了；其他没做的步骤保持原样
          if (step.status === "todo" && i > lastDone && /报告|汇总|总结|撰写|整理成|输出/.test(step.text)) {
            return { ...step, status: "done", note: step.note || "报告已交" };
          }
          return step;
        }),
      };
    });
    useJobStore.getState().log(job.id, { kind: "system", text: "干完了，写好了报告" });
  } catch (error) {
    const latest = loadJobs().find((item) => item.id === job.id);
    if (signal.aborted || latest?.status === "cancelled") {
      useJobStore.getState().update(job.id, { status: "cancelled", finishedAt: Date.now(), skillsUsed: [...skillsUsed] });
      return loadJobs().find((item) => item.id === job.id) || job;
    }
    const message = error instanceof Error ? error.message : String(error);
    useJobStore.getState().update(job.id, { status: "failed", finishedAt: Date.now(), error: message, skillsUsed: [...skillsUsed] });
    useJobStore.getState().log(job.id, { kind: "error", text: `出错停下了：${message}`, ok: false });
  }
  return loadJobs().find((item) => item.id === job.id) || job;
}

// ───────────────────────── 复盘 ─────────────────────────

const REVIEW_SYSTEM = "你是一个认真的员工，正在给自己刚做完的一项工作做复盘。只输出 JSON，不要输出别的。";

function reviewPrompt(job: Job) {
  const steps = job.steps.map((step, i) => `${i + 1}. [${step.status}] ${step.text}${step.note ? ` —— ${step.note}` : ""}`).join("\n");
  const log = job.log
    .filter((entry) => entry.kind === "tool" || entry.kind === "error" || entry.kind === "note")
    .slice(-40)
    .map((entry) => `- ${entry.ok === false ? "✗" : "✓"} ${entry.text}${entry.ok === false && entry.detail ? `（${entry.detail.slice(0, 160)}）` : ""}`)
    .join("\n");
  const feedback = job.feedback
    ? `\n用户对结果的评价：${job.feedback.good ? "满意" : "不满意"}${job.feedback.comment ? `，原话：“${job.feedback.comment}”` : ""}。这是最重要的信号，经验教训要优先针对用户的意见。`
    : "";
  return `工作任务：${job.title}
要求：${job.goal}
最终状态：${job.status}${job.error ? `（${job.error}）` : ""}
用到的技能：${job.skillsUsed?.join("、") || "无"}

计划和完成情况：
${steps || "（没有列计划）"}

工具调用记录（✓ 成功 ✗ 失败）：
${log || "（没有调用工具）"}

工作报告：
${(job.report || "（没有报告）").slice(0, 2500)}
${feedback}

请复盘，输出 JSON：
{
  "score": 1-5 的整数（这次完成得怎么样）,
  "summary": "一句话总结",
  "went_well": ["做得好的地方，0～3 条"],
  "problems": ["走了弯路或做错的地方，0～3 条，要具体"],
  "lessons": ["下次做同类工作时可以直接照做的经验，1～4 条，每条以动词开头，要具体可执行，比如“搜价格时关键词加上年份和型号”；不要写空话"],
  "skill": {
    "action": "update 或 create 或 none",
    "name": "update 时填用到的技能名；create 时起一个简短的新技能名",
    "description": "create 时填：这个技能做什么、什么时候用",
    "instructions": "create 时填：完整做法（Markdown，步骤+注意事项）"
  }
}
规则：用到了技能就 update 那个技能；没用技能、而这类工作以后很可能还会再做、并且这次做成了，才 create；其他情况 none。
简单的查询或计算（查个天气、算个数、一两步就做完的事）不要 create，选 none。`;
}

const LESSONS_HEADING = "## 经验教训";
const MAX_LESSONS = 15;

/** 把新经验并进 Markdown 正文里的“经验教训”一节（去重，最多留 15 条） */
function mergeLessons(body: string, lessons: string[]): string {
  const index = body.indexOf(LESSONS_HEADING);
  const before = index >= 0 ? body.slice(0, index).trimEnd() : body.trimEnd();
  const existing =
    index >= 0
      ? body
          .slice(index + LESSONS_HEADING.length)
          .split("\n")
          .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
          .filter(Boolean)
      : [];
  const merged = [...existing];
  for (const lesson of lessons) {
    if (!merged.some((item) => item === lesson || item.includes(lesson) || lesson.includes(item))) merged.push(lesson);
  }
  const kept = merged.slice(-MAX_LESSONS);
  return `${before}\n\n${LESSONS_HEADING}\n（做完工作后自动复盘写入的，可以手动修改）\n${kept
    .filter((line) => !line.startsWith("（做完工作后"))
    .map((line) => `- ${line}`)
    .join("\n")}\n`;
}

async function applyLessonsToSkill(
  review: { lessons: string[]; skill?: { action?: string; name?: string; description?: string; instructions?: string } },
  job: Job
): Promise<{ skill?: JobReview["skill"]; note?: string }> {
  const plan = review.skill;
  const lessons = review.lessons.filter(Boolean);
  if (!plan || plan.action === "none" || !plan.name) return {};
  await useSkillLibrary.getState().reload().catch(() => {});
  const name = plan.name.trim();
  const target = allSkills().find((skill) => skill.name.toLowerCase() === name.toLowerCase());

  if (plan.action === "update" || target) {
    if (!target) return { note: `没找到技能「${name}」，经验只留在这次复盘里。` };
    if (lessons.length === 0) return {};
    if (target.source === "app") {
      const id = target.key.replace(/^app:/, "");
      const skill = customSkillsStore.getById(id);
      if (!skill) return { note: `技能「${name}」不见了。` };
      customSkillsStore.update(id, { instructions: mergeLessons(skill.instructions || "", lessons) });
      return { skill: { name: target.name, action: "updated" } };
    }
    if (target.source !== "paw" || !target.dir || !target.raw) {
      return { note: `技能「${name}」在桌宠技能文件夹外面，没有改它。经验只留在这次复盘里。` };
    }
    const { meta, body } = parseSkillMarkdown(target.raw);
    const content = buildSkillMarkdown(meta.name || target.name, meta.description || target.description, mergeLessons(body, lessons));
    await invoke("skill_save", { name: target.name, content, existingDir: target.dir });
    await useSkillLibrary.getState().reload().catch(() => {});
    return { skill: { name: target.name, action: "updated" } };
  }

  if (plan.action === "create") {
    // 没做成的、两步就完的小事不值得沉淀成技能，免得技能越攒越乱
    if (job.status !== "done" || job.steps.length < 3) return {};
    const instructions = String(plan.instructions || "").trim();
    const description = String(plan.description || "").trim();
    if (!instructions || !description) return { note: "复盘建议新建技能，但说明不完整，没有建。" };
    const body = lessons.length ? mergeLessons(instructions, lessons) : instructions;
    await invoke("skill_save", { name, content: buildSkillMarkdown(name, description, body), existingDir: null });
    await useSkillLibrary.getState().reload().catch(() => {});
    return { skill: { name, action: "created" } };
  }
  return {};
}

/** 复盘一项工作；有用户评价时会重新复盘一次 */
export async function reviewJob(jobId: string): Promise<JobReview | null> {
  const job = loadJobs().find((item) => item.id === jobId);
  if (!job || !quickModelAvailable()) return null;
  if (job.status !== "done" && job.status !== "failed") return null;
  const store = useJobStore.getState();
  store.update(jobId, { reviewing: true });
  try {
    // 推理模型复盘时思考得多，上限给足；没按格式回答就再要一次
    let raw = await quickComplete(REVIEW_SYSTEM, reviewPrompt(job), { maxTokens: 8000, temperature: 0.4 });
    let parsed = extractJson<any>(raw);
    if (!parsed) {
      raw = await quickComplete(REVIEW_SYSTEM, `${reviewPrompt(job)}\n\n只输出一个 JSON 对象，不要任何解释；字符串里的换行写成 \\n。`, {
        maxTokens: 8000,
        temperature: 0.2,
      });
      parsed = extractJson<any>(raw);
    }
    if (!parsed) {
      store.update(jobId, { reviewing: false });
      store.log(jobId, { kind: "error", text: "复盘没成功（模型没按格式回答）", ok: false });
      return null;
    }
    const list = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4) : []);
    const lessons = list(parsed.lessons);
    let applied: { skill?: JobReview["skill"]; note?: string } = {};
    try {
      applied = await applyLessonsToSkill({ lessons, skill: parsed.skill }, job);
    } catch (error) {
      applied = { note: `写技能失败：${error}` };
    }
    const review: JobReview = {
      score: Math.max(1, Math.min(5, Math.round(Number(parsed.score) || 3))),
      summary: String(parsed.summary || "").trim(),
      wentWell: list(parsed.went_well),
      problems: list(parsed.problems),
      lessons,
      skill: applied.skill,
      skillNote: applied.note,
      at: Date.now(),
    };
    store.update(jobId, { review, reviewing: false });
    store.log(jobId, {
      kind: "system",
      text: `复盘完成${review.skill ? `，经验写进了技能「${review.skill.name}」${review.skill.action === "created" ? "（新建）" : ""}` : ""}`,
    });
    return review;
  } catch (error) {
    store.update(jobId, { reviewing: false });
    store.log(jobId, { kind: "error", text: `复盘出错：${error}`, ok: false });
    return null;
  }
}

/** 你对结果打分 / 提意见：记下来，并带着你的意见重新复盘 */
export async function giveFeedback(jobId: string, good: boolean, comment?: string) {
  useJobStore.getState().update(jobId, { feedback: { good, comment: comment?.trim() || undefined, at: Date.now() } });
  useJobStore.getState().log(jobId, { kind: "system", text: `你的评价：${good ? "👍" : "👎"}${comment?.trim() ? ` ${comment.trim()}` : ""}` });
  return reviewJob(jobId);
}

// ───────────────────────── 桌宠窗口里的执行器 ─────────────────────────

interface RunnerOptions {
  /** 开工、干完时告诉用户 */
  onStart?: (job: Job) => void;
  onFinish?: (job: Job) => void;
}

/** 在桌宠窗口里挂一个：有排队的任务就一件件干 */
export function useJobRunner({ onStart, onFinish }: RunnerOptions) {
  const optionsRef = useRef({ onStart, onFinish });
  optionsRef.current = { onStart, onFinish };

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let controller: AbortController | null = null;
    let currentId = "";

    // 上次没干完就被关掉的任务：标成中断
    for (const job of loadJobs()) {
      if (job.status === "running") {
        useJobStore.getState().update(job.id, { status: "failed", finishedAt: Date.now(), error: "Paw 被关掉了，任务中断" });
      }
    }

    const pump = async () => {
      if (disposed || busy) return;
      const next = [...loadJobs()].reverse().find((job) => job.status === "queued");
      if (!next) return;
      busy = true;
      controller = new AbortController();
      currentId = next.id;
      try {
        const finished = await runJob(next, controller.signal, (job) => optionsRef.current.onStart?.(job));
        if (disposed) return;
        if (finished.status === "done" || finished.status === "failed") {
          optionsRef.current.onFinish?.(finished);
          emit(JOB_FINISHED_EVENT, { id: finished.id, status: finished.status }).catch(() => {});
          await reviewJob(finished.id);
        }
      } finally {
        busy = false;
        controller = null;
        currentId = "";
        if (!disposed) window.setTimeout(pump, 500);
      }
    };

    // 工作台点了“停止”：任务状态变成 cancelled，这里看到就中止
    const unsubscribe = useJobStore.subscribe((state) => {
      if (!currentId || !controller) return;
      const job = state.jobs.find((item) => item.id === currentId);
      if (job?.status === "cancelled") controller.abort();
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === JOBS_KEY || event.key === null) {
        useJobStore.getState().reload();
        void pump();
      }
    };
    window.addEventListener("storage", onStorage);
    let unlisten: (() => void) | undefined;
    listen(JOB_QUEUED_EVENT, () => {
      useJobStore.getState().reload();
      void pump();
    })
      .then((fn) => (disposed ? fn() : (unlisten = fn)))
      .catch(() => {});
    const timer = window.setInterval(pump, 15_000);
    const startup = window.setTimeout(pump, 3000);

    return () => {
      disposed = true;
      controller?.abort();
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      unlisten?.();
      window.clearInterval(timer);
      window.clearTimeout(startup);
    };
  }, []);
}

// ───────────────────────── 聊天里用的工具 ─────────────────────────

function statusText(status: JobStatus) {
  return { queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已停止" }[status];
}

/** 从工作报告里取“结果”一节，聊天和气泡里用 */
export function reportHeadline(report?: string) {
  if (!report) return "";
  const match = /##\s*结果\s*\n+([\s\S]*?)(?:\n##\s|$)/.exec(report);
  const text = (match ? match[1] : report).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function getJobTools(): Tool[] {
  return [
    {
      name: "start_job",
      description:
        "把一件需要很多步、要花一段时间的事交给后台工作模式去做（比如调研整理、批量处理文件、查资料写报告）。它会自己列计划、一步步做、记工作日志、写报告并复盘。用户说“交给你干 / 你自己去做 / 帮我搞定…”或任务明显很长时使用；简单问题直接回答，不要用。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务名，十个字左右" },
          goal: { type: "string", description: "完整的任务要求：要做什么、做到什么程度、有什么要求或限制（把用户说的细节都写进去）" },
        },
        required: ["goal"],
      },
      execute: async (args) => {
        const goal = String(args.goal || "").trim();
        if (!goal) return "任务要求不能为空。";
        const queued = loadJobs().filter((job) => job.status === "queued" || job.status === "running").length;
        const job = useJobStore.getState().create(goal, String(args.title || ""), "chat");
        return `已创建工作任务「${job.title}」${queued ? `，前面还有 ${queued} 件在做或排队` : "，马上开工"}。用户可以在工作台“工作”页看进度和工作日志，做完桌宠会冒泡告诉他。告诉用户你接下了，不用等结果。`;
      },
    },
    {
      name: "get_jobs",
      description: "查看后台工作任务的进度和结果（用户问“那个任务干得怎么样了 / 做完了吗 / 报告呢”时用）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "按任务名或内容找，不填就列最近的" },
        },
      },
      execute: async (args) => {
        const query = String(args.query || "").trim().toLowerCase();
        const jobs = loadJobs()
          .filter((job) => !query || `${job.title} ${job.goal}`.toLowerCase().includes(query))
          .slice(0, 5);
        if (jobs.length === 0) return query ? `没找到和“${query}”有关的工作任务。` : "还没有工作任务。";
        return jobs
          .map((job) => {
            const progress = jobProgress(job);
            const lines = [`### ${job.title}（${statusText(job.status)}${progress.total ? `，${progress.done}/${progress.total} 步` : ""}）`, `要求：${job.goal.slice(0, 200)}`];
            if (progress.current) lines.push(`正在做：${progress.current.text}`);
            if (job.report) lines.push(`报告：\n${job.report.slice(0, 1500)}`);
            if (job.error) lines.push(`出错：${job.error}`);
            if (job.review) lines.push(`复盘：${job.review.summary}；经验：${job.review.lessons.join("；")}`);
            return lines.join("\n");
          })
          .join("\n\n");
      },
    },
  ];
}
