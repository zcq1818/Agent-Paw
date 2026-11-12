import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

/**
 * 软件操作流程：不用大模型，按固定步骤操作别的软件（每日签到、领积分、例行点击）。
 *
 * 找按钮分两路：
 * 1. 先读界面结构（UI Automation）——WorkBuddy 这类 Electron 应用能读到按钮名字，最准；
 * 2. 读不到（Trae 等 VS Code 系软件、自绘界面）就截窗口用 Windows 自带 OCR 认字，再点文字中心。
 *
 * 签到步骤是自适应的：看到「已签到 / 已领取」就结束；看到「立即领取 / 签到」就点；
 * 都没有就点入口（比如「Buddy加油站」）再看，最多几轮。每一步都写日志，结果说清楚。
 */

export type FlowStep =
  | { do: "open"; app: "workbuddy" | "trae"; path?: string }
  | { do: "launch"; target: string }
  | { do: "wait_window"; timeoutMs?: number }
  | { do: "wait"; ms: number }
  | { do: "click_text"; text: string[]; optional?: boolean }
  | { do: "keys"; keys: string }
  | {
      do: "checkin";
      claim: string[];
      done: string[];
      entry?: string[];
      maxRounds?: number;
      /** 这些文字都不在界面上时，说明当天的领取入口已经消失（领过了） */
      goneMeansDone?: string[];
    };

export interface UiFlow {
  id: string;
  name: string;
  /** 目标窗口的进程名（正则，不区分大小写） */
  process: string;
  steps: FlowStep[];
  builtin?: boolean;
  description?: string;
}

export interface FlowResult {
  ok: boolean;
  summary: string;
  log: string[];
}

interface WindowInfo {
  id: number;
  title: string;
  process: string;
  minimized: boolean;
}

interface UiNode {
  id: number;
  role: string;
  name: string;
  enabled: boolean;
}

interface OcrLine {
  text: string;
  words: Array<{ t: string; x: number; y: number; w: number; h: number }>;
  x: number;
  y: number;
  w: number;
  h: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CLICKABLE_ROLES = /按钮|链接|菜单项|选项卡|列表项|button|link|menu|tab/i;

// ───────────────────────── 内置流程 ─────────────────────────

export const BUILTIN_FLOWS: UiFlow[] = [
  {
    id: "workbuddy-checkin",
    name: "WorkBuddy 每日领积分",
    process: "workbuddy",
    builtin: true,
    description: "打开 WorkBuddy，在「Buddy加油站」领取每日积分。",
    steps: [
      { do: "open", app: "workbuddy" },
      { do: "wait_window", timeoutMs: 45_000 },
      { do: "wait", ms: 2500 },
      {
        do: "checkin",
        claim: ["立即领取", "立即签到", "领取积分", "签到领取", "去签到", "签到"],
        done: ["领取成功", "已领取", "已签到", "今日已领", "明日再来", "明天再来", "签到成功"],
        entry: ["Buddy加油站", "加油站", "每日可领"],
        // 领过之后侧栏的「Buddy加油站 · 每日可领」整块会消失，换成别的活动
        goneMeansDone: ["每日可领", "Buddy加油站"],
        maxRounds: 4,
      },
    ],
  },
];

// ───────────────────────── 执行器 ─────────────────────────

async function findWindow(process: string): Promise<WindowInfo | undefined> {
  const windows = await invoke<WindowInfo[]>("list_windows");
  const pattern = new RegExp(process, "i");
  return windows.find((w) => pattern.test(w.process));
}

interface Hit {
  label: string;
  click: () => Promise<void>;
}

/** 在窗口里找文字：先界面结构，再 OCR。texts 按优先级排列。 */
async function locate(
  win: WindowInfo,
  texts: string[],
  log: string[],
  exclude: string[] = []
): Promise<{ hit?: Hit; seen: string }> {
  const lowered = texts.map((t) => t.toLowerCase());
  const excluded = (name: string) => exclude.some((e) => name.toLowerCase().includes(e.toLowerCase()));
  try {
    const snap = await invoke<{ nodes: UiNode[] }>("ui_snapshot", { id: win.id, maxNodes: 600 });
    const all = snap.nodes.filter((n) => n.name);
    if (all.length > 8) {
      const seen = all.map((n) => n.name).join(" | ");
      const nodes = all.filter((n) => n.enabled && !excluded(n.name));
      for (const text of lowered) {
        const match =
          nodes.find((n) => CLICKABLE_ROLES.test(n.role) && n.name.toLowerCase() === text) ||
          nodes.find((n) => CLICKABLE_ROLES.test(n.role) && n.name.toLowerCase().includes(text)) ||
          nodes.find((n) => n.name.toLowerCase().includes(text));
        if (match) {
          return {
            seen,
            hit: {
              label: `「${match.name}」（${match.role}）`,
              click: async () => {
                await invoke("mouse_click", { element: match.id });
              },
            },
          };
        }
      }
      return { seen };
    }
  } catch (error) {
    log.push(`读界面失败，改用文字识别：${error}`);
  }

  const ocr = await invoke<{ lines: OcrLine[] }>("ocr_window", { id: win.id, saveTo: null });
  const seen = ocr.lines.map((l) => l.text).join(" | ");
  // 去掉识别出来的箭头、符号后比较：先找整行就是这几个字的，再找包含的（“签到”不要先命中“每日签到”）
  const normalize = (value: string) => value.toLowerCase().replace(/[\s>›〉》<‹〈《·•|｜:：,，.。!！?？]/g, "");
  const ordered = (text: string) => [
    ...ocr.lines.filter((line) => normalize(line.text) === normalize(text)),
    ...ocr.lines.filter((line) => normalize(line.text) !== normalize(text)),
  ];
  for (const text of lowered) {
    for (const line of ordered(text)) {
      if (excluded(line.text)) continue;
      const index = line.text.toLowerCase().indexOf(text);
      if (index < 0) continue;
      // 把匹配到的字符映射回对应的词框，点它们的中心
      let pos = 0;
      const boxes: OcrLine["words"] = [];
      for (const word of line.words) {
        const start = line.text.indexOf(word.t, pos);
        const end = start + word.t.length;
        pos = Math.max(pos, end);
        if (end > index && start < index + text.length) boxes.push(word);
      }
      const box = boxes.length ? boxes : line.words;
      const x1 = Math.min(...box.map((b) => b.x));
      const y1 = Math.min(...box.map((b) => b.y));
      const x2 = Math.max(...box.map((b) => b.x + b.w));
      const y2 = Math.max(...box.map((b) => b.y + b.h));
      const cx = Math.round((x1 + x2) / 2);
      const cy = Math.round((y1 + y2) / 2);
      return {
        seen,
        hit: {
          label: `「${line.text}」（文字识别 @${cx},${cy}）`,
          click: async () => {
            await invoke("window_action", { id: win.id, action: "focus" }).catch(() => {});
            await sleep(200);
            await invoke("mouse_click", { x: cx, y: cy });
          },
        },
      };
    }
  }
  return { seen };
}

function includesAny(seen: string, texts: string[]) {
  const lower = seen.toLowerCase();
  return texts.find((t) => lower.includes(t.toLowerCase()));
}

const RUNS_KEY = "paw_app_flow_runs";

function todayKey() {
  return new Date().toDateString();
}

function lastSuccess(flowId: string): { day: string; summary: string } | undefined {
  try {
    return JSON.parse(localStorage.getItem(RUNS_KEY) || "{}")[flowId];
  } catch {
    return undefined;
  }
}

function markSuccess(flowId: string, summary: string) {
  try {
    const all = JSON.parse(localStorage.getItem(RUNS_KEY) || "{}");
    all[flowId] = { day: todayKey(), summary };
    localStorage.setItem(RUNS_KEY, JSON.stringify(all));
  } catch {}
}

/**
 * 执行流程。签到类每天只需要成功一次：今天已经成功过就直接告诉结果，不再去动界面
 * （force 为 true 时照样执行）。
 */
export async function runFlow(flow: UiFlow, signal?: AbortSignal, force = false): Promise<FlowResult> {
  const previous = lastSuccess(flow.id);
  if (!force && previous?.day === todayKey()) {
    return { ok: true, summary: `今天已经做过了（${previous.summary}）`, log: ["今天已经成功执行过，没有再去操作界面"] };
  }
  const result = await runFlowSteps(flow, signal);
  if (result.ok) markSuccess(flow.id, result.summary);
  return result;
}

async function runFlowSteps(flow: UiFlow, signal?: AbortSignal): Promise<FlowResult> {
  const log: string[] = [];
  let win: WindowInfo | undefined;
  const fail = (summary: string): FlowResult => ({ ok: false, summary, log });

  for (const step of flow.steps) {
    if (signal?.aborted) return fail("已停止");
    try {
      switch (step.do) {
        case "open": {
          win = await findWindow(flow.process);
          if (win) {
            await invoke("window_action", { id: win.id, action: win.minimized ? "restore" : "focus" }).catch(() => {});
            log.push(`${win.title} 已经开着，切到前面`);
          } else if (step.app === "workbuddy") {
            log.push(await invoke<string>("open_workbuddy"));
          } else {
            log.push(await invoke<string>("open_in_trae", { path: step.path || "~", line: null, name: null }));
          }
          break;
        }
        case "launch":
          log.push(await invoke<string>("launch_app", { target: step.target }));
          break;
        case "wait_window": {
          const deadline = Date.now() + (step.timeoutMs || 30_000);
          while (!(win = await findWindow(flow.process))) {
            if (Date.now() > deadline) return fail("等了很久窗口也没出来，软件可能没启动成功");
            await sleep(1000);
          }
          if (win.minimized) await invoke("window_action", { id: win.id, action: "restore" }).catch(() => {});
          await invoke("window_action", { id: win.id, action: "focus" }).catch(() => {});
          log.push(`找到窗口：${win.title}`);
          break;
        }
        case "wait":
          await sleep(step.ms);
          break;
        case "keys":
          await invoke("key_press", { keys: step.keys });
          log.push(`按键 ${step.keys}`);
          break;
        case "click_text": {
          win = win || (await findWindow(flow.process));
          if (!win) return fail("目标软件没有打开");
          const { hit } = await locate(win, step.text, log);
          if (!hit) {
            if (step.optional) {
              log.push(`没找到「${step.text.join(" / ")}」，跳过`);
              break;
            }
            return fail(`界面上没找到「${step.text.join(" / ")}」`);
          }
          await hit.click();
          log.push(`点击 ${hit.label}`);
          await sleep(1200);
          break;
        }
        case "checkin": {
          win = win || (await findWindow(flow.process));
          if (!win) return fail("目标软件没有打开");
          const rounds = step.maxRounds || 4;
          let clicked = 0;
          for (let round = 0; round < rounds; round += 1) {
            if (signal?.aborted) return fail("已停止");
            let claim = await locate(win, step.claim, log, step.done);
            // 刚启动时界面还在加载（或无障碍信息还没准备好），读到的文字很少：等一等再读
            for (let wait = 0; wait < 6 && claim.seen.replace(/[\s|]/g, "").length < 20; wait += 1) {
              if (wait === 0) log.push("界面还在加载，等一下");
              await sleep(2500);
              claim = await locate(win, step.claim, log, step.done);
            }
            const done = includesAny(claim.seen, step.done);
            if (done) {
              const summary = clicked ? `签到完成（界面显示「${done}」）` : `今天已经签过了（界面显示「${done}」）`;
              return { ok: true, summary, log };
            }
            if (claim.hit) {
              await claim.hit.click();
              clicked += 1;
              log.push(`点击 ${claim.hit.label}`);
              await sleep(2200);
              continue;
            }
            if (clicked) {
              // 点过领取按钮，按钮消失了：大概率已经领到
              return { ok: true, summary: "已点击领取，领取按钮已消失，应该领到了", log };
            }
            const entry = step.entry ? await locate(win, step.entry, log, step.done) : { hit: undefined, seen: "" };
            if (entry.hit) {
              await entry.hit.click();
              log.push(`打开入口 ${entry.hit.label}`);
              await sleep(2200);
              continue;
            }
            if (step.goneMeansDone?.length && !includesAny(claim.seen, step.goneMeansDone)) {
              return { ok: true, summary: "今天的领取入口已经不在了，应该已经领过", log };
            }
            log.push(`界面文字：${claim.seen.slice(0, 300)}`);
            return fail("没找到签到或领取的入口，可能这个版本的位置变了");
          }
          return clicked
            ? { ok: true, summary: `点了 ${clicked} 次领取，界面没有出现明确的完成提示，请看一眼确认`, log }
            : fail("试了几轮都没完成签到");
        }
      }
    } catch (error) {
      return fail(`第 ${flow.steps.indexOf(step) + 1} 步出错：${error}`);
    }
  }
  return { ok: true, summary: "流程执行完了", log };
}

// ───────────────────────── 自定义流程（用户教的） ─────────────────────────

export const FLOWS_KEY = "paw_app_flows";

export function loadCustomFlows(): UiFlow[] {
  try {
    const saved = JSON.parse(localStorage.getItem(FLOWS_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveCustomFlows(flows: UiFlow[]) {
  localStorage.setItem(FLOWS_KEY, JSON.stringify(flows));
}

export function allFlows(): UiFlow[] {
  return [...BUILTIN_FLOWS, ...loadCustomFlows()];
}

export function findFlow(ref: string) {
  const text = String(ref || "").trim().toLowerCase();
  const flows = allFlows();
  return (
    flows.find((f) => f.id === text) ||
    flows.find((f) => f.name.toLowerCase() === text) ||
    flows.find((f) => f.name.toLowerCase().includes(text) || text.includes(f.name.toLowerCase()))
  );
}

function splitList(value: unknown) {
  return String(value || "")
    .split(/[,，、;；\n]|->|→|>/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 把用户描述的签到步骤变成流程：依次点“入口”，最后点“领取 / 签到”，看到完成提示就结束。
 * app：workbuddy / trae / 其它软件的名字或 exe 路径（用 launch_app 打开）。
 */
export function buildCustomFlow(input: {
  name: string;
  app: string;
  process: string;
  clicks: string[];
  done: string[];
}): UiFlow {
  const app = input.app.trim();
  const open: FlowStep =
    /^workbuddy$/i.test(app) ? { do: "open", app: "workbuddy" } : /^trae$/i.test(app) ? { do: "open", app: "trae" } : { do: "launch", target: app };
  const claim = input.clicks.slice(-1);
  // 入口倒序：已经走到后面的步骤时优先点后面的，避免每轮都回到第一步
  const entry = input.clicks.slice(0, -1).reverse();
  return {
    id: `flow_${Date.now().toString(36)}`,
    name: input.name,
    process: input.process,
    description: `打开 ${app}，${input.clicks.map((c) => `点「${c}」`).join(" → ")}`,
    steps: [
      open,
      { do: "wait_window", timeoutMs: 60_000 },
      { do: "wait", ms: 3000 },
      { do: "checkin", claim, entry, done: input.done.length ? input.done : ["已签到", "已领取", "领取成功", "签到成功"], maxRounds: entry.length + 3 },
    ],
  };
}

function formatResult(flow: UiFlow, result: FlowResult) {
  const text = `${flow.name}：${result.summary}\n\n过程：\n${result.log.map((l) => `- ${l}`).join("\n")}`;
  // 流程没成功时别让模型自己用电脑控制到处乱点（可能点到付费、分享之类的按钮）
  return result.ok
    ? text
    : `${text}\n\n（流程没有成功。不要自己用电脑控制去尝试点击其它按钮；把上面的情况告诉用户，问用户签到入口在界面上叫什么、要依次点哪些文字，再用 create_app_flow 更新流程。）`;
}

export function getFlowTools(): Tool[] {
  return [
    {
      name: "list_app_flows",
      description: "列出可以自动执行的软件操作流程（例如 WorkBuddy 每日领积分，以及用户教过的签到流程）。只读。",
      parameters: { type: "object", properties: {} },
      execute: async () =>
        allFlows()
          .map((f) => `- ${f.name}（ID ${f.id}${f.builtin ? "，内置" : "，自定义"}）：${f.description || ""}`)
          .join("\n"),
    },
    {
      name: "run_app_flow",
      description:
        "立即执行一个软件操作流程，比如帮用户在 WorkBuddy 里签到领积分。用户说“帮我签到”“去 WorkBuddy 领一下积分”时用这个，不要自己用电脑控制去点。今天已经成功过会直接返回结果。想每天自动做，用 create_automation 并把 flow 设成这个流程的 ID。",
      parameters: {
        type: "object",
        properties: {
          flow: { type: "string", description: "流程 ID 或名称，如 workbuddy-checkin" },
          force: { type: "boolean", description: "今天已经成功过也再执行一次（用户明确要求重做时）" },
        },
        required: ["flow"],
      },
      execute: async (args) => {
        const flow = findFlow(args.flow);
        if (!flow) return `没有找到流程「${args.flow}」。可用：${allFlows().map((f) => f.id).join("、")}`;
        return formatResult(flow, await runFlow(flow, undefined, args.force === true));
      },
    },
    {
      name: "create_app_flow",
      description:
        "按用户描述教会桌宠一个软件签到 / 领取流程。例如用户说“Trae 签到：点右上角积分 → 每日签到 → 签到”，就创建 app=trae，clicks=积分,每日签到,签到。clicks 填界面上要依次点击的文字（最后一个是领取或签到按钮），done 填完成后界面会出现的文字。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "流程名，如“Trae 每日签到”" },
          app: { type: "string", description: "workbuddy、trae，或其它软件的名字 / exe 路径" },
          process: { type: "string", description: "窗口所属进程名关键词，如 trae、workbuddy、wechat；不填按 app 推断" },
          clicks: { type: "string", description: "依次点击的界面文字，用逗号或 → 分隔" },
          done: { type: "string", description: "完成后会出现的文字，逗号分隔，如 已签到,签到成功；可不填" },
        },
        required: ["name", "app", "clicks"],
      },
      execute: async (args) => {
        const clicks = splitList(args.clicks);
        if (!clicks.length) return "需要至少一个要点击的文字。";
        const app = String(args.app || "").trim();
        const process = String(args.process || "").trim() || app.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
        const flow = buildCustomFlow({ name: String(args.name), app, process, clicks, done: splitList(args.done) });
        saveCustomFlows([...loadCustomFlows().filter((f) => f.name !== flow.name), flow]);
        return `已学会「${flow.name}」（ID ${flow.id}）：${flow.description}。可以先用 run_app_flow 试一次；要每天自动做，用 create_automation 把 flow 设成 ${flow.id}。`;
      },
    },
    {
      name: "delete_app_flow",
      description: "删除一个用户教过的自定义流程（内置流程不能删）。",
      parameters: {
        type: "object",
        properties: { flow: { type: "string", description: "流程 ID 或名称" } },
        required: ["flow"],
      },
      execute: async (args) => {
        const flow = findFlow(args.flow);
        if (!flow) return `没有找到流程「${args.flow}」。`;
        if (flow.builtin) return "内置流程不能删除。";
        saveCustomFlows(loadCustomFlows().filter((f) => f.id !== flow.id));
        return `已删除「${flow.name}」。`;
      },
    },
  ];
}
