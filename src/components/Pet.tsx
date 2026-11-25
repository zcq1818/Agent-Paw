import { Suspense, lazy, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { BUILTIN_AVATARS, describeAvatar, loadCustomAvatars, useCustomAvatarsLoaded } from "../store/petAvatars";
import { bubbleText } from "../utils/bubbleText";
import { usePetStore } from "../store/pet";
import { useChatStore } from "../store/chat";
import { useAgentStore } from "../store/agent";
import { useThemeClass } from "../store/theme";
import { useActivityMonitor, useActivityStore, checkAndDeliverYesterdaySummary } from "../store/activity";
import { usePetProactivity } from "../agent/proactivity";
import { chatterAvailable, fetchHotTopics, generateChatter, type ChatterKind } from "../agent/chatter";
import { jobProgress, reportHeadline, useJobRunner, useJobStore, type Job } from "../agent/jobs";
import { useCnbWatcher } from "../agent/cnb";
import { useWorkerMode } from "../agent/worker";
import { PET_COMMAND_EVENT, type PetCommandPayload } from "../agent/selfControl";
import { BOND_GAIN_EVENT, levelInfo, unlocksAtLevel, useBondStore, type BondSource, type GainResult } from "../agent/bond";
import { applyTimelineConfig } from "../agent/timeline";
import { useAutomationRunner, useAutomationStore } from "../agent/automations";
import { recordOfferFeedback, useInitiative, type Offer } from "../agent/initiative";
import { fetchTodayNews, formatNewsBubble, formatNewsMarkdown } from "../agent/news";
import { getInteractionByType, getRandomInteraction, getTimeBasedGreeting } from "../utils/petInteractions";
import { toolActionLabel, type ToolRun } from "../agent/toolEvents";
import { HOTKEY_EVENT } from "../store/shortcut";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { describePaths, type DroppedFile } from "../agent/documents";
import { muteHint, useAppHints, useDailyWrap, useGrowthStore, buildDailyWrap, wrapPrompt, todayFocusMinutes, dayKey, type AppHint, type DailyWrap } from "../agent/petLife";
import { DropCard, FocusBadge, GrowthMenuHeader, HintCard, UpdateCard, WrapCard, type DropChoice } from "./PetCards";
import { installUpdate, skipVersion, useUpdateCheck, type UpdateInfo } from "../agent/updater";
import { useBotStore, type BotRole } from "../store/bots";
import { loadConfig } from "../agent/kernel";

type PetState = "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking" | "morning" | "night" | "dance" | "stretch" | "look" | "wave";
type Facing = "left" | "right";

type WorkArea = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

const PET_SIZE = { width: 340, height: 340 };
/** 聊天框的窗口大小可以拖角调整，记在本机；这里是默认值和下限。 */
const CHAT_SIZE_KEY = "paw_mini_chat_size";
const DEFAULT_CHAT_SIZE = { width: 460, height: 640 };
const MIN_CHAT_SIZE = { width: 360, height: 460 };

function loadChatSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_SIZE_KEY) || "null");
    if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
      return {
        width: Math.max(MIN_CHAT_SIZE.width, Math.round(saved.width)),
        height: Math.max(MIN_CHAT_SIZE.height, Math.round(saved.height)),
      };
    }
  } catch {}
  return { ...DEFAULT_CHAT_SIZE };
}

/** 当前聊天框尺寸（逻辑像素）。模块级变量，窗口缩放、贴边计算和渲染都读它。 */
let chatSize = loadChatSize();

function applyChatSize(size: { width: number; height: number }) {
  chatSize = {
    width: Math.max(MIN_CHAT_SIZE.width, Math.round(size.width)),
    height: Math.max(MIN_CHAT_SIZE.height, Math.round(size.height)),
  };
  return chatSize;
}

function saveChatSize() {
  try {
    localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify(chatSize));
  } catch {}
}

type ResizeCorner = "nw" | "se";
const SPRITE_SIZE = 128;
const EDGE_PADDING = 14;
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

/** 小聊天框里正在生成的那条回复：没出字时跳动的点 + 当前在做什么；出字后带闪烁光标。 */
function MiniStreamingReply({ text, runs }: { text: string; runs: ToolRun[] }) {
  const pending = runs.find((run) => run.status === "pending");
  const running = [...runs].reverse().find((run) => run.status === "running");
  const finished = runs.filter((run) => run.status === "done" || run.status === "error");
  const status = pending
    ? "等你确认…"
    : running
      ? `正在${toolActionLabel(running.name)}…`
      : finished.length
        ? "整理结果…"
        : "正在思考…";

  return (
    <div className="mini-chat-reply fade-in text-left text-sm">
      {runs.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {runs.slice(-4).map((run) => (
            <span
              key={run.id}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-fg-muted"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  run.status === "done"
                    ? "bg-success"
                    : run.status === "error"
                      ? "bg-danger"
                      : run.status === "pending"
                        ? "animate-pulse bg-accent"
                        : "animate-pulse bg-primary"
                }`}
              />
              {run.name === "审批"
                ? run.status === "pending"
                  ? "等你确认"
                  : run.status === "done"
                    ? "已确认"
                    : "没确认"
                : toolActionLabel(run.name)}
            </span>
          ))}
        </div>
      )}
      <div
        className={`mini-chat-assistant pet-bubble-markdown inline-block max-w-[92%] break-words rounded-2xl bg-surface px-3 py-2 text-left text-fg shadow-sm ${
          text ? "mini-streaming" : ""
        }`}
      >
        {text ? (
          <Suspense fallback={<div className="whitespace-pre-wrap">{text}</div>}>
            <MarkdownContent content={text} compact />
          </Suspense>
        ) : (
          <span className="flex items-center gap-2 text-fg-muted">
            <span className="typing-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="text-xs">{status}</span>
          </span>
        )}
      </div>
      {text && (running || pending) && <div className="mt-1 text-[11px] text-fg-muted">{status}</div>}
    </div>
  );
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

async function showMainWindow(view: "chat" | "settings" | "jobs") {
  try {
    if (view === "jobs") await emit("open-view", { view: "jobs" });
    else await emit(view === "chat" ? "open-chat" : "open-settings");
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
    const size = expanded ? chatSize : PET_SIZE;
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
  const [chatSizeState, setChatSizeState] = useState(chatSize);
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
  const [dropFiles, setDropFiles] = useState<DroppedFile[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [wrap, setWrap] = useState<DailyWrap | null>(null);
  const [hint, setHint] = useState<AppHint | null>(null);
  const focus = useGrowthStore((state) => state.focus);
  const growthDays = useGrowthStore((state) => state.days);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState("");
  const cardOpenRef = useRef(false);
  cardOpenRef.current = Boolean(dropFiles || wrap || hint || update);
  const focusRef = useRef(focus);
  focusRef.current = focus;

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
  useCustomAvatarsLoaded();
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
  const currentToolRuns = useAgentStore((state) => state.currentToolRuns);
  const recordTyping = useActivityStore((state) => state.recordTyping);

  const pauseMotion = useCallback((ms = 1800) => {
    pauseMotionUntilRef.current = Math.max(pauseMotionUntilRef.current, Date.now() + ms);
  }, []);

  const markHumanTouch = useCallback(() => {
    lastHumanTouchRef.current = Date.now();
    pauseMotion(1800);
  }, [pauseMotion]);

  // 有任何弹出的东西（菜单、聊天框、气泡、播报、提议、卡片）时桌宠不走动，不然窗口会被带着跑。
  // 用 ref：走动循环里每一步都要看到最新状态（走到一半打开聊天框也要立刻停）。
  const popupOpenRef = useRef(false);
  popupOpenRef.current = Boolean(
    showMenu || showMiniChat || bubbleMessage || newsBanner || routineBanner || offer || dropFiles || wrap || hint || update
  );

  const shouldPauseMotion = useCallback(() => {
    return (
      popupOpenRef.current ||
      hoverPetRef.current ||
      chatActiveRef.current ||
      Date.now() < pauseMotionUntilRef.current ||
      isDragging ||
      showMenu ||
      showMiniChat ||
      isStreaming ||
      Boolean(focusRef.current) ||
      cardOpenRef.current ||
      isQuietNow(quietHoursEnabled, quietStart, quietEnd)
    );
  }, [isDragging, isStreaming, quietEnd, quietHoursEnabled, quietStart, showMenu, showMiniChat]);
  const shouldPauseMotionRef = useRef(shouldPauseMotion);
  shouldPauseMotionRef.current = shouldPauseMotion;

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

  /** 加成长经验；升级时跳个舞、告诉你解锁了什么 */
  const gainBond = useCallback(
    (source: BondSource, amount?: number): GainResult => {
      const result = useBondStore.getState().gain(source, amount);
      if (result.leveledUp) {
        const info = levelInfo(useBondStore.getState().xp);
        // 称号已经在前半句说了，解锁列表里不再重复
        const unlocks = unlocksAtLevel(result.level).filter((item) => !item.startsWith("称号"));
        const line = `升级啦！现在是 Lv${result.level}「${info.title}」${unlocks.length ? `，解锁了${unlocks.join("、")}` : ""}。谢谢你一直陪着我～`;
        window.setTimeout(() => {
          speak(`🎉 ${line}`, 9000, "dance");
          addMessage({ role: "assistant", content: `## 🎉 升到 Lv${result.level} 啦\n\n${line}\n\n右键我可以看成长进度。` });
        }, 600);
      }
      return result;
    },
    [addMessage, speak]
  );
  const gainBondRef = useRef(gainBond);
  gainBondRef.current = gainBond;

  // 成长：每天第一次见面签到；有人在电脑前就算陪伴时间；别的窗口发消息也记聊天经验
  useEffect(() => {
    const checkIn = window.setTimeout(() => {
      const checked = useBondStore.getState().checkIn();
      if (!checked) return;
      const result = gainBondRef.current("signin", checked.bonus);
      if (checked.streak > 1 && !result.leveledUp) {
        speakRef.current(`连续第 ${checked.streak} 天见面啦，签到成长 +${result.gained}，今天也一起加油！`, 6000);
      }
    }, 6000);
    const presence = window.setInterval(async () => {
      try {
        const idle = await invoke<number>("user_idle_seconds");
        if (idle < 300 && !isQuietNow(quietHoursEnabled, quietStart, quietEnd)) gainBondRef.current("presence");
      } catch {
        // 浏览器预览
      }
    }, 5 * 60_000);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<{ source?: BondSource; amount?: number }>(BOND_GAIN_EVENT, (event) => {
      const source = event.payload?.source;
      if (source) gainBondRef.current(source, event.payload?.amount);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      window.clearTimeout(checkIn);
      window.clearInterval(presence);
      unlisten?.();
    };
  }, [quietEnd, quietHoursEnabled, quietStart]);

  // CNB 协作：每分钟跟进 NPC 开的 PR，开出来就自动审核
  useCnbWatcher();

  // 员工模式：开了就经 MCP 去勾上的系统领活，领到的变成「工作」排队干，干完交回去（见 agent/worker.ts）
  useWorkerMode();

  // 工作任务：在桌宠窗口里排队执行，开工和干完都说一声
  useJobRunner({
    onStart: (job: Job) => {
      speakRef.current(`开工：${job.title}。我在后台干，你忙你的。`, 4500, "thinking");
    },
    onFinish: (job: Job) => {
      if (job.status === "done") {
        const headline = reportHeadline(job.report);
        addMessage({
          role: "assistant",
          content: `## ✅ 活干完了：${job.title}\n\n${headline || "报告写好了。"}\n\n完整的工作日志和报告在工作台 →「工作」。`,
        });
        speakRef.current(`活干完了：${job.title}。${headline ? headline.slice(0, 40) : ""}`, 9000, "dance");
        gainBondRef.current("interact", 2);
      } else {
        addMessage({ role: "assistant", content: `## ⚠️ 没干完：${job.title}\n\n${job.error || "中途出错了"}\n\n工作日志在工作台 →「工作」。` });
        speakRef.current(`「${job.title}」没干完：${(job.error || "中途出错了").slice(0, 40)}`, 8000, "look");
      }
    },
  });
  const runningJob = useJobStore((state) => state.jobs.find((job) => job.status === "running"));

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
    interactionFrequency,
  });

  const moveTo = useCallback(
    async (target: { x: number; y: number }, reason: "wander" | "cursor" | "edge" = "wander", force = false) => {
      // 贴边（edge）是把窗口挪回屏幕内，弹框开着也要做；其它走动有弹框就不走
      const blocked = () => (reason !== "edge" && popupOpenRef.current) || (!force && shouldPauseMotionRef.current());
      if (movingRef.current || blocked()) return false;
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
          if (dragRef.current || blocked()) break;
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
    // 刚说过话就别再插一句；模型能用时主要靠它现编的搭话，写死的提醒偶尔说一句就好。
    if (!force && Date.now() - lastSpokenRef.current < 3 * 60_000) return;
    if (!force && chatterAvailable() && Math.random() < 0.85) return;
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
    setShowMiniChat(true);
    setShowMenu(false);
    setBubbleMessage(null);
    resizePetWindow(true).then(async () => {
      try {
        const appWindow = getCurrentWindow();
        const [work, pos] = await Promise.all([getActiveWorkArea(), appWindow.outerPosition()]);
        // 屏幕放不下就先缩小，再挪回屏幕内
        const scale = scaleFactor();
        const maxW = Math.floor(work.size.width / scale) - EDGE_PADDING * 2;
        const maxH = Math.floor(work.size.height / scale) - EDGE_PADDING * 2;
        if (chatSize.width > maxW || chatSize.height > maxH) {
          setChatSizeState(applyChatSize({ width: Math.min(chatSize.width, maxW), height: Math.min(chatSize.height, maxH) }));
          await appWindow.setSize(new LogicalSize(chatSize.width, chatSize.height));
        }
        const safe = clampToWorkArea(pos, work, chatSize);
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

  // 聊天框开着时点了别的地方（桌宠窗口失去焦点）就自动收起；回复没写完也没关系，写完会用气泡告诉你。
  useEffect(() => {
    if (!showMiniChat) return;
    const openedAt = Date.now();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          // 刚打开时窗口还在调整大小，焦点可能抖一下；拖角改大小时也别收
          if (focused || Date.now() - openedAt < 800 || resizeRef.current) return;
          closeMiniChat();
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Browser dev fallback.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showMiniChat, closeMiniChat]);

  // ── 拖角调整聊天框大小 ──
  // 宠物窗口本身不可缩放（透明无边框），这里自己算：按住角上的把手拖动，按鼠标位移改窗口大小；
  // 拖左上角时窗口右下角不动（同时挪位置）。指针捕获保证鼠标拖出窗口外也能继续。
  const resizeRef = useRef<{
    corner: ResizeCorner;
    startX: number;
    startY: number;
    startSize: { width: number; height: number };
    startPos: { x: number; y: number } | null;
    work: WorkArea | null;
    target: { width: number; height: number } | null;
    busy: boolean;
  } | null>(null);
  const [resizing, setResizing] = useState(false);

  const applyResize = useCallback(async () => {
    const state = resizeRef.current;
    if (!state || state.busy || !state.target) return;
    state.busy = true;
    const target = state.target;
    state.target = null;
    try {
      const appWindow = getCurrentWindow();
      const size = applyChatSize(target);
      if (state.corner === "nw" && state.startPos) {
        const scale = scaleFactor();
        await appWindow.setPosition(
          new PhysicalPosition(
            Math.round(state.startPos.x + (state.startSize.width - size.width) * scale),
            Math.round(state.startPos.y + (state.startSize.height - size.height) * scale)
          )
        );
      }
      await appWindow.setSize(new LogicalSize(size.width, size.height));
      setChatSizeState(size);
    } catch {
      // Browser dev fallback.
    } finally {
      state.busy = false;
      if (state.target) requestAnimationFrame(() => applyResize());
    }
  }, []);

  const startResize = useCallback(
    (corner: ResizeCorner) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      pauseMotion(5000);
      const state = {
        corner,
        startX: event.screenX,
        startY: event.screenY,
        startSize: { ...chatSize },
        startPos: null as { x: number; y: number } | null,
        work: null as WorkArea | null,
        target: null,
        busy: false,
      };
      resizeRef.current = state;
      setResizing(true);
      Promise.all([getCurrentWindow().outerPosition(), getActiveWorkArea()])
        .then(([pos, work]) => {
          state.startPos = { x: pos.x, y: pos.y };
          state.work = work;
        })
        .catch(() => {});
    },
    [pauseMotion]
  );

  const moveResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeRef.current;
      if (!state) return;
      pauseMotion(1500);
      const dx = event.screenX - state.startX;
      const dy = event.screenY - state.startY;
      let width = state.corner === "se" ? state.startSize.width + dx : state.startSize.width - dx;
      let height = state.corner === "se" ? state.startSize.height + dy : state.startSize.height - dy;
      // 不超出屏幕工作区
      if (state.work && state.startPos) {
        const scale = scaleFactor();
        const pad = EDGE_PADDING;
        const left = state.work.position.x / scale;
        const top = state.work.position.y / scale;
        const right = (state.work.position.x + state.work.size.width) / scale;
        const bottom = (state.work.position.y + state.work.size.height) / scale;
        const winLeft = state.startPos.x / scale;
        const winTop = state.startPos.y / scale;
        if (state.corner === "se") {
          width = Math.min(width, right - pad - winLeft);
          height = Math.min(height, bottom - pad - winTop);
        } else {
          width = Math.min(width, winLeft + state.startSize.width - left - pad);
          height = Math.min(height, winTop + state.startSize.height - top - pad);
        }
      }
      state.target = {
        width: Math.max(MIN_CHAT_SIZE.width, width),
        height: Math.max(MIN_CHAT_SIZE.height, height),
      };
      requestAnimationFrame(() => applyResize());
    },
    [applyResize, pauseMotion]
  );

  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    const finish = () => {
      if (resizeRef.current?.busy || resizeRef.current?.target) {
        window.setTimeout(finish, 30);
        return;
      }
      resizeRef.current = null;
      setResizing(false);
      saveChatSize();
    };
    finish();
  }, []);

  /** 双击把手：恢复默认大小。 */
  const resetChatSize = useCallback(async () => {
    applyChatSize(DEFAULT_CHAT_SIZE);
    saveChatSize();
    setChatSizeState(chatSize);
    await resizePetWindow(true);
    try {
      const appWindow = getCurrentWindow();
      const [work, pos] = await Promise.all([getActiveWorkArea(), appWindow.outerPosition()]);
      const safe = clampToWorkArea(pos, work, chatSize);
      if (safe.x !== pos.x || safe.y !== pos.y) await appWindow.setPosition(new PhysicalPosition(safe.x, safe.y));
    } catch {}
  }, []);

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
    report: (markdown) => addMessage({ role: "assistant", content: markdown }),
  });

  useInitiative({
    enabled: true,
    isBusy: () =>
      showMiniChat ||
      isDragging ||
      showMenu ||
      Boolean(focusRef.current) ||
      cardOpenRef.current ||
      useAgentStore.getState().isStreaming ||
      isQuietNow(quietHoursEnabled, quietStart, quietEnd),
    hasOffer: () => Boolean(offerRef.current),
    showOffer: (next) => {
      setBubbleMessage(null);
      setOffer(next);
      // 提醒休息时它自己先伸个懒腰
      setPetState(next.kind === "break" ? "stretch" : "wave");
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

  // ───────── 拖文件给宠物 ─────────
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWebview()
        .onDragDropEvent(async (event) => {
          const payload = event.payload;
          if (payload.type === "enter") {
            setDragOver(true);
            setPetState("excited");
            setStatusText("放这儿～");
          } else if (payload.type === "leave") {
            setDragOver(false);
            setStatusText(null);
            setPetState(defaultStateForTime(usePetStore.getState().timeOfDay));
          } else if (payload.type === "drop") {
            setDragOver(false);
            setStatusText(null);
            markHumanTouch();
            const paths = payload.paths || [];
            if (!paths.length) return;
            const files = await describePaths(paths).catch(() => []);
            if (!files.length) return;
            setOffer(null);
            setHint(null);
            setBubbleMessage(null);
            setDropFiles(files);
            setPetState("wave");
            window.setTimeout(() => setPetState(defaultStateForTime(usePetStore.getState().timeOfDay)), 2400);
          }
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // 浏览器预览没有 Tauri
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [markHumanTouch]);

  /** 切到团队里某个角色的成员（没有这个角色就留在当前成员） */
  const switchToRole = useCallback(async (role?: BotRole) => {
    if (!role) return undefined;
    const store = useBotStore.getState();
    const bot = store.bots.find((item) => item.role === role && !item.archived);
    if (!bot) return undefined;
    if (store.activeBotId !== bot.id) {
      store.switchBot(bot.id);
      // 等会话分区切过去，消息才会写进它自己的会话
      await wait(350);
    }
    return bot;
  }, []);

  const runDropChoice = useCallback(
    async (prompt: string, role?: BotRole) => {
      setDropFiles(null);
      await switchToRole(role);
      openMiniChat();
      await runPrompt(prompt);
    },
    [openMiniChat, runPrompt, switchToRole]
  );

  // ───────── 下班小结 ─────────
  useDailyWrap({
    isBusy: () => showMiniChat || isDragging || showMenu || Boolean(focusRef.current) || cardOpenRef.current || Boolean(offerRef.current) || useAgentStore.getState().isStreaming,
    show: (next) => {
      setBubbleMessage(null);
      setWrap(next);
      setPetState("stretch");
      window.setTimeout(resetToDefaultState, 2800);
    },
  });

  const showWrapNow = useCallback(async () => {
    setOffer(null);
    setHint(null);
    setWrap(await buildDailyWrap());
    localStorage.setItem("paw_daily_wrap_shown", dayKey());
    setPetState("stretch");
    window.setTimeout(resetToDefaultState, 2800);
  }, [resetToDefaultState]);

  const runWrap = useCallback(
    async (target: "report" | "slack" | "jira") => {
      setWrap(null);
      openMiniChat();
      await runPrompt(wrapPrompt(target));
    },
    [openMiniChat, runPrompt]
  );

  // ───────── 按打开的软件搭话 ─────────
  useAppHints({
    isBusy: () =>
      showMiniChat ||
      isDragging ||
      showMenu ||
      Boolean(focusRef.current) ||
      cardOpenRef.current ||
      Boolean(offerRef.current) ||
      useAgentStore.getState().isStreaming ||
      isQuietNow(quietHoursEnabled, quietStart, quietEnd),
    show: (next) => {
      setBubbleMessage(null);
      setHint(next);
      setPetState("look");
      window.setTimeout(resetToDefaultState, 2400);
    },
  });

  const closeHint = useCallback(() => setHint(null), []);

  // 新版本：后台检查，有就弹卡片
  useUpdateCheck((info) => {
    setUpdateError("");
    setUpdateProgress(null);
    setUpdate(info);
  });

  const runUpdate = useCallback(async () => {
    if (!update) return;
    setUpdateError("");
    setUpdateProgress(0);
    try {
      await installUpdate(update, setUpdateProgress);
    } catch (error) {
      setUpdateProgress(null);
      setUpdateError(`更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [update]);

  const acceptHint = useCallback(async () => {
    const current = hint;
    if (!current) return;
    setHint(null);
    markHumanTouch();
    if (current.action.type === "prompt") {
      openMiniChat();
      await runPrompt(current.action.prompt);
      return;
    }
    const bot = await switchToRole(current.action.role);
    openMiniChat();
    if (bot) addMessage({ role: "assistant", content: `我是${bot.name}，${bot.tagline || "随时待命"}。有事直接说～` });
  }, [addMessage, hint, markHumanTouch, openMiniChat, runPrompt, switchToRole]);

  // ───────── 专注陪伴 ─────────
  const startFocus = useCallback(
    (minutes: number) => {
      setShowMenu(false);
      useGrowthStore.getState().startFocus(minutes);
      setPetState("sit");
      speak(`好，陪你专注 ${minutes} 分钟。这段时间我不打扰你。`, 3800, "sit");
    },
    [speak]
  );

  useEffect(() => {
    if (!focus) return;
    setPetState("sit");
    const finish = () => {
      const result = useGrowthStore.getState().finishFocus();
      if (!result) return;
      setPetState("dance");
      const today = todayFocusMinutes();
      // 专注 1 分钟 +1 经验，再奖励 5 点；升级的话 gainBond 会自己庆祝
      const gained = gainBondRef.current("focus", result.minutes + 5);
      if (!gained.leveledUp) {
        speak(`专注 ${result.minutes} 分钟完成！成长 +${gained.gained}，今天一共专注 ${today} 分钟，起来活动 5 分钟吧。`, 7000, "dance");
      }
      window.setTimeout(resetToDefaultState, 4200);
    };
    const left = focus.endsAt - Date.now();
    if (left <= 0) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, left);
    return () => window.clearTimeout(timer);
  }, [focus, resetToDefaultState, speak]);

  const cancelFocus = useCallback(() => {
    useGrowthStore.getState().cancelFocus();
    speak("好，先停下。下次再一起专注。", 3200, "wave");
  }, [speak]);

  const sendMiniMessage = useCallback(async () => {
    const text = miniInput.trim();
    if (!text) return;
    markHumanTouch();
    pauseMotion(2500);
    setMiniInput("");
    recordTyping(text.length, "mini_chat");
    if (isStreaming) {
      // 运行中插话：不打断，模型下一步就能看到
      useAgentStore.getState().interject(text);
      return;
    }
    addMessage({ role: "user", content: text });
    setPetState("thinking");
    setEmotion("thinking");
    await sendMessage(text);
  }, [addMessage, isStreaming, markHumanTouch, miniInput, pauseMotion, recordTyping, sendMessage, setEmotion]);

  // 全局快捷键：shortcut.ts 已经把桌宠窗口显示并聚焦，这里负责打开聊天框 / 发消息 / 停止
  useEffect(() => {
    const focusInput = () =>
      window.setTimeout(() => document.querySelector<HTMLInputElement>(".mini-chat-input")?.focus(), 120);

    const ask = async (text: string) => {
      openMiniChat();
      focusInput();
      if (useAgentStore.getState().isStreaming) {
        useAgentStore.getState().interject(text);
        return;
      }
      addMessage({ role: "user", content: text });
      setPetState("thinking");
      setEmotion("thinking");
      await sendMessage(text);
    };

    const onHotkey = async (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      markHumanTouch();
      if (action === "stop") {
        if (useAgentStore.getState().isStreaming) {
          useAgentStore.getState().stopGeneration();
          speak("好，停下了。", 3000, "idle");
        }
        return;
      }
      if (action === "chat") {
        openMiniChat();
        focusInput();
        return;
      }
      if (action === "screen") {
        await ask("看一下我现在的屏幕：说说上面是什么，有没有需要我注意或者你能帮忙的地方。");
        return;
      }
      if (action === "clipboard") {
        let clip: { kind: string; text: string; files: string[] } = { kind: "empty", text: "", files: [] };
        try {
          clip = await invoke("clipboard_read");
        } catch {
          try {
            clip = { kind: "text", text: await navigator.clipboard.readText(), files: [] };
          } catch {}
        }
        if (clip.kind === "text" && clip.text.trim()) {
          const text = clip.text.trim();
          const fence = text.includes("```") ? "~~~" : "```";
          await ask(
            `帮我处理一下刚复制的内容：报错就分析原因和解决办法，外文就翻译成中文，长文就总结要点，其他情况判断我最可能想做什么。\n\n${fence}\n${text}\n${fence}`
          );
        } else if (clip.kind === "files" && clip.files.length) {
          await ask(`我刚复制了这些文件，帮我看看是什么、能怎么处理：\n${clip.files.map((file) => `- ${file}`).join("\n")}`);
        } else {
          speak(
            clip.kind === "private"
              ? "这段内容被标记为私密（比如密码），我就不看啦。"
              : clip.kind === "image"
                ? "剪贴板里是图片，可以截屏或发图片给我。"
                : "剪贴板是空的，先复制一段文字再按我～"
          );
        }
      }
    };

    window.addEventListener(HOTKEY_EVENT, onHotkey);

    // 启动器里搜不到软件、选了“问桌宠”：打开聊天框把这句话发出去
    let disposed = false;
    let unlistenAsk: (() => void) | undefined;
    listen<{ text?: string }>("launcher-ask", async (event) => {
      const text = event.payload?.text?.trim();
      if (!text) return;
      try {
        const appWindow = getCurrentWindow();
        if (!(await appWindow.isVisible())) await appWindow.show();
        await appWindow.setFocus();
      } catch {}
      await ask(text);
    })
      .then((fn) => (disposed ? fn() : (unlistenAsk = fn)))
      .catch(() => {});

    return () => {
      disposed = true;
      unlistenAsk?.();
      window.removeEventListener(HOTKEY_EVENT, onHotkey);
    };
  }, [addMessage, markHumanTouch, openMiniChat, sendMessage, setEmotion, speak]);

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
  }, [showMiniChat, messages.length, streamText, isStreaming, currentToolRuns.length]);

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
    setShowMenu(false);
    const interaction = Math.random() < 0.45 ? getInteractionByType("tip") : getInteractionByType("joke");
    adjustLife({ affection: 3, energy: -0.5, curiosity: -1 });
    gainBond("interact");
    speak(`${interaction.emoji} ${interaction.message}`);
  }, [adjustLife, gainBond, isDragging, markHumanTouch, pauseMotion, speak]);

  /** 右键菜单里的“讲个笑话 / 聊聊热搜”：马上让模型现编一条。 */
  const chatNow = useCallback(
    async (kind: ChatterKind) => {
      markHumanTouch();
      if (!chatterAvailable()) {
        speak("先在 设置 → 模型 里填好模型，我才能现编笑话和聊热搜哦。", 6000, "look");
        return;
      }
      speak(kind === "hot" ? "我去看看现在都在聊啥…" : "让我想想…", 3000, "thinking");
      const hot = kind === "hot" ? await fetchHotTopics() : [];
      if (kind === "hot" && hot.length === 0) {
        speak("热搜暂时没拉到，等会儿再试试。", 4500, "look");
        return;
      }
      const chatter = await generateChatter(kind, hot);
      if (!chatter) {
        speak("脑子卡了一下，再点我一次试试。", 4000, "look");
        return;
      }
      addMessage({ role: "assistant", content: chatter.detail });
      speak(chatter.bubble, 9000, kind === "joke" ? "dance" : "excited");
    },
    [addMessage, markHumanTouch, speak]
  );

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
    gainBond("interact", 2);
    setPetState("excited");
    speak("谢谢你，我补到能量了。", 4200);
    window.setTimeout(resetToDefaultState, 2600);
  }, [adjustLife, gainBond, markHumanTouch, pauseMotion, resetToDefaultState, speak]);

  const trainPet = useCallback(() => {
    markHumanTouch();
    pauseMotion(3200);
    adjustLife({ curiosity: 10, energy: -7, affection: 1 });
    gainBond("interact", 2);
    setPetState("thinking");
    speak("我记住了一点新东西。", 4200);
    window.setTimeout(resetToDefaultState, 3000);
  }, [adjustLife, gainBond, markHumanTouch, pauseMotion, resetToDefaultState, speak]);

  const playWithPet = useCallback(() => {
    markHumanTouch();
    pauseMotion(2800);
    adjustLife({ affection: 4, energy: -4, curiosity: 1 });
    gainBond("interact", 2);
    setPetState("dance");
    speak("再来一次，我喜欢这个。", 4200);
    window.setTimeout(resetToDefaultState, 2800);
  }, [adjustLife, gainBond, markHumanTouch, pauseMotion, resetToDefaultState, speak]);

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

  // 聊天里让桌宠自己动手（paw_pet_action）：别的窗口发事件，这里执行
  const petCommandRef = useRef<(payload: PetCommandPayload) => void>(() => {});
  petCommandRef.current = (payload) => {
    const act = (state: PetState, ms: number) => {
      setPetState(state);
      window.setTimeout(resetToDefaultState, ms);
    };
    switch (payload.action) {
      case "focus":
        startFocus(payload.minutes || 25);
        break;
      case "cancel_focus":
        cancelFocus();
        break;
      case "dance":
        act("dance", 3200);
        break;
      case "sit":
        act("sit", 3600);
        break;
      case "sleep":
        act("sleep", 7000);
        break;
      case "stretch":
        act("stretch", 2800);
        break;
      case "excited":
        setPetState("excited");
        speak("收到，我精神起来了。");
        break;
      case "wander":
        void wander(true);
        break;
      case "come_to_cursor":
        void reactToCursor(true);
        break;
      case "feed":
        feedPet();
        break;
      case "train":
        trainPet();
        break;
      case "play":
        playWithPet();
        break;
      case "joke":
        void chatNow("joke");
        break;
      case "hot_topic":
        void chatNow("hot");
        break;
      case "fact":
        void chatNow("fact");
        break;
      case "news":
        void broadcastTodayNews();
        break;
      case "daily_wrap":
        void showWrapNow();
        break;
      case "squad":
        void emit("squad-toggle");
        break;
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<PetCommandPayload>(PET_COMMAND_EVENT, (event) => {
      if (event.payload?.action) petCommandRef.current(event.payload);
    })
      .then((fn) => (disposed ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const closeBubble = useCallback(() => setBubbleMessage(null), []);

  // 点别处就收起：右键菜单、气泡、播报、提议、提示、小结、拖入文件卡片、更新提示（正在下载更新时不收）。
  // 聊天框有自己的收起逻辑（上面的 onFocusChanged），专注计时和干活进度是常驻状态，不收。
  const dismissPopups = useCallback(() => {
    setShowMenu(false);
    setBubbleMessage(null);
    setNewsBanner(null);
    setRoutineBanner(null);
    setOffer(null);
    setHint(null);
    setWrap(null);
    setDropFiles(null);
    if (updateProgress === null) setUpdate(null);
  }, [updateProgress]);
  const dismissPopupsRef = useRef(dismissPopups);
  dismissPopupsRef.current = dismissPopups;

  // 桌宠窗口失去焦点（点了桌面或别的软件）
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused || resizeRef.current || dragRef.current) return;
          dismissPopupsRef.current();
        })
        .then((fn) => (disposed ? fn() : (unlisten = fn)))
        .catch(() => {});
    } catch {
      // Browser dev fallback.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 点了桌宠窗口里的透明空白处（不是宠物、也不是任何卡片）
  const handleBackgroundPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.target !== event.currentTarget || event.button !== 0) return;
      dismissPopups();
      if (showMiniChat) closeMiniChat();
    },
    [closeMiniChat, dismissPopups, showMiniChat]
  );

  const handlePetPointerEnter = useCallback(() => {
    hoverPetRef.current = true;
    pauseMotion(3200);
  }, [pauseMotion]);

  const handlePetPointerLeave = useCallback(() => {
    hoverPetRef.current = false;
    pauseMotion(700);
  }, [pauseMotion]);

  const menuLeft = Math.max(8, Math.min(menuPos.x, (showMiniChat ? chatSizeState.width : PET_SIZE.width) - 164));
  const menuTop = Math.max(8, Math.min(menuPos.y, (showMiniChat ? chatSizeState.height : PET_SIZE.height) - 286));
  const recentMessages = messages.slice(-30);

  return (
    <div
      className={`pet-window ${themeClass} relative h-screen w-screen select-none overflow-hidden`}
      onContextMenu={handleContextMenu}
      onPointerDown={handleBackgroundPointerDown}
    >
      {dropFiles && !showMiniChat && (
        <DropCard
          files={dropFiles}
          canControl={loadConfig().computerControl !== "off"}
          onPick={(choice: DropChoice) => void runDropChoice(choice.prompt, choice.role)}
          onAsk={(text) => void runDropChoice(text)}
          onClose={() => setDropFiles(null)}
        />
      )}

      {wrap && !dropFiles && !showMiniChat && (
        <WrapCard
          wrap={wrap}
          onReport={() => void runWrap("report")}
          onSlack={() => void runWrap("slack")}
          onJira={() => void runWrap("jira")}
          onClose={() => setWrap(null)}
        />
      )}

      {update && !wrap && !dropFiles && !showMiniChat && (
        <UpdateCard
          version={update.version}
          notes={update.notes}
          progress={updateProgress}
          error={updateError}
          onInstall={() => void runUpdate()}
          onSkip={() => {
            skipVersion(update.version);
            setUpdate(null);
          }}
          onClose={() => updateProgress === null && setUpdate(null)}
        />
      )}

      {hint && !update && !wrap && !dropFiles && !showMiniChat && (
        <HintCard
          hint={hint}
          onAccept={() => void acceptHint()}
          onMute={() => {
            muteHint(hint.id);
            setHint(null);
          }}
          onClose={closeHint}
        />
      )}

      {focus && !showMiniChat && !dropFiles && !wrap && !hint && !update && !offer && (
        <FocusBadge endsAt={focus.endsAt} minutes={focus.minutes} onCancel={cancelFocus} />
      )}

      {runningJob && !focus && !showMiniChat && !dropFiles && !wrap && !hint && !update && !offer && (
        <JobChip job={runningJob} onOpen={() => void showMainWindow("jobs")} />
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-30 rounded-3xl border-2 border-dashed border-primary/70 bg-primary/5" />
      )}

      {offer && !showMiniChat && !dropFiles && !wrap && !hint && (
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

      {!showMiniChat && bubbleMessage && !offer && !dropFiles && !wrap && !hint && (
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

      {showMiniChat && (
        <div
          className={`mini-chat-window absolute left-3 right-3 top-3 z-30 flex flex-col rounded-2xl border border-line bg-surface/95 text-fg p-3 shadow-2xl pointer-events-auto ${
            resizing ? "select-none" : ""
          }`}
          style={{ bottom: (petSize || SPRITE_SIZE) + 20 }}
        >
          {(["nw", "se"] as const).map((corner) => (
            <div
              key={corner}
              data-resize={corner}
              onPointerDown={startResize(corner)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onDoubleClick={resetChatSize}
              title="拖动调整聊天框大小，双击恢复默认"
              className={`group absolute z-40 flex h-5 w-5 items-center justify-center ${
                corner === "nw" ? "-left-1 -top-1 cursor-nwse-resize" : "-bottom-1 -right-1 cursor-nwse-resize"
              }`}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                className={`text-fg-muted opacity-50 transition group-hover:text-primary group-hover:opacity-100 ${
                  corner === "nw" ? "rotate-180" : ""
                } ${resizing && resizeRef.current?.corner === corner ? "text-primary opacity-100" : ""}`}
                aria-hidden="true"
              >
                <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </div>
          ))}
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <div className="text-sm font-semibold text-fg">和{petName}聊天</div>
            <button className="text-xs text-fg-muted hover:text-fg" onClick={closeMiniChat}>
              收起
            </button>
          </div>
          <div ref={miniChatListRef} className="mini-chat-list min-h-0 flex-1 space-y-2 overflow-y-auto rounded-xl bg-app p-2">
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
            {!isStreaming && recentMessages.length > 0 && recentMessages[recentMessages.length - 1].role === "user" && (
              <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-xs text-fg-muted">
                <span className="min-w-0 flex-1">这条消息没有收到回复。</span>
                <button
                  type="button"
                  className="shrink-0 rounded-lg bg-primary px-2.5 py-1 font-medium text-primary-fg"
                  onClick={() => void useAgentStore.getState().retryLast()}
                >
                  重新发送
                </button>
              </div>
            )}
            {isStreaming && <MiniStreamingReply text={streamText} runs={currentToolRuns} />}
          </div>
          <div className="mt-2 flex shrink-0 gap-2">
            <input
              className="mini-chat-input min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-primary"
              value={miniInput}
              onChange={(event) => setMiniInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") sendMiniMessage();
              }}
              placeholder={isStreaming ? "可以继续补充，Enter 发送" : `问问${petName}…`}
            />
            <button
              className="rounded-xl bg-primary px-3 py-2 text-sm font-bold text-primary-fg disabled:opacity-50"
              disabled={!miniInput.trim()}
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
        <Suspense fallback={<div className="h-28 w-28 rounded-full bg-primary/30 shadow-lg" />}>
          <RiggedPet3D
            model={avatarInfo.model || BUILTIN_AVATARS[0].model!}
            state={petState}
            facing={facing}
            size={petSize || SPRITE_SIZE}
          />
        </Suspense>

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
          <GrowthMenuHeader
            todayMin={growthDays[dayKey()] || 0}
            focusing={Boolean(focus)}
            onFocus={startFocus}
          />
          <MenuItem label="聊天" onClick={() => { setShowMenu(false); openMiniChat(); }} />
          <MenuItem label="交代工作" onClick={() => { setShowMenu(false); void showMainWindow("jobs"); }} />
          <MenuItem label="下班小结" onClick={() => { setShowMenu(false); void showWrapNow(); }} />
          <MenuItem label="叫团队出来" onClick={() => { setShowMenu(false); void emit("squad-toggle"); }} />
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
          <MenuItem label="讲个笑话" onClick={() => { setShowMenu(false); void chatNow("joke"); }} />
          <MenuItem label="聊聊热搜" onClick={() => { setShowMenu(false); void chatNow("hot"); }} />
          <MenuItem label="冷知识" onClick={() => { setShowMenu(false); void chatNow("fact"); }} />
          <MenuItem label="摸摸头" onClick={() => { setShowMenu(false); gainBond("interact"); speak("皮卡皮卡~ 好舒服，我会更努力陪你。"); }} />
          <div className="my-1 border-t border-line" />
          <MenuItem label="设置" onClick={() => { setShowMenu(false); showMainWindow("settings"); }} />
        </div>
      )}
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

/** 桌宠头顶的小条：正在干的活和进度，点一下看详情 */
function JobChip({ job, onOpen }: { job: Job; onOpen: () => void }) {
  const progress = jobProgress(job);
  const label = progress.current?.text || (progress.total ? "整理结果" : "列计划");
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${job.title}：点我看工作日志`}
      className="absolute left-1/2 top-3 z-30 flex max-w-[92%] -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface/95 py-1 pl-2 pr-2.5 text-[11px] text-fg shadow-md backdrop-blur pointer-events-auto"
    >
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      <span className="shrink-0 font-medium">干活中{progress.total ? ` ${progress.done}/${progress.total}` : ""}</span>
      <span className="min-w-0 truncate text-fg-muted">{label}</span>
    </button>
  );
}
