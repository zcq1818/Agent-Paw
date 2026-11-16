import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Globe, MessageCircle, RefreshCw, Search } from "lucide-react";
import { pinyin } from "pinyin-pro";
import { useThemeClass } from "../store/theme";

/**
 * 快捷启动器：全局快捷键呼出，输入软件名 / 拼音 / 首字母，回车打开。
 * 搜不到软件时可以直接把这句话交给桌宠，或打开网址。
 */

interface LauncherApp {
  name: string;
  id: string;
  path: string;
  icon: string;
}

interface IndexedApp extends LauncherApp {
  lower: string;
  /** 英文单词首字母：Visual Studio Code → vsc */
  wordInitials: string;
  /** 全拼：weixin */
  full: string;
  /** 拼音首字母：wx */
  initials: string;
}

type Row =
  | { kind: "app"; app: IndexedApp; score: number }
  | { kind: "url"; url: string }
  | { kind: "ask"; text: string };

const USAGE_KEY = "paw_launcher_usage";
const WIDTH = 680;
const INPUT_HEIGHT = 64;
const ROW_HEIGHT = 48;
const MAX_ROWS = 8;
/** 缓存超过这么久就在后台重新扫描一次（新装的软件能搜到） */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

function loadUsage(): Record<string, { count: number; last: number }> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function recordUsage(id: string) {
  const usage = loadUsage();
  const entry = usage[id] || { count: 0, last: 0 };
  usage[id] = { count: entry.count + 1, last: Date.now() };
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {}
}

function indexApp(app: LauncherApp): IndexedApp {
  const lower = app.name.toLowerCase();
  const words = lower.split(/[^a-z0-9一-鿿]+/).filter(Boolean);
  const wordInitials = words.map((word) => (/^[a-z0-9]/.test(word) ? word[0] : "")).join("");
  let full = lower;
  let initials = wordInitials;
  if (/[一-鿿]/.test(app.name)) {
    const syllables = pinyin(app.name, { toneType: "none", type: "array", nonZh: "consecutive" }) as string[];
    full = syllables.join("").toLowerCase().replace(/\s+/g, "");
    initials = syllables
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s[0])
      .join("")
      .toLowerCase();
  }
  return { ...app, lower, wordInitials, full, initials };
}

/** 依次匹配 query 的每个字符（容错的模糊匹配）。 */
function subsequence(text: string, query: string) {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i += 1;
  return i === query.length;
}

function scoreApp(app: IndexedApp, query: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const name = app.lower.replace(/\s+/g, "");
  let score = 0;
  if (name === q) score = 100;
  else if (name.startsWith(q)) score = 85;
  else if (app.initials && app.initials.startsWith(q)) score = 78;
  else if (app.wordInitials && app.wordInitials.startsWith(q)) score = 76;
  else if (app.full.startsWith(q)) score = 72;
  else if (name.includes(q)) score = 60;
  else if (app.full.includes(q)) score = 50;
  else if (app.initials.includes(q) && q.length >= 2) score = 40;
  else if (q.length >= 2 && subsequence(name, q)) score = 25;
  else if (q.length >= 3 && subsequence(app.full, q)) score = 20;
  if (!score) return 0;
  // 卸载程序、帮助文档之类往后放
  if (/卸载|uninstall|帮助|help|readme|manual|说明/i.test(app.name)) score -= 30;
  return score;
}

function looksLikeUrl(text: string) {
  return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(text.trim()) && !/\s/.test(text.trim());
}

function AppIcon({ app }: { app: LauncherApp }) {
  if (app.icon) {
    return <img src={`data:image/png;base64,${app.icon}`} alt="" className="h-7 w-7 shrink-0 object-contain" draggable={false} />;
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-sm font-semibold text-primary-ink">
      {app.name.slice(0, 1)}
    </span>
  );
}

export function Launcher() {
  const themeClass = useThemeClass();
  const [apps, setApps] = useState<IndexedApp[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const usageRef = useRef(loadUsage());

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const list = await invoke<LauncherApp[]>("launcher_apps", { refresh });
      setApps(list.map(indexApp));
      setNotice(refresh ? `已更新，共 ${list.length} 个软件` : "");
    } catch (error) {
      setNotice(`读取软件列表失败：${error}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 第一次加载：先用缓存，缓存太旧或没有就后台重新扫描
  useEffect(() => {
    (async () => {
      const age = await invoke<number | null>("launcher_cache_age").catch(() => null);
      if (age === null) {
        await load(true);
        return;
      }
      await load(false);
      if (age > REFRESH_AFTER_MS) void load(true);
    })();
  }, [load]);

  const hide = useCallback(() => {
    getCurrentWindow().hide().catch(() => {});
  }, []);

  // 每次呼出：清空输入、聚焦；失去焦点就收起
  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let disposed = false;
    const track = (promise: Promise<() => void>) =>
      promise.then((fn) => (disposed ? fn() : unlisten.push(fn))).catch(() => {});
    track(
      listen("launcher-shown", () => {
        usageRef.current = loadUsage();
        setQuery("");
        setSelected(0);
        setNotice("");
        window.setTimeout(() => inputRef.current?.focus(), 30);
      })
    );
    track(
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) hide();
      })
    );
    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, [hide]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim();
    const usage = usageRef.current;
    const boost = (id: string) => {
      const entry = usage[id];
      if (!entry) return 0;
      const recency = Date.now() - entry.last < 7 * 86_400_000 ? 6 : 0;
      return Math.min(20, Math.log2(entry.count + 1) * 5) + recency;
    };
    if (!q) {
      // 空输入：最近常用的软件
      return apps
        .filter((app) => usage[app.id])
        .map((app) => ({ kind: "app" as const, app, score: boost(app.id) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ROWS);
    }
    const matched = apps
      .map((app) => ({ kind: "app" as const, app, score: scoreApp(app, q) }))
      .filter((row) => row.score > 0)
      .map((row) => ({ ...row, score: row.score + boost(row.app.id) }))
      .sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length)
      .slice(0, MAX_ROWS - 1);
    const extra: Row[] = [];
    if (looksLikeUrl(q)) extra.push({ kind: "url", url: /^https?:\/\//i.test(q) ? q : `https://${q}` });
    extra.push({ kind: "ask", text: q });
    return [...matched, ...extra];
  }, [apps, query]);

  useEffect(() => {
    if (selected >= rows.length) setSelected(Math.max(0, rows.length - 1));
  }, [rows.length, selected]);

  // 窗口高度跟着结果条数走（透明窗口的空白处也会挡住鼠标，所以不能留大块空白）
  const footer = 28;
  const height = INPUT_HEIGHT + (rows.length ? rows.length * ROW_HEIGHT + 12 : 0) + (rows.length || notice ? footer : 0) + 16;
  useEffect(() => {
    getCurrentWindow()
      .setSize(new LogicalSize(WIDTH, height))
      .catch(() => {});
  }, [height]);

  const run = async (row: Row | undefined) => {
    if (!row) return;
    try {
      if (row.kind === "app") {
        recordUsage(row.app.id);
        await invoke("launcher_open", { id: row.app.id });
      } else if (row.kind === "url") {
        await invoke("launch_app", { target: row.url });
      } else {
        await emit("launcher-ask", { text: row.text });
      }
      hide();
    } catch (error) {
      setNotice(String(error));
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else hide();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((value) => (rows.length ? (value + 1) % rows.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((value) => (rows.length ? (value - 1 + rows.length) % rows.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void run(rows[selected]);
    } else if (event.altKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      void run(rows[Number(event.key) - 1]);
    }
  };

  return (
    <div className={`${themeClass} h-screen w-screen p-2`}>
      <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex h-16 shrink-0 items-center gap-3 px-5">
          <Search size={20} className="shrink-0 text-primary" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="搜索软件：名字、拼音或首字母都行，比如 wx、vsc"
            className="min-w-0 flex-1 bg-transparent text-lg text-fg outline-none placeholder:text-fg-muted"
            spellCheck={false}
          />
          {loading && <RefreshCw size={16} className="shrink-0 animate-spin text-fg-muted" />}
        </div>

        {rows.length > 0 && (
          <ul className="border-t border-line px-2 py-1.5">
            {rows.map((row, index) => {
              const active = index === selected;
              return (
                <li
                  key={row.kind === "app" ? row.app.id + row.app.name : row.kind}
                  onMouseMove={() => setSelected(index)}
                  onClick={() => void run(row)}
                  className={`flex h-12 cursor-pointer items-center gap-3 rounded-xl px-3 ${active ? "bg-primary/10" : ""}`}
                >
                  {row.kind === "app" ? (
                    <>
                      <AppIcon app={row.app} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-fg">{row.app.name}</div>
                        <div className="truncate text-[11px] text-fg-muted">{row.app.path || "应用商店应用"}</div>
                      </div>
                    </>
                  ) : row.kind === "url" ? (
                    <>
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
                        <Globe size={16} />
                      </span>
                      <div className="min-w-0 flex-1 truncate text-sm text-fg">打开网址 {row.url}</div>
                    </>
                  ) : (
                    <>
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-primary">
                        <MessageCircle size={16} />
                      </span>
                      <div className="min-w-0 flex-1 truncate text-sm text-fg">
                        问桌宠：<span className="text-fg-muted">{row.text}</span>
                      </div>
                    </>
                  )}
                  {index < 9 && <kbd className="shrink-0 text-[11px] text-fg-muted">{active ? "Enter" : `Alt+${index + 1}`}</kbd>}
                </li>
              );
            })}
          </ul>
        )}

        {(rows.length > 0 || notice) && (
          <div className="mt-auto flex h-7 shrink-0 items-center gap-3 border-t border-line px-5 text-[11px] text-fg-muted">
            <span className="min-w-0 flex-1 truncate">{notice || "↑↓ 选择 · Enter 打开 · Esc 关闭"}</span>
            <button
              type="button"
              className="flex items-center gap-1 hover:text-fg"
              onClick={() => void load(true)}
              title="重新扫描本机软件（装了新软件后用）"
            >
              <RefreshCw size={11} />
              刷新软件列表
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
