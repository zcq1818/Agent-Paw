import { useMemo, useState } from "react";
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
    <div className={`chat-window ${themeClass} flex h-screen flex-col`}>
      <div className="border-b border-gray-700 bg-gray-800/80 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="text-gray-400 transition-colors hover:text-white" aria-label="返回工作台">
              ←
            </button>
            <div>
              <div className="font-semibold text-white">活动观察</div>
              <div className="text-xs text-gray-400">本地记录前台窗口名称，不截图、不读键盘、不上传。</div>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            启用
          </label>
        </div>
      </div>

      <div className="space-y-3 border-b border-gray-800 px-4 py-3">
        <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap bg-gray-900/70 p-3 text-xs leading-relaxed text-gray-200">{summary}</pre>
        <div className="flex gap-2">
          <button onClick={refreshSummary} className="rounded-lg bg-yellow-500 px-3 py-1.5 text-sm font-bold text-gray-900 hover:bg-yellow-400">
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

      <div className="flex-1 overflow-y-auto px-4 py-3">
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
