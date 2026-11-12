import { create } from "zustand";

/**
 * Rooms：多个 Bot 在同一话题下协作。
 * 房间与消息是团队级共享数据，因此使用全局 key（不按单个 Bot 分区）。
 */

export interface Room {
  id: string;
  name: string;
  topic: string;
  memberBotIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  botId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  /** 这条用户消息 @ 到的 Bot id 列表。 */
  mentions: string[];
}

const ROOMS_KEY = "paw_rooms_v1";
const MESSAGES_KEY = "paw_room_messages_v1";
const ACTIVE_ROOM_KEY = "paw_active_room_v1";

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function loadState() {
  const rooms = readArray<Room>(ROOMS_KEY).filter(
    (room) => room && typeof room.id === "string" && Array.isArray(room.memberBotIds)
  );
  const messages = readArray<RoomMessage>(MESSAGES_KEY);
  let activeRoomId = "";
  try {
    activeRoomId = localStorage.getItem(ACTIVE_ROOM_KEY) || "";
  } catch {}
  if (!rooms.some((room) => room.id === activeRoomId)) activeRoomId = rooms[0]?.id || "";
  return { rooms, messages, activeRoomId };
}

function persist(state: Pick<RoomState, "rooms" | "messages" | "activeRoomId">) {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(state.rooms));
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(state.messages));
    localStorage.setItem(ACTIVE_ROOM_KEY, state.activeRoomId);
  } catch {}
}

export interface RoomState {
  rooms: Room[];
  messages: RoomMessage[];
  activeRoomId: string;
  createRoom: (name?: string, topic?: string, memberBotIds?: string[]) => string;
  updateRoom: (id: string, patch: Partial<Pick<Room, "name" | "topic" | "memberBotIds">>) => void;
  deleteRoom: (id: string) => void;
  setActiveRoom: (id: string) => void;
  appendMessage: (msg: Omit<RoomMessage, "id" | "createdAt" | "mentions"> & { mentions?: string[] }) => string;
  clearMessages: (roomId: string) => void;
  hydrate: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => {
  const commit = (patch: Partial<Pick<RoomState, "rooms" | "messages" | "activeRoomId">>) => {
    set(patch as Partial<RoomState>);
    const next = get();
    persist({ rooms: next.rooms, messages: next.messages, activeRoomId: next.activeRoomId });
  };

  return {
    ...loadState(),

    createRoom: (name = "新房间", topic = "", memberBotIds = []) => {
      const now = nowIso();
      const room: Room = {
        id: uid("room"),
        name: name.trim() || "新房间",
        topic,
        memberBotIds: [...memberBotIds],
        createdAt: now,
        updatedAt: now,
      };
      commit({ rooms: [...get().rooms, room], activeRoomId: room.id });
      return room.id;
    },

    updateRoom: (id, patch) => {
      commit({
        rooms: get().rooms.map((room) =>
          room.id === id ? { ...room, ...patch, id: room.id, updatedAt: nowIso() } : room
        ),
      });
    },

    deleteRoom: (id) => {
      const rooms = get().rooms.filter((room) => room.id !== id);
      const messages = get().messages.filter((message) => message.roomId !== id);
      const activeRoomId = get().activeRoomId === id ? rooms[0]?.id || "" : get().activeRoomId;
      commit({ rooms, messages, activeRoomId });
    },

    setActiveRoom: (id) => {
      if (!get().rooms.some((room) => room.id === id)) return;
      commit({ activeRoomId: id });
    },

    appendMessage: (msg) => {
      if (!get().rooms.some((room) => room.id === msg.roomId)) return "";
      const message: RoomMessage = {
        ...msg,
        id: uid("rmsg"),
        createdAt: nowIso(),
        mentions: msg.mentions || [],
      };
      commit({
        messages: [...get().messages, message],
        rooms: get().rooms.map((room) =>
          room.id === message.roomId ? { ...room, updatedAt: message.createdAt } : room
        ),
      });
      return message.id;
    },

    clearMessages: (roomId) => {
      commit({ messages: get().messages.filter((message) => message.roomId !== roomId) });
    },

    hydrate: () => set(loadState()),
  };
});

export function getRoomMessages(state: RoomState, roomId: string): RoomMessage[] {
  return state.messages.filter((message) => message.roomId === roomId);
}
