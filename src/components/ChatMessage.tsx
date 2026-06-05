import ReactMarkdown from "react-markdown";

interface ChatMessageProps {
  message: {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
    surface?: unknown;
  };
  isStreaming?: boolean;
}

export function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* 头像 */}
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-yellow-500 text-gray-900"
        }`}
      >
        {isUser ? "👤" : "⚡"}
      </div>

      {/* 消息气泡 */}
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? "bg-blue-600 text-white rounded-tr-md"
            : "bg-gray-800 text-gray-100 rounded-tl-md"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
        {isStreaming && (
          <span className="inline-block w-2 h-4 bg-yellow-400 ml-1 animate-pulse" />
        )}
      </div>
    </div>
  );
}
