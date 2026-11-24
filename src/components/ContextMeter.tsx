import { useState } from "react";
import { Layers, Loader2 } from "lucide-react";
import { Popover, Switch } from "./ui";
import { useAgentStore } from "../store/agent";
import { useChatStore } from "../store/chat";
import { getActiveBotId } from "../agent/scope";
import { loadConfig } from "../agent/kernel";
import {
  PART_LABELS,
  contextWindowFor,
  formatTokens,
  guessContextWindow,
  loadWindowOverrides,
  setWindowOverride,
  usageKey,
  useContextUsageStore,
  useContextUsageSync,
  type UsagePartKey,
} from "../agent/contextUsage";
import { deferToolsEnabled, setDeferToolsEnabled } from "../agent/toolLoading";

const PART_COLORS: Record<UsagePartKey, string> = {
  messages: "bg-primary",
  summary: "bg-primary/45",
  toolResults: "bg-primary/70",
  builtinTools: "bg-fg/70",
  mcpTools: "bg-accent",
  toolIndex: "bg-fg-muted/40",
  system: "bg-fg-muted/80",
  memory: "bg-fg-muted/65",
  skills: "bg-fg-muted/50",
  deferredBuiltin: "bg-line",
  deferredMcp: "bg-line",
};

const WINDOW_OPTIONS = [8_000, 32_000, 64_000, 128_000, 200_000, 400_000, 1_000_000];

function percent(value: number, total: number) {
  if (!total) return "0%";
  const ratio = (value / total) * 100;
  return ratio > 0 && ratio < 0.1 ? "<0.1%" : `${ratio.toFixed(1)}%`;
}

/** 聊天顶栏的“上下文”：上一次发送时各部分占了多少，可以手动压缩、改窗口大小、开关工具按需加载 */
export function ContextMeter() {
  useContextUsageSync();
  const conversationId = useChatStore((state) => state.activeConversationId);
  const conversation = useChatStore((state) => state.conversations.find((item) => item.id === state.activeConversationId));
  const key = usageKey(getActiveBotId(), conversationId);
  const usage = useContextUsageStore((state) => state.byKey[key]);
  const compacting = useAgentStore((state) => state.compacting);
  const isStreaming = useAgentStore((state) => state.isStreaming);
  const [note, setNote] = useState("");
  const [defer, setDefer] = useState(() => deferToolsEnabled());
  const [, force] = useState(0);

  const model = usage?.model || loadConfig().model || "";
  const windowSize = contextWindowFor(model);
  const used = usage ? Math.max(usage.total, usage.actual || 0) : 0;
  const ratio = windowSize ? Math.min(1, used / windowSize) : 0;
  const level = ratio >= 0.8 ? "text-danger" : ratio >= 0.6 ? "text-accent" : "text-fg-muted";
  const shown = usage?.parts.filter((part) => !part.deferred) || [];
  const deferred = usage?.parts.filter((part) => part.deferred && (part.count || part.tokens)) || [];
  const free = Math.max(0, windowSize - used - (usage?.reserve || 0));
  const override = loadWindowOverrides()[model];

  const circumference = 2 * Math.PI * 7;

  return (
    <Popover
      className="w-[340px]"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          title="上下文用量"
          className={`flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs transition ${open ? "border-primary/60 bg-surface-2" : "border-line hover:bg-surface-2"}`}
        >
          {compacting ? (
            <Loader2 size={14} className="animate-spin text-primary" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="7" fill="none" strokeWidth="2" className="stroke-line" />
              <circle
                cx="8"
                cy="8"
                r="7"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                transform="rotate(-90 8 8)"
                strokeDasharray={`${circumference * ratio} ${circumference}`}
                className={ratio >= 0.8 ? "stroke-danger" : ratio >= 0.6 ? "stroke-accent" : "stroke-primary"}
              />
            </svg>
          )}
          <span className={`tabular-nums ${level}`}>{usage ? `${Math.round(ratio * 100)}%` : "上下文"}</span>
        </button>
      )}
    >
      {() => (
        <div className="space-y-3 p-2.5 text-xs">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold text-fg">上下文</span>
            <span className="truncate pl-2 text-[11px] text-fg-muted">{model || "未选模型"}</span>
          </div>

          {!usage ? (
            <p className="leading-relaxed text-fg-muted">发一条消息后，这里会显示这次对话发给模型的内容各占了多少。</p>
          ) : (
            <>
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] text-fg">
                    已使用 <span className={`font-semibold ${level === "text-fg-muted" ? "text-fg" : level}`}>{Math.round(ratio * 100)}%</span>
                  </span>
                  <span className="tabular-nums text-fg-muted">
                    {formatTokens(used)} / {formatTokens(windowSize)}
                  </span>
                </div>
                <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-surface-2">
                  {shown.map((part) => (
                    <span key={part.key} className={PART_COLORS[part.key]} style={{ width: `${(part.tokens / windowSize) * 100}%` }} />
                  ))}
                  <span className="bg-fg-muted/20" style={{ width: `${(usage.reserve / windowSize) * 100}%` }} />
                </div>
              </div>

              <table className="w-full">
                <tbody>
                  {shown.map((part) => (
                    <tr key={part.key}>
                      <td className="py-0.5 pr-2">
                        <span className="flex items-center gap-2 text-fg">
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${PART_COLORS[part.key]}`} />
                          {PART_LABELS[part.key]}
                          {part.count !== undefined && part.key !== "toolResults" && <span className="text-fg-muted">· {part.count}</span>}
                        </span>
                      </td>
                      <td className="py-0.5 text-right tabular-nums text-fg-muted">{formatTokens(part.tokens)}</td>
                      <td className="w-14 py-0.5 text-right tabular-nums text-fg-muted">{percent(part.tokens, windowSize)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-0.5 pr-2">
                      <span className="flex items-center gap-2 text-fg">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-fg-muted/20" />
                        预留给回复
                      </span>
                    </td>
                    <td className="py-0.5 text-right tabular-nums text-fg-muted">{formatTokens(usage.reserve)}</td>
                    <td className="py-0.5 text-right tabular-nums text-fg-muted">{percent(usage.reserve, windowSize)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-2">
                      <span className="flex items-center gap-2 text-fg">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-line bg-surface" />
                        可用空间
                      </span>
                    </td>
                    <td className="py-0.5 text-right tabular-nums text-fg-muted">{formatTokens(free)}</td>
                    <td className="py-0.5 text-right tabular-nums text-fg-muted">{percent(free, windowSize)}</td>
                  </tr>
                  {deferred.map((part) => (
                    <tr key={part.key}>
                      <td className="py-0.5 pr-2 pt-1.5 text-fg-muted">
                        {PART_LABELS[part.key]}
                        {part.count ? ` · ${part.count} 个` : ""}
                      </td>
                      <td className="py-0.5 pt-1.5 text-right tabular-nums text-fg-muted">{formatTokens(part.tokens)}</td>
                      <td className="py-0.5 pt-1.5 text-right text-fg-muted">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {usage.actual ? (
                <p className="text-[11px] text-fg-muted">模型实际计数：输入 {formatTokens(usage.actual)} tokens（上一轮）</p>
              ) : null}
            </>
          )}

          {conversation?.summary && (
            <details className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2">
              <summary className="cursor-pointer text-fg">前面 {conversation.summarizedCount || 0} 条消息已整理成摘要</summary>
              <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed text-fg-muted">{conversation.summary}</p>
            </details>
          )}

          <div className="space-y-2 border-t border-line pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-fg">
                压缩对话
                <span className="block text-[11px] text-fg-muted">快装不下时会自动压缩；也可以现在手动压缩</span>
              </span>
              <button
                type="button"
                disabled={compacting || isStreaming}
                onClick={async () => {
                  setNote("");
                  setNote(await useAgentStore.getState().compactNow());
                }}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 text-xs text-fg transition hover:bg-surface-2 disabled:opacity-50"
              >
                {compacting ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
                立即压缩
              </button>
            </div>
            {note && <p className="rounded-md bg-primary/10 px-2 py-1.5 text-[11px] text-fg">{note}</p>}

            <div className="flex items-center justify-between gap-2">
              <span className="text-fg">
                工具按需加载
                <span className="block text-[11px] text-fg-muted">不常用的工具和 MCP 工具只列名字，用到再加载</span>
              </span>
              <Switch
                label="工具按需加载"
                checked={defer}
                onChange={(value) => {
                  setDeferToolsEnabled(value);
                  setDefer(value);
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-fg">
                上下文窗口
                <span className="block text-[11px] text-fg-muted">按模型名猜的，不准可以改</span>
              </span>
              <select
                className="input h-7 w-[150px] shrink-0 py-0 text-xs"
                value={override || 0}
                disabled={!model}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setWindowOverride(model, value || null);
                  force((n) => n + 1);
                }}
              >
                <option value={0}>自动（{formatTokens(guessContextWindow(model))}）</option>
                {WINDOW_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {formatTokens(value)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-fg-muted">按字数估算，和模型的实际计数会有出入；显示的是这个对话上一次发送时的情况。</p>
        </div>
      )}
    </Popover>
  );
}
