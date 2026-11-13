import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { fetchExternal } from "./http";

/**
 * MCP 服务的 OAuth 登录（MCP 授权规范：OAuth 2.1 + PKCE）。
 *
 * 流程：服务返回 401 → 读受保护资源元数据找到授权服务器 → 读授权服务器元数据 →
 * 没有现成 Client ID 时动态注册一个 → 用系统浏览器打开授权页，用户自己登录、点同意 →
 * 浏览器跳回 http://127.0.0.1:端口/callback → 用授权码换令牌 → 之后请求带上 Bearer 令牌，过期自动刷新。
 *
 * 桌宠不接触账号密码，只保存服务发的访问令牌（存在本机，不会发给模型）。
 */

export const DEFAULT_OAUTH_PORT = 33418;

export interface McpOAuthSettings {
  /** 预先注册好的应用（如 Slack 要求自建应用）；留空则动态注册 */
  clientId?: string;
  clientSecret?: string;
  /** 空格分隔；留空用服务声明的全部权限 */
  scopes?: string;
  /** 回调端口，回调地址是 http://127.0.0.1:端口/callback */
  port?: number;
}

export interface McpTokenRecord {
  accessToken: string;
  refreshToken?: string;
  /** 毫秒时间戳 */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  scope?: string;
  obtainedAt: string;
}

const TOKENS_KEY = "paw_mcp_tokens";

function readTokens(): Record<string, McpTokenRecord> {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeTokens(tokens: Record<string, McpTokenRecord>) {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  } catch {}
}

export function getMcpToken(serverId: string): McpTokenRecord | undefined {
  return readTokens()[serverId];
}

export function clearMcpToken(serverId: string) {
  const tokens = readTokens();
  delete tokens[serverId];
  writeTokens(tokens);
}

function saveToken(serverId: string, record: McpTokenRecord) {
  const tokens = readTokens();
  tokens[serverId] = record;
  writeTokens(tokens);
}

export function redirectUri(port: number) {
  return `http://127.0.0.1:${port}/callback`;
}

// ───────────────────────── 元数据发现 ─────────────────────────

async function getJson(url: string): Promise<any | null> {
  try {
    const response = await fetchExternal(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.trim().startsWith("{")) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 WWW-Authenticate 里取 resource_metadata / scope */
function parseAuthenticate(header: string | null) {
  const out: Record<string, string> = {};
  if (!header) return out;
  const pattern = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(header))) out[match[1]] = match[2];
  return out;
}

interface Discovery {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes: string[];
  authMethods: string[];
}

export async function discover(serverUrl: string, extraHeaders: Record<string, string>): Promise<Discovery> {
  const url = new URL(serverUrl);
  // 1. 不带令牌请求一次，看 401 里有没有 resource_metadata
  let challenge: Record<string, string> = {};
  try {
    const response = await fetchExternal(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extraHeaders },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "paw-desktop-pet", version: "0.1.0" } },
      }),
    });
    challenge = parseAuthenticate(response.headers.get("www-authenticate"));
    response.body?.cancel().catch(() => {});
  } catch {}

  // 2. 受保护资源元数据（RFC 9728）
  const path = url.pathname.replace(/\/$/, "");
  const prmCandidates = [
    challenge.resource_metadata,
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean) as string[];
  let prm: any = null;
  for (const candidate of prmCandidates) {
    prm = await getJson(candidate);
    if (prm) break;
  }
  const authServer: string = prm?.authorization_servers?.[0] || url.origin;

  // 3. 授权服务器元数据（RFC 8414，路径插入式和后缀式都试）
  const as = new URL(authServer);
  const asPath = as.pathname.replace(/\/$/, "");
  const asCandidates = [
    `${as.origin}/.well-known/oauth-authorization-server${asPath}`,
    `${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    `${as.origin}/.well-known/openid-configuration${asPath}`,
    `${authServer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  ];
  let meta: any = null;
  for (const candidate of asCandidates) {
    meta = await getJson(candidate);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }
  if (!meta) throw new Error("这个服务没有提供 OAuth 授权信息，可能只支持在请求头里填令牌。");

  const scopes: string[] = challenge.scope
    ? challenge.scope.split(/\s+/).filter(Boolean)
    : Array.isArray(prm?.scopes_supported)
      ? prm.scopes_supported
      : [];
  return {
    resource: prm?.resource || serverUrl,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    scopes,
    authMethods: meta.token_endpoint_auth_methods_supported || [],
  };
}

// ───────────────────────── PKCE ─────────────────────────

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length = 48) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, length);
}

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// ───────────────────────── 令牌 ─────────────────────────

async function tokenRequest(endpoint: string, params: Record<string, string>) {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => value && body.set(key, value));
  const response = await fetchExternal(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const text = await response.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {}
  // Slack 失败时也返回 200，用 ok:false 表示
  if (!response.ok || data.ok === false || data.error) {
    const reason = data.error_description || data.error || text.slice(0, 160) || response.status;
    throw new Error(`换取令牌失败：${reason}`);
  }
  const accessToken = data.access_token || data.authed_user?.access_token;
  if (!accessToken) throw new Error("服务没有返回访问令牌");
  return {
    accessToken: String(accessToken),
    refreshToken: data.refresh_token || data.authed_user?.refresh_token,
    expiresIn: Number(data.expires_in || data.authed_user?.expires_in) || undefined,
    scope: data.scope || data.authed_user?.scope,
  };
}

/** 令牌快过期时刷新；没有刷新令牌或刷新失败返回 null（需要重新登录）。 */
export async function refreshMcpToken(serverId: string): Promise<McpTokenRecord | null> {
  const record = getMcpToken(serverId);
  if (!record?.refreshToken) return null;
  try {
    const result = await tokenRequest(record.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: record.refreshToken,
      client_id: record.clientId,
      client_secret: record.clientSecret || "",
      resource: record.resource,
    });
    const next: McpTokenRecord = {
      ...record,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || record.refreshToken,
      expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined,
      obtainedAt: new Date().toISOString(),
    };
    saveToken(serverId, next);
    return next;
  } catch {
    return null;
  }
}

/** 拿可用的访问令牌：快过期（1 分钟内）就先刷新。 */
export async function validMcpToken(serverId: string): Promise<string | null> {
  const record = getMcpToken(serverId);
  if (!record) return null;
  if (record.expiresAt && record.expiresAt - Date.now() < 60_000) {
    const refreshed = await refreshMcpToken(serverId);
    return refreshed?.accessToken || null;
  }
  return record.accessToken;
}

let activePort: number | null = null;

export function cancelMcpLogin() {
  if (activePort !== null) invoke("oauth_cancel", { port: activePort }).catch(() => {});
}

/**
 * 完整登录：打开浏览器让用户授权，等回调，换令牌并保存。
 * onStatus 用来在界面上提示当前进行到哪一步。
 */
export async function loginMcpServer(
  server: { id: string; url?: string; headers?: Record<string, string>; oauth?: McpOAuthSettings },
  onStatus?: (text: string) => void
): Promise<McpTokenRecord> {
  const serverUrl = (server.url || "").trim();
  if (!/^https?:\/\//i.test(serverUrl)) throw new Error("先填好服务地址");
  const settings = server.oauth || {};
  const port = settings.port || DEFAULT_OAUTH_PORT;
  const headers = { ...(server.headers || {}) };
  delete headers.Authorization;
  delete headers.authorization;

  onStatus?.("正在读取授权信息…");
  const info = await discover(serverUrl, headers);

  onStatus?.("正在准备回调…");
  const actualPort: number = await invoke("oauth_listen", { port });
  activePort = actualPort;
  const redirect = redirectUri(actualPort);

  try {
    let clientId = settings.clientId?.trim() || "";
    let clientSecret = settings.clientSecret?.trim() || "";
    if (!clientId) {
      if (!info.registrationEndpoint) {
        throw new Error("这个服务不支持自动注册，需要先建一个应用，把 Client ID（和 Client Secret）填到“OAuth 设置”里。");
      }
      onStatus?.("正在注册桌宠应用…");
      const response = await fetchExternal(info.registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "Paw 桌宠",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.client_id) {
        throw new Error(`自动注册失败：${data.error_description || data.error || response.status}`);
      }
      clientId = data.client_id;
      clientSecret = data.client_secret || "";
    }

    const verifier = randomString(64);
    const state = randomString(24);
    const scope = (settings.scopes?.trim() || info.scopes.join(" ")).trim();
    const authUrl = new URL(info.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirect);
    authUrl.searchParams.set("code_challenge", await challengeFor(verifier));
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("resource", info.resource);
    if (scope) authUrl.searchParams.set("scope", scope);

    onStatus?.("已在浏览器打开授权页，请在浏览器里登录并点同意…");
    await open(authUrl.toString());
    const callback: { code: string; state: string; error: string; error_description: string } = await invoke("oauth_wait", {
      port: actualPort,
      timeoutSecs: 300,
    });
    if (callback.error) throw new Error(`授权被拒绝或失败：${callback.error_description || callback.error}`);
    if (!callback.code) throw new Error("没有拿到授权码");
    if (callback.state !== state) throw new Error("授权回调校验失败（state 不一致），请重试。");

    onStatus?.("正在换取令牌…");
    const token = await tokenRequest(info.tokenEndpoint, {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: redirect,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
      resource: info.resource,
    });
    const record: McpTokenRecord = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1000 : undefined,
      tokenEndpoint: info.tokenEndpoint,
      clientId,
      clientSecret: clientSecret || undefined,
      resource: info.resource,
      scope: token.scope || scope,
      obtainedAt: new Date().toISOString(),
    };
    saveToken(server.id, record);
    return record;
  } finally {
    invoke("oauth_cancel", { port: actualPort }).catch(() => {});
    activePort = null;
  }
}
