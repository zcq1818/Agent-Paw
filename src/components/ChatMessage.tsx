import { useMemo, useState } from "react";
import { ArrowRight, Check, Copy, RotateCcw } from "lucide-react";
import type { SurfaceSpec } from "../agent/surfaces";
import type { ToolRun } from "../agent/toolEvents";
import { useBotStore } from "../store/bots";
import { MarkdownContent } from "./MarkdownContent";
import { SurfaceRenderer } from "./SurfaceRenderer";
import { BotAvatar } from "./BotAvatar";
import { ToolRunList } from "./ToolRunList";

/** 流式期间也按 Markdown 实时排版（以前显示原始符号，结束才排版），末尾带闪烁光标。 */
function StreamingText({ text }: { text: string }) {
  return (
    <div className="markdown-body streaming-markdown max-w-none">
      <MarkdownContent content={text} />
      <span className="stream-caret" aria-hidden="true" />
    </div>
  );
}

interface ChatMessageProps {
  message: {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
    surface?: SurfaceSpec;
    toolRuns?: ToolRun[];
  };
  isStreaming?: boolean;
  /** 最后一条助手回复：常驻显示“重新生成 / 继续”。 */
  isLast?: boolean;
  onRetry?: () => void;
  onContinue?: () => void;
  onSurfaceAction?: (prompt: string) => void;
}

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </button>
  );
}

export function ChatMessage({ message, isStreaming, isLast, onRetry, onContinue, onSurfaceAction }: ChatMessageProps) {
  const isUser = message.role === "user";
  const activeBot = useBotStore((state) => state.bots.find((bot) => bot.id === state.activeBotId));
  const [copied, setCopied] = useState(false);
  const timeLabel = useMemo(() => {
    const date = new Date(message.createdAt);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }, [message.createdAt]);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] select-text whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary/15 px-4 py-2.5 text-[0.92rem] leading-relaxed text-fg">
          {message.content}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-fg-muted opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          {timeLabel && <span className="px-1">{timeLabel}</span>}
          <ActionButton label={copied ? "已复制" : "复制"} onClick={copyMessage}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </ActionButton>
        </div>
      </div>
    );
  }

  const waiting = isStreaming && !message.content;

  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
        {activeBot ? <BotAvatar bot={activeBot} size={24} /> : <span className="text-xs font-bold text-primary-ink">P</span>}
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs">
          <span className="font-medium text-fg">{activeBot?.name || "皮卡丘"}</span>
          {timeLabel && !isStreaming && <span className="text-fg-muted">{timeLabel}</span>}
        </div>

        <div className="text-fg">
          {waiting ? (
            <div className="flex h-7 items-center">
              <span className="typing-dots" aria-label="正在思考">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : isStreaming ? (
            <StreamingText text={message.content} />
          ) : (
            <div className="markdown-body max-w-none">
              <MarkdownContent content={message.content} />
            </div>
          )}
          {message.surface && <SurfaceRenderer surface={message.surface} onAction={onSurfaceAction} />}
          <ToolRunList runs={message.toolRuns} />
        </div>

        {message.content && !isStreaming && (
          <div
            className={`mt-1 flex items-center gap-0.5 transition ${
              isLast ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
            }`}
          >
            <ActionButton label={copied ? "已复制" : "复制"} onClick={copyMessage}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </ActionButton>
            {isLast && onRetry && (
              <ActionButton label="重新生成" onClick={onRetry}>
                <RotateCcw size={13} />
                <span>重新生成</span>
              </ActionButton>
            )}
            {isLast && onContinue && (
              <ActionButton label="继续回答" onClick={onContinue}>
                <ArrowRight size={13} />
                <span>继续</span>
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
