import { useEffect, useRef } from "react";
import { useChatStore } from "../store/chat";
import { usePetStore } from "../store/pet";
import { useActivityStore } from "../store/activity";
import { memoryStore } from "./memory";
import { personalityStore } from "./personality";
import { customSkillsStore } from "./customSkills";
import { fetchTodayNews, formatNewsBubble, formatNewsMarkdown, markTodayNewsPushed } from "./news";
import { selectProactivePlan } from "./decision";

type SpeakFn = (message: string, duration?: number) => void;

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
}

const COOLDOWN_KEY = "paw_proactivity_cooldowns";
const LAST_RUN_KEY = "paw_proactivity_last_run";
const MIN_RUN_INTERVAL_MS = 12 * 60_000;
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
}: UsePetProactivityOptions) {
  const cooldownsRef = useRef<Cooldowns>(loadCooldowns());
  const runningRef = useRef(false);

  useEffect(() => {
    if (!enableInteractions && !autoAction) return;

    let disposed = false;

    const run = async () => {
      if (disposed || runningRef.current || shouldPauseMotion()) return;
      const lastRun = Number(localStorage.getItem(LAST_RUN_KEY) || "0");
      if (lastRun && Date.now() - lastRun < MIN_RUN_INTERVAL_MS) return;

      runningRef.current = true;
      try {
        const messages = useChatStore
          .getState()
          .messages.slice(-16)
          .map((message) => message.content);
        const activity = useActivityStore.getState();
        const recentTouchMinutes = minutesSince(lastHumanTouchRef.current || Date.now());
        const activitySummary = activity.enabled ? activity.getSummary() : "";
        const memoryCount = (await memoryStore.getStats()).total;
        const smartSuggestions = await personalityStore.getSmartSuggestions();
        const newsItems = autonomousNews && !isCooldownActive(cooldownsRef.current, "news", NEWS_COOLDOWN_MS)
          ? await fetchTodayNews()
          : [];

        const plan = selectProactivePlan({
          hour: new Date().getHours(),
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
        });

        if (!plan) return;

        localStorage.setItem(LAST_RUN_KEY, Date.now().toString());

        if (plan.kind === "news") {
          markCooldown(cooldownsRef.current, "news");
          addMessage({ role: "assistant", content: formatNewsMarkdown(plan.items, plan.title) });
          plan.items.slice(0, 3).forEach((item, index) => {
            window.setTimeout(() => {
              if (disposed || shouldPauseMotion()) return;
              setPetState("wave");
              speak(formatNewsBubble(item, index, Math.min(plan.items.length, 3)), 7500);
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

    const timer = window.setInterval(run, 11 * 60_000);
    window.setTimeout(run, 12_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [addMessage, autonomousLearning, autonomousNews, autoAction, enableInteractions, lastHumanTouchRef, shouldPauseMotion, setPetState, speak]);
}
