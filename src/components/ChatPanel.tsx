import { useState, useRef, useEffect, useCallback } from "react";
import { useChatStore } from "../store/chat";
import { useAgentStore } from "../store/agent";
import { usePetStore } from "../store/pet";
import { ChatMessage } from "./ChatMessage";

interface ChatPanelProps {
  onOpenSettings: () => void;
  onBack: () => void;
}

export function ChatPanel({ onOpenSettings, onBack }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messages = useChatStore((s) => s.messages);
  const addMessage = useChatStore((s) => s.addMessage);
  const isStreaming = useAgentStore((s) => s.isStreaming);
  const streamText = useAgentStore((s) => s.streamText);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const setEmotion = usePetStore((s) => s.setEmotion);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    addMessage({ role: "user", content: text });
    setEmotion("thinking");

    try {
      await sendMessage(text);
      setEmotion("excited");
      setTimeout(() => setEmotion("idle"), 2000);
    } catch {
      setEmotion("idle");
    }
  }, [input, isStreaming, addMessage, sendMessage, setEmotion]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="chat-window flex flex-col h-screen bg-gradient-to-b from-gray-900 to-gray-950">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800/80 backdrop-blur border-b border-gray-700">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-gray-400 hover:text-white transition-colors"
          >
            ←
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <span className="font-semibold text-white">皮卡丘</span>
            <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">
              在线
            </span>
          </div>
        </div>
        <button
          onClick={onOpenSettings}
          className="text-gray-400 hover:text-white transition-colors"
        >
          ⚙️
        </button>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-3">
            <span className="text-5xl">⚡</span>
            <p className="text-lg">皮卡~！有什么可以帮你的？</p>
            <div className="flex flex-wrap gap-2 mt-4 justify-center">
              {["今天天气怎么样", "帮我写个脚本", "提醒我开会", "讲个笑话"].map(
                (s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setInput(s);
                    }}
                    className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-full text-sm text-gray-300 transition-colors"
                  >
                    {s}
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}

        {/* 流式输出预览 */}
        {isStreaming && streamText && (
          <ChatMessage
            message={{
              id: "streaming",
              role: "assistant",
              content: streamText,
              createdAt: new Date().toISOString(),
            }}
            isStreaming
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <div className="px-4 py-3 bg-gray-800/50 border-t border-gray-700">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="皮卡~ 说点什么..."
            rows={1}
            className="flex-1 bg-gray-800 text-white rounded-xl px-4 py-2.5 resize-none border border-gray-600 focus:border-yellow-500 focus:outline-none transition-colors placeholder:text-gray-500"
            style={{ maxHeight: 120 }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="px-4 bg-yellow-500 hover:bg-yellow-400 disabled:bg-gray-700 disabled:text-gray-500 text-gray-900 font-bold rounded-xl transition-colors"
          >
            {isStreaming ? "⏳" : "⚡"}
          </button>
        </div>
      </div>
    </div>
  );
}
