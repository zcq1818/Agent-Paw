import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Globe, MessageCircle, PawPrint, RefreshCw, Tag } from "lucide-react";
import { useThemeClass } from "../store/theme";
import { indexApp, isUsefulApp, matchApp, type IndexedApp, type LauncherApp } from "../agent/launcherSearch";

/**
 * 快捷启动器：全局快捷键呼出，输入软件名 / 拼音 / 首字母 / 简称，回车打开。
 * 选中软件按 Tab 可以给它设自己的简称；搜不到软件时可以打开网址或交给桌宠。
 */

type Row =
  | { kind: "app"; app: IndexedApp; score: number; highlight: Set<number>; via?: string }
  | { kind: "url"; url: string }
  | { kind: "ask"; text: string };

const USAGE_KEY = "paw_launcher_usage";
const ALIAS_KEY = "paw_launcher_alias";
const WIDTH = 720;
const PAD = 14; // 外圈留给阴影的透明边
const SEARCH_H = 68;
const ROW_H = 56;
const LABEL_H = 26;
const FOOTER_H = 40;
const MAX_APPS = 7;
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
const EXAMPLES: Array<[string, string]> = [
  ["wx", "微信"],
  ["vsc", "VS Code"],
  ["jsb", "记事本"],
  ["chrome", "浏览器"],
];

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function recordUsage(id: string) {
  const usage = readJson<Record<string, { count: number; last: number }>>(USAGE_KEY, {});
  const entry = usage[id] || { count: 0, last: 0 };
  usage[id] = { count: entry.count + 1, last: Date.now() };
  writeJson(USAGE_KEY, usage);
}

function looksLikeUrl(text: string) {
  const value = text.trim();
  return !/\s/.test(value) && /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(value);
}

/** 路径太长时只留盘符和最后两级。 */
function shortPath(path: string) {
  if (!path) return "应用商店";
  const parts = path.split(/[\\/]/);
  return parts.length <= 4 ? path : `${parts[0]}\\…\\${parts.slice(-2).join("\\")}`;
}

function Highlighted({ text, marks }: { text: string; marks: Set<number> }) {
  if (!marks.size) return <>{text}</>;
  const out: ReactNode[] = [];
  let buffer = "";
  let marked = false;
  const flush = (key: number) => {
    if (!buffer) return;
    out.push(
      marked ? (
        <span key={key} className="font-semibold text-primary-ink">
          {buffer}
        </span>
      ) : (
        <Fragment key={key}>{buffer}</Fragment>
      )
    );
    buffer = "";
  };
  [...text].forEach((ch, i) => {
    const isMarked = marks.has(i);
    if (isMarked !== marked) {
      flush(i);
      marked = isMarked;
    }
    buffer += ch;
  });
  flush(text.length);
  return <>{out}</>;
}

function AppIcon({ app, size = 28 }: { app: LauncherApp; size?: number }) {
  if (app.icon) {
    return (
      <img
        src={`data:image/png;base64,${app.icon}`}
        alt=""
        draggable={false}
        style={{ width: size, height: size }}
        className="shrink-0 object-contain"
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-semibold text-primary-ink"
    >
      {app.name.slice(0, 1)}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-md border border-line bg-surface-2 px-1.5 font-sans text-[10px] font-medium text-fg-muted shadow-[0_1px_0_rgb(var(--line))]">
      {children}
    </kbd>
  );
}

export function Launcher() {
  const themeClass = useThemeClass();
  const [rawApps, setRawApps] = useState<LauncherApp[]>([]);
  const [aliases, setAliases] = useState<Record<string, string[]>>(() => readJson(ALIAS_KEY, {}));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [aliasTarget, setAliasTarget] = useState<IndexedApp | null>(null);
  const [aliasInput, setAliasInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [usage, setUsage] = useState(() => readJson<Record<string, { count: number; last: number }>>(USAGE_KEY, {}));

  const apps = useMemo(
    () => rawApps.filter(isUsefulApp).map((app) => indexApp(app, aliases[app.id] || [])),
    [rawApps, aliases]
  );

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const list = await invoke<LauncherApp[]>("launcher_apps", { refresh });
      setRawApps(list);
      if (refresh) setNotice(`已更新，共 ${list.filter(isUsefulApp).length} 个软件`);
    } catch (error) {
      setNotice(`读取软件列表失败：${error}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const age = await invoke<number | null>("launcher_cache_age").catch(() => null);
      if (age === null) return load(true);
      await load(false);
      if (age > REFRESH_AFTER_MS) void load(true);
    })();
  }, [load]);

  const hide = useCallback(() => {
    getCurrentWindow().hide().catch(() => {});
  }, []);

  const focusInput = () => window.setTimeout(() => inputRef.current?.focus(), 20);

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let disposed = false;
    const track = (promise: Promise<() => void>) => promise.then((fn) => (disposed ? fn() : unlisten.push(fn))).catch(() => {});
    track(
      listen("launcher-shown", () => {
        setUsage(readJson(USAGE_KEY, {}));
        setAliases(readJson(ALIAS_KEY, {}));
        setQuery("");
        setSelected(0);
        setNotice("");
        setAliasTarget(null);
        focusInput();
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

  const boost = useCallback(
    (id: string) => {
      const entry = usage[id];
      if (!entry) return 0;
      return Math.min(18, Math.log2(entry.count + 1) * 5) + (Date.now() - entry.last < 7 * 86_400_000 ? 6 : 0);
    },
    [usage]
  );

  const { rows, sections } = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const recent = apps
        .filter((app) => usage[app.id])
        .sort((a, b) => boost(b.id) - boost(a.id) || usage[b.id].last - usage[a.id].last)
        .slice(0, MAX_APPS)
        .map((app) => ({ kind: "app" as const, app, score: 0, highlight: new Set<number>() }));
      return { rows: recent as Row[], sections: recent.length ? [{ at: 0, label: "最近使用" }] : [] };
    }
    const matchedAll = apps
      .map((app) => {
        const m = matchApp(app, q);
        return m ? { kind: "app" as const, app, score: m.score + boost(app.id), highlight: m.highlight, via: m.via } : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length);
    // 已经有很准的结果时，跳字匹配这类勉强沾边的就不显示了
    const top = matchedAll[0]?.score || 0;
    const matched: Row[] = matchedAll.filter((row) => top < 80 || row.score >= 56).slice(0, MAX_APPS);
    const extra: Row[] = [];
    if (looksLikeUrl(q)) extra.push({ kind: "url", url: /^https?:\/\//i.test(q) ? q : `https://${q}` });
    extra.push({ kind: "ask", text: q });
    const sections = [];
    if (matched.length) sections.push({ at: 0, label: "软件" });
    sections.push({ at: matched.length, label: "更多" });
    return { rows: [...matched, ...extra], sections };
  }, [apps, query, usage, boost]);

  useEffect(() => {
    if (selected >= rows.length) setSelected(Math.max(0, rows.length - 1));
  }, [rows.length, selected]);

  const showExamples = !query.trim() && rows.length === 0 && !aliasTarget;
  const listHeight = aliasTarget ? 0 : rows.length * ROW_H + sections.length * LABEL_H + (rows.length ? 12 : 0);
  const height = PAD * 2 + SEARCH_H + listHeight + (showExamples ? 64 : 0) + FOOTER_H;
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

  const startAlias = (row: Row | undefined) => {
    if (row?.kind !== "app") return;
    setAliasTarget(row.app);
    setAliasInput((aliases[row.app.id] || []).join(" "));
    focusInput();
  };

  const saveAlias = () => {
    if (!aliasTarget) return;
    const list = aliasInput
      .split(/[\s,，、]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const next = { ...aliases };
    if (list.length) next[aliasTarget.id] = [...new Set(list)];
    else delete next[aliasTarget.id];
    setAliases(next);
    writeJson(ALIAS_KEY, next);
    setNotice(list.length ? `「${aliasTarget.name}」的简称：${list.join("、")}` : `已清除「${aliasTarget.name}」的简称`);
    setQuery(list[0] || query);
    setAliasTarget(null);
    setSelected(0);
    focusInput();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (aliasTarget) {
      if (event.key === "Enter") {
        event.preventDefault();
        saveAlias();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setAliasTarget(null);
        focusInput();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else hide();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((v) => (rows.length ? (v + 1) % rows.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((v) => (rows.length ? (v - 1 + rows.length) % rows.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void run(rows[selected]);
    } else if (event.key === "Tab") {
      event.preventDefault();
      startAlias(rows[selected]);
    } else if (event.altKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      void run(rows[Number(event.key) - 1]);
    }
  };

  const sectionAt = new Map(sections.map((s) => [s.at, s.label]));

  return (
    <div className={`${themeClass} h-screen w-screen`} style={{ padding: PAD }}>
      <div className="flex h-full flex-col overflow-hidden rounded-[20px] border border-line/80 bg-surface shadow-[0_18px_50px_-12px_rgba(4,30,66,0.38)]">
        {/* 搜索栏 */}
        <div className="flex shrink-0 items-center gap-3 px-4" style={{ height: SEARCH_H }}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {aliasTarget ? <AppIcon app={aliasTarget} size={26} /> : <PawPrint size={20} strokeWidth={2.2} />}
          </span>
          <input
            ref={inputRef}
            autoFocus
            value={aliasTarget ? aliasInput : query}
            onChange={(event) => {
              if (aliasTarget) setAliasInput(event.target.value);
              else {
                setQuery(event.target.value);
                setSelected(0);
                setNotice("");
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={
              aliasTarget
                ? `给「${aliasTarget.name}」设简称，多个用空格隔开，如 vx wc`
                : "打开软件：输入名字、拼音、首字母或简称"
            }
            className="chat-composer-input min-w-0 flex-1 border-0 bg-transparent text-[19px] font-medium text-fg outline-none placeholder:font-normal placeholder:text-fg-muted/80"
            spellCheck={false}
          />
          {loading ? (
            <RefreshCw size={16} className="shrink-0 animate-spin text-fg-muted" />
          ) : aliasTarget ? (
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-muted">
              <Kbd>Enter</Kbd> 保存
            </span>
          ) : query ? (
            <span className="shrink-0 text-[11px] text-fg-muted">
              <Kbd>Esc</Kbd> 清空
            </span>
          ) : null}
        </div>

        {/* 结果 */}
        {!aliasTarget && rows.length > 0 && (
          <div className="border-t border-line/70 px-2 py-1.5">
            {rows.map((row, index) => {
              const active = index === selected;
              const label = sectionAt.get(index);
              return (
                <Fragment key={row.kind === "app" ? `${row.app.id}|${row.app.name}` : row.kind}>
                  {label && (
                    <div className="flex items-end px-3 text-[11px] font-medium tracking-wide text-fg-muted" style={{ height: LABEL_H }}>
                      {label}
                    </div>
                  )}
                  <div
                    onMouseMove={() => setSelected(index)}
                    onClick={() => void run(row)}
                    className={`relative flex cursor-pointer items-center gap-3 rounded-xl px-3 transition-colors ${
                      active ? "bg-primary/[0.09]" : "hover:bg-surface-2"
                    }`}
                    style={{ height: ROW_H }}
                  >
                    {active && <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-primary" />}
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2">
                      {row.kind === "app" ? (
                        <AppIcon app={row.app} />
                      ) : row.kind === "url" ? (
                        <Globe size={18} className="text-fg-muted" />
                      ) : (
                        <MessageCircle size={18} className="text-primary" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      {row.kind === "app" ? (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[15px] text-fg">
                              <Highlighted text={row.app.name} marks={row.highlight} />
                            </span>
                            {row.app.aliases.slice(0, 3).map((alias) => (
                              <span key={alias} className="shrink-0 rounded-md bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary-ink">
                                {alias}
                              </span>
                            ))}
                          </div>
                          <div className="truncate text-[11px] text-fg-muted">{row.via || shortPath(row.app.path)}</div>
                        </>
                      ) : row.kind === "url" ? (
                        <>
                          <div className="truncate text-[15px] text-fg">打开网址</div>
                          <div className="truncate text-[11px] text-fg-muted">{row.url}</div>
                        </>
                      ) : (
                        <>
                          <div className="truncate text-[15px] text-fg">
                            问桌宠：<span className="text-fg-muted">{row.text}</span>
                          </div>
                          <div className="truncate text-[11px] text-fg-muted">交给桌宠处理，比如“帮我打开上周的周报”</div>
                        </>
                      )}
                    </div>
                    {active ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
                        {row.kind === "app" && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              startAlias(row);
                            }}
                            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-2 hover:text-fg"
                            title="给这个软件设简称（Tab）"
                          >
                            <Tag size={11} />
                            简称
                          </button>
                        )}
                        <Kbd>↵</Kbd>
                      </span>
                    ) : (
                      index < 9 && <span className="shrink-0 text-[11px] tabular-nums text-fg-muted/70">Alt {index + 1}</span>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}

        {showExamples && (
          <div className="flex items-center gap-2 border-t border-line/70 px-5" style={{ height: 64 }}>
            <span className="text-xs text-fg-muted">试试</span>
            {EXAMPLES.map(([q, label]) => (
              <button
                key={q}
                type="button"
                onClick={() => {
                  setQuery(q);
                  focusInput();
                }}
                className="rounded-lg border border-line px-2.5 py-1 text-xs text-fg hover:border-primary/60 hover:bg-primary/5"
              >
                <span className="font-semibold text-primary-ink">{q}</span>
                <span className="ml-1 text-fg-muted">{label}</span>
              </button>
            ))}
          </div>
        )}

        {/* 底栏 */}
        <div className="mt-auto flex shrink-0 items-center gap-3 border-t border-line/70 bg-surface-2/60 px-4 text-[11px] text-fg-muted" style={{ height: FOOTER_H }}>
          {notice ? (
            <span className="min-w-0 flex-1 truncate">{notice}</span>
          ) : aliasTarget ? (
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd>Enter</Kbd> 保存
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Esc</Kbd> 取消
              </span>
              <span>清空后保存 = 删除简称</span>
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> 选择
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> 打开
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Tab</Kbd> 设简称
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Esc</Kbd> 关闭
              </span>
            </span>
          )}
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface hover:text-fg"
            onClick={() => void load(true)}
            title="重新扫描本机软件（装了新软件后用）"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            刷新
          </button>
        </div>
      </div>
    </div>
  );
}
