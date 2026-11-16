import { Suspense, lazy, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { Button, EmptyState, PageHeader, StatTile, Switch } from "./ui";
import { useActivityStore } from "../store/activity";
import { useThemeClass } from "../store/theme";

const MarkdownContent = lazy(() => import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })));

interface ActivityPanelProps {
  onClose: () => void;
}

function formatDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/** 进程名去掉 .exe，看着更像软件名 */
function appName(processName?: string) {
  return (processName || "未知应用").replace(/\.exe$/i, "");
}

export function ActivityPanel({ onClose }: ActivityPanelProps) {
  const themeClass = useThemeClass();
  const enabled = useActivityStore((state) => state.enabled);
  const entries = useActivityStore((state) => state.entries);
  const current = useActivityStore((state) => state.current);
  const setEnabled = useActivityStore((state) => state.setEnabled);
  const getSummary = useActivityStore((state) => state.getSummary);
  const clear = useActivityStore((state) => state.clear);
  const [summary, setSummary] = useState(getSummary());
  const [showSummary, setShowSummary] = useState(false);

  const all = useMemo(() => (current ? [...entries, current] : entries), [current, entries]);

  const today = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const list = all.filter((entry) => new Date(entry.startedAt).getTime() >= start.getTime());
    const byApp = new Map<string, number>();
    let total = 0;
    for (const entry of list) {
      total += entry.durationMs;
      const name = appName(entry.processName);
      byApp.set(name, (byApp.get(name) || 0) + entry.durationMs);
    }
    const top = [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { list, total, top, switches: list.length };
  }, [all]);

  const timeline = useMemo(
    () => all.slice().sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()).slice(0, 80),
    [all]
  );

  const maxTop = today.top[0]?.[1] || 1;

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader
        title="电脑活动"
        description="只记前台窗口名称，不截图、不记按键、不上传；桌宠用它回答“我今天都干了什么”"
        onBack={onClose}
        actions={
          <>
            {enabled && all.length > 0 && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  if (confirm("确定清空本地活动记录吗？")) {
                    clear();
                    setSummary("活动记录已清空。");
                  }
                }}
              >
                <Trash2 size={14} />
                清空
              </Button>
            )}
            <Switch label="启用活动观察" checked={enabled} onChange={setEnabled} />
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="page-pad space-y-5 py-5">
          {!enabled ? (
            <div className="rounded-xl border border-line bg-surface">
              <EmptyState
                icon={<Activity size={20} />}
                title="活动观察没开"
                hint="打开后桌宠会记下你在用哪些软件、用了多久，可以帮你写日报、回答“我昨天下午在干嘛”。数据只存在本机。"
              />
              <div className="flex justify-center pb-8">
                <Button variant="primary" onClick={() => setEnabled(true)}>
                  开启活动观察
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatTile value={today.total ? formatDuration(today.total) : "—"} label="今天在电脑前" tone="primary" />
                <StatTile value={today.top[0]?.[0] || "—"} label="今天用得最多" />
                <StatTile value={today.switches} label="切换窗口次数" />
              </div>

              {today.top.length > 0 && (
                <section className="rounded-xl border border-line bg-surface p-4">
                  <h2 className="mb-3 text-sm font-semibold text-fg">今天的时间花在哪</h2>
                  <ul className="space-y-2.5">
                    {today.top.map(([name, ms]) => (
                      <li key={name} className="grid grid-cols-[120px_1fr_80px] items-center gap-3 text-sm">
                        <span className="truncate text-fg" title={name}>
                          {name}
                        </span>
                        <span className="h-2 overflow-hidden rounded-full bg-surface-2">
                          <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (ms / maxTop) * 100)}%` }} />
                        </span>
                        <span className="text-right text-xs tabular-nums text-fg-muted">{formatDuration(ms)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="overflow-hidden rounded-xl border border-line bg-surface">
                <button
                  type="button"
                  onClick={() => {
                    if (!showSummary) setSummary(getSummary());
                    setShowSummary((value) => !value);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-surface-2/60"
                >
                  {showSummary ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
                  <span className="font-medium text-fg">详细分析</span>
                  <span className="text-xs text-fg-muted">专注时长、软件排行、行为画像</span>
                </button>
                {showSummary && (
                  <div className="markdown-body border-t border-line px-5 py-4 text-sm">
                    <Suspense fallback={<pre className="whitespace-pre-wrap text-xs">{summary}</pre>}>
                      <MarkdownContent content={summary} />
                    </Suspense>
                  </div>
                )}
              </section>

              <section className="overflow-hidden rounded-xl border border-line bg-surface">
                <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-fg">最近的窗口</h2>
                {timeline.length === 0 ? (
                  <EmptyState title="还没有记录" hint="用一会儿电脑再回来看。" />
                ) : (
                  <ul className="divide-y divide-line">
                    {timeline.map((entry) => (
                      <li key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                        <span className="w-12 shrink-0 text-xs tabular-nums text-fg-muted">
                          {new Date(entry.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-fg">{appName(entry.processName)}</div>
                          <div className="truncate text-[11px] text-fg-muted">{entry.title || "无窗口标题"}</div>
                        </div>
                        <span className="shrink-0 text-xs tabular-nums text-fg-muted">{formatDuration(entry.durationMs)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
