import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { fetchExternal } from "./http";
import { confirmSystemAction, type Tool } from "./tools";
import { registerToolAction } from "./toolEvents";
import { clearMcpToken, getMcpToken, refreshMcpToken, validMcpToken, type McpOAuthSettings } from "./mcpOAuth";

/**
 * 外部 MCP 服务：用户在设置里接入的第三方工具（文件系统、GitHub、数据库、浏览器……）。
 *
 * - 本机命令（stdio）：Rust 侧 mcp_client.rs 启动进程并握手，两个窗口共用一个进程；
 * - 网址（Streamable HTTP）：这里用 tauri-plugin-http 直接请求。
 *
 * 连上后把工具列表缓存在本机，聊天时转成桌宠的普通工具（名字 mcp_<服务>_<工具>）。
 * 除了服务自己声明为只读的工具，调用前都会弹确认卡片，可以“一直允许”。
 * 配置里的环境变量 / 请求头可能有令牌，只存在本机，不会发给模型。
 */

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 网址方式的 OAuth 登录设置（Slack 这类需要自建应用时填 Client ID） */
  oauth?: McpOAuthSettings;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpServerState {
  tools: McpToolInfo[];
  serverName?: string;
  serverVersion?: string;
  updatedAt?: string;
  error?: string;
}

const SERVERS_KEY = "paw_mcp_servers";
const STATE_KEY = "paw_mcp_state";
const PROTOCOL_VERSION = "2025-06-18";
const MAX_RESULT_CHARS = 20_000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function loadMcpServers(): McpServerConfig[] {
  const list = readJson<McpServerConfig[]>(SERVERS_KEY, []);
  return Array.isArray(list) ? list.filter((item) => item && item.id && item.name) : [];
}

export function loadMcpState(): Record<string, McpServerState> {
  return readJson<Record<string, McpServerState>>(STATE_KEY, {});
}

interface McpStore {
  servers: McpServerConfig[];
  state: Record<string, McpServerState>;
  busy: Record<string, boolean>;
  reload: () => void;
  save: (server: McpServerConfig) => void;
  remove: (id: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  refresh: (id: string) => Promise<McpServerState>;
}

export const useMcpStore = create<McpStore>((set, get) => {
  const commitServers = (servers: McpServerConfig[]) => {
    writeJson(SERVERS_KEY, servers);
    set({ servers });
  };
  const commitState = (id: string, value: McpServerState | null) => {
    const state = { ...loadMcpState() };
    if (value) state[id] = value;
    else delete state[id];
    writeJson(STATE_KEY, state);
    set({ state });
  };

  return {
    servers: loadMcpServers(),
    state: loadMcpState(),
    busy: {},
    reload: () => set({ servers: loadMcpServers(), state: loadMcpState() }),
    save: (server) => {
      const servers = get().servers;
      const previous = servers.find((item) => item.id === server.id);
      const exists = Boolean(previous);
      // 地址或应用换了，旧令牌就不能用了
      if (
        previous &&
        (previous.url !== server.url || previous.oauth?.clientId !== server.oauth?.clientId)
      ) {
        clearMcpToken(server.id);
      }
      commitServers(exists ? servers.map((item) => (item.id === server.id ? server : item)) : [...servers, server]);
      void disconnectMcpServer(server.id);
    },
    remove: (id) => {
      commitServers(get().servers.filter((item) => item.id !== id));
      commitState(id, null);
      clearMcpToken(id);
      void disconnectMcpServer(id);
    },
    setEnabled: (id, enabled) => {
      commitServers(get().servers.map((item) => (item.id === id ? { ...item, enabled } : item)));
      if (!enabled) void disconnectMcpServer(id);
    },
    refresh: async (id) => {
      const server = get().servers.find((item) => item.id === id);
      if (!server) throw new Error("找不到这个 MCP 服务");
      set({ busy: { ...get().busy, [id]: true } });
      try {
        const result = await connectMcpServer(server);
        commitState(id, result);
        return result;
      } catch (error) {
        const previous = loadMcpState()[id];
        const failed: McpServerState = {
          tools: previous?.tools || [],
          serverName: previous?.serverName,
          serverVersion: previous?.serverVersion,
          updatedAt: previous?.updatedAt,
          error: error instanceof Error ? error.message : String(error),
        };
        commitState(id, failed);
        return failed;
      } finally {
        set({ busy: { ...get().busy, [id]: false } });
      }
    },
  };
});

export function newMcpServerId() {
  return `mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ───────────────────────── 传输 ─────────────────────────

interface HttpSession {
  sessionId?: string;
  protocolVersion: string;
  ready: Promise<void>;
}

const httpSessions = new Map<string, HttpSession>();
let rpcId = 1;

function stdioConfig(server: McpServerConfig) {
  return {
    command: server.command || "",
    args: server.args || [],
    env: server.env || {},
    cwd: server.cwd || null,
  };
}

/** 从 SSE 流里找到对应 id 的响应；服务端在同一个流里先发的通知直接跳过。 */
async function readSseResponse(response: Response, id: number): Promise<any> {
  const handleEvent = (data: string) => {
    if (!data.trim()) return undefined;
    try {
      const message = JSON.parse(data);
      if (message && message.id === id && ("result" in message || "error" in message)) return message;
    } catch {}
    return undefined;
  };
  const parseBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return handleEvent(data);
  };

  const reader = response.body?.getReader();
  if (!reader) {
    for (const block of (await response.text()).split(/\r?\n\r?\n/)) {
      const found = parseBlock(block);
      if (found) return found;
    }
    throw new Error("MCP 服务没有返回结果");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, "");
        const found = parseBlock(block);
        if (found) return found;
      }
      if (done) break;
    }
    const found = parseBlock(buffer);
    if (found) return found;
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error("MCP 服务没有返回结果");
}

async function httpPost(
  server: McpServerConfig,
  session: Pick<HttpSession, "sessionId" | "protocolVersion"> | null,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ message: any; sessionId?: string }> {
  const url = (server.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("MCP 服务地址要以 http:// 或 https:// 开头");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers || {}),
  };
  if (session?.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  if (session) headers["MCP-Protocol-Version"] = session.protocolVersion;

  // 登录授权过的服务带上令牌（请求头里手动填了 Authorization 的以手填为准）
  const manualAuth = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  const token = manualAuth ? null : await validMcpToken(server.id);
  if (token) headers.Authorization = `Bearer ${token}`;

  let response = await fetchExternal(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (response.status === 401 && token) {
    // 令牌被服务端判定过期：刷新一次再试
    const refreshed = await refreshMcpToken(server.id);
    if (refreshed) {
      headers.Authorization = `Bearer ${refreshed.accessToken}`;
      response = await fetchExternal(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    }
  }
  const sessionId = response.headers.get("mcp-session-id") || undefined;
  if (!("id" in body)) return { message: null, sessionId };
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 200);
    const hint =
      response.status === 401
        ? manualAuth
          ? "（请求头里的令牌无效或过期）"
          : getMcpToken(server.id)
            ? "（登录已过期，点“登录授权”重新登录）"
            : "（需要登录：点“登录授权”）"
        : response.status === 403
          ? "（没有权限：检查账号权限或令牌范围）"
        : response.status === 404 || response.status === 405
          ? /\/sse\/?$/i.test(url)
            ? "（这是旧版 SSE 地址，桌宠只支持新版 Streamable HTTP，一般把结尾的 /sse 换成 /mcp）"
            : "（地址不对，或服务不支持 Streamable HTTP）"
          : "";
    const error = new Error(`MCP 服务返回 ${response.status}${hint}${text ? `：${text}` : ""}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  const type = response.headers.get("content-type") || "";
  const message = type.includes("text/event-stream")
    ? await readSseResponse(response, body.id as number)
    : await response.json();
  return { message, sessionId };
}

function unwrap(message: any) {
  if (message?.error) throw new Error(`MCP 服务返回错误：${message.error.message || JSON.stringify(message.error)}`);
  return message?.result;
}

function httpSession(server: McpServerConfig, fresh = false): HttpSession {
  const existing = httpSessions.get(server.id);
  if (existing && !fresh) return existing;
  const session: HttpSession = { protocolVersion: PROTOCOL_VERSION, ready: Promise.resolve() };
  session.ready = (async () => {
    const { message, sessionId } = await httpPost(server, null, {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paw-desktop-pet", version: "0.1.0" },
      },
    });
    const result = unwrap(message);
    session.sessionId = sessionId;
    session.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
    (session as HttpSession & { init?: unknown }).init = result;
    await httpPost(server, session, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  })();
  session.ready.catch(() => httpSessions.delete(server.id));
  httpSessions.set(server.id, session);
  return session;
}

async function mcpRequest(
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<any> {
  if (server.transport === "stdio") {
    return invoke("mcp_stdio_request", {
      serverId: server.id,
      config: stdioConfig(server),
      method,
      params,
      timeoutMs: options.timeoutMs ?? null,
    });
  }

  let session = httpSession(server);
  await session.ready;
  if (method === "initialize") return (session as HttpSession & { init?: unknown }).init;
  const call = () =>
    httpPost(server, session, { jsonrpc: "2.0", id: rpcId++, method, params }, options.signal).then((r) => unwrap(r.message));
  try {
    return await call();
  } catch (error) {
    // 会话过期（服务重启过）：重新握手再试一次
    if ((error as Error & { status?: number }).status === 404 && session.sessionId) {
      session = httpSession(server, true);
      await session.ready;
      return call();
    }
    throw error;
  }
}

export async function disconnectMcpServer(id: string) {
  const session = httpSessions.get(id);
  httpSessions.delete(id);
  try {
    await invoke("mcp_stdio_stop", { serverId: id });
  } catch {}
  if (session?.sessionId) {
    // 礼貌地结束 HTTP 会话；失败无所谓
    const server = loadMcpServers().find((item) => item.id === id);
    if (server?.url) {
      fetchExternal(server.url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": session.sessionId, ...(server.headers || {}) },
      }).catch(() => {});
    }
  }
}

/** 连上服务、取工具列表。 */
export async function connectMcpServer(server: McpServerConfig): Promise<McpServerState> {
  const init = await mcpRequest(server, "initialize");
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await mcpRequest(server, "tools/list", cursor ? { cursor } : {}, { timeoutMs: 60_000 });
    for (const tool of result?.tools || []) {
      if (tool && typeof tool.name === "string") {
        tools.push({
          name: tool.name,
          title: tool.title || tool.annotations?.title,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
      }
    }
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return {
    tools,
    serverName: init?.serverInfo?.name,
    serverVersion: init?.serverInfo?.version,
    updatedAt: new Date().toISOString(),
  };
}

/** 把 MCP 的 content 数组整理成给模型看的文字。 */
export function formatMcpResult(result: any): string {
  if (!result) return "（没有返回内容）";
  const parts: string[] = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item?.type === "image") parts.push(`[图片 ${item.mimeType || ""}]`);
    else if (item?.type === "audio") parts.push(`[音频 ${item.mimeType || ""}]`);
    else if (item?.type === "resource_link") parts.push(`[资源] ${item.name || ""} ${item.uri || ""}`.trim());
    else if (item?.type === "resource") {
      const res = item.resource || {};
      parts.push(typeof res.text === "string" ? `[${res.uri || "资源"}]\n${res.text}` : `[资源] ${res.uri || ""}`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  let text = parts.join("\n\n").trim() || "（没有返回内容）";
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…（内容太长，已截断）`;
  return result.isError ? `工具报错：${text}` : text;
}

// ───────────────────────── 转成桌宠工具 ─────────────────────────

function slugify(server: McpServerConfig, used: Set<string>) {
  let base = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16);
  if (!base) base = `s${server.id.slice(-4)}`;
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}${i}`;
  used.add(slug);
  return slug;
}

function toolName(slug: string, name: string) {
  return `mcp_${slug}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

/** 模型接口对 JSON Schema 的容忍度不一，去掉常见的会报错的字段。 */
function cleanSchema(schema: unknown): Tool["parameters"] {
  const value = schema && typeof schema === "object" ? { ...(schema as Record<string, any>) } : {};
  delete value.$schema;
  delete value.$id;
  if (value.type !== "object") value.type = "object";
  if (!value.properties || typeof value.properties !== "object") value.properties = {};
  return value as Tool["parameters"];
}

function describeArgs(args: Record<string, unknown>) {
  const text = JSON.stringify(args, null, 2);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export function getMcpTools(): Tool[] {
  const servers = loadMcpServers().filter((server) => server.enabled);
  if (servers.length === 0) return [];
  const state = loadMcpState();
  const used = new Set<string>();
  const tools: Tool[] = [];
  const names = new Set<string>();

  for (const server of servers) {
    const info = state[server.id];
    if (!info?.tools?.length) continue;
    const slug = slugify(server, used);
    for (const tool of info.tools) {
      const name = toolName(slug, tool.name);
      if (names.has(name)) continue;
      names.add(name);
      const title = tool.title || tool.name;
      registerToolAction(name, `用 ${server.name} 的 ${title}`);
      const readOnly = tool.annotations?.readOnlyHint === true;
      const destructive = tool.annotations?.destructiveHint === true && !readOnly;
      tools.push({
        name,
        description: `[外部 MCP：${server.name}] ${(tool.description || title).slice(0, 1000)}`,
        parameters: cleanSchema(tool.inputSchema),
        execute: async (args) => {
          if (!readOnly) {
            const ok = await confirmSystemAction(
              `${destructive ? "⚠️ " : ""}${server.name} 要执行「${title}」\n参数：${describeArgs(args)}`,
              "tool",
              {
                scope: `mcp:${server.id}:${tool.name}`,
                label: `${server.name} · ${title}`,
                allowAlways: !destructive,
              }
            );
            if (!ok) return "用户拒绝了这次调用。";
          }
          const latest = loadMcpServers().find((item) => item.id === server.id) || server;
          const result = await mcpRequest(latest, "tools/call", { name: tool.name, arguments: args }, { timeoutMs: 180_000 });
          return formatMcpResult(result);
        },
      });
    }
  }
  return tools;
}

/** 系统提示里的一小段：告诉模型接了哪些外部服务。 */
export function mcpPromptSection(): string {
  const state = loadMcpState();
  const lines = loadMcpServers()
    .filter((server) => server.enabled && state[server.id]?.tools?.length)
    .map((server) => `- ${server.name}：${state[server.id].tools.length} 个工具`);
  if (lines.length === 0) return "";
  return [
    "## 外部 MCP 服务",
    "用户接入了下面这些外部服务，对应工具名以 mcp_ 开头、描述里标着服务名。用户提到这些服务或相关的事时优先用它们，不要说自己做不到。",
    ...lines,
  ].join("\n");
}

// ───────────────────────── 导入配置 ─────────────────────────

/** 把命令行拆成参数，支持引号。 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

export function joinArgs(args: string[] = []): string {
  return args.map((arg) => (/\s/.test(arg) || arg === "" ? `"${arg}"` : arg)).join(" ");
}

/** "KEY=VALUE" 或 "Key: Value" 一行一个。 */
export function parsePairs(input: string, separator: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key) out[key] = line.slice(index + 1).trim();
  }
  return out;
}

export function formatPairs(pairs: Record<string, string> = {}, separator: "=" | ":"): string {
  return Object.entries(pairs)
    .map(([key, value]) => (separator === ":" ? `${key}: ${value}` : `${key}=${value}`))
    .join("\n");
}

/**
 * 支持各家通用的 JSON 配置：{"mcpServers": {"名字": {"command": "...", "args": [...], "env": {...}}}}，
 * 或 {"名字": {"url": "...", "headers": {...}}}。
 */
export function parseMcpJson(input: string): McpServerConfig[] {
  let data: any;
  try {
    data = JSON.parse(input);
  } catch {
    throw new Error("不是有效的 JSON");
  }
  const map = data?.mcpServers || data?.servers || data;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("没找到 mcpServers");
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries<any>(map)) {
    if (!raw || typeof raw !== "object") continue;
    const url = raw.url || raw.serverUrl || raw.httpUrl;
    if (typeof url === "string") {
      out.push({
        id: newMcpServerId(),
        name,
        transport: "http",
        enabled: true,
        url,
        headers: raw.headers && typeof raw.headers === "object" ? raw.headers : undefined,
      });
    } else if (typeof raw.command === "string") {
      out.push({
        id: newMcpServerId(),
        name,
        transport: "stdio",
        enabled: true,
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        env: raw.env && typeof raw.env === "object" ? raw.env : undefined,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      });
    }
  }
  if (out.length === 0) throw new Error("没有可识别的服务（需要 command 或 url）");
  return out;
}
