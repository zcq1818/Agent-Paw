import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Cpu,
  Download,
  Eraser,
  ListTodo,
  Menu,
  MoreHorizontal,
  Search,
  Settings2,
  Square,
  Terminal,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import { useAgentStore } from "../store/agent";
import { useChatStore } from "../store/chat";
import { usePetStore } from "../store/pet";
import { getActiveBot, useBotStore } from "../store/bots";
import { ensureModelProfiles } from "../agent/kernel";
import { setActiveModelProfile, useModelProfileStore } from "../agent/modelProfiles";
import { ChatMessage } from "./ChatMessage";
import { BotAvatar } from "./BotAvatar";
import { IconButton, MenuItem, Popover } from "./ui";

const SUGGESTIONS = [
  { icon: <Zap size={16} />, title: "你能做什么？", detail: "看看我会哪些本事", prompt: "你能做什么？" },
  { icon: <ListTodo size={16} />, title: "查看我的任务", detail: "待办和日程一览", prompt: "查看我的任务" },
  { icon: <Terminal size={16} />, title: "打开记事本", detail: "帮你启动常用应用", prompt: "打开记事本" },
  { icon: <Wand2 size={16} />, title: "帮我写个脚本", detail: "比如批量重命名文件", prompt: "帮我写一个批量重命名文件的 Python 脚本" },
];

interface ChatViewProps {
  /** 窄窗口下打开侧边栏抽屉；宽窗口时为 undefined（侧边栏常驻）。 */
  onOpenSidebar?: () => void;
  onOpenSettings: () => void;
}

export function ChatView({ onOpenSidebar, onOpenSettings }: ChatViewProps) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const conversations = useChatStore((state) => state.conversations);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const messages = useChatStore((state) => state.messages);
  const addMessage = useChatStore((state) => state.addMessage);
  const clearMessages = useChatStore((state) => state.clear);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const isStreaming = useAgentStore((state) => state.isStreaming);
  const streamText = useAgentStore((state) => state.streamText);
  const currentToolRuns = useAgentStore((state) => state.currentToolRuns);
  const sendMessage = useAgentStore((state) => state.sendMessage);
  const stopGeneration = useAgentStore((state) => state.stopGeneration);
  const retryLast = useAgentStore((state) => state.retryLast);
  const continueLast = useAgentStore((state) => state.continueLast);
  const setEmotion = usePetStore((state) => state.setEmotion);
  const activeBot = useBotStore((state) => getActiveBot(state));

  const runningToolName = [...currentToolRuns].reverse().find((run) => run.status === "running")?.name;
  const conversationTitle = conversations.find((item) => item.id === activeConversationId)?.title || "新对话";

  // 告诉桌宠“用户正在聊天”，聊天时宠物不乱跑。
  const setChatActive = useCallback(async (active: boolean) => {
    try {
      await emit("chat-activity", { active });
    } catch {
      // Browser dev fallback.
    }
  }, []);

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

  const lastAssistantId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.id,
    [messages]
  );

  useEffect(() => {
    if (search) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    const behavior = isStreaming || streamText ? "auto" : "smooth";
    requestAnimationFrame(() => container.scrollTo({ top: container.scrollHeight, behavior }));
  }, [search, messages.length, streamText, isStreaming, activeConversationId]);

  // 输入框随内容自动长高（最多约 8 行）。
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [input]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (isStreaming) {
      // 运行中插话：不打断当前任务，模型下一步就能看到
      useAgentStore.getState().interject(text);
      return;
    }
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
      // 输入法组字时按 Enter 是确认候选词，不能发送。
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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

  const applySuggestion = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onMouseEnter={() => setChatActive(true)}
      onMouseLeave={() => setChatActive(false)}
      onFocusCapture={() => setChatActive(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(nextTarget)) setChatActive(false);
      }}
    >
      {/* 顶栏 */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
        {onOpenSidebar && (
          <IconButton label="打开侧边栏" onClick={onOpenSidebar}>
            <Menu size={18} />
          </IconButton>
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={conversationTitle}>
          {conversationTitle}
        </h1>
        <ModelPicker onManage={onOpenSettings} />
        <IconButton
          label="搜索对话"
          active={searchOpen}
          onClick={() => {
            setSearchOpen((open) => !open);
            if (searchOpen) setSearch("");
          }}
        >
          <Search size={17} />
        </IconButton>
        <Popover
          trigger={({ toggle }) => (
            <IconButton label="更多操作" onClick={toggle}>
              <MoreHorizontal size={18} />
            </IconButton>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Download size={15} />}
                onClick={() => {
                  close();
                  exportMessages();
                }}
              >
                导出对话
              </MenuItem>
              <MenuItem
                icon={<Eraser size={15} />}
                onClick={() => {
                  close();
                  if (confirm("确定清空当前对话的消息吗？")) clearMessages();
                }}
              >
                清空消息
              </MenuItem>
              <div className="my-1 h-px bg-line" />
              <MenuItem
                danger
                icon={<Trash2 size={15} />}
                onClick={() => {
                  close();
                  if (confirm("确定删除当前对话吗？")) deleteConversation(activeConversationId);
                }}
              >
                删除对话
              </MenuItem>
            </>
          )}
        </Popover>
      </header>

      {searchOpen && (
        <div className="fade-in flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2">
          <Search size={15} className="text-fg-muted" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearch("");
                setSearchOpen(false);
              }
            }}
            placeholder="搜索当前对话"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
          />
          {search && <span className="text-xs text-fg-muted">{visibleMessages.length} 条结果</span>}
          <IconButton
            label="关闭搜索"
            onClick={() => {
              setSearch("");
              setSearchOpen(false);
            }}
          >
            <X size={15} />
          </IconButton>
        </div>
      )}

      {/* 消息区 */}
      <div ref={messagesContainerRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 py-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
              {activeBot ? <BotAvatar bot={activeBot} size={48} /> : <Zap size={28} className="text-primary" />}
            </div>
            <h2 className="mt-4 text-xl font-semibold text-fg">你好，我是{activeBot?.name || "皮卡丘"}</h2>
            <p className="mt-1.5 text-sm text-fg-muted">可以聊天、查资料、管理待办，或者帮你打开电脑上的应用。</p>
            <div className="mt-7 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
              {SUGGESTIONS.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => applySuggestion(item.prompt)}
                  className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition hover:border-primary/60 hover:shadow-card"
                >
                  <span className="mt-0.5 text-primary-ink">{item.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{item.title}</span>
                    <span className="block text-xs text-fg-muted">{item.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
            {visibleMessages.length === 0 && (
              <div className="py-16 text-center text-sm text-fg-muted">没有匹配的聊天记录。</div>
            )}
            {visibleMessages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                onSurfaceAction={setInput}
                isLast={!isStreaming && !search && message.id === lastAssistantId}
                onRetry={retryLast}
                onContinue={continueLast}
              />
            ))}
            {isStreaming && !search && (
              <ChatMessage
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamText,
                  createdAt: new Date().toISOString(),
                  toolRuns: currentToolRuns,
                }}
                isStreaming
              />
            )}
          </div>
        )}
      </div>

      {/* 输入框 */}
      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-6 sm:pb-5">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-2xl border border-line bg-surface shadow-card transition focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/10">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`给${activeBot?.name || "皮卡丘"}发消息`}
              rows={1}
              className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-muted"
            />
            <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
              <span className="min-w-0 flex-1 truncate pl-1 text-xs text-fg-muted">
                {isStreaming
                  ? `${runningToolName ? `正在调用 ${runningToolName}…` : "正在生成…"} 可以继续输入补充，Enter 发送`
                  : "Enter 发送 · Shift + Enter 换行"}
              </span>
              {isStreaming && (
                <button
                  type="button"
                  onClick={stopGeneration}
                  aria-label="停止生成"
                  title="停止生成"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-fg text-surface transition hover:opacity-85"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
              {(!isStreaming || input.trim()) && (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  aria-label={isStreaming ? "补充给正在进行的任务" : "发送"}
                  title={isStreaming ? "补充给正在进行的任务" : "发送"}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-fg transition hover:brightness-110 disabled:bg-surface-2 disabled:text-fg-muted"
                >
                  <ArrowUp size={17} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 顶栏里的模型切换。 */
function ModelPicker({ onManage }: { onManage: () => void }) {
  useState(() => ensureModelProfiles());
  const profiles = useModelProfileStore((state) => state.profiles);
  const activeId = useModelProfileStore((state) => state.activeId);
  const override = useBotStore((state) => getActiveBot(state)?.modelOverride);
  const botOverrides = Boolean(override && (override.model || override.baseUrl || override.apiKey || override.provider));
  const active = profiles.find((profile) => profile.id === activeId);

  return (
    <Popover
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          title="切换模型"
          className={`flex h-8 max-w-[45vw] items-center gap-1.5 rounded-lg border px-2.5 text-xs transition sm:max-w-[220px] ${
            open ? "border-primary/60 bg-surface-2" : "border-line hover:bg-surface-2"
          }`}
        >
          <Cpu size={14} className="shrink-0 text-primary-ink" />
          <span className="truncate font-medium text-fg">{botOverrides ? "Bot 专属模型" : active?.name || "选择模型"}</span>
          <ChevronDown size={14} className="shrink-0 text-fg-muted" />
        </button>
      )}
      className="w-[280px]"
    >
      {(close) => (
        <>
          {botOverrides && (
            <div className="mx-1 mb-1 rounded-lg bg-accent/10 px-2.5 py-2 text-xs leading-relaxed text-fg">
              当前 Bot 在“团队”里设置了专属模型，聊天会优先使用它。
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                onClick={() => {
                  setActiveModelProfile(profile.id);
                  close();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{profile.name}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {(profile.providerLabel || profile.provider) + " · " + profile.model}
                    {profile.apiKey ? "" : " · 未填 Key"}
                  </span>
                </span>
                {profile.id === activeId && <Check size={16} className="shrink-0 text-primary-ink" />}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-line" />
          <MenuItem
            icon={<Settings2 size={15} />}
            onClick={() => {
              close();
              onManage();
            }}
          >
            管理模型…
          </MenuItem>
        </>
      )}
    </Popover>
  );
}
