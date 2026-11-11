import { useMemo, useState } from "react";
import { askBot, resolveTargets, type RoomHistoryItem } from "../agent/rooms";
import { useBotStore } from "../store/bots";
import { useRoomStore } from "../store/rooms";
import { BotAvatar } from "./BotAvatar";
import { useThemeClass } from "../store/theme";

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
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);

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

    const history: RoomHistoryItem[] = roomMessages.slice(-8).map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      content: message.content,
      botName: message.botId
        ? bots.find((bot) => bot.id === message.botId)?.name
        : undefined,
    }));

    for (const bot of targets) {
      setPendingBot(bot.name);
      try {
        const reply = await askBot(bot, text, history, room.name);
        appendMessage({ roomId: room.id, role: "assistant", botId: bot.id, content: reply });
        history.push({ role: "assistant", content: reply, botName: bot.name });
      } catch (cause) {
        appendMessage({
          roomId: room.id,
          role: "assistant",
          botId: bot.id,
          content: `调用失败：${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    setPendingBot("");
  };

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col`}>
      <div className="flex items-center gap-3 border-b border-gray-700 ui-panel px-4 py-3">
        <button onClick={onClose} className="text-gray-400 transition-colors hover:text-white" aria-label="返回聊天">
          ←
        </button>
        <div>
          <div className="font-semibold">团队房间</div>
          <div className="text-xs ui-muted">多个 Bot 在同一话题下协作，用 @ 指派</div>
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
                <span className="truncate text-xs ui-muted">
                  {item.memberBotIds.length} 位成员
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          {!room ? (
            <div className="flex flex-1 items-center justify-center text-sm ui-muted">
              从左侧新建或选择一个房间。
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-gray-700 ui-panel px-4 py-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{room.name}</div>
                  <div className="truncate text-xs ui-muted">
                    成员：{memberBots.map((bot) => bot.name).join("、") || "无"}
                  </div>
                </div>
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowSettings(!showSettings)}
                    className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-gray-600"
                  >
                    房间设置
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm("确定清空这个房间的消息吗？")) clearMessages(room.id);
                    }}
                    className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-red-900/60"
                  >
                    清空消息
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`确定删除房间「${room.name}」吗？`)) deleteRoom(room.id);
                    }}
                    className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-red-900/60"
                  >
                    删除
                  </button>
                </div>
              </div>

              {showSettings && (
                <div className="space-y-3 border-b border-gray-700 ui-panel px-4 py-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs ui-muted">
                      房间名
                      <input
                        className="input mt-1"
                        value={room.name}
                        onChange={(event) => updateRoom(room.id, { name: event.target.value })}
                      />
                    </label>
                    <label className="block text-xs ui-muted">
                      话题 / 共同指令
                      <input
                        className="input mt-1"
                        value={room.topic}
                        onChange={(event) => updateRoom(room.id, { topic: event.target.value })}
                        placeholder="例如：本周版本复盘"
                      />
                    </label>
                  </div>
                  <div className="text-xs ui-muted">成员（勾选后 @ 可单独指派）</div>
                  <div className="flex flex-wrap gap-2">
                    {availableBots.map((bot) => (
                      <label key={bot.id} className="flex items-center gap-1.5 rounded-lg ui-panel-strong px-2.5 py-1.5 text-xs">
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

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {roomMessages.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm ui-muted">
                    <span className="text-3xl">💬</span>
                    <span>发条消息让房间里的 Bot 开始协作</span>
                    <span className="text-xs">不带 @ 时默认全体成员作答；@名字 只指派指定 Bot</span>
                  </div>
                )}
                {roomMessages.map((message) => {
                  const isUser = message.role === "user";
                  const bot = message.botId ? bots.find((item) => item.id === message.botId) : undefined;
                  return (
                    <div key={message.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[80%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
                          isUser ? "bg-yellow-500 text-gray-900" : "bg-gray-800 text-gray-100"
                        }`}
                      >
                        {!isUser && (
                          <div className="mb-1 flex items-center gap-1 text-xs text-yellow-300">
                            {bot && <BotAvatar bot={bot} size={18} />}
                            {bot?.name || "系统"}
                          </div>
                        )}
                        {message.content}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-gray-700 ui-panel px-4 py-3">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs ui-muted">快捷 @：</span>
                  <button
                    type="button"
                    onClick={() => insertMention("全体")}
                    className="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-600"
                  >
                    @全体
                  </button>
                  {memberBots.map((bot) => (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => insertMention(bot.name)}
                      className="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-600"
                    >
                      @{bot.name}
                    </button>
                  ))}
                </div>
                {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
                <div className="flex gap-2">
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    rows={1}
                    placeholder="输入消息，Enter 发送；@名字 指派给指定 Bot"
                    className="flex-1 resize-none rounded-xl border border-gray-600 bg-gray-800 px-4 py-2.5 placeholder:text-gray-500 focus:border-yellow-500 focus:outline-none"
                    style={{ maxHeight: 120 }}
                  />
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={Boolean(pendingBot) || !input.trim()}
                    className="rounded-xl bg-yellow-500 px-4 font-bold text-gray-900 hover:bg-yellow-400 disabled:bg-gray-700 disabled:text-gray-500"
                  >
                    {pendingBot ? `${pendingBot} 思考中` : "发送"}
                  </button>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
