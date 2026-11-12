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
import { BUILTIN_AVATARS, describeAvatar, loadCustomAvatars } from "../store/petAvatars";
import { bubbleText } from "../utils/bubbleText";
import { usePetStore } from "../store/pet";
import { useChatStore } from "../store/chat";
import { useAgentStore } from "../store/agent";
import { useThemeClass } from "../store/theme";
import { useActivityMonitor, useActivityStore, checkAndDeliverYesterdaySummary } from "../store/activity";
import { usePetProactivity } from "../agent/proactivity";
import { applyTimelineConfig } from "../agent/timeline";
import { useAutomationRunner, useAutomationStore } from "../agent/automations";
import { recordOfferFeedback, useInitiative, type Offer } from "../agent/initiative";
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
const MarkdownContent = lazy(() => import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })));
const RiggedPet3D = lazy(() => import("./RiggedPet3D").then((module) => ({ default: module.RiggedPet3D })));

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
  // 已经是摘要（带“点我看完整回复”）的就不再截；否则按 Markdown 友好的方式截断。
  return text.includes("点我看完整回复") ? text : bubbleText(text);
}

/**
 * 工作区、窗口位置、鼠标坐标都是物理像素，而 PET_SIZE / CHAT_SIZE 是逻辑像素（setSize 用 LogicalSize）。
 * 屏幕缩放不是 100% 时必须换算，否则贴边计算会把窗口放出屏幕或离边缘太远。
 */
function scaleFactor() {
  return window.devicePixelRatio || 1;
}

function physicalSize(size: { width: number; height: number }) {
  const scale = scaleFactor();
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

function centerOfWindow(position: { x: number; y: number }) {
  const size = physicalSize(PET_SIZE);
  return { x: position.x + size.width / 2, y: position.y + size.height / 2 };
}

function clampToWorkArea(target: { x: number; y: number }, work: WorkArea, logicalSize = PET_SIZE) {
  const size = physicalSize(logicalSize);
  const padding = Math.round(EDGE_PADDING * scaleFactor());
  const minX = work.position.x + padding;
  const minY = work.position.y + padding;
  const maxX = Math.max(minX, work.position.x + work.size.width - size.width - padding);
  const maxY = Math.max(minY, work.position.y + work.size.height - size.height - padding);
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
  const [showVitals, setShowVitals] = useState(false);
  const vitalsTimerRef = useRef<number | null>(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [bubbleMessage, setBubbleMessage] = useState<string | null>(null);
  const [miniInput, setMiniInput] = useState("");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [newsBanner, setNewsBanner] = useState<{ title: string; items: string[] } | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const offerRef = useRef<Offer | null>(null);
  offerRef.current = offer;
  const [routineBanner, setRoutineBanner] = useState<{ title: string; subtitle: string; items: string[] } | null>(null);

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
  const idleActionTimerRef = useRef<number | null>(null);
  const miniChatListRef = useRef<HTMLDivElement>(null);

  const emotion = usePetStore((state) => state.emotion);
  const avatar = usePetStore((state) => state.avatar);
  const petName = usePetStore((state) => state.name);
  const avatarInfo = describeAvatar(avatar);
  const autoAction = usePetStore((state) => state.autoAction);
  const timeOfDay = usePetStore((state) => state.timeOfDay);
  const enableInteractions = usePetStore((state) => state.enableInteractions);
  const interactionFrequency = usePetStore((state) => state.interactionFrequency);
  const petSize = usePetStore((state) => state.size);
  const petOpacity = usePetStore((state) => state.opacity);
  const life = usePetStore((state) => state.life);
  const roamScope = usePetStore((state) => state.roamScope);
  const avoidCursor = usePetStore((state) => state.avoidCursor);
  const autonomousNews = usePetStore((state) => state.autonomousNews);
  const autonomousLearning = usePetStore((state) => state.autonomousLearning);
  const quietHoursEnabled = usePetStore((state) => state.quietHoursEnabled);
  const quietStart = usePetStore((state) => state.quietStart);
  const quietEnd = usePetStore((state) => state.quietEnd);
  const setEmotion = usePetStore((state) => state.setEmotion);
  const setAvatar = usePetStore((state) => state.setAvatar);
  const adjustLife = usePetStore((state) => state.adjustLife);
  const tickLife = usePetStore((state) => state.tickLife);
  const refreshTimeOfDay = usePetStore((state) => state.refreshTimeOfDay);

  const messages = useChatStore((state) => state.messages);
  const addMessage = useChatStore((state) => state.addMessage);
  const sendMessage = useAgentStore((state) => state.sendMessage);
  const isStreaming = useAgentStore((state) => state.isStreaming);
  const streamText = useAgentStore((state) => state.streamText);
  const recordTyping = useActivityStore((state) => state.recordTyping);

  const pauseMotion = useCallback((ms = 1800) => {
    pauseMotionUntilRef.current = Math.max(pauseMotionUntilRef.current, Date.now() + ms);
  }, []);

  const showVitalsBriefly = useCallback((duration = 3000) => {
    setShowVitals(true);
    if (vitalsTimerRef.current) window.clearTimeout(vitalsTimerRef.current);
    vitalsTimerRef.current = window.setTimeout(() => {
      setShowVitals(false);
      vitalsTimerRef.current = null;
    }, duration);
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
    (message: string, duration = 6500, pose: PetState = "excited") => {
      setBubbleMessage(trimBubbleText(message));
      setPetState(pose);
      setEmotion("excited");
      lastSpokenRef.current = Date.now();
      adjustLife({ affection: 1, energy: -0.4 });
      window.setTimeout(resetToDefaultState, Math.min(duration, 2800));
    },
    [adjustLife, resetToDefaultState, setEmotion]
  );

  useActivityMonitor();

  // Deliver yesterday's activity summary on first launch of the day
  useEffect(() => {
    const getSummary = useActivityStore.getState().getSummary;
    checkAndDeliverYesterdaySummary(getSummary, addMessage, speak);
  }, [addMessage, speak]);

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
    if (life.energy < 18 && !force) {
      setPetState("sleep");
      adjustLife({ energy: 2, curiosity: -1 });
      window.setTimeout(resetToDefaultState, 7600);
      return;
    }

    const work = await getActiveWorkArea();
    const action = Math.random();

    if (action < 0.12) {
      setPetState("stretch");
      window.setTimeout(resetToDefaultState, 2600);
      return;
    }

    if (action < 0.24) {
      setPetState("sit");
      window.setTimeout(resetToDefaultState, 3500);
      return;
    }

    if (action < 0.34) {
      setPetState("look");
      window.setTimeout(resetToDefaultState, 2200);
      return;
    }

    if (action < 0.42 && enableInteractions) {
      setPetState("dance");
      window.setTimeout(resetToDefaultState, 2600);
      return;
    }

    if (action < 0.50 && timeOfDay !== "morning") {
      setPetState("sleep");
      window.setTimeout(resetToDefaultState, timeOfDay === "night" ? 9000 : 5500);
      return;
    }

    const current = await getCurrentWindow().outerPosition();
    const petPx = physicalSize(PET_SIZE);
    let target = {
      x: rand(work.position.x + 40, work.position.x + work.size.width - petPx.width - 40),
      y: rand(work.position.y + 40, work.position.y + work.size.height - petPx.height - 40),
    };

    if (roamScope === "nearby") {
      target = {
        x: current.x + rand(-260, 260),
        y: current.y + rand(-180, 220),
      };
    } else if (roamScope === "corner") {
      const right = work.position.x + work.size.width - petPx.width - 48;
      const bottom = work.position.y + work.size.height - petPx.height - 48;
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
      } else if (!avoidCursor && roamScope === "full" && (action > 0.72 || gap < 380)) {
        // 只有“全屏活动 + 不避开鼠标”时才凑到鼠标旁边，否则会跑出“附近 / 角落”的范围。
        const offsetX = rand(-petPx.width * 0.75, petPx.width * 0.75);
        const offsetY = rand(70, petPx.height * 0.95);
        target = { x: cursor.x + offsetX, y: cursor.y + offsetY };
      }
    } catch {}

    const moved = await moveTo(target, "wander", force);
    if (moved) adjustLife({ energy: -2, curiosity: -1 });
  }, [adjustLife, autoAction, avoidCursor, enableInteractions, life.energy, moveTo, resetToDefaultState, roamScope, shouldPauseMotion, timeOfDay]);

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
        window.setTimeout(resetToDefaultState, 1600);
      } else if (avoidCursor && gap < 240 && Math.random() < 0.35) {
        // 避开鼠标：鼠标靠近（但还没碰到）时往反方向挪一点。
        const away = {
          x: position.x + (center.x < cursor.x ? -220 : 220) + rand(-40, 40),
          y: position.y + (center.y < cursor.y ? -140 : 140) + rand(-40, 40),
        };
        await moveTo(away, "cursor", force);
      } else if (!avoidCursor && roamScope === "full" && gap > 760 && Math.random() < 0.08) {
        // 不避开鼠标且全屏活动时，偶尔跑到鼠标附近；其它设置下不追鼠标。
        const target = {
          x: cursor.x + rand(-160, 80),
          y: cursor.y + rand(80, 220),
        };
        await moveTo(target, "cursor", force);
      }
    } catch {
      // Browser dev fallback.
    }
  }, [autoAction, avoidCursor, moveTo, resetToDefaultState, roamScope, shouldPauseMotion, speak]);

  const triggerRandomInteraction = useCallback((force = false) => {
    if (!enableInteractions || (!force && shouldPauseMotion())) return;
    if (Date.now() - lastHumanTouchRef.current < 15_000) return;
    const interaction = getRandomInteraction();
    adjustLife({ affection: 1, curiosity: -1 });
    speak(`${interaction.emoji} ${interaction.message}`);
  }, [adjustLife, enableInteractions, shouldPauseMotion, speak]);

  const performIdleAction = useCallback(async (force = false) => {
    if (!autoAction || (!force && shouldPauseMotion()) || movingRef.current) return;
    if (Date.now() - lastHumanTouchRef.current < 12_000 && !force) return;
    if (life.energy < 22 && !force) {
      setPetState("sleep");
      adjustLife({ energy: 4, curiosity: -1 });
      window.setTimeout(resetToDefaultState, 7800);
      return;
    }

    const roll = Math.random();
    if (timeOfDay === "night" && roll < 0.35) {
      setPetState("sleep");
      window.setTimeout(resetToDefaultState, 8200);
      return;
    }

    if (roll < 0.24) {
      setPetState("stretch");
      window.setTimeout(resetToDefaultState, 2600);
      return;
    }

    if (roll < 0.48) {
      setPetState("look");
      window.setTimeout(resetToDefaultState, 1800);
      return;
    }

    if (roll < 0.66) {
      adjustLife({ affection: 1, energy: -0.5 });
      speak("我还在这里陪着你。", 3200, "wave");
      return;
    }

    if (roll < 0.84) {
      await wander(true);
      return;
    }

    await reactToCursor(true);
  }, [adjustLife, autoAction, life.energy, reactToCursor, resetToDefaultState, shouldPauseMotion, speak, timeOfDay, wander]);

  const openMiniChat = useCallback(() => {
    markHumanTouch();
    pauseMotion(2200);
    setShowVitals(false);
    setShowMiniChat(true);
    setShowMenu(false);
    setBubbleMessage(null);
    resizePetWindow(true).then(async () => {
      try {
        const appWindow = getCurrentWindow();
        const [work, pos] = await Promise.all([getActiveWorkArea(), appWindow.outerPosition()]);
        const safe = clampToWorkArea(pos, work, CHAT_SIZE);
        if (safe.x !== pos.x || safe.y !== pos.y) {
          await appWindow.setPosition(new PhysicalPosition(safe.x, safe.y));
        }
      } catch {
        // Browser dev fallback.
      }
    });
  }, [markHumanTouch, pauseMotion]);

  const closeMiniChat = useCallback(() => {
    setShowMiniChat(false);
    pauseMotion(900);
    resizePetWindow(false);
    resetToDefaultState();
  }, [pauseMotion, resetToDefaultState]);

  /** 以用户身份把一段指令交给桌宠执行（主动提议被接受、自动任务到点）。 */
  const runPrompt = useCallback(
    async (prompt: string) => {
      if (useAgentStore.getState().isStreaming) return;
      addMessage({ role: "user", content: prompt });
      setPetState("thinking");
      setEmotion("thinking");
      await sendMessage(prompt);
    },
    [addMessage, sendMessage, setEmotion]
  );

  useEffect(() => {
    // Rust 记录器每次启动都是关闭状态，由前端把设置推过去。
    void applyTimelineConfig();
  }, []);

  useAutomationRunner({
    runPrompt,
    speak,
    isBusy: () => useAgentStore.getState().isStreaming,
  });

  useInitiative({
    enabled: true,
    isBusy: () =>
      showMiniChat || isDragging || showMenu || useAgentStore.getState().isStreaming || isQuietNow(quietHoursEnabled, quietStart, quietEnd),
    hasOffer: () => Boolean(offerRef.current),
    showOffer: (next) => {
      setBubbleMessage(null);
      setOffer(next);
      setPetState("wave");
      setEmotion("excited");
      window.setTimeout(resetToDefaultState, 2600);
    },
  });

  useEffect(() => {
    if (!offer) return;
    // 30 秒没理会就收起，不算拒绝
    const timer = window.setTimeout(() => setOffer((current) => (current?.id === offer.id ? null : current)), 30_000);
    return () => window.clearTimeout(timer);
  }, [offer]);

  const acceptOffer = useCallback(async () => {
    const current = offerRef.current;
    if (!current) return;
    setOffer(null);
    markHumanTouch();
    recordOfferFeedback(current.kind, true);
    const accept = current.accept;
    if (accept.type === "prompt") {
      openMiniChat();
      await runPrompt(accept.prompt);
    } else if (accept.type === "automation") {
      useAutomationStore.getState().add({
        name: accept.name,
        time: accept.time,
        days: accept.days,
        action: accept.action,
        source: "suggested",
      });
      speak(`好，记下了：${accept.name}，到点我自己来。在设置里随时能关。`, 6000, "wave");
    } else {
      speak("好嘞～", 2400, "wave");
    }
  }, [markHumanTouch, openMiniChat, runPrompt, speak]);

  const declineOffer = useCallback(() => {
    const current = offerRef.current;
    if (!current) return;
    setOffer(null);
    markHumanTouch();
    recordOfferFeedback(current.kind, false);
  }, [markHumanTouch]);

  const sendMiniMessage = useCallback(async () => {
    const text = miniInput.trim();
    if (!text || isStreaming) return;
    markHumanTouch();
    pauseMotion(2500);
    setMiniInput("");
    recordTyping(text.length, "mini_chat");
    addMessage({ role: "user", content: text });
    setPetState("thinking");
    setEmotion("thinking");
    await sendMessage(text);
  }, [addMessage, isStreaming, markHumanTouch, miniInput, pauseMotion, recordTyping, sendMessage, setEmotion]);

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
    tickLife();
    const timer = window.setInterval(tickLife, 90_000);
    return () => window.clearInterval(timer);
  }, [tickLife]);

  const speakRef = useRef(speak);
  speakRef.current = speak;
  const adjustLifeRef = useRef(adjustLife);
  adjustLifeRef.current = adjustLife;
  const wanderRef = useRef(wander);
  wanderRef.current = wander;
  const reactToCursorRef = useRef(reactToCursor);
  reactToCursorRef.current = reactToCursor;
  const performIdleActionRef = useRef(performIdleAction);
  performIdleActionRef.current = performIdleAction;
  const triggerRandomInteractionRef = useRef(triggerRandomInteraction);
  triggerRandomInteractionRef.current = triggerRandomInteraction;

  useEffect(() => {
    // listen() 是异步的：cleanup 先于注册完成时要立刻注销，否则会重复监听（同一句话说两遍）。
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };
    async function setupListeners() {
      try {
        track(await listen<{ message: string }>("pet-say", (event) => {
          if (event.payload?.message) speakRef.current(event.payload.message, 9000);
        }));
        track(await listen<{ title?: string; items?: string[] }>("pet-news", (event) => {
          const title = event.payload?.title || "今日新闻速览";
          const items = (event.payload?.items || []).filter(Boolean).slice(0, 3);
          setNewsBanner({ title, items });
          adjustLifeRef.current({ curiosity: -3, affection: 1, energy: -1 });
          window.setTimeout(() => {
            setNewsBanner((current) => (current?.title === title ? null : current));
          }, 12000);
        }));
        track(await listen<{ title?: string; subtitle?: string; items?: string[] }>("pet-routine", (event) => {
          const title = event.payload?.title || "今日安排";
          const subtitle = event.payload?.subtitle || "按节奏走就好";
          const items = (event.payload?.items || []).filter(Boolean).slice(0, 3);
          setRoutineBanner({ title, subtitle, items });
          window.setTimeout(() => {
            setRoutineBanner((current) => (current?.title === title ? null : current));
          }, 14000);
        }));
        track(await listen("pet-thinking", () => {
          setPetState("thinking");
        }));
        track(await listen<{ active: boolean }>("chat-activity", (event) => {
          chatActiveRef.current = Boolean(event.payload?.active);
          if (chatActiveRef.current) {
            pauseMotion(2500);
          }
        }));
      } catch {
        // Browser dev fallback.
      }
    }

    setupListeners();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [pauseMotion]);

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
      () => triggerRandomInteractionRef.current(),
      FREQUENCY_INTERVALS[interactionFrequency]
    );
    return () => {
      if (interactionTimerRef.current) window.clearInterval(interactionTimerRef.current);
    };
  }, [enableInteractions, interactionFrequency]);

  useEffect(() => {
    if (!autoAction) return;
    roamTimerRef.current = window.setInterval(() => {
      wanderRef.current().catch(() => {});
    }, ACTION_INTERVALS[interactionFrequency]);
    attentionTimerRef.current = window.setInterval(() => {
      reactToCursorRef.current().catch(() => {});
    }, 1400);
    idleActionTimerRef.current = window.setInterval(() => {
      performIdleActionRef.current().catch(() => {});
    }, 22_000);
    // 启动时的一次性动作：要随 effect 一起清理，且不带 force（尊重暂停、免打扰与“刚被碰过”的保护）。
    const startupWander = window.setTimeout(() => {
      wanderRef.current().catch(() => {});
    }, 1800);
    const startupIdle = window.setTimeout(() => {
      performIdleActionRef.current().catch(() => {});
    }, 5200);

    return () => {
      if (roamTimerRef.current) window.clearInterval(roamTimerRef.current);
      if (attentionTimerRef.current) window.clearInterval(attentionTimerRef.current);
      if (idleActionTimerRef.current) window.clearInterval(idleActionTimerRef.current);
      window.clearTimeout(startupWander);
      window.clearTimeout(startupIdle);
    };
  }, [autoAction, interactionFrequency]);

  useEffect(() => {
    if (emotion === "thinking") {
      setPetState("thinking");
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
    showVitalsBriefly();
    setMenuPos({ x: event.clientX, y: event.clientY });
    setShowMenu((value) => !value);
  }, [markHumanTouch, pauseMotion]);

  const handlePointerDown = useCallback(async (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    markHumanTouch();
    pauseMotion(1600);
    setShowMenu(false);
    const drag = {
      pointerStart: { x: event.screenX, y: event.screenY },
      windowStart: { x: 0, y: 0 },
      moved: false,
      nativeStarted: false,
    };
    dragRef.current = drag;
    try {
      const pos = await getCurrentWindow().outerPosition();
      drag.windowStart = { x: pos.x, y: pos.y };
    } catch {
      // Browser dev fallback.
    }
  }, [markHumanTouch, pauseMotion]);

  useEffect(() => {
    const onPointerMove = async (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!(event.buttons & 1)) {
        // 松手事件被系统拖拽循环吞掉时，这里兜底结束拖拽状态。
        dragRef.current = null;
        setIsDragging(false);
        return;
      }
      const dx = event.screenX - drag.pointerStart.x;
      const dy = event.screenY - drag.pointerStart.y;
      if (Math.abs(dx) + Math.abs(dy) < 6) return;

      drag.moved = true;
      setIsDragging(true);
      setPetState("walk");
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
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [resetToDefaultState, snapInsideWorkArea]);

  const handlePetClick = useCallback(() => {
    if (isDragging || dragRef.current?.moved) return;
    markHumanTouch();
    pauseMotion(2200);
    showVitalsBriefly();
    setShowMenu(false);
    const interaction = Math.random() < 0.45 ? getInteractionByType("tip") : getInteractionByType("joke");
    adjustLife({ affection: 3, energy: -0.5, curiosity: -1 });
    speak(`${interaction.emoji} ${interaction.message}`);
  }, [adjustLife, isDragging, markHumanTouch, pauseMotion, speak]);

  const cycleAvatar = useCallback(async () => {
    const options = [...(await loadCustomAvatars()), ...BUILTIN_AVATARS];
    const index = options.findIndex((option) => option.value === avatar);
    const next = options[(index + 1) % options.length];
    setAvatar(next.value);
    setPetState("wave");
    speak(`换成「${next.label}」啦~`, 4000, "wave");
  }, [avatar, setAvatar, speak]);

  const feedPet = useCallback(() => {
    markHumanTouch();
    pauseMotion(2800);
    adjustLife({ energy: 18, affection: 2, curiosity: -1 });
    setPetState("excited");
    speak("谢谢你，我补到能量了。", 4200);
    window.setTimeout(resetToDefaultState, 2600);
  }, [adjustLife, markHumanTouch, pauseMotion, resetToDefaultState, speak]);

  const trainPet = useCallback(() => {
    markHumanTouch();
    pauseMotion(3200);
    adjustLife({ curiosity: 10, energy: -7, affection: 1 });
    setPetState("thinking");
    speak("我记住了一点新东西。", 4200);
    window.setTimeout(resetToDefaultState, 3000);
  }, [adjustLife, markHumanTouch, pauseMotion, resetToDefaultState, speak]);

  const playWithPet = useCallback(() => {
    markHumanTouch();
    pauseMotion(2800);
    adjustLife({ affection: 4, energy: -4, curiosity: 1 });
    setPetState("dance");
    speak("再来一次，我喜欢这个。", 4200);
    window.setTimeout(resetToDefaultState, 2800);
  }, [adjustLife, markHumanTouch, pauseMotion, resetToDefaultState, speak]);

  const broadcastTodayNews = useCallback(async () => {
    setPetState("thinking");
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
          speak(formatNewsBubble(item, index, queue.length), 9000, "wave");
        }, index * 1800);
      });
    } catch {
      speak("新闻源今天有点不给力，我没有拉取成功。");
    }
  }, [addMessage, speak]);

  const closeBubble = useCallback(() => setBubbleMessage(null), []);

  const handlePetPointerEnter = useCallback(() => {
    hoverPetRef.current = true;
    showVitalsBriefly(4000);
    pauseMotion(3200);
  }, [pauseMotion]);

  const handlePetPointerLeave = useCallback(() => {
    hoverPetRef.current = false;
    pauseMotion(700);
  }, [pauseMotion]);

  const menuLeft = Math.max(8, Math.min(menuPos.x, (showMiniChat ? CHAT_SIZE.width : PET_SIZE.width) - 164));
  const menuTop = Math.max(8, Math.min(menuPos.y, (showMiniChat ? CHAT_SIZE.height : PET_SIZE.height) - 286));
  const recentMessages = messages.slice(-8);
  const lifeMood =
    life.energy < 25 ? "想休息" : life.affection > 75 ? "很亲近" : life.curiosity > 80 ? "想探索" : "陪伴中";

  return (
    <div className={`pet-window ${themeClass} relative h-screen w-screen select-none overflow-hidden`} onContextMenu={handleContextMenu}>
      {offer && !showMiniChat && (
        <div className="offer-card absolute left-4 right-4 top-4 z-40 rounded-2xl border border-line bg-surface/95 px-4 py-3 text-fg shadow-xl backdrop-blur pointer-events-auto">
          <div className="mb-1 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-fg">{offer.title}</div>
            <div className="text-[11px] text-fg-muted">主动提议</div>
          </div>
          <div className="text-xs leading-relaxed text-fg/85">{offer.message}</div>
          <div className="mt-2.5 flex justify-end gap-2">
            {offer.accept.type !== "none" && (
              <button
                className="rounded-lg border border-line px-3 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
                onClick={declineOffer}
              >
                {offer.declineLabel || "不用了"}
              </button>
            )}
            <button
              className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-fg transition-opacity hover:opacity-90"
              onClick={acceptOffer}
            >
              {offer.acceptLabel || "好呀"}
            </button>
          </div>
        </div>
      )}

      {!showMiniChat && bubbleMessage && !offer && (
        <PetBubble
          message={bubbleMessage}
          isVisible={true}
          onClose={closeBubble}
          onOpen={openMiniChat}
          autoClose={7200}
        />
      )}

      {newsBanner && !showMiniChat && (
        <button
          className="absolute left-4 right-4 top-4 z-40 rounded-2xl border border-line bg-surface/95 text-fg px-4 py-3 text-left shadow-xl backdrop-blur pointer-events-auto"
          onClick={openMiniChat}
          onDoubleClick={() => showMainWindow("chat")}
          title="双击打开完整聊天"
        >
          <div className="mb-1 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-fg">{newsBanner.title}</div>
            <div className="text-[11px] text-fg-muted">主动播报</div>
          </div>
          <div className="space-y-1 text-xs text-fg/80">
            {newsBanner.items.map((item, index) => (
              <div key={`${newsBanner.title}-${index}`} className="line-clamp-1">
                {index + 1}. {item}
              </div>
            ))}
          </div>
        </button>
      )}

      {routineBanner && !showMiniChat && (
        <button
          className="absolute left-4 right-4 top-[116px] z-40 rounded-2xl border border-line bg-surface/95 text-fg px-4 py-3 text-left shadow-xl backdrop-blur pointer-events-auto"
          onClick={openMiniChat}
          onDoubleClick={() => showMainWindow("chat")}
          title="双击打开完整聊天"
        >
          <div className="mb-1 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-fg">{routineBanner.title}</div>
            <div className="text-[11px] text-fg-muted">{routineBanner.subtitle}</div>
          </div>
          <div className="space-y-1 text-xs text-fg/80">
            {routineBanner.items.map((item, index) => (
              <div key={`${routineBanner.title}-${index}`} className="line-clamp-1">
                {index + 1}. {item}
              </div>
            ))}
          </div>
        </button>
      )}

      {!showMiniChat && showVitals && (
        <div className="absolute bottom-3 left-3 z-20 w-32 rounded-xl border border-line bg-surface/90 p-2 text-[11px] text-fg shadow-lg backdrop-blur pointer-events-none transition-opacity duration-200">
          <div className="mb-1 font-semibold">{lifeMood}</div>
          <LifeBar label="精力" value={life.energy} color="bg-emerald-400" />
          <LifeBar label="亲密" value={life.affection} color="bg-pink-400" />
          <LifeBar label="好奇" value={life.curiosity} color="bg-sky-400" />
        </div>
      )}

      {showMiniChat && (
        <div className="mini-chat-window absolute left-4 right-4 top-4 z-30 rounded-2xl border border-line bg-surface/95 text-fg p-3 shadow-2xl pointer-events-auto">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-fg">和{petName}聊天</div>
            <button className="text-xs text-fg-muted hover:text-fg" onClick={closeMiniChat}>
              收起
            </button>
          </div>
          <div ref={miniChatListRef} className="mini-chat-list h-60 space-y-2 overflow-y-auto rounded-xl bg-app p-2">
            {recentMessages.length === 0 && <div className="text-sm text-fg-muted">直接输入就能聊天。</div>}
            {recentMessages.map((message) => (
              <div
                key={message.id}
                className={`text-sm ${message.role === "user" ? "text-right" : "text-left"}`}
                onDoubleClick={() => showMainWindow("chat")}
                title="双击打开完整聊天"
              >
                {message.role === "user" ? (
                  <span className="mini-chat-user inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-3 py-2 text-left text-primary-fg">
                    {message.content}
                  </span>
                ) : (
                  <div className="mini-chat-assistant pet-bubble-markdown inline-block max-w-[92%] break-words rounded-2xl bg-surface px-3 py-2 text-left text-fg shadow-sm">
                    <Suspense fallback={<div className="whitespace-pre-wrap">{message.content}</div>}>
                      <MarkdownContent content={message.content} compact />
                    </Suspense>
                  </div>
                )}
              </div>
            ))}
            {isStreaming && (
              <div className="text-left text-sm">
                <div className="mini-chat-assistant pet-bubble-markdown inline-block max-w-[92%] break-words rounded-2xl bg-surface px-3 py-2 text-left text-fg shadow-sm">
                  {streamText ? (
                    <Suspense fallback={<div className="whitespace-pre-wrap">{streamText}</div>}>
                      <MarkdownContent content={streamText} compact />
                    </Suspense>
                  ) : (
                    <span className="text-fg-muted">正在思考…</span>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className="mini-chat-input min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-primary"
              value={miniInput}
              onChange={(event) => setMiniInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") sendMiniMessage();
              }}
              placeholder={`问问${petName}…`}
            />
            <button
              className="rounded-xl bg-primary px-3 py-2 text-sm font-bold text-primary-fg disabled:opacity-50"
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
        {avatarInfo.kind === "rigged" && avatarInfo.model ? (
          <Suspense fallback={<div className="h-28 w-28 rounded-full bg-primary/30 shadow-lg" />}>
            <RiggedPet3D model={avatarInfo.model} state={petState} facing={facing} size={petSize || SPRITE_SIZE} />
          </Suspense>
        ) : (
          <Suspense fallback={<div className="h-28 w-28 rounded-full bg-primary/30 shadow-lg" />}>
            <Pikachu3D state={petState} facing={facing} size={petSize || SPRITE_SIZE} />
          </Suspense>
        )}

        {statusText && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 rounded-full bg-surface/90 px-2.5 py-0.5 text-xs text-fg-muted shadow-sm backdrop-blur pointer-events-none">
            {statusText}
          </div>
        )}
      </div>

      {showMenu && (
        <div
          className="absolute z-50 min-w-[156px] overflow-y-auto rounded-xl border border-line bg-surface/95 py-1 shadow-2xl backdrop-blur pointer-events-auto"
          style={{ left: menuLeft, top: menuTop, maxHeight: `calc(100vh - ${menuTop + 8}px)` }}
        >
          <MenuItem label="聊天" onClick={() => { setShowMenu(false); openMiniChat(); }} />
          <MenuItem label="打开工作台" onClick={() => { setShowMenu(false); showMainWindow("chat"); }} />
          <MenuItem label="切换形态" onClick={() => { setShowMenu(false); cycleAvatar(); }} />
          <MenuItem label="自己逛逛" onClick={() => { setShowMenu(false); wander(true); }} />
          <MenuItem label="靠近鼠标" onClick={() => { setShowMenu(false); reactToCursor(true); }} />
          <MenuItem label="坐下" onClick={() => { setShowMenu(false); setPetState("sit"); window.setTimeout(resetToDefaultState, 3600); }} />
          <MenuItem label="睡觉" onClick={() => { setShowMenu(false); setPetState("sleep"); window.setTimeout(resetToDefaultState, 7000); }} />
          <MenuItem label="开心跳" onClick={() => { setShowMenu(false); setPetState("excited"); speak("收到，我精神起来了。"); }} />
          <MenuItem label="跳个舞" onClick={() => { setShowMenu(false); setPetState("dance"); window.setTimeout(resetToDefaultState, 3200); }} />
          <MenuItem label="伸懒腰" onClick={() => { setShowMenu(false); setPetState("stretch"); window.setTimeout(resetToDefaultState, 2800); }} />
          <MenuItem label="喂食" onClick={() => { setShowMenu(false); feedPet(); }} />
          <MenuItem label="训练" onClick={() => { setShowMenu(false); trainPet(); }} />
          <MenuItem label="陪玩" onClick={() => { setShowMenu(false); playWithPet(); }} />
          <MenuItem label="今日新闻" onClick={() => { setShowMenu(false); broadcastTodayNews(); }} />
          <MenuItem label="说句话" onClick={() => { setShowMenu(false); triggerRandomInteraction(true); }} />
          <MenuItem label="摸摸头" onClick={() => { setShowMenu(false); speak("皮卡皮卡~ 好舒服，我会更努力陪你。"); }} />
          <div className="my-1 border-t border-line" />
          <MenuItem label="设置" onClick={() => { setShowMenu(false); showMainWindow("settings"); }} />
        </div>
      )}
    </div>
  );
}

function LifeBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="mb-1 last:mb-0">
      <div className="mb-0.5 flex justify-between">
        <span>{label}</span>
        <span>{Math.round(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <div className={`h-full ${color}`} style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-fg transition-colors hover:bg-surface-2"
      onClick={onClick}
    >
      <span>{label}</span>
    </button>
  );
}
