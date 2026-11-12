import type { SmartSuggestion } from "./personality";
import type { NewsItem } from "./news";

export interface ProactiveContext {
  hour: number;
  timeOfDay: "morning" | "afternoon" | "evening" | "night";
  minutesSinceHumanTouch: number;
  memoryCount: number;
  activityEnabled: boolean;
  autonomousNews: boolean;
  autonomousLearning: boolean;
  activitySummary: string;
  newsItems: NewsItem[];
  smartSuggestions: SmartSuggestion[];
  recentUserMessages: string[];
  /** 处于冷却期（或已无意义，如 Skill 已存在）的计划类型，选择时直接跳过。 */
  blocked?: Partial<Record<ProactivePlan["kind"], boolean>>;
}

export type ProactivePlan =
  | {
      kind: "news";
      priority: number;
      title: string;
      items: NewsItem[];
    }
  | {
      kind: "activity";
      priority: number;
      summary: string;
    }
  | {
      kind: "suggestion";
      priority: number;
      suggestion: SmartSuggestion;
    }
  | {
      kind: "skill";
      priority: number;
      name: string;
      description: string;
      examples: string[];
    }
  | {
      kind: "memory";
      priority: number;
      message: string;
    };

function countMatches(messages: string[], pattern: RegExp) {
  return messages.reduce((count, text) => count + (pattern.test(text) ? 1 : 0), 0);
}

export function selectProactivePlan(context: ProactiveContext): ProactivePlan | null {
  const plans: ProactivePlan[] = [];

  if (context.autonomousNews && context.newsItems.length > 0 && context.minutesSinceHumanTouch > 12) {
    const timeBias = context.timeOfDay === "morning" || context.timeOfDay === "evening" ? 12 : 0;
    const freshnessBias = Math.min(context.newsItems.length, 5) * 4;
    plans.push({
      kind: "news",
      priority: 55 + timeBias + freshnessBias,
      title: "今日新闻后台简报",
      items: context.newsItems.slice(0, 5),
    });
  }

  if (context.activityEnabled && context.activitySummary && !context.activitySummary.includes("还没有足够")) {
    plans.push({
      kind: "activity",
      priority: 48 + Math.min(context.minutesSinceHumanTouch / 5, 12),
      summary: context.activitySummary,
    });
  }

  const topSuggestion = context.smartSuggestions[0];
  if (topSuggestion && context.minutesSinceHumanTouch > 18) {
    const priorityBase = topSuggestion.priority === "high" ? 62 : topSuggestion.priority === "medium" ? 52 : 42;
    plans.push({
      kind: "suggestion",
      priority: priorityBase + topSuggestion.confidence * 10,
      suggestion: topSuggestion,
    });
  }

  if (context.autonomousLearning && context.memoryCount < 5 && context.minutesSinceHumanTouch > 30) {
    plans.push({
      kind: "memory",
      priority: 35,
      message: "我还在慢慢认识你的偏好和习惯，等你多说一点，我会记得更准。",
    });
  }

  // 英文词加单词边界，避免 restart / startup 之类误计数。
  const appRequests = countMatches(context.recentUserMessages, /打开|启动|运行|\b(open|launch|start)\b/i);
  if (context.autonomousLearning && appRequests >= 3) {
    plans.push({
      kind: "skill",
      priority: 80,
      name: "常用应用操作助手",
      description: "根据用户近期习惯，优先识别打开应用、网页、系统入口等桌面操作，并在执行前确认。",
      examples: ["打开记事本", "帮我启动任务管理器", "打开 GitHub"],
    });
  }

  // 之前冷却只写不读：同一条建议 / 活动摘要每轮都会重复推送；
  // Skill 计划优先级最高，创建后仍会一直胜出，把其他计划全部饿死。
  const available = plans.filter((plan) => !context.blocked?.[plan.kind]);
  if (available.length === 0) return null;
  return available.sort((a, b) => b.priority - a.priority)[0];
}
