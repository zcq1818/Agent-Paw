import {
  buildAnthropicRequest,
  buildChatCompletionsUrl,
  buildRequestHeaders,
  isAnthropicProvider,
  loadConfig,
  normalizeConfig,
  parseConfigJson,
  type AgentConfig,
} from "./kernel";
import { getAvailableExperts, type Expert } from "../store/experts";

/**
 * 大总管编排器：把一条任务拆给多个专家模型并行执行，再汇总。
 * Claude 走 Anthropic Messages API，DeepSeek / 本地模型走 OpenAI Chat Completions。
 */

export type DelegationMode = "parallel" | "review";

export interface DelegationTask {
  id: string;
  expert: Expert;
  prompt: string;
}

export interface ExpertResult {
  task: DelegationTask;
  status: "done" | "error";
  text: string;
  durationMs: number;
  error?: string;
}

/** 规则化拆分：多段任务按顺序分发，单段任务则让每位专家从自己的角色视角各做一份。 */
export function planDelegation(
  userTask: string,
  experts: Expert[],
  mode: DelegationMode = "parallel"
): DelegationTask[] {
  const available = getAvailableExperts(experts);
  if (available.length === 0) return [];

  const parts = userTask
    .split(/[；;]+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const stamp = Date.now();

  if (parts.length > 1 && parts.length <= available.length) {
    return parts.map((part, index) => ({
      id: `task_${stamp}_${index}`,
      expert: available[index],
      prompt: part,
    }));
  }

  return available.map((expert, index) => ({
    id: `task_${stamp}_${index}`,
    expert,
    prompt:
      mode === "review"
        ? `请以「${expert.role}」的视角复核下面这件事，指出事实错误、遗漏与风险，并给出改进建议：\n\n${userTask}`
        : `请以「${expert.role}」的视角完成下面的任务：\n\n${userTask}`,
  }));
}

function expertConfig(expert: Expert): AgentConfig {
  return normalizeConfig({
    ...loadConfig(),
    provider: expert.provider,
    model: expert.model,
    baseUrl: expert.baseUrl,
    apiKey: expert.apiKey,
    stream: false,
    enableTools: false,
  });
}

export async function callExpert(expert: Expert, prompt: string, signal?: AbortSignal): Promise<string> {
  // 本机 Claude Code CLI：走 Tauri Rust 侧 spawn，复用已登录凭据，不走 HTTP API。
  if (expert.provider === "claude-local") {
    const { callLocalClaude } = await import("./localClaude");
    return callLocalClaude(prompt, expert.command, expert.allowedTools || "Read");
  }

  const config = expertConfig(expert);
  const system = `你是「${expert.name}」，桌面宠物大总管委派的专家，职责：${expert.role}。只完成本次子任务，用中文与 Markdown，简洁准确，不要假装执行过本地操作。`;

  if (isAnthropicProvider(config)) {
    if (!config.apiKey) throw new Error("未配置 Anthropic API Key");
    const request = buildAnthropicRequest(config, system, prompt);
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Claude 请求失败 (${response.status})：${(await response.text()).slice(0, 160)}`);
    }
    const data = await response.json();
    const text = (data?.content || [])
      .map((part: { text?: string }) => part?.text || "")
      .join("")
      .trim();
    if (!text) throw new Error("Claude 返回空内容");
    return text;
  }

  if (!config.apiKey && expert.provider !== "custom") {
    throw new Error(`未配置 ${expert.name} 的 API Key`);
  }
  const response = await fetch(buildChatCompletionsUrl(config), {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify({
      ...parseConfigJson(config.extraBody),
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`${expert.name} 请求失败 (${response.status})：${(await response.text()).slice(0, 160)}`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${expert.name} 返回空内容`);
  return text;
}

export async function runDelegation(
  tasks: DelegationTask[],
  onProgress?: (result: ExpertResult) => void,
  signal?: AbortSignal
): Promise<ExpertResult[]> {
  return Promise.all(
    tasks.map(async (task) => {
      const started = Date.now();
      try {
        const text = await callExpert(task.expert, task.prompt, signal);
        const result: ExpertResult = {
          task,
          status: "done",
          text,
          durationMs: Date.now() - started,
        };
        onProgress?.(result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: ExpertResult = {
          task,
          status: "error",
          text: "",
          durationMs: Date.now() - started,
          error: message,
        };
        onProgress?.(result);
        return result;
      }
    })
  );
}

export function formatDelegationReport(results: ExpertResult[]): string {
  if (results.length === 0) return "没有可执行任务。";
  const done = results.filter((result) => result.status === "done").length;
  let report = `## 大总管汇总\n\n共委派 ${results.length} 位专家，成功 ${done} 位。\n`;
  results.forEach((result, index) => {
    const label = result.status === "done" ? "完成" : "失败";
    report += `\n### ${index + 1}. ${result.task.expert.name} · ${result.task.expert.role}（${result.durationMs}ms，${label}）\n\n`;
    report += result.status === "done" ? result.text : `调用失败：${result.error}`;
    report += "\n";
  });
  return report;
}

/** 大总管目前能实际操作的本地能力清单（如实列出，不夸大）。 */
export const LOCAL_CAPABILITIES = [
  { name: "打开网页 / 应用", detail: "open_url / open_app，需内联审批确认" },
  { name: "系统动作", detail: "打开设置、资源管理器、记事本、任务管理器等" },
  { name: "待办 / 日程", detail: "增删查待办与日程" },
  { name: "记忆 / 技能", detail: "读写长期记忆、自定义技能" },
  { name: "剪贴板 / 宠物播报", detail: "读取或写入剪贴板、让桌宠说话" },
  { name: "调用本机 Claude Code", detail: "claude -p 无头模式，复用本机登录态；默认只放行只读 Read" },
];

export const NOT_YET_SUPPORTED = [
  "点击网页里的按钮、填表、滚动、截图（需要浏览器自动化内核）",
  "读取屏幕像素、模拟鼠标键盘控制任意窗口（需要 Rust 侧放权）",
  "让云端专家模型反向操作本机（它们只返回文字）；本机 Claude 通道默认也只放行只读 Read，写文件 / 跑命令需显式配置白名单",
];
