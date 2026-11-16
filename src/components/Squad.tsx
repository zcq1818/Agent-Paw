import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getAllWindows, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import { useBotStore, type BotProfile } from "../store/bots";
import { useThemeClass } from "../store/theme";
import { BotAvatar } from "./BotAvatar";

/**
 * 团队上桌面：一个透明小窗口，贴在桌宠旁边，团队成员排成一排。
 * - 房间里讨论时自动出现：轮到谁谁头上冒“思考中”，说完冒一句话；被 @ 的人跳一下；
 * - 右键菜单“叫团队出来”手动叫出来，没事干的成员会打瞌睡；
 * - 点成员打开工作台的房间页。
 */

export type SquadEvent =
  | { type: "start"; roomName: string; memberIds: string[]; mentionIds: string[] }
  | { type: "speaking"; botId: string }
  | { type: "said"; botId: string; text: string }
  | { type: "skip"; botId: string }
  | { type: "end" };

export const SQUAD_ROOM_KEY = "paw_squad_room";

export function squadInRooms() {
  return localStorage.getItem(SQUAD_ROOM_KEY) !== "off";
}

export function setSquadInRooms(on: boolean) {
  localStorage.setItem(SQUAD_ROOM_KEY, on ? "on" : "off");
}

/** 房间页调用：把讨论进度发给桌面上的成员 */
export function emitSquad(event: SquadEvent) {
  if (!squadInRooms()) return;
  void emit("squad-room", event).catch(() => {});
}

const SLOT = 78;
const HEIGHT = 210;
const MAX_MEMBERS = 8;

function snippet(text: string) {
  const plain = text
    .replace(/```[\s\S]*?```/g, "（代码）")
    .replace(/^\s*(#+|>|[-*]|\d+\.)\s+/gm, "")
    .replace(/[*_`|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 46 ? `${plain.slice(0, 46)}…` : plain;
}

type Bubble = { botId: string; text: string; kind: "thinking" | "said" | "skip" };

export function Squad() {
  const themeClass = useThemeClass();
  const bots = useBotStore((state) => state.bots);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"hidden" | "idle" | "room">("hidden");
  const [roomName, setRoomName] = useState("");
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [jumping, setJumping] = useState<string[]>([]);
  const [sleepy, setSleepy] = useState<string[]>([]);
  const hideTimer = useRef<number | null>(null);
  const bubbleTimer = useRef<number | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const members = memberIds
    .map((id) => bots.find((bot) => bot.id === id && !bot.archived))
    .filter((bot): bot is BotProfile => Boolean(bot))
    .slice(0, MAX_MEMBERS);

  /** 贴到桌宠左边（放不下就放右边），底边和桌宠脚下对齐 */
  const placeAndShow = useCallback(async (count: number) => {
    try {
      const me = getCurrentWindow();
      const width = Math.max(2, count) * SLOT + 28;
      await me.setSize(new LogicalSize(width, HEIGHT));
      const pet = (await getAllWindows()).find((item) => item.label === "pet");
      if (pet) {
        const [pos, size, scale] = await Promise.all([pet.outerPosition(), pet.outerSize(), pet.scaleFactor()]);
        const w = width * scale;
        const h = HEIGHT * scale;
        const bottom = pos.y + Math.round(size.height * 0.78);
        let x = pos.x - w + Math.round(40 * scale);
        if (x < 0) x = pos.x + size.width - Math.round(40 * scale);
        await me.setPosition(new PhysicalPosition(Math.round(x), Math.round(bottom - h)));
      }
      await me.show();
    } catch {
      // 浏览器预览
    }
  }, []);

  const hide = useCallback(async () => {
    setMode("hidden");
    setBubble(null);
    try {
      await getCurrentWindow().hide();
    } catch {}
  }, []);

  const cancelHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const showBubble = (next: Bubble, ms?: number) => {
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    setBubble(next);
    if (ms) bubbleTimer.current = window.setTimeout(() => setBubble((current) => (current === next ? null : current)), ms);
  };

  const jump = (ids: string[]) => {
    setJumping(ids);
    window.setTimeout(() => setJumping([]), 900);
  };

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    unlisteners.push(
      listen("squad-toggle", () => {
        cancelHide();
        if (modeRef.current !== "hidden") {
          void hide();
          return;
        }
        const ids = useBotStore
          .getState()
          .bots.filter((bot) => !bot.archived)
          .map((bot) => bot.id);
        setMemberIds(ids);
        setRoomName("");
        setMode("idle");
        void placeAndShow(Math.min(ids.length, MAX_MEMBERS));
        // 先一起挥手，再各自发呆
        jump(ids);
        showBubble({ botId: ids[0], text: "大家都在～点我们进房间聊", kind: "said" }, 5000);
      })
    );

    unlisteners.push(
      listen<SquadEvent>("squad-room", (event) => {
        const payload = event.payload;
        if (payload.type === "start") {
          cancelHide();
          setMemberIds(payload.memberIds);
          setRoomName(payload.roomName);
          setMode("room");
          setBubble(null);
          void placeAndShow(Math.min(payload.memberIds.length, MAX_MEMBERS));
          if (payload.mentionIds.length) window.setTimeout(() => jump(payload.mentionIds), 300);
          return;
        }
        if (modeRef.current === "hidden") return;
        if (payload.type === "speaking") showBubble({ botId: payload.botId, text: "", kind: "thinking" });
        if (payload.type === "said") {
          showBubble({ botId: payload.botId, text: snippet(payload.text), kind: "said" }, 9000);
          jump([payload.botId]);
        }
        if (payload.type === "skip") showBubble({ botId: payload.botId, text: "这个不归我管～", kind: "skip" }, 2500);
        if (payload.type === "end") {
          cancelHide();
          // 讨论结束后留一会儿再走
          hideTimer.current = window.setTimeout(() => {
            if (modeRef.current === "room") void hide();
          }, 14_000);
        }
      })
    );

    return () => {
      unlisteners.forEach((promise) => promise.then((fn) => fn()).catch(() => {}));
      cancelHide();
    };
  }, [hide, placeAndShow]);

  // 闲着的时候，随机有人打瞌睡
  useEffect(() => {
    if (mode !== "idle") {
      setSleepy([]);
      return;
    }
    const timer = window.setInterval(() => {
      const ids = memberIds.filter(() => Math.random() < 0.35);
      setSleepy(ids);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [memberIds, mode]);

  const openRooms = async () => {
    try {
      await emit("open-view", { view: "rooms" });
      const main = (await getAllWindows()).find((item) => item.label === "main");
      if (main) {
        await main.show();
        await main.setFocus();
      } else {
        // 工作台窗口被关掉了就重新建一个
        await invoke("toggle_main_window");
      }
    } catch {}
  };

  if (mode === "hidden") return <div className={`pet-window ${themeClass} h-screen w-screen`} />;

  const bubbleIndex = bubble ? members.findIndex((bot) => bot.id === bubble.botId) : -1;

  return (
    <div className={`pet-window ${themeClass} group relative h-screen w-screen select-none`}>
      {/* 气泡 */}
      {bubble && bubbleIndex >= 0 && (
        <div
          className="squad-bubble absolute bottom-[104px] z-20 max-w-[240px] rounded-2xl border border-line bg-surface/95 px-3 py-2 text-xs leading-relaxed text-fg shadow-lg backdrop-blur pointer-events-auto"
          style={{ left: Math.min(Math.max(8, 14 + bubbleIndex * SLOT + SLOT / 2 - 60), Math.max(8, members.length * SLOT + 28 - 248)) }}
        >
          {bubble.kind === "thinking" ? (
            <span className="typing-dots" aria-label="思考中">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <span className={bubble.kind === "skip" ? "text-fg-muted" : ""}>{bubble.text}</span>
          )}
        </div>
      )}

      {/* 房间名 + 关闭 */}
      <div className="absolute right-2 top-2 z-30 flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100 pointer-events-auto">
        {roomName && <span className="rounded-full bg-surface/90 px-2 py-0.5 text-[10px] text-fg-muted shadow-sm">{roomName}</span>}
        <button
          type="button"
          onClick={() => void hide()}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-surface/90 text-fg-muted shadow-sm hover:text-fg"
          aria-label="让团队回去"
          title="让团队回去"
        >
          <X size={11} />
        </button>
      </div>

      {/* 成员 */}
      <div className="absolute bottom-2 left-[14px] flex items-end">
        {members.map((bot, index) => {
          const thinking = bubble?.kind === "thinking" && bubble.botId === bot.id;
          const speaking = bubble?.kind === "said" && bubble.botId === bot.id;
          const isJumping = jumping.includes(bot.id);
          const isSleepy = mode === "idle" && sleepy.includes(bot.id) && !isJumping && !speaking;
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => void openRooms()}
              title={`${bot.name}${bot.tagline ? ` · ${bot.tagline}` : ""}`}
              className="relative flex flex-col items-center pointer-events-auto"
              style={{ width: SLOT }}
            >
              {isSleepy && <span className="squad-zzz absolute -top-1 right-3 text-xs text-fg-muted">z</span>}
              <span
                className={`squad-member flex h-16 w-16 items-center justify-center ${isJumping ? "squad-jump" : thinking ? "squad-think" : "squad-bob"} ${
                  isSleepy ? "opacity-70" : ""
                }`}
                style={{ animationDelay: isJumping || thinking ? "0s" : `${(index * 0.37) % 2}s` }}
              >
                <BotAvatar bot={bot} size={60} />
              </span>
              <span
                className={`mt-0.5 max-w-full truncate rounded-full px-1.5 text-[10px] shadow-sm ${
                  thinking || speaking ? "bg-primary text-primary-fg" : "bg-surface/90 text-fg-muted"
                }`}
              >
                {bot.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
