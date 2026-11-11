import { useState } from "react";
import { summarizeArgs, type ToolRun, type ToolRunStatus } from "../agent/toolEvents";
import { ToolResultView } from "./ToolResultView";

const STATUS_STYLE: Record<ToolRunStatus, { dot: string; label: string }> = {
  pending: { dot: "bg-sky-400 animate-pulse", label: "等待确认" },
  running: { dot: "bg-yellow-400 animate-pulse", label: "执行中" },
  done: { dot: "bg-green-400", label: "完成" },
  error: { dot: "bg-red-400", label: "失败" },
};

/** 把一次回复里的工具调用 / 审批渲染成可折叠卡片，不再混进正文文本。 */
export function ToolRunList({ runs }: { runs?: ToolRun[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!runs || runs.length === 0) return null;

  const done = runs.filter((run) => run.status === "done").length;
  const failed = runs.filter((run) => run.status === "error").length;
  const pending = runs.filter((run) => run.status === "pending").length;
  const running = runs.length - done - failed - pending;

  return (
    <div className="ui-panel mt-2.5 rounded-xl border p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2 ui-muted">
        <span className="font-semibold">工具调用 {runs.length}</span>
        {pending > 0 && <span className="text-sky-500">等待确认 {pending}</span>}
        {running > 0 && <span className="text-yellow-500">执行中 {running}</span>}
        {done > 0 && <span className="text-green-500">完成 {done}</span>}
        {failed > 0 && <span className="text-red-500">失败 {failed}</span>}
      </div>

      <div className="mt-2 space-y-1.5">
        {runs.map((run) => {
          const style = STATUS_STYLE[run.status];
          const isOpen = Boolean(expanded[run.id]);
          const args = summarizeArgs(run.args);
          const detail = run.result || run.detail;
          return (
            <div key={run.id} className="ui-panel-strong rounded-lg border px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
                <span className="font-mono font-semibold">{run.name}</span>
                <span className="ui-muted">{style.label}</span>
                {run.durationMs !== undefined && <span className="ui-muted">{run.durationMs}ms</span>}
                {detail && (
                  <button
                    type="button"
                    onClick={() => setExpanded((state) => ({ ...state, [run.id]: !state[run.id] }))}
                    className="ui-muted ml-auto shrink-0 underline-offset-2 hover:underline"
                  >
                    {isOpen ? "收起" : "详情"}
                  </button>
                )}
              </div>
              {args && <div className="ui-muted mt-1 truncate font-mono text-[11px]">{args}</div>}
              {run.status === "pending" && run.detail && (
                <div className="ui-muted mt-1 truncate text-[11px]">{run.detail}</div>
              )}
              {isOpen && run.result && <ToolResultView name={run.name} result={run.result} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
