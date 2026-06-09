import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  availableMonitors,
  currentMonitor,
  cursorPosition,
  getAllWindows,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PetBubble } from "./PetBubble";
import { PixelPetSprite } from "./PixelPetSprite";
import { usePetStore } from "../store/pet";
import { useChatStore } from "../store/chat";
import { useAgentStore } from "../store/agent";
import { useThemeClass } from "../store/theme";
import { useActivityMonitor } from "../store/activity";
import { usePetProactivity } from "../agent/proactivity";
import { fetchTodayNews, formatNewsBubble, formatNewsMarkdown } from "../agent/news";
import { getInteractionByType, getRandomInteraction, getTimeBasedGreeting } from "../utils/petInteractions";

type PetState = "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking" | "morning" | "night" | "dance" | "stretch" | "look" | "wave";
type Facing = "left" | "right";

type WorkArea = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

const PET_SIZE = { width: 340, height: 340 };
const CHAT_SIZE = { width: 440, height: 560 };
const SPRITE_SIZE = 128;
const EDGE_PADDING = 14;
const Pikachu3D = lazy(() => import("./Pikachu3D").then((module) => ({ default: module.Pikachu3D })));

const FREQUENCY_INTERVALS: Record<"rare" | "normal" | "frequent", number> = {
  rare: 46_000,
  normal: 28_000,
  frequent: 16_000,
};

const ACTION_INTERVALS: Record<"rare" | "normal" | "frequent", number> = {
  rare: 16_000,
  normal: 10_000,
  frequent: 7_000,
};

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function defaultStateForTime(timeOfDay: string): PetState {
  if (timeOfDay === "morning") return "morning";
  if (timeOfDay === "night") return "night";
  return "idle";
}

function minutesOfDay(value: string) {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function isQuietNow(enabled: boolean, start: string, end: string) {
  if (!enabled) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const startMinutes = minutesOfDay(start);
  const endMinutes = minutesOfDay(end);
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return current >= startMinutes && current < endMinutes;
  return current >= startMinutes || current < endMinutes;
}

function trimBubbleText(text: string) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "代码写好了，详细内容在聊天里。")
    .replace(/[#*_`>\[\]\(\)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 140)}...` : cleaned;
}

function centerOfWindow(position: { x: number; y: number }) {
  return { x: position.x + PET_SIZE.width / 2, y: position.y + PET_SIZE.height / 2 };
}

function clampToWorkArea(target: { x: number; y: number }, work: WorkArea, size = PET_SIZE) {
  const minX = work.position.x + EDGE_PADDING;
  const minY = work.position.y + EDGE_PADDING;
  const maxX = work.position.x + work.size.width - size.width - EDGE_PADDING;
  const maxY = work.position.y + work.size.height - size.height - EDGE_PADDING;
  return {
    x: Math.round(clamp(target.x, minX, maxX)),
    y: Math.round(clamp(target.y, minY, maxY)),
  };
}

async function getActiveWorkArea(): Promise<WorkArea> {
  try {
    const monitor = await currentMonitor();
    if (monitor?.workArea) return monitor.workArea;
  } catch {}

  try {
    const monitors = await availableMonitors();
    if (monitors[0]?.workArea) return monitors[0].workArea;
  } catch {}

  return {
    position: { x: 0, y: 0 },
    size: { width: window.screen.width || 1920, height: window.screen.height || 1080 },
  };
}

async function showMainWindow(view: "chat" | "settings") {
  try {
    await emit(view === "chat" ? "open-chat" : "open-settings");
    const windows = await getAllWindows();
    const mainWindow = windows.find((window) => window.label === "main");
    if (mainWindow) {
      await mainWindow.show();
      await mainWindow.setFocus();
      return;
    }
    await invoke("toggle_main_window");
  } catch {
    // Browser dev fallback.
  }
}

async function resizePetWindow(expanded: boolean) {
  try {
    const size = expanded ? CHAT_SIZE : PET_SIZE;
    await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
  } catch {
    // Browser dev fallback.
  }
}

export function Pet() {
  const themeClass = useThemeClass();
  const [petState, setPetState] = useState<PetState>("idle");
  const [facing, setFacing] = useState<Facing>("right");
  const [showMenu, setShowMenu] = useState(false);
  const [showMiniChat, setShowMiniChat] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [bubbleMessage, setBubbleMessage] = useState<string | null>(null);
  const [miniInput, setMiniInput] = useState("");
  const [statusText, setStatusText] = useState<string | null>(null);

  const dragRef = useRef<{
    pointerStart: { x: number; y: number };
    windowStart: { x: number; y: number };
    moved: boolean;
    nativeStarted: boolean;
  } | null>(null);
  const movingRef = useRef(false);
  const hoverPetRef = useRef(false);
  const chatActiveRef = useRef(false);
  const pauseMotionUntilRef = useRef(0);
  const lastHumanTouchRef = useRef(Date.now());
  const lastSpokenRef = useRef(0);
  const roamTimerRef = useRef<number | null>(null);
  const interactionTimerRef = useRef<number | null>(null);
  const attentionTimerRef = useRef<number | null>(null);
  const miniChatListRef = useRef<HTMLDivElement>(null);

  const emotion = usePetStore((state) => state.emotion);
  const avatar = usePetStore((state) => state.avatar);
  const autoAction = usePetStore((state) => state.autoAction);
  const timeOfDay = usePetStore((state) => state.timeOfDay);
  const enableInteractions = usePetStore((state) => state.enableInteractions);
  const interactionFrequency = usePetStore((state) => state.interactionFrequency);
  const petSize = usePetStore((state) => state.size);
  const petOpacity = usePetStore((state) => state.opacity);
  const roamScope = usePetStore((state) => state.roamScope);
  const avoidCursor = usePetStore((state) => state.avoidCursor);
  const autonomousNews = usePetStore((state) => state.autonomousNews);
  const autonomousLearning = usePetStore((state) => state.autonomousLearning);
  const quietHoursEnabled = usePetStore((state) => state.quietHoursEnabled);
  const quietStart = usePetStore((state) => state.quietStart);
  const quietEnd = usePetStore((state) => state.quietEnd);
  const setEmotion = usePetStore((state) => state.setEmotion);
  const setAvatar = usePetStore((state) => state.setAvatar);
  const refreshTimeOfDay = usePetStore((state) => state.refreshTimeOfDay);

  const messages = useChatStore((state) => state.messages);
  const addMessage = useChatStore((state) => state.addMessage);
  const sendMessage = useAgentStore((state) => state.sendMessage);
  const isStreaming = useAgentStore((state) => state.isStreaming);
  const streamText = useAgentStore((state) => state.streamText);

  const pauseMotion = useCallback((ms = 1800) => {
    pauseMotionUntilRef.current = Math.max(pauseMotionUntilRef.current, Date.now() + ms);
  }, []);

  const markHumanTouch = useCallback(() => {
    lastHumanTouchRef.current = Date.now();
    pauseMotion(1800);
  }, [pauseMotion]);

  const shouldPauseMotion = useCallback(() => {
    return (
      hoverPetRef.current ||
      chatActiveRef.current ||
      Date.now() < pauseMotionUntilRef.current ||
      isDragging ||
      showMenu ||
      showMiniChat ||
      isStreaming ||
      isQuietNow(quietHoursEnabled, quietStart, quietEnd)
    );
  }, [isDragging, isStreaming, quietEnd, quietHoursEnabled, quietStart, showMenu, showMiniChat]);

  const resetToDefaultState = useCallback(() => {
    setStatusText(null);
    setPetState(defaultStateForTime(timeOfDay));
    setEmotion("idle");
  }, [setEmotion, timeOfDay]);

  const speak = useCallback(
    (message: string, duration = 6500) => {
      setBubbleMessage(trimBubbleText(message));
      setPetState("excited");
      setEmotion("excited");
      lastSpokenRef.current = Date.now();
      window.setTimeout(resetToDefaultState, Math.min(duration, 2800));
    },
    [resetToDefaultState, setEmotion]
  );

  useActivityMonitor(
    useCallback(
      (summary: string) => {
        addMessage({ role: "assistant", content: summary });
        speak("我整理了一下你最近的电脑活动，已经放到聊天里。", 5200);
      },
      [addMessage, speak]
    )
  );

  usePetProactivity({
    shouldPauseMotion,
    speak,
    setPetState,
    addMessage,
    lastHumanTouchRef,
    autonomousNews,
    autonomousLearning,
    enableInteractions,
    autoAction,
  });

  const moveTo = useCallback(
    async (target: { x: number; y: number }, reason: "wander" | "cursor" | "edge" = "wander", force = false) => {
      if (movingRef.current || (!force && shouldPauseMotion())) return false;
      movingRef.current = true;
      try {
        const appWindow = getCurrentWindow();
        const work = await getActiveWorkArea();
        const start = await appWindow.outerPosition();
        const safeTarget = clampToWorkArea(target, work);
        const dx = safeTarget.x - start.x;
        const dy = safeTarget.y - start.y;

        if (Math.abs(dx) + Math.abs(dy) < 18) return true;

        setFacing(dx < 0 ? "left" : "right");
        setPetState("walk");
        setStatusText(reason === "cursor" ? "发现你了" : reason === "edge" ? "回到桌面里" : "巡逻中");

        const steps = clamp(Math.round(distance(start, safeTarget) / 18), 18, 54);
        for (let step = 1; step <= steps; step += 1) {
          if (dragRef.current || (!force && shouldPauseMotion())) break;
          const t = easeOutCubic(step / steps);
          const x = Math.round(start.x + dx * t);
          const y = Math.round(start.y + dy * t);
          await appWindow.setPosition(new PhysicalPosition(x, y));
          await wait(18);
        }
        resetToDefaultState();
        return true;
      } catch {
        return false;
    } finally {
      movingRef.current = false;
    }
  },
    [resetToDefaultState, shouldPauseMotion]
  );

  const snapInsideWorkArea = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      const work = await getActiveWorkArea();
      const pos = await appWindow.outerPosition();
      const safe = clampToWorkArea(pos, work);
      if (Math.abs(safe.x - pos.x) + Math.abs(safe.y - pos.y) > 2) {
        await moveTo(safe, "edge", true);
      }
    } catch {}
  }, [moveTo]);

  const wander = useCallback(async (force = false) => {
    if (!autoAction || (!force && shouldPauseMotion()) || movingRef.current) return;

    const work = await getActiveWorkArea();
    const action = Math.random();

    if (action < 0.12) {
      setPetState("stretch");
      setStatusText("伸个懒腰");
      window.setTimeout(resetToDefaultState, 2600);
      return;
    }

    if (action < 0.24) {
      setPetState("sit");
      setStatusText("观察桌面");
      window.setTimeout(resetToDefaultState, 3500);
      return;
    }

    if (action < 0.34) {
      setPetState("look");
      setStatusText("观察环境");
      window.setTimeout(resetToDefaultState, 2200);
      return;
    }

    if (action < 0.42 && enableInteractions) {
      setPetState("dance");
      setStatusText("自己开心一下");
      window.setTimeout(resetToDefaultState, 2600);
      return;
    }

    if (action < 0.50 && timeOfDay !== "morning") {
      setPetState("sleep");
      setStatusText(timeOfDay === "night" ? "安静陪伴" : "小憩一下");
      window.setTimeout(resetToDefaultState, timeOfDay === "night" ? 9000 : 5500);
      return;
    }

    const current = await getCurrentWindow().outerPosition();
    let target = {
      x: rand(work.position.x + 40, work.position.x + work.size.width - PET_SIZE.width - 40),
      y: rand(work.position.y + 40, work.position.y + work.size.height - PET_SIZE.height - 40),
    };

    if (roamScope === "nearby") {
      target = {
        x: current.x + rand(-260, 260),
        y: current.y + rand(-180, 220),
      };
    } else if (roamScope === "corner") {
      const right = work.position.x + work.size.width - PET_SIZE.width - 48;
      const bottom = work.position.y + work.size.height - PET_SIZE.height - 48;
      target = {
        x: right + rand(-220, 40),
        y: bottom + rand(-160, 40),
      };
    }

    try {
      const cursor = await cursorPosition();
      const gap = distance(cursor, centerOfWindow(current));
      if (avoidCursor && gap < 260) {
        const awayX = centerOfWindow(current).x < cursor.x ? -260 : 140;
        const awayY = centerOfWindow(current).y < cursor.y ? -180 : 120;
        target = { x: current.x + awayX + rand(-60, 60), y: current.y + awayY + rand(-60, 60) };
      } else if (!avoidCursor && (action > 0.72 || gap < 380)) {
        const offsetX = rand(-PET_SIZE.width * 0.75, PET_SIZE.width * 0.75);
        const offsetY = rand(70, PET_SIZE.height * 0.95);
        target = { x: cursor.x + offsetX, y: cursor.y + offsetY };
      }
    } catch {}

    await moveTo(target, "wander", force);
  }, [autoAction, avoidCursor, enableInteractions, moveTo, resetToDefaultState, roamScope, shouldPauseMotion, timeOfDay]);

  const reactToCursor = useCallback(async (force = false) => {
    if (!autoAction || (!force && shouldPauseMotion()) || movingRef.current) return;

    try {
      const appWindow = getCurrentWindow();
      const [cursor, position] = await Promise.all([cursorPosition(), appWindow.outerPosition()]);
      const center = centerOfWindow(position);
      const gap = distance(cursor, center);
      setFacing(cursor.x < center.x ? "left" : "right");

      if (gap < 95 && Date.now() - lastSpokenRef.current > 20_000) {
        speak("皮卡~ 你靠得好近，我看到你啦。", 4500);
      } else if (gap < 180 && Math.random() < 0.22) {
        setPetState("thinking");
        setStatusText("盯着鼠标");
        window.setTimeout(resetToDefaultState, 1600);
      } else if (gap > 760 && Math.random() < 0.08) {
        const target = {
          x: cursor.x + rand(-160, 80),
          y: cursor.y + rand(80, 220),
        };
        await moveTo(target, "cursor", force);
      }
    } catch {
      // Browser dev fallback.
    }
  }, [autoAction, moveTo, resetToDefaultState, shouldPauseMotion, speak]);

  const triggerRandomInteraction = useCallback((force = false) => {
    if (!enableInteractions || (!force && shouldPauseMotion())) return;
    if (Date.now() - lastHumanTouchRef.current < 15_000) return;
    const interaction = getRandomInteraction();
    speak(`${interaction.emoji} ${interaction.message}`);
  }, [enableInteractions, shouldPauseMotion, speak]);

  const openMiniChat = useCallback(() => {
    markHumanTouch();
    pauseMotion(2200);
    setShowMiniChat(true);
    setShowMenu(false);
    setBubbleMessage(null);
    resizePetWindow(true);
  }, [markHumanTouch, pauseMotion]);

  const closeMiniChat = useCallback(() => {
    setShowMiniChat(false);
    pauseMotion(900);
    resizePetWindow(false);
    resetToDefaultState();
  }, [pauseMotion, resetToDefaultState]);

  const sendMiniMessage = useCallback(async () => {
    const text = miniInput.trim();
    if (!text || isStreaming) return;
    markHumanTouch();
    pauseMotion(2500);
    setMiniInput("");
    addMessage({ role: "user", content: text });
    setPetState("thinking");
    setEmotion("thinking");
    await sendMessage(text);
  }, [addMessage, isStreaming, markHumanTouch, miniInput, pauseMotion, sendMessage, setEmotion]);

  useEffect(() => {
    resizePetWindow(showMiniChat);
  }, [showMiniChat]);

  useEffect(() => {
    if (!showMiniChat) return;
    const container = miniChatListRef.current;
    if (!container) return;

    const behavior = isStreaming || streamText ? "auto" : "smooth";
    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior });
    });
  }, [showMiniChat, messages.length, streamText, isStreaming]);

  useEffect(() => {
    const timer = window.setInterval(refreshTimeOfDay, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshTimeOfDay]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    async function setupListeners() {
      try {
        const unlistenSay = await listen<{ message: string }>("pet-say", (event) => {
          if (event.payload?.message) speak(event.payload.message, 9000);
        });
        const unlistenThinking = await listen("pet-thinking", () => {
          setPetState("thinking");
          setStatusText("思考中");
        });
        const unlistenChat = await listen<{ active: boolean }>("chat-activity", (event) => {
          chatActiveRef.current = Boolean(event.payload?.active);
          if (chatActiveRef.current) {
            pauseMotion(2500);
          }
        });
        unlisteners.push(unlistenSay, unlistenThinking, unlistenChat);
      } catch {
        // Browser dev fallback.
      }
    }

    setupListeners();
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [pauseMotion, speak]);

  useEffect(() => {
    if (!enableInteractions) return;
    const todayKey = `paw_greeted_${new Date().toDateString()}`;
    if (!localStorage.getItem(todayKey)) {
      const greeting = getTimeBasedGreeting();
      speak(`${greeting.emoji} ${greeting.message}`);
      localStorage.setItem(todayKey, "1");
    }
  }, [enableInteractions, speak]);

  useEffect(() => {
    if (!enableInteractions) return;
    interactionTimerRef.current = window.setInterval(
      triggerRandomInteraction,
      FREQUENCY_INTERVALS[interactionFrequency]
    );
    return () => {
      if (interactionTimerRef.current) window.clearInterval(interactionTimerRef.current);
    };
  }, [enableInteractions, interactionFrequency, triggerRandomInteraction]);

  useEffect(() => {
    if (!autoAction) return;
    roamTimerRef.current = window.setInterval(wander, ACTION_INTERVALS[interactionFrequency]);
    attentionTimerRef.current = window.setInterval(reactToCursor, 1400);
    window.setTimeout(wander, 1800);

    return () => {
      if (roamTimerRef.current) window.clearInterval(roamTimerRef.current);
      if (attentionTimerRef.current) window.clearInterval(attentionTimerRef.current);
    };
  }, [autoAction, interactionFrequency, reactToCursor, wander]);

  useEffect(() => {
    if (emotion === "thinking") {
      setPetState("thinking");
      setStatusText("思考中");
    } else if (emotion === "excited" || emotion === "happy") {
      setPetState("excited");
    } else if (emotion === "sleepy") {
      setPetState("sleep");
    } else if (emotion === "idle") {
      resetToDefaultState();
    }
  }, [emotion, resetToDefaultState]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    markHumanTouch();
    pauseMotion(1600);
    setMenuPos({ x: event.clientX, y: event.clientY });
    setShowMenu((value) => !value);
  }, [markHumanTouch, pauseMotion]);

  const handlePointerDown = useCallback(async (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    markHumanTouch();
    pauseMotion(1600);
    setShowMenu(false);
    try {
      const pos = await getCurrentWindow().outerPosition();
      dragRef.current = {
        pointerStart: { x: event.screenX, y: event.screenY },
        windowStart: { x: pos.x, y: pos.y },
        moved: false,
        nativeStarted: false,
      };
    } catch {
      dragRef.current = {
        pointerStart: { x: event.screenX, y: event.screenY },
        windowStart: { x: 0, y: 0 },
        moved: false,
        nativeStarted: false,
      };
    }
  }, [markHumanTouch, pauseMotion]);

  useEffect(() => {
    const onPointerMove = async (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.screenX - drag.pointerStart.x;
      const dy = event.screenY - drag.pointerStart.y;
      if (Math.abs(dx) + Math.abs(dy) < 6) return;

      drag.moved = true;
      setIsDragging(true);
      setPetState("walk");
      setStatusText("跟着你走");
      setFacing(dx < 0 ? "left" : "right");

      try {
        if (!drag.nativeStarted) {
          drag.nativeStarted = true;
          await invoke("pet_drag_start");
        }
      } catch {
        try {
          await getCurrentWindow().setPosition(
            new PhysicalPosition(drag.windowStart.x + dx, drag.windowStart.y + dy)
          );
        } catch {
          // Browser dev fallback.
        }
      }
    };

    const onPointerUp = () => {
      const moved = dragRef.current?.moved;
      dragRef.current = null;
      window.setTimeout(() => setIsDragging(false), 80);
      if (moved) {
        snapInsideWorkArea();
        window.setTimeout(resetToDefaultState, 250);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [resetToDefaultState, snapInsideWorkArea]);

  const handlePetClick = useCallback(() => {
    if (isDragging || dragRef.current?.moved) return;
    markHumanTouch();
    pauseMotion(2200);
    setShowMenu(false);
    const interaction = Math.random() < 0.45 ? getInteractionByType("tip") : getInteractionByType("joke");
    speak(`${interaction.emoji} ${interaction.message}`);
  }, [isDragging, markHumanTouch, pauseMotion, speak]);

  const cycleAvatar = useCallback(() => {
    const avatars = ["pixel_pikachu", "pixel_cat", "pixel_dog", "toon_pikachu"] as const;
    const next = avatars[(avatars.indexOf(avatar) + 1) % avatars.length];
    setAvatar(next);
    setPetState("excited");
    speak(next === "pixel_cat" ? "喵~ 换成像素猫了。" : next === "pixel_dog" ? "汪~ 换成像素狗了。" : "皮卡~ 换好外观了。");
  }, [avatar, setAvatar, speak]);

  const broadcastTodayNews = useCallback(async () => {
    setPetState("thinking");
    setStatusText("搜索新闻");
    try {
      const items = await fetchTodayNews(true);
      if (items.length === 0) {
        speak("暂时没有拉到可用新闻源，我稍后再试。");
        return;
      }
      addMessage({ role: "assistant", content: formatNewsMarkdown(items, "今日新闻手动播报") });
      const queue = items.slice(0, 5);
      queue.forEach((item, index) => {
        window.setTimeout(() => {
          setPetState("wave");
          setStatusText("新闻播报");
          speak(formatNewsBubble(item, index, queue.length), 9000);
        }, index * 1800);
      });
    } catch {
      speak("新闻源今天有点不给力，我没有拉取成功。");
    }
  }, [addMessage, speak]);

  const handlePetPointerEnter = useCallback(() => {
    hoverPetRef.current = true;
    pauseMotion(3200);
  }, [pauseMotion]);

  const handlePetPointerLeave = useCallback(() => {
    hoverPetRef.current = false;
    pauseMotion(700);
  }, [pauseMotion]);

  const menuLeft = Math.max(8, Math.min(menuPos.x, (showMiniChat ? CHAT_SIZE.width : PET_SIZE.width) - 164));
  const menuTop = Math.max(8, Math.min(menuPos.y, (showMiniChat ? CHAT_SIZE.height : PET_SIZE.height) - 286));
  const recentMessages = messages.slice(-8);

  return (
    <div className={`pet-window ${themeClass} relative h-screen w-screen select-none overflow-hidden`} onContextMenu={handleContextMenu}>
      {!showMiniChat && bubbleMessage && (
        <PetBubble
          message={bubbleMessage}
          isVisible={true}
          onClose={() => setBubbleMessage(null)}
          onOpen={openMiniChat}
          autoClose={7200}
        />
      )}

      {showMiniChat && (
        <div className="mini-chat-window absolute left-4 right-4 top-4 z-30 rounded-2xl border border-yellow-200/70 bg-[#fff0a8]/95 p-3 shadow-2xl pointer-events-auto">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-900">和皮卡丘聊天</div>
            <button className="text-xs text-gray-500 hover:text-gray-900" onClick={closeMiniChat}>
              收起
            </button>
          </div>
          <div ref={miniChatListRef} className="mini-chat-list h-60 space-y-2 overflow-y-auto rounded-xl bg-[#20180a]/10 p-2">
            {recentMessages.length === 0 && <div className="text-sm text-gray-500">皮卡~ 直接输入就能聊天。</div>}
            {recentMessages.map((message) => (
              <div
                key={message.id}
                className={`text-sm ${message.role === "user" ? "text-right" : "text-left"}`}
                onDoubleClick={() => showMainWindow("chat")}
                title="双击打开完整聊天"
              >
                <span
                  className={`inline-block max-w-[85%] rounded-2xl px-3 py-2 ${
                    message.role === "user" ? "mini-chat-user bg-yellow-400 text-gray-900" : "mini-chat-assistant bg-[#fff8d5] text-gray-800 shadow-sm"
                  }`}
                >
                  {message.content.length > 180 ? `${message.content.slice(0, 180)}...` : message.content}
                </span>
              </div>
            ))}
            {isStreaming && (
              <div className="text-left text-sm">
                <span className="mini-chat-assistant inline-block max-w-[85%] rounded-2xl bg-[#fff8d5] px-3 py-2 text-gray-800 shadow-sm">
                  {streamText || "皮卡正在思考..."}
                </span>
              </div>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className="mini-chat-input min-w-0 flex-1 rounded-xl border border-yellow-200 bg-[#fff8d5] px-3 py-2 text-sm text-gray-900 outline-none focus:border-yellow-400"
              value={miniInput}
              onChange={(event) => setMiniInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") sendMiniMessage();
              }}
              placeholder="问问皮卡丘..."
            />
            <button
              className="rounded-xl bg-yellow-400 px-3 py-2 text-sm font-bold text-gray-900 disabled:opacity-50"
              disabled={!miniInput.trim() || isStreaming}
              onClick={sendMiniMessage}
            >
              发送
            </button>
          </div>
        </div>
      )}

      <div
        data-pet-sprite
        className={`absolute left-1/2 -translate-x-1/2 cursor-grab pointer-events-auto active:cursor-grabbing ${
          showMiniChat ? "bottom-3" : "top-[58%] -translate-y-1/2"
        }`}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePetPointerEnter}
        onPointerLeave={handlePetPointerLeave}
        onClick={handlePetClick}
        onDoubleClick={openMiniChat}
        title="单击互动，拖拽移动，双击聊天"
        style={{ opacity: petOpacity }}
      >
        {avatar === "toon_pikachu" ? (
          <Suspense fallback={<div className="h-28 w-28 rounded-full bg-yellow-300/80 shadow-lg" />}>
            <Pikachu3D state={petState} facing={facing} size={petSize || SPRITE_SIZE} />
          </Suspense>
        ) : (
          <PixelPetSprite avatar={avatar} state={petState} facing={facing} size={petSize || SPRITE_SIZE} />
        )}

        {statusText && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 rounded-full bg-white px-2 py-1 text-xs text-gray-800 shadow animate-bounce">
            {statusText}
          </div>
        )}
        {petState === "excited" && <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-lg animate-bounce">⚡</div>}
        {petState === "sleep" && <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-sm animate-float">Zzz</div>}
        {petState === "morning" && <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-lg animate-bounce">☀️</div>}
        {petState === "night" && <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-sm animate-pulse">🌙</div>}
      </div>

      {showMenu && (
        <div
          className="absolute z-50 min-w-[156px] rounded-xl border border-gray-700 bg-gray-900/95 py-1 shadow-2xl backdrop-blur pointer-events-auto"
          style={{ left: menuLeft, top: menuTop }}
        >
          <MenuItem label="聊天" onClick={() => { setShowMenu(false); openMiniChat(); }} />
          <MenuItem label="打开工作台" onClick={() => { setShowMenu(false); showMainWindow("chat"); }} />
          <MenuItem label="切换形态" onClick={() => { setShowMenu(false); cycleAvatar(); }} />
          <MenuItem label="自己逛逛" onClick={() => { setShowMenu(false); wander(true); }} />
          <MenuItem label="靠近鼠标" onClick={() => { setShowMenu(false); reactToCursor(true); }} />
          <MenuItem label="坐下" onClick={() => { setShowMenu(false); setPetState("sit"); setStatusText("休息一下"); window.setTimeout(resetToDefaultState, 3600); }} />
          <MenuItem label="睡觉" onClick={() => { setShowMenu(false); setPetState("sleep"); setStatusText("小睡中"); window.setTimeout(resetToDefaultState, 7000); }} />
          <MenuItem label="开心跳" onClick={() => { setShowMenu(false); setPetState("excited"); speak("收到，我精神起来了。"); }} />
          <MenuItem label="跳个舞" onClick={() => { setShowMenu(false); setPetState("dance"); setStatusText("开心营业"); window.setTimeout(resetToDefaultState, 3200); }} />
          <MenuItem label="伸懒腰" onClick={() => { setShowMenu(false); setPetState("stretch"); setStatusText("伸个懒腰"); window.setTimeout(resetToDefaultState, 2800); }} />
          <MenuItem label="今日新闻" onClick={() => { setShowMenu(false); broadcastTodayNews(); }} />
          <MenuItem label="说句话" onClick={() => { setShowMenu(false); triggerRandomInteraction(true); }} />
          <MenuItem label="摸摸头" onClick={() => { setShowMenu(false); speak("皮卡皮卡~ 好舒服，我会更努力陪你。"); }} />
          <div className="my-1 border-t border-gray-700" />
          <MenuItem label="设置" onClick={() => { setShowMenu(false); showMainWindow("settings"); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-gray-700/50"
      onClick={onClick}
    >
      <span>{label}</span>
    </button>
  );
}
