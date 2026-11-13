import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, LogOut, Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button, Card, Notice, Segmented, Switch } from "./ui";
import {
  formatPairs,
  joinArgs,
  newMcpServerId,
  parseMcpJson,
  parsePairs,
  splitArgs,
  useMcpStore,
  type McpServerConfig,
  type McpTransport,
} from "../agent/mcpServers";
import {
  DEFAULT_OAUTH_PORT,
  cancelMcpLogin,
  clearMcpToken,
  getMcpToken,
  loginMcpServer,
  redirectUri,
} from "../agent/mcpOAuth";

const TRANSPORT_OPTIONS: Array<{ value: McpTransport; label: string }> = [
  { value: "stdio", label: "本机命令" },
  { value: "http", label: "网址" },
];

interface Example {
  label: string;
  draft: Partial<Draft>;
  /** 选中后在表单上方显示的说明 */
  guide?: string;
}

/** 常用服务，点一下填进表单（只填表单，不会自动安装或连接）。 */
const EXAMPLES: Example[] = [
  {
    label: "Jira / Confluence",
    draft: { name: "Jira", transport: "http", url: "https://mcp.atlassian.com/v1/mcp/authv2" },
    guide:
      "Atlassian 官方 MCP。保存后会打开浏览器，用你的 Atlassian 账号登录并点同意即可，不需要填令牌。公司账号如果连不上，可能要管理员在 Atlassian 后台允许 Rovo MCP。",
  },
  {
    label: "Slack",
    draft: { name: "Slack", transport: "http", url: "https://mcp.slack.com/mcp", showOAuth: true },
    guide:
      "Slack 官方 MCP 不支持自动注册，需要先在 api.slack.com/apps 建一个内部应用：在 Agents & AI Apps 里打开 MCP，在 OAuth & Permissions 里加上下面的回调地址和需要的 User Token Scopes，再把 Client ID / Client Secret 填到这里。公司工作区一般需要管理员批准这个应用。",
  },
  {
    label: "文件系统",
    draft: { name: "文件系统", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-filesystem D:/文档" },
  },
  {
    label: "网页抓取",
    draft: { name: "网页抓取", transport: "stdio", command: "uvx", args: "mcp-server-fetch" },
  },
  {
    label: "浏览器（Playwright）",
    draft: { name: "浏览器", transport: "stdio", command: "npx", args: "-y @playwright/mcp@latest" },
  },
  {
    label: "GitHub",
    draft: {
      name: "GitHub",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: "Authorization: Bearer 你的 GitHub 令牌",
    },
  },
];

interface Draft {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  showOAuth: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string;
  port: string;
}

function emptyDraft(): Draft {
  return {
    id: "",
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    showOAuth: false,
    clientId: "",
    clientSecret: "",
    scopes: "",
    port: "",
  };
}

function toDraft(server: McpServerConfig): Draft {
  const oauth = server.oauth || {};
  return {
    ...emptyDraft(),
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command || "",
    args: joinArgs(server.args),
    env: formatPairs(server.env, "="),
    cwd: server.cwd || "",
    url: server.url || "",
    headers: formatPairs(server.headers, ":"),
    showOAuth: Boolean(oauth.clientId || oauth.scopes || oauth.port),
    clientId: oauth.clientId || "",
    clientSecret: oauth.clientSecret || "",
    scopes: oauth.scopes || "",
    port: oauth.port ? String(oauth.port) : "",
  };
}

function fromDraft(draft: Draft, enabled: boolean): McpServerConfig {
  const env = parsePairs(draft.env, "=");
  const headers = parsePairs(draft.headers, ":");
  if (draft.transport === "stdio") {
    return {
      id: draft.id || newMcpServerId(),
      name: draft.name.trim(),
      transport: "stdio",
      enabled,
      command: draft.command.trim(),
      args: splitArgs(draft.args),
      env: Object.keys(env).length ? env : undefined,
      cwd: draft.cwd.trim() || undefined,
    };
  }
  const port = Number(draft.port);
  const oauth = {
    clientId: draft.clientId.trim() || undefined,
    clientSecret: draft.clientSecret.trim() || undefined,
    scopes: draft.scopes.trim() || undefined,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
  };
  return {
    id: draft.id || newMcpServerId(),
    name: draft.name.trim(),
    transport: "http",
    enabled,
    url: draft.url.trim(),
    headers: Object.keys(headers).length ? headers : undefined,
    oauth: Object.values(oauth).some((value) => value !== undefined) ? oauth : undefined,
  };
}

function ServerForm({ initial, onDone }: { initial: Draft; onDone: (saved?: McpServerConfig) => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [guide, setGuide] = useState("");
  const [error, setError] = useState("");
  const patch = (value: Partial<Draft>) => setDraft((current) => ({ ...current, ...value }));
  const callback = redirectUri(Number(draft.port) || DEFAULT_OAUTH_PORT);

  const submit = () => {
    if (!draft.name.trim()) return setError("起个名字，比如“Jira”");
    if (draft.transport === "stdio" && !draft.command.trim()) return setError("填上启动命令，比如 npx、uvx 或程序路径");
    if (draft.transport === "http" && !/^https?:\/\//i.test(draft.url.trim())) return setError("网址要以 http:// 或 https:// 开头");
    if (draft.transport === "http" && /mcp\.slack\.com/i.test(draft.url) && !draft.clientId.trim()) {
      return setError("Slack 需要先填自己建的 Slack 应用的 Client ID 和 Client Secret");
    }
    onDone(fromDraft(draft, true));
  };

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-2 px-4 py-3">
      {!initial.id && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          常用：
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              className="rounded-full border border-line px-2 py-0.5 hover:border-primary hover:text-fg"
              onClick={() => {
                setDraft({ ...emptyDraft(), ...example.draft });
                setGuide(example.guide || "");
                setError("");
              }}
            >
              {example.label}
            </button>
          ))}
        </div>
      )}
      {guide && <Notice tone="info">{guide}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-fg-muted">
          名字
          <input className="input mt-1 w-full" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <div className="text-xs text-fg-muted">
          连接方式
          <div className="mt-1">
            <Segmented value={draft.transport} options={TRANSPORT_OPTIONS} onChange={(transport) => patch({ transport })} />
          </div>
        </div>
      </div>
      {draft.transport === "stdio" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <label className="block text-xs text-fg-muted">
              命令
              <input className="input mt-1 w-full" placeholder="npx" value={draft.command} onChange={(e) => patch({ command: e.target.value })} />
            </label>
            <label className="block text-xs text-fg-muted">
              参数（空格分隔，带空格的用引号）
              <input
                className="input mt-1 w-full"
                placeholder="-y @modelcontextprotocol/server-filesystem D:/文档"
                value={draft.args}
                onChange={(e) => patch({ args: e.target.value })}
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-fg-muted">
              环境变量（每行 KEY=VALUE，可选）
              <textarea className="input mt-1 min-h-[60px] w-full resize-y font-mono" value={draft.env} onChange={(e) => patch({ env: e.target.value })} />
            </label>
            <label className="block text-xs text-fg-muted">
              工作目录（可选）
              <input className="input mt-1 w-full" value={draft.cwd} onChange={(e) => patch({ cwd: e.target.value })} />
            </label>
          </div>
        </>
      ) : (
        <>
          <label className="block text-xs text-fg-muted">
            地址（Streamable HTTP）
            <input
              className="input mt-1 w-full"
              placeholder="https://example.com/mcp"
              value={draft.url}
              onChange={(e) => patch({ url: e.target.value })}
            />
          </label>
          <label className="block text-xs text-fg-muted">
            请求头（可选，每行 名字: 值。支持登录授权的服务不用填）
            <textarea className="input mt-1 min-h-[52px] w-full resize-y font-mono" value={draft.headers} onChange={(e) => patch({ headers: e.target.value })} />
          </label>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
            onClick={() => patch({ showOAuth: !draft.showOAuth })}
          >
            {draft.showOAuth ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            OAuth 登录设置（Slack 这类要自建应用的服务才需要）
          </button>
          {draft.showOAuth && (
            <div className="space-y-3 rounded-lg border border-line bg-surface px-3 py-3">
              <div className="text-xs text-fg-muted">
                回调地址（在服务方的应用设置里添加）：
                <code className="ml-1 select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">{callback}</code>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-fg-muted">
                  Client ID
                  <input className="input mt-1 w-full font-mono" value={draft.clientId} onChange={(e) => patch({ clientId: e.target.value })} />
                </label>
                <label className="block text-xs text-fg-muted">
                  Client Secret
                  <input
                    className="input mt-1 w-full font-mono"
                    type="password"
                    value={draft.clientSecret}
                    onChange={(e) => patch({ clientSecret: e.target.value })}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  权限范围（可选，空格分隔；留空用服务声明的全部）
                  <input className="input mt-1 w-full font-mono" value={draft.scopes} onChange={(e) => patch({ scopes: e.target.value })} />
                </label>
                <label className="block text-xs text-fg-muted">
                  回调端口（可选，默认 {DEFAULT_OAUTH_PORT}）
                  <input
                    className="input mt-1 w-full font-mono"
                    inputMode="numeric"
                    placeholder={String(DEFAULT_OAUTH_PORT)}
                    value={draft.port}
                    onChange={(e) => patch({ port: e.target.value.replace(/\D/g, "") })}
                  />
                </label>
              </div>
            </div>
          )}
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={submit}>
          保存并连接
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone()}>
          取消
        </Button>
      </div>
    </div>
  );
}

function ImportForm({ onDone }: { onDone: (servers?: McpServerConfig[]) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface-2 px-4 py-3">
      <div className="text-xs text-fg-muted">
        粘贴其他软件里用的 MCP 配置（含 <code>mcpServers</code> 的 JSON），可以一次导入多个。
      </div>
      <textarea
        className="input min-h-[120px] w-full resize-y font-mono text-xs"
        placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/文档"] }\n  }\n}'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            try {
              onDone(parseMcpJson(text));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          导入
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone()}>
          取消
        </Button>
      </div>
    </div>
  );
}

function needsLogin(error?: string) {
  return Boolean(error && /需要登录|登录已过期|点“登录授权”/.test(error));
}

/** 设置 → MCP 服务。 */
export function McpServersCard() {
  const servers = useMcpStore((s) => s.servers);
  const state = useMcpStore((s) => s.state);
  const busy = useMcpStore((s) => s.busy);
  const { save, remove, setEnabled, refresh, reload } = useMcpStore.getState();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [login, setLogin] = useState<{ id: string; status: string } | null>(null);
  const [loginError, setLoginError] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key?.startsWith("paw_mcp_")) reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);

  const startLogin = async (server: McpServerConfig) => {
    if (login) return;
    setLoginError((current) => ({ ...current, [server.id]: "" }));
    setLogin({ id: server.id, status: "准备登录…" });
    try {
      await loginMcpServer(server, (status) => setLogin({ id: server.id, status }));
      setLogin({ id: server.id, status: "登录成功，正在连接…" });
      await refresh(server.id);
    } catch (error) {
      setLoginError((current) => ({ ...current, [server.id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setLogin(null);
      setTick((value) => value + 1);
    }
  };

  const saveAndConnect = async (server: McpServerConfig) => {
    const previous = servers.find((item) => item.id === server.id);
    const saved = { ...server, enabled: previous ? previous.enabled : true };
    save(saved);
    const result = await refresh(server.id);
    // 需要登录的服务（Jira、Slack 等）保存后直接打开浏览器授权
    if (saved.transport === "http" && needsLogin(result.error) && !getMcpToken(saved.id)) {
      await startLogin(saved);
    }
  };

  return (
    <Card
      title="外部 MCP 服务"
      description="接入现成的 MCP 工具服务（Jira、Slack、文件、浏览器……），桌宠聊天时就能直接用。网址方式支持登录授权；本机命令需要先装好 Node.js 或 Python。"
      actions={
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setImporting(true); setEditing(null); }}>
            粘贴 JSON 导入
          </Button>
          <Button size="sm" variant="primary" onClick={() => { setEditing(emptyDraft()); setImporting(false); }}>
            <Plus size={14} />
            添加
          </Button>
        </div>
      }
    >
      {editing && !editing.id && (
        <ServerForm
          initial={editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) void saveAndConnect(saved);
          }}
        />
      )}
      {importing && (
        <ImportForm
          onDone={(list) => {
            setImporting(false);
            list?.forEach((server) => void saveAndConnect(server));
          }}
        />
      )}

      {servers.length === 0 && !editing && !importing ? (
        <p className="text-xs text-fg-muted">还没有接入。点“添加”选 Jira、Slack 等常用服务，或把别的软件里的 MCP 配置粘贴进来。</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {servers.map((server) => {
            const info = state[server.id];
            const loading = Boolean(busy[server.id]);
            const isOpen = Boolean(expanded[server.id]);
            const token = server.transport === "http" ? getMcpToken(server.id) : undefined;
            const loggingIn = login?.id === server.id;
            const target = server.transport === "stdio" ? `${server.command || ""} ${joinArgs(server.args)}`.trim() : server.url || "";
            const manualAuth = Object.keys(server.headers || {}).some((key) => key.toLowerCase() === "authorization");
            const canLogin = server.transport === "http" && !manualAuth;
            if (editing?.id === server.id) {
              return (
                <li key={server.id} className="p-2">
                  <ServerForm
                    initial={editing}
                    onDone={(saved) => {
                      setEditing(null);
                      if (saved) void saveAndConnect(saved);
                    }}
                  />
                </li>
              );
            }
            return (
              <li key={server.id} className="space-y-1.5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-fg-muted hover:text-fg"
                    onClick={() => setExpanded((current) => ({ ...current, [server.id]: !isOpen }))}
                    aria-label={isOpen ? "收起工具列表" : "展开工具列表"}
                  >
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-sm ${server.enabled ? "text-fg" : "text-fg-muted"}`}>{server.name}</span>
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
                        {server.transport === "stdio" ? "本机命令" : "网址"}
                      </span>
                      {token && (
                        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary-ink">已登录</span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-fg-muted" title={target}>
                      {target}
                    </div>
                    <div className="text-xs">
                      {loggingIn ? (
                        <span className="text-primary-ink">{login?.status}</span>
                      ) : loading ? (
                        <span className="text-fg-muted">连接中…（第一次用 npx / uvx 可能要下载，稍等）</span>
                      ) : loginError[server.id] ? (
                        <span className="text-danger">✕ {loginError[server.id]}</span>
                      ) : info?.error ? (
                        <span className="text-danger">✕ {info.error}</span>
                      ) : info?.updatedAt ? (
                        <span className="text-success">
                          ✓ {info.tools.length} 个工具
                          {info.serverName ? ` · ${info.serverName}${info.serverVersion ? ` ${info.serverVersion}` : ""}` : ""}
                        </span>
                      ) : (
                        <span className="text-fg-muted">还没连接</span>
                      )}
                    </div>
                  </div>
                  {canLogin &&
                    (loggingIn ? (
                      <Button size="sm" variant="ghost" onClick={cancelMcpLogin} title="取消登录">
                        取消
                      </Button>
                    ) : token ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (!confirm(`退出「${server.name}」的登录？桌宠会删掉保存的令牌。`)) return;
                          clearMcpToken(server.id);
                          setTick((value) => value + 1);
                          void refresh(server.id);
                        }}
                        title="退出登录（删除本机保存的令牌）"
                      >
                        <LogOut size={14} />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={needsLogin(info?.error) ? "primary" : "secondary"}
                        disabled={Boolean(login)}
                        onClick={() => startLogin(server)}
                        title="在浏览器里登录并授权"
                      >
                        <KeyRound size={14} />
                        登录授权
                      </Button>
                    ))}
                  <Button size="sm" variant="ghost" disabled={loading} onClick={() => refresh(server.id)} title={info?.updatedAt ? "重新连接并刷新工具" : "连接"}>
                    {info?.updatedAt ? <RefreshCw size={14} /> : <Plug size={14} />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(toDraft(server)); setImporting(false); }} title="编辑">
                    <Pencil size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (confirm(`删除 MCP 服务「${server.name}」？`)) remove(server.id);
                    }}
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </Button>
                  <Switch label={`启用 ${server.name}`} checked={server.enabled} onChange={(enabled) => setEnabled(server.id, enabled)} />
                </div>
                {isOpen && (
                  <div className="ml-6 flex flex-wrap gap-1.5">
                    {info?.tools?.length ? (
                      info.tools.map((tool) => (
                        <span
                          key={tool.name}
                          title={tool.description || tool.name}
                          className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-fg"
                        >
                          {tool.name}
                          {tool.annotations?.readOnlyHint ? <span className="ml-1 text-fg-muted">只读</span> : null}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-fg-muted">还没有工具列表，先连接一次。</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-fg-muted">
        登录授权在你自己的浏览器里完成，桌宠不接触账号密码，只在本机保存服务发的令牌，不会发给模型。除了服务自己标为只读的工具，桌宠每次调用前都会弹确认卡片，可以选“一直允许”。
      </p>
    </Card>
  );
}
