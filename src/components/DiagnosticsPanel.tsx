import { useMemo, useState } from "react";
import { getSecurityLogs } from "../agent/kernel";
import { useThemeClass } from "../store/theme";

interface DiagnosticsPanelProps {
  onClose: () => void;
}

export function DiagnosticsPanel({ onClose }: DiagnosticsPanelProps) {
  const themeClass = useThemeClass();
  const [version, setVersion] = useState(0);
  const [levelFilter, setLevelFilter] = useState<"all" | "error" | "warn" | "info" | "debug">("all");
  const allLogs = useMemo(() => getSecurityLogs().slice(0, 120), [version]);
  const logs = useMemo(() => {
    if (levelFilter === "all") return allLogs.slice(0, 80);
    return allLogs.filter((log) => log.level === levelFilter).slice(0, 80);
  }, [allLogs, levelFilter]);
  const counts = useMemo(
    () => ({
      all: allLogs.length,
      error: allLogs.filter((log) => log.level === "error").length,
      warn: allLogs.filter((log) => log.level === "warn").length,
      info: allLogs.filter((log) => log.level === "info").length,
      debug: allLogs.filter((log) => log.level === "debug").length,
    }),
    [allLogs]
  );

  return (
    <div className={`chat-window ${themeClass} flex flex-col h-screen`}>
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800/80 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            ←
          </button>
          <span className="font-semibold text-white">运行日志</span>
        </div>
        <button className="text-xs text-yellow-400 hover:text-yellow-300" onClick={() => setVersion((value) => value + 1)}>
          刷新
        </button>
      </div>

      <div className="border-b border-gray-800 bg-gray-900/70 px-4 py-3">
        <div className="flex gap-1 overflow-x-auto rounded-lg border border-gray-700 bg-gray-800/70 p-0.5 text-xs">
          {[
            ["all", "全部"],
            ["error", "错误"],
            ["warn", "警告"],
            ["info", "信息"],
            ["debug", "调试"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setLevelFilter(value as typeof levelFilter)}
              className={`shrink-0 rounded-md px-2 py-1 transition-colors ${
                levelFilter === value ? "bg-yellow-500 text-gray-900" : "text-gray-400 hover:text-white"
              }`}
            >
              {label} {counts[value as keyof typeof counts]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-gray-500">暂无日志。</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="rounded-lg border border-gray-700 bg-gray-800/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`text-xs font-semibold ${
                    log.level === "error"
                      ? "text-red-300"
                      : log.level === "warn"
                        ? "text-yellow-300"
                        : log.level === "debug"
                          ? "text-blue-300"
                          : "text-green-300"
                  }`}
                >
                  {log.level.toUpperCase()} · {log.category}
                </span>
                <span className="text-xs text-gray-500">{new Date(log.timestamp).toLocaleString("zh-CN")}</span>
              </div>
              <div className="mt-2 text-sm text-gray-100 break-words">{log.message}</div>
              {log.details && (
                <pre className="mt-2 max-h-36 overflow-auto rounded bg-gray-950/80 p-2 text-xs text-gray-400">
                  {JSON.stringify(log.details, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
