import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
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

const TRANSPORT_OPTIONS: Array<{ value: McpTransport; label: string }> = [
  { value: "stdio", label: "本机命令" },
  { value: "http", label: "网址" },
];

/** 常用服务，点一下填进表单（只填表单，不会自动安装或连接）。 */
const EXAMPLES: Array<{ label: string; draft: Partial<Draft> }> = [
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
    label: "GitHub（远程）",
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
}

function emptyDraft(): Draft {
  return { id: "", name: "", transport: "stdio", command: "", args: "", env: "", cwd: "", url: "", headers: "" };
}

function toDraft(server: McpServerConfig): Draft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command || "",
    args: joinArgs(server.args),
    env: formatPairs(server.env, "="),
    cwd: server.cwd || "",
    url: server.url || "",
    headers: formatPairs(server.headers, ":"),
  };
}

function fromDraft(draft: Draft, enabled: boolean): McpServerConfig {
  const env = parsePairs(draft.env, "=");
  const headers = parsePairs(draft.headers, ":");
  return draft.transport === "stdio"
    ? {
        id: draft.id || newMcpServerId(),
        name: draft.name.trim(),
        transport: "stdio",
        enabled,
        command: draft.command.trim(),
        args: splitArgs(draft.args),
        env: Object.keys(env).length ? env : undefined,
        cwd: draft.cwd.trim() || undefined,
      }
    : {
        id: draft.id || newMcpServerId(),
        name: draft.name.trim(),
        transport: "http",
        enabled,
        url: draft.url.trim(),
        headers: Object.keys(headers).length ? headers : undefined,
      };
}

function ServerForm({ initial, onDone }: { initial: Draft; onDone: (saved?: McpServerConfig) => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState("");
  const patch = (value: Partial<Draft>) => setDraft((current) => ({ ...current, ...value }));

  const submit = () => {
    if (!draft.name.trim()) return setError("起个名字，比如“文件系统”");
    if (draft.transport === "stdio" && !draft.command.trim()) return setError("填上启动命令，比如 npx、uvx 或程序路径");
    if (draft.transport === "http" && !/^https?:\/\//i.test(draft.url.trim())) return setError("网址要以 http:// 或 https:// 开头");
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
              onClick={() => setDraft({ ...emptyDraft(), ...example.draft })}
            >
              {example.label}
            </button>
          ))}
        </div>
      )}
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
            请求头（每行 名字: 值，可选，例如 Authorization: Bearer xxx）
            <textarea className="input mt-1 min-h-[60px] w-full resize-y font-mono" value={draft.headers} onChange={(e) => patch({ headers: e.target.value })} />
          </label>
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

/** 设置 → AI 能力 → 外部 MCP 服务。 */
export function McpServersCard() {
  const servers = useMcpStore((s) => s.servers);
  const state = useMcpStore((s) => s.state);
  const busy = useMcpStore((s) => s.busy);
  const { save, remove, setEnabled, refresh, reload } = useMcpStore.getState();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key?.startsWith("paw_mcp_")) reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);

  const saveAndConnect = (server: McpServerConfig) => {
    const previous = servers.find((item) => item.id === server.id);
    save({ ...server, enabled: previous ? previous.enabled : true });
    void refresh(server.id);
  };

  return (
    <Card
      title="外部 MCP 服务"
      description="接入现成的 MCP 工具服务（文件、浏览器、GitHub、数据库……），桌宠聊天时就能直接用。本机命令需要先装好 Node.js 或 Python。"
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
            if (saved) saveAndConnect(saved);
          }}
        />
      )}
      {importing && (
        <ImportForm
          onDone={(list) => {
            setImporting(false);
            list?.forEach(saveAndConnect);
          }}
        />
      )}

      {servers.length === 0 && !editing && !importing ? (
        <p className="text-xs text-fg-muted">还没有接入。点“添加”，或把别的软件里的 MCP 配置粘贴进来。</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {servers.map((server) => {
            const info = state[server.id];
            const loading = Boolean(busy[server.id]);
            const isOpen = Boolean(expanded[server.id]);
            const target = server.transport === "stdio" ? `${server.command || ""} ${joinArgs(server.args)}`.trim() : server.url || "";
            if (editing?.id === server.id) {
              return (
                <li key={server.id} className="p-2">
                  <ServerForm
                    initial={editing}
                    onDone={(saved) => {
                      setEditing(null);
                      if (saved) saveAndConnect(saved);
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
                    </div>
                    <div className="truncate font-mono text-[11px] text-fg-muted" title={target}>
                      {target}
                    </div>
                    <div className="text-xs">
                      {loading ? (
                        <span className="text-fg-muted">连接中…（第一次用 npx / uvx 可能要下载，稍等）</span>
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
        除了服务自己标为只读的工具，桌宠每次调用前都会弹确认卡片，可以选“一直允许”。环境变量和请求头里的令牌只存在本机，不会发给模型。
      </p>
    </Card>
  );
}
