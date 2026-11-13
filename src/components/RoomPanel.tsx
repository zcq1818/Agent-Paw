import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { askBot, isRoomSkip, resolveTargets, type RoomHistoryItem } from "../agent/rooms";
import { useBotStore } from "../store/bots";
import { useRoomStore } from "../store/rooms";
import { BotAvatar } from "./BotAvatar";
import { useThemeClass } from "../store/theme";

const MarkdownContent = lazy(() => import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })));

interface RoomPanelProps {
  onClose: () => void;
}

/** Rooms 工作台：多个 Bot 在同一话题下协作，支持 @ 指派与按 Bot 换脑。 */
export function RoomPanel({ onClose }: RoomPanelProps) {
  const themeClass = useThemeClass();
  const bots = useBotStore((state) => state.bots);
  const rooms = useRoomStore((state) => state.rooms);
  const allMessages = useRoomStore((state) => state.messages);
  const activeRoomId = useRoomStore((state) => state.activeRoomId);
  const createRoom = useRoomStore((state) => state.createRoom);
  const updateRoom = useRoomStore((state) => state.updateRoom);
  const deleteRoom = useRoomStore((state) => state.deleteRoom);
  const setActiveRoom = useRoomStore((state) => state.setActiveRoom);
  const appendMessage = useRoomStore((state) => state.appendMessage);
  const clearMessages = useRoomStore((state) => state.clearMessages);

  const [input, setInput] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [pendingBot, setPendingBot] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const availableBots = useMemo(() => bots.filter((bot) => !bot.archived), [bots]);
  const room = rooms.find((item) => item.id === activeRoomId);
  const memberBots = useMemo(
    () => (room ? availableBots.filter((bot) => room.memberBotIds.includes(bot.id)) : []),
    [room, availableBots]
  );
  const roomMessages = useMemo(
    () => (room ? allMessages.filter((message) => message.roomId === room.id) : []),
    [room, allMessages]
  );

  // 新消息、正在思考的成员变化时滚到底
  useEffect(() => {
    const list = listRef.current;
    if (list) requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }));
  }, [roomMessages.length, pendingBot, room?.id]);

  const handleCreateRoom = () => {
    createRoom(newRoomName || `房间 ${rooms.length + 1}`, "", availableBots.map((bot) => bot.id));
    setNewRoomName("");
    setError("");
  };

  const toggleMember = (botId: string) => {
    if (!room) return;
    const next = room.memberBotIds.includes(botId)
      ? room.memberBotIds.filter((id) => id !== botId)
      : [...room.memberBotIds, botId];
    updateRoom(room.id, { memberBotIds: next });
  };

  const insertMention = (name: string) => {
    setInput((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${name} `);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !room || pendingBot) return;

    const targets = resolveTargets(text, memberBots);
    if (targets.length === 0) {
      setError("房间没有成员，或 @ 的名字对不上。先在「房间设置」里添加成员。");
      return;
    }

    setInput("");
    setError("");
    appendMessage({
      roomId: room.id,
      role: "user",
      content: text,
      mentions: targets.map((bot) => bot.id),
    });

    const history: RoomHistoryItem[] = roomMessages
      .filter((message) => message.role !== "system")
      .slice(-8)
      .map((message) => ({
        role: message.role === "user" ? "user" : "assistant",
        content: message.content,
        botName: message.botId ? bots.find((bot) => bot.id === message.botId)?.name : undefined,
      }));

    const controller = new AbortController();
    abortRef.current = controller;
    const skipped: string[] = [];
    setProgress({ done: 0, total: targets.length });
    for (const [index, bot] of targets.entries()) {
      if (controller.signal.aborted) break;
      setPendingBot(bot.name);
      setProgress({ done: index, total: targets.length });
      try {
        const reply = await askBot(bot, text, history, room.name, controller.signal, room.topic);
        // 和自己职责无关的成员回 [跳过]，不刷屏；只问了一个人时照样显示
        if (isRoomSkip(reply) && targets.length > 1) {
          skipped.push(bot.name);
        } else {
          appendMessage({ roomId: room.id, role: "assistant", botId: bot.id, content: reply });
          history.push({ role: "assistant", content: reply, botName: bot.name });
        }
      } catch (cause) {
        if (controller.signal.aborted) break;
        appendMessage({
          roomId: room.id,
          role: "assistant",
          botId: bot.id,
          content: `调用失败：${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    const notes: string[] = [];
    if (skipped.length) notes.push(`${skipped.join("、")} 觉得这个问题不归自己管，没有发言`);
    if (controller.signal.aborted) notes.push("已停止，后面的成员没有发言");
    if (notes.length) appendMessage({ roomId: room.id, role: "system", content: `${notes.join("；")}。` });
    abortRef.current = null;
    setPendingBot("");
    setProgress(null);
  };

  const pendingProfile = memberBots.find((bot) => bot.name === pendingBot);

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col`}>
      <div className="flex items-center gap-3 border-b border-gray-700 ui-panel px-4 py-3">
        <button onClick={onClose} className="text-gray-400 transition-colors hover:text-white" aria-label="返回聊天">
          ←
        </button>
        <div>
          <div className="font-semibold">团队房间</div>
          <div className="text-xs ui-muted">多个成员在同一话题下协作，用 @ 指派</div>
        </div>
        <span className="ml-auto text-xs ui-muted">{rooms.length} 个房间</span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-gray-700 p-3">
          <div className="mb-3 space-y-2 rounded-xl border border-gray-700 ui-panel p-2">
            <input
              className="input"
              value={newRoomName}
              onChange={(event) => setNewRoomName(event.target.value)}
              placeholder="新房间名"
            />
            <button
              type="button"
              onClick={handleCreateRoom}
              className="w-full rounded-lg bg-yellow-500 px-3 py-1.5 text-sm font-bold text-gray-900 hover:bg-yellow-400"
            >
              新建房间
            </button>
          </div>
          <div className="space-y-1">
            {rooms.length === 0 && <div className="px-2 text-xs ui-muted">还没有房间。</div>}
            {rooms.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveRoom(item.id)}
                className={`flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left transition-colors ${
                  item.id === activeRoomId ? "bg-yellow-500/15 ring-1 ring-yellow-500/50" : "hover:bg-gray-800"
                }`}
              >
                <span className="truncate text-sm">{item.name}</span>
                <span className="truncate text-xs ui-muted">{item.memberBotIds.length} 位成员</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          {!room ? (
            <div className="flex flex-1 items-center justify-center text-sm ui-muted">从左侧新建或选择一个房间。</div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-fg">{room.name}</div>
                  <div className="truncate text-xs text-fg-muted" title={memberBots.map((bot) => bot.name).join("、")}>
                    {memberBots.length} 位成员：{memberBots.map((bot) => bot.name).join("、") || "无"}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowSettings(!showSettings)}
                    className="whitespace-nowrap rounded-lg border border-line px-2.5 py-1 text-xs text-fg hover:bg-surface-2"
                  >
                    房间设置
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm("确定清空这个房间的消息吗？")) clearMessages(room.id);
                    }}
                    className="whitespace-nowrap rounded-lg border border-line px-2.5 py-1 text-xs text-fg hover:bg-surface-2"
                  >
                    清空消息
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`确定删除房间「${room.name}」吗？`)) deleteRoom(room.id);
                    }}
                    className="whitespace-nowrap rounded-lg px-2.5 py-1 text-xs text-danger hover:bg-danger/10"
                  >
                    删除
                  </button>
                </div>
              </div>

              {showSettings && (
                <div className="space-y-3 border-b border-line bg-surface px-4 py-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs text-fg-muted">
                      房间名
                      <input
                        className="input mt-1"
                        value={room.name}
                        onChange={(event) => updateRoom(room.id, { name: event.target.value })}
                      />
                    </label>
                    <label className="block text-xs text-fg-muted">
                      话题 / 共同指令
                      <input
                        className="input mt-1"
                        value={room.topic}
                        onChange={(event) => updateRoom(room.id, { topic: event.target.value })}
                        placeholder="例如：本周版本复盘"
                      />
                    </label>
                  </div>
                  <div className="text-xs text-fg-muted">成员（勾选的成员才会在这个房间发言）</div>
                  <div className="flex flex-wrap gap-2">
                    {availableBots.map((bot) => (
                      <label
                        key={bot.id}
                        className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-fg"
                      >
                        <input
                          type="checkbox"
                          checked={room.memberBotIds.includes(bot.id)}
                          onChange={() => toggleMember(bot.id)}
                        />
                        {bot.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div ref={listRef} className="flex-1 overflow-y-auto bg-app px-4 py-4">
                {roomMessages.length === 0 && !pendingBot && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-fg-muted">
                    <span className="text-3xl">💬</span>
                    <span>发条消息让房间里的成员开始协作</span>
                    <span className="text-xs">不带 @ 时全体成员依次作答（和自己无关的会跳过）；@名字 只问指定成员</span>
                  </div>
                )}
                <div className="mx-auto max-w-3xl space-y-5">
                  {roomMessages.map((message) => {
                    if (message.role === "system") {
                      return (
                        <div key={message.id} className="text-center text-xs text-fg-muted">
                          {message.content}
                        </div>
                      );
                    }
                    if (message.role === "user") {
                      return (
                        <div key={message.id} className="flex justify-end">
                          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-fg">
                            {message.content}
                          </div>
                        </div>
                      );
                    }
                    const bot = message.botId ? bots.find((item) => item.id === message.botId) : undefined;
                    const failed = message.content.startsWith("调用失败：");
                    return (
                      <div key={message.id} className="flex gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-line">
                          {bot ? <BotAvatar bot={bot} size={26} /> : <span>🤖</span>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex items-center gap-2 text-xs">
                            <span className="font-medium text-fg">{bot?.name || "成员"}</span>
                            {bot?.tagline && <span className="truncate text-fg-muted">{bot.tagline}</span>}
                          </div>
                          <div
                            className={`rounded-2xl rounded-tl-md border px-4 py-3 text-sm ${
                              failed ? "border-danger/30 bg-danger/5 text-danger" : "border-line bg-surface text-fg"
                            }`}
                          >
                            <div className="markdown-body max-w-none">
                              <Suspense fallback={<div className="whitespace-pre-wrap">{message.content}</div>}>
                                <MarkdownContent content={message.content} />
                              </Suspense>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {pendingBot && (
                    <div className="flex items-center gap-3 text-sm text-fg-muted">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-line">
                        {pendingProfile ? <BotAvatar bot={pendingProfile} size={26} /> : null}
                      </div>
                      <span className="typing-dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span>
                        {pendingBot} 正在想
                        {progress && progress.total > 1 ? `（第 ${progress.done + 1} / ${progress.total} 位）` : ""}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-line bg-surface px-4 py-3">
                <div className="mx-auto max-w-3xl">
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-fg-muted">@</span>
                    {[{ id: "all", name: "全体" }, ...memberBots].map((bot) => (
                      <button
                        key={bot.id}
                        type="button"
                        onClick={() => insertMention(bot.name)}
                        className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted hover:border-primary hover:text-fg"
                      >
                        {bot.name}
                      </button>
                    ))}
                  </div>
                  {error && <div className="mb-2 text-xs text-danger">{error}</div>}
                  <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface py-1.5 pl-4 pr-1.5 transition focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/10">
                    <textarea
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          handleSend();
                        }
                      }}
                      rows={1}
                      placeholder={pendingBot ? `${pendingBot} 正在想…` : "发消息，Enter 发送；@名字 只问指定成员"}
                      className="chat-composer-input block max-h-[120px] min-w-0 flex-1 resize-none border-0 bg-transparent py-1.5 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-muted"
                    />
                    {pendingBot ? (
                      <button
                        type="button"
                        onClick={() => abortRef.current?.abort()}
                        title="停止，后面的成员不再发言"
                        aria-label="停止"
                        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg text-surface hover:opacity-85"
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleSend}
                        disabled={!input.trim()}
                        title="发送（Enter）"
                        aria-label="发送"
                        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg hover:brightness-110 disabled:bg-surface-2 disabled:text-fg-muted"
                      >
                        <ArrowUp size={17} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
