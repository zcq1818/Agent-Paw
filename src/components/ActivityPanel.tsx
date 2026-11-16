import { useMemo, useState } from "react";
import { PageHeader, Switch } from "./ui";
import { useActivityStore } from "../store/activity";
import { useThemeClass } from "../store/theme";

interface ActivityPanelProps {
  onClose: () => void;
}

function formatMinutes(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `${minutes} 分钟`;
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

  const visibleEntries = useMemo(() => {
    return (current ? [...entries, current] : entries)
      .slice()
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 80);
  }, [current, entries]);

  const refreshSummary = () => setSummary(getSummary());

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader
        title="电脑活动"
        description="只记前台窗口名称，不截图、不记按键、不上传"
        onBack={onClose}
        actions={<Switch label="启用活动观察" checked={enabled} onChange={setEnabled} />}
      />

      <div className="page-pad space-y-3 py-4">
        <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-surface p-3 text-xs leading-relaxed text-fg">{summary}</pre>
        <div className="flex gap-2">
          <button onClick={refreshSummary} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg hover:brightness-110">
            重新分析
          </button>
          <button
            onClick={() => {
              if (confirm("确定清空本地活动记录吗？")) {
                clear();
                setSummary("活动记录已清空。");
              }
            }}
            className="rounded-lg bg-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-red-900/60"
          >
            清空记录
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto page-pad py-3">
        {visibleEntries.length === 0 && <div className="py-12 text-center text-sm text-gray-500">还没有活动记录。</div>}
        <div className="space-y-2">
          {visibleEntries.map((entry) => (
            <article key={entry.id} className="border border-gray-700 bg-gray-800/55 p-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                <span className="font-semibold text-white">{entry.processName || "未知应用"}</span>
                <span className="text-xs text-yellow-200">{formatMinutes(entry.durationMs)}</span>
              </div>
              <div className="line-clamp-2 text-xs text-gray-300">{entry.title || "无窗口标题"}</div>
              <div className="mt-2 text-xs text-gray-500">{new Date(entry.startedAt).toLocaleString()}</div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
