import { useEffect, useRef } from "react";
import { useChatStore } from "../store/chat";
import { usePetStore } from "../store/pet";
import { useActivityStore } from "../store/activity";
import { memoryStore } from "./memory";
import { personalityStore } from "./personality";
import { customSkillsStore } from "./customSkills";
import { fetchTodayNews, formatNewsBubble, formatNewsMarkdown, markTodayNewsPushed, shouldPushTodayNews } from "./news";
import { selectProactivePlan } from "./decision";
import { chatterAvailable, fetchHotTopics, generateChatter, type ChatterKind } from "./chatter";

type PetPose = "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking" | "morning" | "night" | "dance" | "stretch" | "look" | "wave";
type SpeakFn = (message: string, duration?: number, pose?: PetPose) => void;

interface UsePetProactivityOptions {
  shouldPauseMotion: () => boolean;
  speak: SpeakFn;
  setPetState: (state: "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking" | "morning" | "night" | "dance" | "stretch" | "look" | "wave") => void;
  addMessage: (message: { role: "assistant"; content: string }) => void;
  lastHumanTouchRef: { current: number };
  autonomousNews: boolean;
  autonomousLearning: boolean;
  enableInteractions: boolean;
  autoAction: boolean;
  interactionFrequency: "rare" | "normal" | "frequent";
}

const COOLDOWN_KEY = "paw_proactivity_cooldowns";
const LAST_RUN_KEY = "paw_proactivity_last_run";
// 两次主动行为之间至少隔多久（按“互动频率”设置）；搭话的冷却和它一样。
const MIN_RUN_INTERVAL_MS: Record<"rare" | "normal" | "frequent", number> = {
  rare: 30 * 60_000,
  normal: 15 * 60_000,
  frequent: 7 * 60_000,
};
const CHECK_INTERVAL_MS = 2 * 60_000;
const LAST_CHATTER_KIND_KEY = "paw_chatter_last_kind";
const NEWS_COOLDOWN_MS = 45 * 60_000;
const ACTIVITY_COOLDOWN_MS = 45 * 60_000;
const SUGGESTION_COOLDOWN_MS = 35 * 60_000;
const MEMORY_COOLDOWN_MS = 90 * 60_000;
const SKILL_COOLDOWN_MS = 4 * 60 * 60_000;

type Cooldowns = Partial<Record<string, number>>;

function loadCooldowns(): Cooldowns {
  try {
    const saved = localStorage.getItem(COOLDOWN_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
}

function saveCooldowns(cooldowns: Cooldowns) {
  try {
    localStorage.setItem(COOLDOWN_KEY, JSON.stringify(cooldowns));
  } catch {}
}

function isCooldownActive(cooldowns: Cooldowns, key: string, durationMs: number) {
  const last = cooldowns[key] || 0;
  return Date.now() - last < durationMs;
}

function markCooldown(cooldowns: Cooldowns, key: string) {
  cooldowns[key] = Date.now();
  saveCooldowns(cooldowns);
}

function minutesSince(timestamp: number) {
  return (Date.now() - timestamp) / 60_000;
}

/** 选这次聊什么：有热搜时多聊热搜，饭点和深夜多关心一句，不和上次重复。 */
function pickChatterKind(hour: number, hasHot: boolean): ChatterKind {
  const weights: Record<ChatterKind, number> = {
    joke: 3,
    hot: hasHot ? 4 : 0,
    fact: 2,
    care: [11, 12, 17, 18, 22, 23].includes(hour) ? 3 : 1,
    topic: 1.5,
  };
  const last = localStorage.getItem(LAST_CHATTER_KIND_KEY) as ChatterKind | null;
  if (last && last in weights) weights[last] = 0;
  const entries = Object.entries(weights) as Array<[ChatterKind, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [kind, weight] of entries) {
    roll -= weight;
    if (roll <= 0 && weight > 0) return kind;
  }
  return "joke";
}

export function usePetProactivity({
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
}: UsePetProactivityOptions) {
  const cooldownsRef = useRef<Cooldowns>(loadCooldowns());
  const runningRef = useRef(false);
  const callbacksRef = useRef({ shouldPauseMotion, speak, setPetState, addMessage });
  callbacksRef.current = { shouldPauseMotion, speak, setPetState, addMessage };

  useEffect(() => {
    if (!enableInteractions && !autoAction) return;

    let disposed = false;
    const shouldPauseMotion = () => callbacksRef.current.shouldPauseMotion();
    const speak: SpeakFn = (...args) => callbacksRef.current.speak(...args);
    const addMessage = (message: { role: "assistant"; content: string }) => callbacksRef.current.addMessage(message);
    const minInterval = MIN_RUN_INTERVAL_MS[interactionFrequency] || MIN_RUN_INTERVAL_MS.normal;

    const run = async () => {
      if (disposed || runningRef.current || shouldPauseMotion()) return;
      const lastRun = Number(localStorage.getItem(LAST_RUN_KEY) || "0");
      if (lastRun && Date.now() - lastRun < minInterval) return;

      runningRef.current = true;
      try {
        // 只统计用户自己的消息；助手回复里的“已打开…”不应算作用户需求。
        const messages = useChatStore
          .getState()
          .messages.slice(-16)
          .filter((message) => message.role === "user")
          .map((message) => message.content);
        const activity = useActivityStore.getState();
        const recentTouchMinutes = minutesSince(lastHumanTouchRef.current || Date.now());
        const activitySummary = activity.enabled ? activity.getSummary() : "";
        const memoryCount = (await memoryStore.getStats()).total;
        const smartSuggestions = await personalityStore.getSmartSuggestions();
        const cooldowns = cooldownsRef.current;
        // 新闻按天缓存，同一批内容一天只主动推一次。
        const newsAllowed =
          autonomousNews && shouldPushTodayNews("autonomous") && !isCooldownActive(cooldowns, "news", NEWS_COOLDOWN_MS);
        const newsItems = newsAllowed ? await fetchTodayNews() : [];
        const chatterAllowed =
          enableInteractions && chatterAvailable() && !isCooldownActive(cooldowns, "chatter", minInterval);
        const hotTopics = chatterAllowed && autonomousNews ? await fetchHotTopics() : [];
        const hour = new Date().getHours();
        const skillExists = customSkillsStore
          .getAll()
          .some((skill) => skill.tags.includes("autonomous-learning") && skill.name === "常用应用操作助手");

        const plan = selectProactivePlan({
          hour,
          timeOfDay: usePetStore.getState().timeOfDay,
          minutesSinceHumanTouch: recentTouchMinutes,
          memoryCount,
          activityEnabled: activity.enabled,
          autonomousNews,
          autonomousLearning,
          activitySummary,
          newsItems,
          smartSuggestions,
          recentUserMessages: messages,
          chatterEnabled: chatterAllowed,
          chatterKind: chatterAllowed ? pickChatterKind(hour, hotTopics.length > 0) : undefined,
          blocked: {
            news: !newsAllowed,
            activity: isCooldownActive(cooldowns, "activity", ACTIVITY_COOLDOWN_MS),
            suggestion: isCooldownActive(cooldowns, "suggestion", SUGGESTION_COOLDOWN_MS),
            memory: isCooldownActive(cooldowns, "memory", MEMORY_COOLDOWN_MS),
            skill: skillExists || isCooldownActive(cooldowns, "skill", SKILL_COOLDOWN_MS),
          },
        });

        if (!plan) return;

        localStorage.setItem(LAST_RUN_KEY, Date.now().toString());

        if (plan.kind === "chatter") {
          // 先记冷却：模型出错时也别每两分钟重试一次
          markCooldown(cooldownsRef.current, "chatter");
          localStorage.setItem(LAST_CHATTER_KIND_KEY, plan.topic);
          const chatter = await generateChatter(plan.topic, hotTopics);
          if (!chatter || disposed || shouldPauseMotion()) return;
          addMessage({ role: "assistant", content: chatter.detail });
          const pose = chatter.kind === "joke" ? "dance" : chatter.kind === "care" ? "wave" : chatter.kind === "hot" ? "excited" : "look";
          speak(chatter.bubble, 9000, pose);
          return;
        }

        if (plan.kind === "news") {
          markCooldown(cooldownsRef.current, "news");
          markTodayNewsPushed("autonomous");
          addMessage({ role: "assistant", content: formatNewsMarkdown(plan.items, plan.title) });
          plan.items.slice(0, 3).forEach((item, index) => {
            window.setTimeout(() => {
              if (disposed || shouldPauseMotion()) return;
              speak(formatNewsBubble(item, index, Math.min(plan.items.length, 3)), 7500, "wave");
            }, index * 2200);
          });
          speak("我把今天新闻整理好了，已经放到聊天里。", 4200);
          return;
        }

        if (plan.kind === "activity") {
          markCooldown(cooldownsRef.current, "activity");
          addMessage({ role: "assistant", content: plan.summary });
          speak("我整理了一下你最近的电脑活动，已经放到聊天里。", 5200);
          return;
        }

        if (plan.kind === "suggestion") {
          markCooldown(cooldownsRef.current, "suggestion");
          const message = `## 我的小建议\n\n- **${plan.suggestion.title}**\n\n${plan.suggestion.description}`;
          addMessage({ role: "assistant", content: message });
          speak(plan.suggestion.title, 4800);
          return;
        }

        if (plan.kind === "skill") {
          if (!isCooldownActive(cooldownsRef.current, "skill", SKILL_COOLDOWN_MS)) {
            const exists = customSkillsStore
              .getAll()
              .some((skill) => skill.tags.includes("autonomous-learning") && skill.name === plan.name);
            if (!exists) {
              customSkillsStore.create({
                name: plan.name,
                description: plan.description,
                category: "生产力",
                instructions: [
                  "当用户表达打开、启动、运行、访问网页、进入系统设置等需求时，先识别目标应用或 URL。",
                  "优先使用 open_app、open_url 或 system_action 工具完成操作。",
                  "执行外部动作前必须确认；完成后用一句话说明结果。",
                ].join("\n"),
                examples: plan.examples,
                tags: ["autonomous-learning", "system"],
                active: true,
              });
              markCooldown(cooldownsRef.current, "skill");
              speak("我发现你经常让我打开应用，已经给自己写了一个常用应用操作 Skill。", 6500);
            }
          }
          return;
        }

        if (plan.kind === "memory") {
          markCooldown(cooldownsRef.current, "memory");
          addMessage({ role: "assistant", content: `## 本地记忆提醒\n\n${plan.message}` });
          speak(plan.message, 5200);
        }
      } catch {
        // Keep silent when proactive generation fails.
      } finally {
        runningRef.current = false;
      }
    };

    // 每两分钟看一次；真正的间隔由 minInterval 和各类冷却控制。
    const timer = window.setInterval(run, CHECK_INTERVAL_MS);
    const startup = window.setTimeout(run, 12_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(startup);
    };
  }, [autonomousLearning, autonomousNews, autoAction, enableInteractions, interactionFrequency, lastHumanTouchRef]);
}
