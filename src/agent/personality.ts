/**
 * 个性化智能系统
 * - 用户画像
 * - 行为分析
 * - 智能建议
 */

import { memoryStore } from "./memory";
import { todoStore } from "./tools";
import { scopeKey } from "./scope";

export interface UserProfile {
  id: string;
  name?: string;
  timezone: string;
  language: string;
  interests: string[];
  communicationStyle: "formal" | "casual" | "friendly";
  activityPattern: {
    peakHours: number[];
    avgSessionLength: number;
  };
  preferences: {
    tone: "professional" | "playful" | "balanced";
    detailLevel: "brief" | "moderate" | "detailed";
    emojiUsage: "none" | "some" | "many";
  };
  stats: {
    totalConversations: number;
    totalMessages: number;
    toolsUsed: Record<string, number>;
    lastActive: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface BehaviorEvent {
  id: string;
  type: "message" | "tool_use" | "feature_access" | "error";
  action: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface SmartSuggestion {
  type: "task" | "schedule" | "info" | "tip" | "memory";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  action?: string;
  confidence: number;
}

const PROFILE_KEY = "paw_user_profile";
const BEHAVIOR_KEY = "paw_behavior_events";
const CLEANUP_KEY = "paw_behavior_cleanup";

class PersonalityStore {
  private profile: UserProfile;

  constructor() {
    this.profile = this.loadProfile();
    this.initBehaviorTracking();
  }

  private loadProfile(): UserProfile {
    try {
      const saved = localStorage.getItem(scopeKey(PROFILE_KEY));
      if (saved) return JSON.parse(saved);
    } catch {}
    return this.createDefaultProfile();
  }

  private createDefaultProfile(): UserProfile {
    return {
      id: `profile_${Date.now()}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      interests: [],
      communicationStyle: "friendly",
      activityPattern: {
        peakHours: [],
        avgSessionLength: 0,
      },
      preferences: {
        tone: "balanced",
        detailLevel: "moderate",
        emojiUsage: "some",
      },
      stats: {
        totalConversations: 0,
        totalMessages: 0,
        toolsUsed: {},
        lastActive: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private saveProfile(): void {
    localStorage.setItem(scopeKey(PROFILE_KEY), JSON.stringify(this.profile));
  }

  /** 切换 Bot 后重新载入该 Bot 分区里的用户画像。 */
  reloadForActiveBot(): void {
    this.profile = this.loadProfile();
  }

  getProfile(): UserProfile {
    return { ...this.profile };
  }

  updateProfile(updates: Partial<UserProfile>): void {
    this.profile = {
      ...this.profile,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.saveProfile();
  }

  learnFromConversation(message: string, isUser: boolean): void {
    if (!isUser) return;

    const keywords = ["喜欢", "爱", "感兴趣", "热爱", "关注", "编程", "设计", "音乐", "电影", "游戏", "技术", "科技", "AI", "机器学习", "前端", "后端"];
    for (const keyword of keywords) {
      if (message.includes(keyword)) {
        const index = message.indexOf(keyword);
        const context = message.slice(Math.max(0, index - 10), Math.min(message.length, index + 20));
        if (!this.profile.interests.includes(context)) {
          this.profile.interests.push(context);
          if (this.profile.interests.length > 30) {
            this.profile.interests = this.profile.interests.slice(-30);
          }
        }
      }
    }

    if (message.includes("吧") || message.includes("~") || message.includes("呀")) {
      this.profile.communicationStyle = "casual";
    } else if (message.includes("请问") || message.includes("能否")) {
      this.profile.communicationStyle = "formal";
    }

    this.profile.stats.totalMessages += 1;
    this.profile.stats.lastActive = new Date().toISOString();
    this.saveProfile();
  }

  recordToolUsage(toolName: string): void {
    this.profile.stats.toolsUsed[toolName] = (this.profile.stats.toolsUsed[toolName] || 0) + 1;
    this.profile.stats.lastActive = new Date().toISOString();
    this.saveProfile();
  }

  getMostUsedTools(limit = 5): Array<{ tool: string; count: number }> {
    return Object.entries(this.profile.stats.toolsUsed)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  private initBehaviorTracking(): void {
    const lastCleanup = localStorage.getItem(scopeKey(CLEANUP_KEY));
    const now = Date.now();
    if (!lastCleanup || now - parseInt(lastCleanup) > 24 * 60 * 60 * 1000) {
      this.cleanupOldEvents();
      localStorage.setItem(scopeKey(CLEANUP_KEY), now.toString());
    }
  }

  private cleanupOldEvents(): void {
    try {
      const saved = localStorage.getItem(scopeKey(BEHAVIOR_KEY));
      if (!saved) return;

      const events: BehaviorEvent[] = JSON.parse(saved);
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recent = events.filter((event) => new Date(event.timestamp).getTime() > oneWeekAgo);
      localStorage.setItem(scopeKey(BEHAVIOR_KEY), JSON.stringify(recent));
    } catch {}
  }

  trackEvent(type: BehaviorEvent["type"], action: string, metadata?: Record<string, unknown>): void {
    try {
      const saved = localStorage.getItem(scopeKey(BEHAVIOR_KEY));
      const events: BehaviorEvent[] = saved ? JSON.parse(saved) : [];
      events.push({
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type,
        action,
        metadata,
        timestamp: new Date().toISOString(),
      });
      localStorage.setItem(scopeKey(BEHAVIOR_KEY), JSON.stringify(events.slice(-1000)));
    } catch {}
  }

  getRecentEvents(limit = 20): BehaviorEvent[] {
    try {
      const saved = localStorage.getItem(scopeKey(BEHAVIOR_KEY));
      if (!saved) return [];
      const events: BehaviorEvent[] = JSON.parse(saved);
      return events.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  getActivityPattern(): { hour: number; count: number }[] {
    const events = this.getRecentEvents(100);
    const hourCounts: Record<number, number> = {};
    for (let i = 0; i < 24; i++) hourCounts[i] = 0;

    for (const event of events) {
      const hour = new Date(event.timestamp).getHours();
      hourCounts[hour] += 1;
    }

    return Object.entries(hourCounts)
      .map(([hour, count]) => ({ hour: Number(hour), count }))
      .sort((a, b) => b.count - a.count);
  }

  async getSmartSuggestions(): Promise<SmartSuggestion[]> {
    const suggestions: SmartSuggestion[] = [];

    const upcomingTodos = todoStore.getUpcoming(3);
    for (const todo of upcomingTodos) {
      const dueDate = new Date(todo.dueDate!);
      const hoursUntilDue = (dueDate.getTime() - Date.now()) / (1000 * 60 * 60);
      suggestions.push({
        type: "task",
        priority: hoursUntilDue < 2 ? "high" : hoursUntilDue < 24 ? "medium" : "low",
        title: `待办：${todo.text}`,
        description: `截止时间：${dueDate.toLocaleDateString("zh-CN")}`,
        action: `complete_todo:${todo.id}`,
        confidence: 0.9,
      });
    }

    const allTodos = todoStore.getUpcoming(100);
    const highPriorityPending = allTodos.filter((todo: any) => !todo.completed && todo.priority === "high");
    if (highPriorityPending.length > 0) {
      suggestions.push({
        type: "task",
        priority: "high",
        title: "你有未完成的高优先级任务",
        description: `${highPriorityPending.length} 个任务待完成`,
        confidence: 0.85,
      });
    }

    const hour = new Date().getHours();
    if (hour >= 9 && hour <= 11) {
      suggestions.push({
        type: "tip",
        priority: "low",
        title: "上午适合处理复杂任务",
        description: "现在专注力通常更好。",
        confidence: 0.7,
      });
    } else if (hour >= 14 && hour <= 16) {
      suggestions.push({
        type: "tip",
        priority: "low",
        title: "下午注意休息",
        description: "可以起来活动一下。",
        confidence: 0.6,
      });
    } else if (hour >= 22 || hour < 6) {
      suggestions.push({
        type: "tip",
        priority: "medium",
        title: "现在偏晚了",
        description: "注意休息，明天还会有新的任务。",
        confidence: 0.8,
      });
    }

    const memoryStats = await memoryStore.getStats();
    if (memoryStats.total === 0) {
      suggestions.push({
        type: "memory",
        priority: "low",
        title: "开始建立记忆",
        description: "我会记住重要信息，之后帮你更快回答。",
        confidence: 0.5,
      });
    }

    return suggestions.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return b.confidence - a.confidence;
    });
  }

  getPersonalizedContext(): string {
    const profile = this.profile;
    const context: string[] = [];

    if (profile.communicationStyle === "casual") {
      context.push("用户偏好轻松自然的沟通方式。");
    } else if (profile.communicationStyle === "formal") {
      context.push("用户偏好正式专业的表达方式。");
    }

    if (profile.interests.length > 0) {
      context.push(`用户兴趣：${profile.interests.slice(0, 5).join("、")}`);
    }

    const topTools = this.getMostUsedTools(3);
    if (topTools.length > 0) {
      context.push(`常用功能：${topTools.map((item) => item.tool).join("、")}`);
    }

    const lastActive = new Date(profile.stats.lastActive);
    const hoursSince = (Date.now() - lastActive.getTime()) / (1000 * 60 * 60);
    if (hoursSince < 1) {
      context.push("用户最近刚刚活跃。");
    } else if (hoursSince < 24) {
      context.push(`用户约 ${Math.floor(hoursSince)} 小时前活跃。`);
    }

    return context.length > 0 ? `\n\n## 用户个性化信息\n${context.join("\n")}` : "";
  }
}

export const personalityStore = new PersonalityStore();
