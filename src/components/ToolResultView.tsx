import { useMemo } from "react";
import { parseToolResult } from "../agent/toolResultView";

/** 按工具结果类型渲染：清单 / 来源链接 / 指标卡 / 纯文本。 */
export function ToolResultView({ name, result }: { name: string; result: string }) {
  const view = useMemo(() => parseToolResult(name, result), [name, result]);

  if (view.kind === "list") {
    return (
      <ul className="mt-2 space-y-1">
        {view.items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="ui-panel flex items-center gap-2 rounded-lg border px-2 py-1 text-[11px]">
            <span className={item.done ? "text-green-500" : "ui-muted"}>{item.done ? "✓" : "○"}</span>
            <span className={item.done ? "line-through opacity-60" : ""}>{item.label}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (view.kind === "links") {
    return (
      <ul className="mt-2 space-y-1">
        {view.items.map((item, index) => (
          <li key={`${item.href}-${index}`} className="ui-panel truncate rounded-lg border px-2 py-1 text-[11px]">
            <a href={item.href} target="_blank" rel="noreferrer" className="text-blue-500 underline-offset-2 hover:underline">
              {index + 1}. {item.label}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  if (view.kind === "metrics") {
    return (
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {view.items.map((item, index) => (
          <div key={`${item.label}-${index}`} className="ui-panel rounded-lg border px-2 py-1.5 text-[11px]">
            <div className="ui-muted truncate">{item.label}</div>
            <div className="mt-0.5 truncate font-semibold">{item.value}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/15 p-2 text-[11px] leading-relaxed">
      {view.text}
    </pre>
  );
}
