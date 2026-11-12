import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { useAgentStore } from "../store/agent";
import { useChatStore } from "../store/chat";
import { usePetStore } from "../store/pet";
import { useThemeClass } from "../store/theme";
import { ActivityPanel } from "./ActivityPanel";
import { ChatMessage } from "./ChatMessage";
import { CustomSkillsSettings } from "./CustomSkillsSettings";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { MemoryPanel } from "./MemoryPanel";
import { ProductivityPanel } from "./ProductivityPanel";
import { BotRoster } from "./BotRoster";
import { RoomPanel } from "./RoomPanel";
import { ChiefPanel } from "./ChiefPanel";
import { useBotStore } from "../store/bots";

interface ChatPanelProps {
  onOpenSettings: () => void;
  onBack: () => void;
}

type PanelView = "chat" | "team" | "rooms" | "chief" | "memory" | "skills" | "tasks" | "activity" | "logs";

const QUICK_PROMPTS = [
  "你能做什么？",
  "查看我的任务",
  "打开记事本",
  "总结今天的电脑活动",
  "帮我写个脚本",
];

const WORKBENCH_TABS: Array<{ view: PanelView | "settings"; label: string }> = [
  { view: "chat", label: "聊天" },
  { view: "team", label: "团队" },
  { view: "rooms", label: "房间" },
  { view: "chief", label: "总管" },
  { view: "memory", label: "记忆" },
  { view: "skills", label: "Skills" },
  { view: "tasks", label: "任务" },
  { view: "activity", label: "活动" },
  { view: "logs", label: "日志" },
  { view: "settings", label: "设置" },
];

export function ChatPanel({ onOpenSettings, onBack }: ChatPanelProps) {
  const themeClass = useThemeClass();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [panelView, setPanelView] = useState<PanelView>("chat");
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const conversations = useChatStore((state) => state.conversations);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const messages = useChatStore((state) => state.messages);
  const addMessage = useChatStore((state) => state.addMessage);
  const clearMessages = useChatStore((state) => state.clear);
  const createConversation = useChatStore((state) => state.createConversation);
  const switchConversation = useChatStore((state) => state.switchConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const isStreaming = useAgentStore((state) => state.isStreaming);
  const streamText = useAgentStore((state) => state.streamText);
  const currentToolRuns = useAgentStore((state) => state.currentToolRuns);
  const runningToolName = [...currentToolRuns].reverse().find((run) => run.status === "running")?.name;
  const sendMessage = useAgentStore((state) => state.sendMessage);
  const stopGeneration = useAgentStore((state) => state.stopGeneration);
  const retryLast = useAgentStore((state) => state.retryLast);
  const continueLast = useAgentStore((state) => state.continueLast);
  const setEmotion = usePetStore((state) => state.setEmotion);
  const activeBotName = useBotStore(
    (state) => state.bots.find((bot) => bot.id === state.activeBotId)?.name || "皮卡丘"
  );

  const setChatActive = useCallback(async (active: boolean) => {
    try {
      await emit("chat-activity", { active });
    } catch {
      // Browser dev fallback.
    }
  }, []);

  useEffect(() => {
    if (panelView !== "chat") setChatActive(false);
  }, [panelView, setChatActive]);

  useEffect(() => {
    const onWindowBlur = () => setChatActive(false);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      setChatActive(false);
    };
  }, [setChatActive]);

  const visibleMessages = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return messages;
    return messages.filter((message) => message.content.toLowerCase().includes(keyword));
  }, [messages, search]);

  useEffect(() => {
    if (panelView !== "chat" || search) return;
    const container = messagesContainerRef.current;
    if (!container) return;

    const behavior = isStreaming || streamText ? "auto" : "smooth";
    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior });
    });
  }, [panelView, search, messages.length, streamText, isStreaming]);

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
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const exportMessages = () => {
    const blob = new Blob([JSON.stringify(messages, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `paw-chat-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (panelView === "team") return <BotRoster onClose={() => setPanelView("chat")} />;
  if (panelView === "rooms") return <RoomPanel onClose={() => setPanelView("chat")} />;
  if (panelView === "chief") return <ChiefPanel onClose={() => setPanelView("chat")} />;
  if (panelView === "memory") return <MemoryPanel onClose={() => setPanelView("chat")} />;
  if (panelView === "skills") return <CustomSkillsSettings onClose={() => setPanelView("chat")} />;
  if (panelView === "tasks") return <ProductivityPanel onClose={() => setPanelView("chat")} />;
  if (panelView === "activity") return <ActivityPanel onClose={() => setPanelView("chat")} />;
  if (panelView === "logs") return <DiagnosticsPanel onClose={() => setPanelView("chat")} />;

  return (
    <div
      className={`chat-window ${themeClass} flex h-screen flex-col`}
      onMouseEnter={() => setChatActive(true)}
      onMouseLeave={() => setChatActive(false)}
      onFocusCapture={() => setChatActive(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(nextTarget)) setChatActive(false);
      }}
    >
      <div className="space-y-3 border-b border-gray-700 bg-gray-800/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="text-gray-400 transition-colors hover:text-white" aria-label="隐藏窗口">
              ←
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl">⚡</span>
                <span className="font-semibold text-white">Paw 工作台</span>
                <span className="bg-yellow-500/15 px-2 py-0.5 text-xs text-yellow-300">{activeBotName}</span>
                <span className="bg-green-400/10 px-2 py-0.5 text-xs text-green-400">在线</span>
              </div>
              <div className="text-xs text-gray-400">聊天、记忆、技能和系统动作分开管理。</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-xs sm:grid-cols-10">
          {WORKBENCH_TABS.map((tab) => (
            <button
              key={tab.view}
              onClick={() => (tab.view === "settings" ? onOpenSettings() : setPanelView(tab.view))}
              className={`px-2 py-1.5 transition-colors ${
                panelView === tab.view ? "bg-yellow-500 font-bold text-gray-900" : "bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <select className="input" value={activeConversationId} onChange={(event) => switchConversation(event.target.value)} title="选择对话">
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => createConversation()} className="rounded-lg bg-gray-700 px-3 text-xs text-gray-100 hover:bg-gray-600">
            新建
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("确定删除当前对话吗？")) deleteConversation(activeConversationId);
            }}
            className="rounded-lg bg-gray-700 px-3 text-xs text-gray-100 hover:bg-red-900/60"
          >
            删除
          </button>
        </div>

        <div className="grid grid-cols-[1fr_auto_auto] gap-2">
          <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前对话" />
          <button onClick={exportMessages} className="rounded-lg bg-gray-700 px-3 text-xs text-gray-100 hover:bg-gray-600">
            导出
          </button>
          <button
            onClick={() => {
              if (confirm("确定清空当前对话吗？")) clearMessages();
            }}
            className="rounded-lg bg-gray-700 px-3 text-xs text-gray-100 hover:bg-red-900/60"
          >
            清空
          </button>
        </div>
      </div>

      <div ref={messagesContainerRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-gray-500">
            <span className="text-5xl">⚡</span>
            <p className="text-lg">Paw 在这里。想让我做点什么？</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => setInput(prompt)}
                  className="rounded-full bg-gray-800 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.length > 0 && visibleMessages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">没有匹配的聊天记录。</div>
        )}

        {visibleMessages.map((message) => (
          <ChatMessage key={message.id} message={message} onSurfaceAction={setInput} />
        ))}

        {isStreaming && !search && (
          <ChatMessage
            message={{
              id: "streaming",
              role: "assistant",
              content: streamText || "Paw 正在思考...",
              createdAt: new Date().toISOString(),
              toolRuns: currentToolRuns,
            }}
            isStreaming
          />
        )}
      </div>

      <div className="border-t border-gray-700 bg-gray-800/50 px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={retryLast}
              disabled={isStreaming || messages.length === 0}
              className="rounded-lg bg-gray-800 px-2.5 py-1 text-gray-300 transition-colors hover:bg-gray-700 disabled:opacity-40"
            >
              重新生成
            </button>
            <button
              type="button"
              onClick={continueLast}
              disabled={isStreaming || messages.length === 0}
              className="rounded-lg bg-gray-800 px-2.5 py-1 text-gray-300 transition-colors hover:bg-gray-700 disabled:opacity-40"
            >
              继续回答
            </button>
          </div>
          {isStreaming && (
            <span className="text-xs text-yellow-300">
              {runningToolName ? `正在调用 ${runningToolName}...` : "正在生成..."}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-600 bg-gray-800 px-4 py-2.5 text-white placeholder:text-gray-500 transition-colors focus:border-yellow-500 focus:outline-none"
            style={{ maxHeight: 120 }}
          />
          <button
            onClick={isStreaming ? stopGeneration : handleSend}
            disabled={!isStreaming && !input.trim()}
            className={`rounded-xl px-4 font-bold transition-colors ${
              isStreaming
                ? "bg-red-500 text-white hover:bg-red-400"
                : "bg-yellow-500 text-gray-900 hover:bg-yellow-400 disabled:bg-gray-700 disabled:text-gray-500"
            }`}
          >
            {isStreaming ? "停止" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
