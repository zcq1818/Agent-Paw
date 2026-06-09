import type { SurfaceSpec } from "../agent/surfaces";

interface SurfaceRendererProps {
  surface: SurfaceSpec;
  onAction?: (prompt: string) => void;
}

const toneClass: Record<string, string> = {
  default: "border-gray-700 bg-gray-800/80 text-gray-200",
  good: "border-green-500/30 bg-green-500/10 text-green-300",
  warn: "border-yellow-500/30 bg-yellow-500/10 text-yellow-300",
  danger: "border-red-500/30 bg-red-500/10 text-red-300",
};

export function SurfaceRenderer({ surface, onAction }: SurfaceRendererProps) {
  return (
    <article className="mt-3 overflow-hidden rounded-xl border-2 border-gray-700 bg-gray-900/80 shadow-lg">
      <header className="flex items-start justify-between gap-3 border-b border-gray-800 px-3 py-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-yellow-300">{surface.intent}</div>
          <h3 className="text-sm font-semibold text-white">{surface.title}</h3>
        </div>
        <span className="text-[11px] text-gray-500">
          {new Date(surface.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </header>

      <div className="space-y-3 px-3 py-3">
        {surface.summary && <p className="text-sm leading-relaxed text-gray-300">{surface.summary}</p>}

        {surface.metrics?.length ? (
          <div className="grid grid-cols-3 gap-2">
            {surface.metrics.map((metric) => (
              <div key={metric.label} className={`rounded-lg border-2 p-2 ${toneClass[metric.tone || "default"]}`}>
                <div className="text-base font-semibold leading-none">{metric.value}</div>
                <div className="mt-1 text-[11px] opacity-80">{metric.label}</div>
              </div>
            ))}
          </div>
        ) : null}

        {surface.items?.length ? (
          <div className="space-y-1.5">
            {surface.items.map((item) => (
              <div key={item.id} className={`rounded-lg border-2 px-2.5 py-2 ${toneClass[item.tone || "default"]}`}>
                <div className={`text-sm ${item.done ? "line-through opacity-70" : ""}`}>{item.title}</div>
                {item.meta && <div className="mt-0.5 text-[11px] opacity-75">{item.meta}</div>}
              </div>
            ))}
          </div>
        ) : null}

        {surface.actions?.length ? (
          <div className="flex flex-wrap gap-2">
            {surface.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => onAction?.(action.prompt)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  action.style === "primary"
                    ? "bg-yellow-500 text-gray-900 hover:bg-yellow-400"
                    : action.style === "danger"
                      ? "bg-red-500 text-white hover:bg-red-400"
                      : "bg-gray-800 text-gray-200 hover:bg-gray-700"
                }`}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
