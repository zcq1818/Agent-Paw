import { useMemo, useState } from "react";
import type { SurfaceSpec } from "../agent/surfaces";
import type { ToolRun } from "../agent/toolEvents";
import { useBotStore } from "../store/bots";
import { MarkdownContent } from "./MarkdownContent";
import { SurfaceRenderer } from "./SurfaceRenderer";
import { BotAvatar } from "./BotAvatar";
import { ToolRunList } from "./ToolRunList";

/** 流式期间用纯文本逐字淡入；结束后切回完整 Markdown 渲染。 */
function StreamingText({ text }: { text: string }) {
  const tailLength = Math.min(10, text.length);
  const head = text.slice(0, text.length - tailLength);
  const tail = Array.from(text.slice(text.length - tailLength));
  return (
    <div className="streaming-text whitespace-pre-wrap">
      {head}
      <span key={text.length} className="stream-tail">
        {tail.map((character, index) => (
          <span key={index} style={{ animationDelay: `${index * 26}ms` }}>
            {character === "\n" ? <br /> : character}
          </span>
        ))}
      </span>
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
  onSurfaceAction?: (prompt: string) => void;
}

export function ChatMessage({ message, isStreaming, onSurfaceAction }: ChatMessageProps) {
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

  const botSurfaceStyle = {
    background: "var(--ui-surface)",
    borderColor: "var(--ui-border)",
    color: "var(--ui-text)",
  };

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-yellow-200 text-sm shadow-lg ${
          isUser ? "bg-blue-600 text-white" : ""
        }`}
        style={isUser ? undefined : { background: "var(--ui-surface-strong)", color: "var(--ui-text)" }}
        aria-label={isUser ? "用户" : activeBot?.name || "桌宠"}
      >
        {isUser ? "你" : activeBot ? <BotAvatar bot={activeBot} size={26} /> : "P"}
      </div>

      <div className={`group flex max-w-[80%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl border-2 px-4 py-2.5 shadow-lg ${
            isUser ? "rounded-tr-md border-blue-200 bg-blue-600 text-white" : "rounded-tl-md"
          }`}
          style={isUser ? undefined : botSurfaceStyle}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
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
        <div className={`flex items-center gap-2 px-1 text-[11px] ui-muted ${isUser ? "flex-row-reverse" : ""}`}>
          {!isUser && activeBot && <span>{activeBot.name}</span>}
          {timeLabel && <span>{timeLabel}</span>}
          {message.content && !isStreaming && (
            <button
              type="button"
              onClick={copyMessage}
              className="opacity-0 transition-opacity hover:underline group-hover:opacity-100 focus:opacity-100"
            >
              {copied ? "已复制" : "复制"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
