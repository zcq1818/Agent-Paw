import { useMemo, useState } from "react";
import type { SurfaceSpec } from "../agent/surfaces";
import { MarkdownContent } from "./MarkdownContent";
import { SurfaceRenderer } from "./SurfaceRenderer";

interface ChatMessageProps {
  message: {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
    surface?: SurfaceSpec;
  };
  isStreaming?: boolean;
  onSurfaceAction?: (prompt: string) => void;
}

export function ChatMessage({ message, isStreaming, onSurfaceAction }: ChatMessageProps) {
  const isUser = message.role === "user";
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

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-8 h-8 rounded-full border-2 border-yellow-200 shadow-lg flex items-center justify-center flex-shrink-0 text-sm ${
          isUser ? "bg-blue-600 text-white" : "bg-yellow-500 text-gray-900"
        }`}
        aria-label={isUser ? "用户" : "皮卡丘"}
      >
        {isUser ? "你" : "P"}
      </div>

      <div className={`group flex max-w-[80%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl border-2 px-4 py-2.5 shadow-lg ${
            isUser
              ? "border-blue-200 bg-blue-600 text-white rounded-tr-md"
              : "border-yellow-200 bg-gray-800 text-gray-100 rounded-tl-md"
          }`}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="markdown-body max-w-none">
              <MarkdownContent content={message.content} />
            </div>
          )}
          {isStreaming && (
            <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-yellow-400 align-middle" />
          )}
          {message.surface && <SurfaceRenderer surface={message.surface} onAction={onSurfaceAction} />}
        </div>
        <div className={`flex items-center gap-2 px-1 text-[11px] text-gray-500 ${isUser ? "flex-row-reverse" : ""}`}>
          {timeLabel && <span>{timeLabel}</span>}
          {message.content && !isStreaming && (
            <button
              type="button"
              onClick={copyMessage}
              className="opacity-0 transition-opacity hover:text-gray-300 group-hover:opacity-100 focus:opacity-100"
            >
              {copied ? "已复制" : "复制"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
