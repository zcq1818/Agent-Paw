import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ToolEvent } from "./toolEvents";

/**
 * 「本机 Claude」模型通道（前端部分）。
 *
 * Rust 侧（src-tauri/src/claude_code.rs）用官方非交互模式启动用户自己安装、自己登录的
 * Claude Code：`claude -p --output-format stream-json`。这里负责：
 * - 解析流式输出，边生成边显示；
 * - 执行 Claude 通过 MCP 调用的桌宠工具（审批卡片照常弹出）；
 * - 按会话记住 Claude 的 session，下一轮用 --resume 接着聊；会话被改动过（重新生成、
 *   中途换过模型）就重新开一个 session，并把最近的聊天记录作为背景带上。
 *
 * 不读取、不保存任何 Claude 账号凭据；登录过期时提示用户去 Claude Code 里重新登录。
 */

export const CLAUDE_LOCAL_PROVIDER = "claude-local";

/** 桌宠工具的最小形状（kernel 和 tools 里各有一份 Tool 定义，这里只取用得到的字段）。 */
interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: Record<string, any>) => Promise<string>;
}

/** 本机智能体：claude = Claude Code，codebuddy = 腾讯 CodeBuddy Code（WorkBuddy 同款引擎）。 */
export type LocalAgentKind = "claude" | "codebuddy";
export const CODEBUDDY_LOCAL_PROVIDER = "codebuddy-local";

export function localAgentOf(provider?: string): LocalAgentKind | null {
  if (provider === CLAUDE_LOCAL_PROVIDER) return "claude";
  if (provider === CODEBUDDY_LOCAL_PROVIDER) return "codebuddy";
  return null;
}

export const CLAUDE_MODEL_OPTIONS = [
  { value: "", label: "跟随 Claude Code 默认" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];

/** CodeBuddy Code 2.183 `--help` 里列出的模型（档位 + 常用具体模型）。 */
export const CODEBUDDY_MODEL_OPTIONS = [
  { value: "", label: "跟随 CodeBuddy 默认" },
  { value: "fast-model", label: "快速档" },
  { value: "balanced-model", label: "均衡档" },
  { value: "primary-model", label: "主力档" },
  { value: "deep-model", label: "深度思考档" },
  { value: "hy3", label: "混元 hy3" },
  { value: "deepseek-v4.1-flash", label: "DeepSeek v4.1 Flash" },
  { value: "glm-5.3", label: "GLM 5.3" },
  { value: "kimi-k3", label: "Kimi K3" },
];

export const LOCAL_AGENT_LABELS: Record<LocalAgentKind, string> = {
  claude: "Claude",
  codebuddy: "CodeBuddy",
};

const SESSIONS_KEY = "paw_claude_sessions";

interface SessionRecord {
  sessionId: string;
  /** 这个 session 最后一条回复的指纹，用来判断聊天记录是否还和 Claude 那边一致 */
  lastReply: string;
  updatedAt: number;
}

function fingerprint(text: string) {
  let h = 0;
  const value = text.trim();
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `${value.length}:${h.toString(36)}`;
}

function loadSessions(): Record<string, SessionRecord> {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveSession(key: string, record: SessionRecord) {
  const all = loadSessions();
  all[key] = record;
  // 只留最近 100 个会话
  const entries = Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 100);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function transcript(history: Array<{ role: string; content: string }>) {
  const lines = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-16)
    .map((m) => `${m.role === "user" ? "用户" : "你"}：${m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content}`);
  return lines.join("\n\n");
}

export interface ClaudeRunOptions {
  conversationKey: string;
  systemPrompt: string;
  /** 含本轮用户消息在内的聊天记录 */
  history: Array<{ role: string; content: string }>;
  userText: string;
  tools: Tool[];
  model?: string;
  readOnlyBuiltins?: boolean;
  path?: string;
  agent?: LocalAgentKind;
  onChunk: (text: string) => void;
  onToolEvent?: (event: ToolEvent) => void;
  executeTool: (tool: Tool | undefined, name: string, args: Record<string, unknown>) => Promise<{ result: string; ok: boolean }>;
  signal?: AbortSignal;
}

const LOGIN_HINTS: Record<LocalAgentKind, string> = {
  claude:
    "本机 Claude 的登录已过期或还没登录。请在终端运行 `claude`，按提示用 `/login` 重新登录你的 Claude 账号（登录在 Claude Code 自己的页面完成，桌宠不经手），然后再试。",
  codebuddy:
    "本机 CodeBuddy 还没登录。请在终端运行 `codebuddy`，按提示用 `/login` 登录你的 CodeBuddy 账号（登录在 CodeBuddy 自己的页面完成，桌宠不经手），然后再试。",
};

function friendlyError(text: string, agent: LocalAgentKind) {
  if (/Failed to authenticate|OAuth|not logged in|Authentication required|Invalid API key|\/login|log in|sign in/i.test(text)) {
    return LOGIN_HINTS[agent];
  }
  if (/usage limit|rate limit|limit reached|quota|额度/i.test(text)) {
    return `${LOCAL_AGENT_LABELS[agent]} 的用量额度暂时用完了：${text.slice(0, 200)}`;
  }
  return text.slice(0, 400);
}

export async function runClaudeLocal(options: ClaudeRunOptions): Promise<string> {
  const requestId = `cr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const mcpTools = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));

  // 判断能否接着上一个 session
  const previousReply = [...options.history.slice(0, -1)].reverse().find((m) => m.role === "assistant")?.content || "";
  const agent: LocalAgentKind = options.agent || "claude";
  // 同一个对话换了智能体（Claude ↔ CodeBuddy）时不能互相 --resume，按智能体分开记
  const sessionKey = options.conversationKey ? `${agent}:${options.conversationKey}` : "";
  const record = sessionKey ? loadSessions()[sessionKey] : undefined;
  const canResume = Boolean(record && previousReply && record.lastReply === fingerprint(previousReply));
  const earlier = options.history.slice(0, -1);
  const prompt =
    canResume || earlier.length === 0
      ? options.userText
      : `（以下是这次对话之前的聊天记录，供你了解上下文）\n\n${transcript(earlier)}\n\n（记录结束）\n\n用户现在说：${options.userText}`;

  let text = "";
  let sessionId = canResume ? record!.sessionId : "";
  let resultText = "";
  let errorText = "";
  let lastAssistantText = "";
  let sawDelta = false;
  let blockHasText = false;
  const unlisteners: Array<() => void> = [];

  const append = (chunk: string) => {
    if (!chunk) return;
    text += chunk;
    options.onChunk(chunk);
  };

  let resolveEnd: (value: { code: number | null; stderr: string }) => void = () => {};
  const finished = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    resolveEnd = resolve;
  });
  unlisteners.push(
    await listen<{ requestId: string; code: number | null; stderr: string }>("claude-run-end", (event) => {
      if (event.payload.requestId === requestId) resolveEnd(event.payload);
    })
  );

  unlisteners.push(
    await listen<{ requestId: string; line: string }>("claude-run", (event) => {
      if (event.payload.requestId !== requestId) return;
      let data: any;
      try {
        data = JSON.parse(event.payload.line);
      } catch {
        return;
      }
      if (data.session_id) sessionId = data.session_id;
      if (data.type === "stream_event") {
        const ev = data.event || {};
        if (ev.type === "message_start") {
          blockHasText = false;
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          // 多轮工具调用之间的文字用空行隔开
          if (!blockHasText && text && !text.endsWith("\n\n")) append(text.endsWith("\n") ? "\n" : "\n\n");
          blockHasText = true;
          sawDelta = true;
          append(ev.delta.text || "");
        }
      } else if (data.type === "assistant") {
        const parts = (data.message?.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text);
        if (parts.length) lastAssistantText = parts.join("");
        // 没有逐字输出时用整条消息兜底；出错时的合成消息只用来报错，不当作回复
        if (!sawDelta && parts.length && data.message?.model !== "<synthetic>") append((text ? "\n\n" : "") + parts.join(""));
      } else if (data.type === "result") {
        resultText = typeof data.result === "string" ? data.result : "";
        if (data.is_error || (data.subtype && data.subtype !== "success")) {
          errorText =
            resultText ||
            lastAssistantText ||
            (Array.isArray(data.errors) ? data.errors.join("；") : "") ||
            data.subtype ||
            "未知错误";
        }
      }
    })
  );

  unlisteners.push(
    await listen<{ requestId: string; callId: string; name: string; arguments: Record<string, unknown> }>("claude-tool-call", async (event) => {
      const { callId, name, arguments: args } = event.payload;
      // 两个窗口都在监听：只处理自己这次运行发起的工具调用
      if (event.payload.requestId !== requestId) return;
      const runId = `${requestId}-${callId}`;
      options.onToolEvent?.({ type: "start", id: runId, name, args: JSON.stringify(args || {}), at: Date.now() });
      let result = "";
      let ok = true;
      if (options.signal?.aborted) {
        result = "用户已停止";
        ok = false;
      } else {
        try {
          const executed = await options.executeTool(toolsByName.get(name), name, args || {});
          result = executed.result;
          ok = executed.ok;
        } catch (error) {
          result = `工具执行失败：${error}`;
          ok = false;
        }
      }
      options.onToolEvent?.({ type: "finish", id: runId, name, status: ok ? "done" : "error", result, at: Date.now() });
      await invoke("claude_tool_result", { callId, text: result || "(空)", isError: !ok }).catch(() => {});
    })
  );

  const onAbort = () => {
    void invoke("claude_cancel", { requestId }).catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort);

  try {
    await invoke("claude_run", {
      request: {
        requestId,
        prompt,
        systemPrompt: options.systemPrompt,
        sessionId: canResume ? record!.sessionId : null,
        model: options.model || null,
        readOnlyBuiltins: Boolean(options.readOnlyBuiltins),
        tools: mcpTools,
        path: options.path || null,
        agent,
      },
    });
    const end = await finished;
    if (options.signal?.aborted) throw new DOMException("生成已停止", "AbortError");
    if (errorText) throw new Error(friendlyError(errorText, agent));
    if (!text.trim() && resultText) append(resultText);
    if (!text.trim()) {
      throw new Error(
        friendlyError(end.stderr || `${LOCAL_AGENT_LABELS[agent]} 没有返回内容（退出码 ${end.code ?? "未知"}）`, agent)
      );
    }
    if (sessionId && sessionKey) saveSession(sessionKey, { sessionId, lastReply: fingerprint(text), updatedAt: Date.now() });
    return text;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    unlisteners.forEach((fn) => fn());
  }
}

/** 一次性提问（不带工具、不接续会话）：测试连接、多 Bot 房间等用。 */
export async function askClaudeLocal(
  system: string,
  prompt: string,
  options: { model?: string; path?: string; signal?: AbortSignal; agent?: LocalAgentKind } = {}
): Promise<string> {
  return runClaudeLocal({
    conversationKey: "",
    systemPrompt: system,
    history: [{ role: "user", content: prompt }],
    userText: prompt,
    tools: [],
    model: options.model,
    path: options.path,
    agent: options.agent,
    signal: options.signal,
    onChunk: () => {},
    executeTool: async () => ({ result: "没有可用工具", ok: false }),
  });
}

export function localAgentPrompt(agent: LocalAgentKind) {
  const product = agent === "codebuddy" ? "CodeBuddy Code" : "Claude Code";
  return [
    "## 运行环境",
    `你通过用户本机的 ${product} 运行。桌宠的工具都在 MCP 服务 paw 里（名字形如 mcp__paw__add_todo），按工具说明直接调用；需要用户确认的操作会自动弹出确认卡片，被拒绝就停止并说明。`,
    `不要提及 ${product} 的命令行、斜杠命令或工作目录，你是用户的桌面宠物助手。`,
  ].join("\n");
}

/** 兼容旧引用 */
export const CLAUDE_LOCAL_PROMPT = localAgentPrompt("claude");
