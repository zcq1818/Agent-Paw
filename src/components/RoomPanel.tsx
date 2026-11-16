import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Eraser, MessagesSquare, MonitorUp, Plus, Settings2, Square, Trash2 } from "lucide-react";
import { EmptyState, IconButton, PageHeader, relativeTime } from "./ui";
import { askBot, isRoomSkip, resolveTargets, type RoomHistoryItem } from "../agent/rooms";
import { useBotStore, type BotProfile } from "../store/bots";
import { useRoomStore } from "../store/rooms";
import { BotAvatar } from "./BotAvatar";
import { useThemeClass } from "../store/theme";
import { emitSquad, setSquadInRooms, squadInRooms } from "./Squad";

const MarkdownContent = lazy(() => import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })));

interface RoomPanelProps {
  onClose: () => void;
}

/** 几个成员头像叠在一起。 */
function AvatarStack({ bots, size = 22, max = 4 }: { bots: BotProfile[]; size?: number; max?: number }) {
  const shown = bots.slice(0, max);
  const rest = bots.length - shown.length;
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((bot, index) => (
        <span
          key={bot.id}
          className="flex items-center justify-center overflow-hidden rounded-full bg-surface-2 ring-2 ring-surface"
          style={{ width: size, height: size, marginLeft: index ? -size * 0.3 : 0 }}
          title={bot.name}
        >
          <BotAvatar bot={bot} size={size - 2} />
        </span>
      ))}
      {rest > 0 && (
        <span
          className="flex items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-fg-muted ring-2 ring-surface"
          style={{ width: size, height: size, marginLeft: -size * 0.3 }}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

/** 房间：多个团队成员在同一话题下协作，支持 @ 指定谁回答。 */
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
  const [creating, setCreating] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [pendingBot, setPendingBot] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [squadOn, setSquadOn] = useState(squadInRooms);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  // 每个房间最后一条消息，用在左侧列表的预览
  const lastMessageByRoom = useMemo(() => {
    const map = new Map<string, (typeof allMessages)[number]>();
    for (const message of allMessages) {
      if (message.role === "system") continue;
      const prev = map.get(message.roomId);
      if (!prev || prev.createdAt <= message.createdAt) map.set(message.roomId, message);
    }
    return map;
  }, [allMessages]);

  // 新消息、正在思考的成员变化时滚到底
  useEffect(() => {
    const list = listRef.current;
    if (list) requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }));
  }, [roomMessages.length, pendingBot, room?.id]);

  const handleCreateRoom = () => {
    createRoom(newRoomName.trim() || `房间 ${rooms.length + 1}`, "", availableBots.map((bot) => bot.id));
    setNewRoomName("");
    setCreating(false);
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
    inputRef.current?.focus();
  };

  const fillInput = (text: string) => {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !room || pendingBot) return;

    const targets = resolveTargets(text, memberBots);
    if (targets.length === 0) {
      setError("房间没有成员，或 @ 的名字对不上。点右上角的设置添加成员。");
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
    emitSquad({
      type: "start",
      roomName: room.name,
      memberIds: memberBots.map((bot) => bot.id),
      mentionIds: /@/.test(text) ? targets.map((bot) => bot.id) : [],
    });
    setProgress({ done: 0, total: targets.length });
    for (const [index, bot] of targets.entries()) {
      if (controller.signal.aborted) break;
      setPendingBot(bot.name);
      setProgress({ done: index, total: targets.length });
      emitSquad({ type: "speaking", botId: bot.id });
      try {
        const reply = await askBot(bot, text, history, room.name, controller.signal, room.topic);
        // 和自己职责无关的成员回 [跳过]，不刷屏；只问了一个人时照样显示
        if (isRoomSkip(reply) && targets.length > 1) {
          skipped.push(bot.name);
          emitSquad({ type: "skip", botId: bot.id });
        } else {
          emitSquad({ type: "said", botId: bot.id, text: reply });
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
    emitSquad({ type: "end" });
    abortRef.current = null;
    setPendingBot("");
    setProgress(null);
  };

  const pendingProfile = memberBots.find((bot) => bot.name === pendingBot);

  const examples = useMemo(() => {
    const list = ["大家各自从自己的角度说说：", "帮我把这件事拆成几步，各自认领："];
    if (memberBots.length >= 2) list.unshift(`@${memberBots[0].name} @${memberBots[1].name} 你们俩讨论一下：`);
    return list;
  }, [memberBots]);

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader title="房间" description="几个团队成员一起讨论同一件事，用 @ 指定谁来回答" onBack={onClose} />

      <div className="flex min-h-0 flex-1">
        {/* 左：房间列表 */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <span className="text-xs font-medium text-fg-muted">我的房间 · {rooms.length}</span>
            <IconButton label="新建房间" onClick={() => setCreating(true)}>
              <Plus size={16} />
            </IconButton>
          </div>

          {creating && (
            <div className="px-3 pb-2">
              <input
                autoFocus
                className="input h-9 w-full text-sm"
                value={newRoomName}
                onChange={(event) => setNewRoomName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) handleCreateRoom();
                  if (event.key === "Escape") {
                    setCreating(false);
                    setNewRoomName("");
                  }
                }}
                onBlur={() => {
                  if (!newRoomName.trim()) setCreating(false);
                }}
                placeholder="房间名，回车创建"
              />
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {rooms.length === 0 && !creating && (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mx-1 mt-1 flex w-[calc(100%-0.5rem)] items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-3 text-xs text-fg-muted hover:border-primary/60 hover:text-primary-ink"
              >
                <Plus size={14} />
                建第一个房间
              </button>
            )}
            {rooms.map((item) => {
              const members = availableBots.filter((bot) => item.memberBotIds.includes(bot.id));
              const last = lastMessageByRoom.get(item.id);
              const lastBot = last?.botId ? bots.find((bot) => bot.id === last.botId) : undefined;
              const active = item.id === activeRoomId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveRoom(item.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active ? "bg-primary/10" : "hover:bg-surface-2"
                  }`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary-ink">
                    <MessagesSquare size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm ${active ? "font-semibold text-fg" : "text-fg"}`}>{item.name}</span>
                      <span className="shrink-0 text-[11px] text-fg-muted">{relativeTime(last?.createdAt || item.updatedAt)}</span>
                    </span>
                    <span className="block truncate text-xs text-fg-muted">
                      {last
                        ? `${last.role === "user" ? "我" : lastBot?.name || "成员"}：${last.content.replace(/\s+/g, " ")}`
                        : `${members.length} 位成员，还没说话`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* 右：房间对话 */}
        <main className="flex min-w-0 flex-1 flex-col">
          {!room ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={<MessagesSquare size={20} />}
                title={rooms.length ? "选一个房间开始" : "还没有房间"}
                hint="房间里可以同时问好几位团队成员，比如让产品经理、测试员和代码员一起看一个需求。点左上角的 + 建一个。"
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-line bg-surface px-5 py-2.5">
                <AvatarStack bots={memberBots} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-fg">{room.name}</div>
                  <div className="truncate text-xs text-fg-muted" title={memberBots.map((bot) => bot.name).join("、")}>
                    {memberBots.length} 位成员{room.topic ? ` · 话题：${room.topic}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton
                    label={squadOn ? "讨论时成员会出现在桌面上（点击关闭）" : "讨论时让成员出现在桌面上"}
                    active={squadOn}
                    className={squadOn ? "!text-primary-ink" : ""}
                    onClick={() => {
                      setSquadInRooms(!squadOn);
                      setSquadOn(!squadOn);
                    }}
                  >
                    <MonitorUp size={16} />
                  </IconButton>
                  <IconButton label="房间设置（名字、话题、成员）" active={showSettings} onClick={() => setShowSettings(!showSettings)}>
                    <Settings2 size={16} />
                  </IconButton>
                  <IconButton
                    label="清空消息"
                    disabled={roomMessages.length === 0}
                    onClick={() => {
                      if (confirm("确定清空这个房间的消息吗？")) clearMessages(room.id);
                    }}
                  >
                    <Eraser size={16} />
                  </IconButton>
                  <IconButton
                    label="删除房间"
                    className="hover:!text-danger"
                    onClick={() => {
                      if (confirm(`确定删除房间「${room.name}」吗？消息也会一起删掉。`)) deleteRoom(room.id);
                    }}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </div>

              {showSettings && (
                <div className="space-y-4 border-b border-line bg-surface px-5 py-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-medium text-fg">
                      房间名
                      <input
                        className="input mt-1.5 w-full"
                        value={room.name}
                        onChange={(event) => updateRoom(room.id, { name: event.target.value })}
                      />
                    </label>
                    <label className="block text-xs font-medium text-fg">
                      话题 / 共同指令
                      <input
                        className="input mt-1.5 w-full"
                        value={room.topic}
                        onChange={(event) => updateRoom(room.id, { topic: event.target.value })}
                        placeholder="例如：本周版本复盘，每人不超过 5 句话"
                      />
                    </label>
                  </div>
                  <div>
                    <div className="mb-2 flex items-center gap-3 text-xs">
                      <span className="font-medium text-fg">成员</span>
                      <span className="text-fg-muted">点一下加入或移出，只有在房间里的成员才会发言</span>
                      <span className="ml-auto flex gap-3">
                        <button
                          type="button"
                          className="text-primary-ink hover:underline"
                          onClick={() => updateRoom(room.id, { memberBotIds: availableBots.map((bot) => bot.id) })}
                        >
                          全选
                        </button>
                        <button type="button" className="text-fg-muted hover:text-fg" onClick={() => updateRoom(room.id, { memberBotIds: [] })}>
                          清空
                        </button>
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {availableBots.map((bot) => {
                        const inRoom = room.memberBotIds.includes(bot.id);
                        return (
                          <button
                            key={bot.id}
                            type="button"
                            onClick={() => toggleMember(bot.id)}
                            aria-pressed={inRoom}
                            className={`flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition ${
                              inRoom ? "border-primary/50 bg-primary/10 text-fg" : "border-line text-fg-muted opacity-70 hover:opacity-100"
                            }`}
                          >
                            <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-surface-2">
                              <BotAvatar bot={bot} size={22} />
                            </span>
                            {bot.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                {roomMessages.length === 0 && !pendingBot ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <AvatarStack bots={memberBots} size={40} max={6} />
                    <div className="text-sm font-medium text-fg">
                      {memberBots.length ? `和 ${memberBots.length} 位成员一起讨论` : "房间里还没有成员"}
                    </div>
                    <div className="max-w-md text-xs leading-relaxed text-fg-muted">
                      {memberBots.length
                        ? "不带 @ 时大家依次发言，和自己无关的会跳过；@名字 只问指定的人。"
                        : "点右上角的设置，把团队成员拉进来。"}
                    </div>
                    {memberBots.length > 0 && (
                      <div className="mt-1 flex max-w-lg flex-wrap justify-center gap-2">
                        {examples.map((text) => (
                          <button
                            key={text}
                            type="button"
                            onClick={() => fillInput(text)}
                            className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-fg-muted transition hover:border-primary/50 hover:text-fg"
                          >
                            {text}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mx-auto max-w-3xl space-y-5">
                    {roomMessages.map((message) => {
                      if (message.role === "system") {
                        return (
                          <div key={message.id} className="flex justify-center">
                            <span className="rounded-full bg-surface-2 px-3 py-1 text-[11px] text-fg-muted">{message.content}</span>
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
                        <div key={message.id} className="group flex gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface ring-1 ring-line">
                            {bot ? <BotAvatar bot={bot} size={26} /> : <span>🤖</span>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="mb-1 flex items-baseline gap-2 text-xs">
                              <span className="font-medium text-fg">{bot?.name || "成员"}</span>
                              {bot?.tagline && <span className="truncate text-fg-muted">{bot.tagline}</span>}
                              <span className="ml-auto shrink-0 text-[11px] text-fg-muted opacity-0 transition group-hover:opacity-100">
                                {relativeTime(message.createdAt)}
                              </span>
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
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface ring-1 ring-line">
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
                )}
              </div>

              <div className="px-5 pb-4 pt-1">
                <div className="mx-auto max-w-3xl">
                  {error && <div className="mb-2 text-xs text-danger">{error}</div>}
                  <div className="rounded-2xl border border-line bg-surface shadow-sm transition focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/10">
                    <div className="flex items-end gap-2 py-1.5 pl-4 pr-1.5">
                      <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            handleSend();
                          }
                        }}
                        rows={1}
                        placeholder={pendingBot ? `${pendingBot} 正在想…` : "发消息，Enter 发送"}
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
                    {memberBots.length > 0 && (
                      <div className="flex items-center gap-1 overflow-x-auto border-t border-line/70 px-2 py-1.5 [scrollbar-width:none]">
                        <span className="shrink-0 px-1 text-[11px] text-fg-muted">@</span>
                        <button
                          type="button"
                          onClick={() => insertMention("全体")}
                          title="所有成员依次发言"
                          className="shrink-0 rounded-full px-2 py-0.5 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                        >
                          全体
                        </button>
                        {memberBots.map((bot) => (
                          <button
                            key={bot.id}
                            type="button"
                            onClick={() => insertMention(bot.name)}
                            title={`只问${bot.name}`}
                            className="flex shrink-0 items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                          >
                            <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full bg-surface-2">
                              <BotAvatar bot={bot} size={18} />
                            </span>
                            {bot.name}
                          </button>
                        ))}
                      </div>
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
