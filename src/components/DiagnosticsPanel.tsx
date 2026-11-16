import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { Button, EmptyState, FilterChips, PageHeader, relativeTime } from "./ui";
import { getSecurityLogs } from "../agent/kernel";
import { useThemeClass } from "../store/theme";

interface DiagnosticsPanelProps {
  onClose: () => void;
}

type Level = "all" | "error" | "warn" | "info" | "debug";

const LEVEL_STYLE: Record<Exclude<Level, "all">, { dot: string; label: string }> = {
  error: { dot: "bg-danger", label: "错误" },
  warn: { dot: "bg-accent", label: "警告" },
  info: { dot: "bg-primary", label: "信息" },
  debug: { dot: "bg-[#8D99AE]", label: "调试" },
};

export function DiagnosticsPanel({ onClose }: DiagnosticsPanelProps) {
  const themeClass = useThemeClass();
  const [version, setVersion] = useState(0);
  const [levelFilter, setLevelFilter] = useState<Level>("all");
  const [open, setOpen] = useState<string | null>(null);
  const allLogs = useMemo(() => getSecurityLogs().slice(0, 200), [version]);
  const logs = useMemo(
    () => (levelFilter === "all" ? allLogs : allLogs.filter((log) => log.level === levelFilter)).slice(0, 120),
    [allLogs, levelFilter]
  );
  const count = (level: Exclude<Level, "all">) => allLogs.filter((log) => log.level === level).length;

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader
        title="运行日志"
        description="桌宠运行时记下的错误和提示，排查问题时看"
        onBack={onClose}
        actions={
          <Button size="sm" variant="secondary" onClick={() => setVersion((value) => value + 1)}>
            刷新
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="page-pad space-y-4 py-5">
          <FilterChips
            value={levelFilter}
            options={[
              { value: "all", label: "全部", count: allLogs.length },
              { value: "error", label: "错误", count: count("error") },
              { value: "warn", label: "警告", count: count("warn") },
              { value: "info", label: "信息", count: count("info") },
              { value: "debug", label: "调试", count: count("debug") },
            ]}
            onChange={setLevelFilter}
          />

          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {logs.length === 0 ? (
              <EmptyState
                icon={<ScrollText size={20} />}
                title={allLogs.length ? "这个级别下没有日志" : "暂无日志"}
                hint="出现报错时这里会有记录，遇到问题可以把它截图发给开发者。"
              />
            ) : (
              <ul className="divide-y divide-line">
                {logs.map((log) => {
                  const style = LEVEL_STYLE[log.level as Exclude<Level, "all">] || LEVEL_STYLE.info;
                  const expanded = open === log.id;
                  return (
                    <li key={log.id}>
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : log.id)}
                        disabled={!log.details}
                        className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition enabled:hover:bg-surface-2/60"
                      >
                        <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${style.dot}`} title={style.label} />
                        <div className="min-w-0 flex-1">
                          <div className="break-words text-sm text-fg">{log.message}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-muted">
                            <span>{style.label}</span>
                            <span className="rounded bg-surface-2 px-1.5 py-px">{log.category}</span>
                            <span>{relativeTime(log.timestamp)}</span>
                            {log.details && <span className="text-primary-ink">{expanded ? "收起详情" : "详情"}</span>}
                          </div>
                        </div>
                      </button>
                      {expanded && log.details && (
                        <pre className="mx-4 mb-3 ml-9 max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] text-fg-muted">
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
