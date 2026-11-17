import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { Globe } from "lucide-react";
import { Button, Segmented, Switch } from "./ui";
import { useMcpStore, type McpServerConfig } from "../agent/mcpServers";

/**
 * 内置的“浏览器”：用微软的 Playwright MCP 按网页结构操作（读页面、点按钮、填表），不动鼠标键盘。
 * - 后台浏览器：独立的 Edge，默认不显示窗口；登录状态存在 data\browser 里，下次还在；
 * - 用我的 Chrome：通过 Chrome 扩展连到你正在用的 Chrome，直接用里面的登录状态，在后台标签页里操作。
 */

export const BROWSER_SERVER_ID = "mcp_builtin_browser";
const PACKAGE = "@playwright/mcp@0.0.85";
const TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";
const EXTENSION_URL = "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";
const NODE_URL = "https://nodejs.org/zh-cn/download";

type Mode = "background" | "chrome";
interface BrowserSettings {
  mode: Mode;
  showWindow: boolean;
  token: string;
}

const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: "background", label: "后台浏览器" },
  { value: "chrome", label: "用我的 Chrome" },
];

function readSettings(server?: McpServerConfig): BrowserSettings {
  const args = server?.args || [];
  return {
    mode: args.includes("--extension") ? "chrome" : "background",
    showWindow: server ? !args.includes("--headless") && !args.includes("--extension") : false,
    token: server?.env?.[TOKEN_ENV] || "",
  };
}

/** 浏览器资料（登录状态）和它生成的快照文件都放在数据文件夹里，跟着安装目录走 */
async function dataDir() {
  const skills: string = await invoke("skills_root");
  return skills.replace(/[\\/]skills[\\/]?$/, "");
}

async function buildServer(settings: BrowserSettings, enabled: boolean): Promise<McpServerConfig> {
  const data = await dataDir();
  const args = ["-y", PACKAGE, "--output-dir", `${data}\\browser-output`];
  if (settings.mode === "chrome") {
    // --background：不把 Chrome 切到前台，也不激活它开的标签页
    args.push("--extension", "--background");
  } else {
    args.push("--browser", "msedge", "--user-data-dir", `${data}\\browser`);
    if (!settings.showWindow) args.push("--headless");
  }
  const token = settings.token.trim();
  return {
    id: BROWSER_SERVER_ID,
    name: "浏览器",
    transport: "stdio",
    enabled,
    command: "npx",
    args,
    env: settings.mode === "chrome" && token ? { [TOKEN_ENV]: token } : undefined,
  };
}

function friendlyError(error: string) {
  if (/找不到命令 npx/.test(error)) return { text: "需要先安装 Node.js（装好后重启桌宠）", node: true };
  return { text: error.length > 300 ? `${error.slice(0, 300)}…` : error, node: false };
}

export function BrowserCard() {
  const server = useMcpStore((s) => s.servers.find((item) => item.id === BROWSER_SERVER_ID));
  const info = useMcpStore((s) => s.state[BROWSER_SERVER_ID]);
  const busy = useMcpStore((s) => Boolean(s.busy[BROWSER_SERVER_ID]));
  const { save, remove, setEnabled, refresh } = useMcpStore.getState();
  const [settings, setSettings] = useState<BrowserSettings>(() => readSettings(server));

  useEffect(() => {
    if (server) setSettings(readSettings(server));
    // 只在配置变了（比如别的窗口改了）时同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.args?.join(" "), server?.env?.[TOKEN_ENV]]);

  const connected = Boolean(server?.enabled && info?.updatedAt && !info?.error);
  const error = server?.enabled ? info?.error : undefined;

  /** 保存设置；已经启用的话马上按新设置重启 */
  const apply = async (next: BrowserSettings, enable = server?.enabled ?? false) => {
    setSettings(next);
    if (!server && !enable) return;
    const config = await buildServer(next, enable);
    save(config);
    if (enable) await refresh(BROWSER_SERVER_ID).catch(() => {});
  };

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-ink">
          <Globe size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">浏览器</span>
            {connected && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary-ink">已启用</span>}
          </div>
          <div className="text-xs leading-relaxed text-fg-muted">
            让桌宠打开网页、点按钮、填表、读内容。它按网页结构直接操作，不动你的鼠标和键盘；点击、输入这类操作会先弹卡片问你。
          </div>
        </div>
        {server && (
          <Switch
            label="启用浏览器"
            checked={server.enabled}
            onChange={(enabled) => {
              setEnabled(BROWSER_SERVER_ID, enabled);
              if (enabled) void refresh(BROWSER_SERVER_ID).catch(() => {});
            }}
          />
        )}
      </div>

      <Segmented value={settings.mode} options={MODE_OPTIONS} onChange={(mode) => void apply({ ...settings, mode })} />

      {settings.mode === "background" ? (
        <div className="space-y-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
          <p>在后台开一个独立的 Edge，看不见、不抢焦点，和你自己的浏览器互不影响。登录过的网站会记住，下次不用再登。</p>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg">显示窗口</div>
              <div>要登录网站时打开：对桌宠说“打开 某某网站”，在弹出的窗口里登录一次，然后再关掉。</div>
            </div>
            <Switch label="显示浏览器窗口" checked={settings.showWindow} onChange={(showWindow) => void apply({ ...settings, showWindow })} />
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
          <p>直接用你 Chrome 里的登录状态。桌宠在 Chrome 里新开标签页操作，不会切到前台，也不会动你正在看的页面。</p>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">① 在 Chrome 里安装官方的 Playwright Extension</span>
            <Button size="sm" variant="secondary" onClick={() => void open(EXTENSION_URL)}>
              打开商店页
            </Button>
          </div>
          <div>② 点 Chrome 工具栏上的扩展图标，复制里面的令牌粘贴到这里。不填也能用，但每次连接都要在 Chrome 里点一下同意。</div>
          <input
            className="input h-8 w-full font-mono text-xs"
            type="password"
            placeholder={TOKEN_ENV}
            value={settings.token}
            onChange={(event) => setSettings({ ...settings, token: event.target.value })}
            onBlur={() => {
              if (settings.token.trim() !== (server?.env?.[TOKEN_ENV] || "")) void apply(settings);
            }}
          />
        </div>
      )}

      <div className="flex items-center gap-2 text-xs">
        <div className="min-w-0 flex-1">
          {busy ? (
            <span className="text-fg-muted">启动中…第一次要下载组件，可能要一两分钟</span>
          ) : error ? (
            <span className="text-danger">✕ {friendlyError(error).text}</span>
          ) : connected ? (
            <span className="text-success">
              {settings.mode === "chrome"
                ? "✓ 准备好了。第一次用时才会连到你的 Chrome，所以要先装好上面的扩展"
                : "✓ 可以用了。对桌宠说“打开 xx 网站，帮我查一下…”"}
            </span>
          ) : server && !server.enabled ? (
            <span className="text-fg-muted">已关闭</span>
          ) : null}
        </div>
        {error && friendlyError(error).node && (
          <Button size="sm" variant="secondary" onClick={() => void open(NODE_URL)}>
            下载 Node.js
          </Button>
        )}
        {!server ? (
          <Button size="sm" variant="primary" onClick={() => void apply(settings, true)}>
            启用
          </Button>
        ) : (
          error && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh(BROWSER_SERVER_ID).catch(() => {})}>
              重试
            </Button>
          )
        )}
        {server && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm("移除浏览器？后台浏览器里登录过的网站信息还留在数据文件夹，下次启用还能用。")) remove(BROWSER_SERVER_ID);
            }}
          >
            移除
          </Button>
        )}
      </div>
    </div>
  );
}
