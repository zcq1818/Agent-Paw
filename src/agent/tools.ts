import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { customSkillsStore } from "./customSkills";
import { fetchTodayNews, formatNewsMarkdown } from "./news";
import { useActivityStore } from "../store/activity";
import { useBotStore } from "../store/bots";
import type { ApprovalKind } from "../store/bots";
import { emitToolEvent } from "./toolEvents";

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
  execute: (args: Record<string, any>) => Promise<string>;
}

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  priority: "high" | "medium" | "low";
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startTime: string;
  endTime?: string;
  location?: string;
  createdAt: string;
}

const TODO_KEY = "paw_todos";
const CALENDAR_KEY = "paw_calendar";
const SHORTCUT_KEY = "paw_shortcuts";

function readJson<T>(key: string, fallback: T): T {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/**
 * 外部动作确认：走内联审批卡片，替代原来的 window.confirm 弹窗。
 * 卡片由 ApprovalOverlay 渲染；无人应答时 120 秒后自动拒绝，避免工具调用被永久挂住。
 */
export function confirmSystemAction(message: string, kind: ApprovalKind = "shell"): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(true);

  const store = useBotStore.getState();
  const id = store.requestApproval({
    botId: store.activeBotId || "bot_default_paw",
    threadId: store.activeThreadId || "",
    kind,
    summary: message.split("\n")[0] || "需要确认外部动作",
    detail: message,
  });
  emitToolEvent({
    type: "approval",
    id,
    status: "pending",
    detail: message.split("\n")[0] || "需要确认外部动作",
    at: Date.now(),
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      emitToolEvent({
        type: "approval",
        id,
        status: allowed ? "done" : "error",
        detail: allowed ? "已允许" : "已拒绝或超时",
        at: Date.now(),
      });
      resolve(allowed);
    };

    unsubscribe = useBotStore.subscribe((state) => {
      const request = state.approvals.find((item) => item.id === id);
      if (request && request.status !== "pending") finish(request.status === "allowed");
    });

    timer = setTimeout(() => {
      useBotStore.getState().resolveApproval(id, "denied");
      finish(false);
    }, 120000);
  });
}

class TodoStore {
  private todos: Todo[] = readJson<Todo[]>(TODO_KEY, []);

  private load() {
    this.todos = readJson<Todo[]>(TODO_KEY, []);
  }

  private save() {
    writeJson(TODO_KEY, this.todos);
  }

  add(text: string, priority: "high" | "medium" | "low" = "medium", dueDate?: string): Todo {
    this.load();
    const now = new Date().toISOString();
    const todo: Todo = {
      id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      completed: false,
      priority,
      dueDate,
      createdAt: now,
      updatedAt: now,
    };
    this.todos.unshift(todo);
    this.save();
    return todo;
  }

  toggle(id: string): Todo | undefined {
    this.load();
    const todo = this.todos.find((item) => item.id === id);
    if (!todo) return undefined;
    todo.completed = !todo.completed;
    todo.updatedAt = new Date().toISOString();
    this.save();
    return todo;
  }

  delete(id: string): boolean {
    this.load();
    const before = this.todos.length;
    this.todos = this.todos.filter((item) => item.id !== id);
    this.save();
    return this.todos.length !== before;
  }

  update(id: string, updates: Partial<Omit<Todo, "id" | "createdAt">>): Todo | undefined {
    this.load();
    const todo = this.todos.find((item) => item.id === id);
    if (!todo) return undefined;
    Object.assign(todo, updates, { updatedAt: new Date().toISOString() });
    this.save();
    return todo;
  }

  getStats() {
    this.load();
    const now = new Date();
    return {
      total: this.todos.length,
      completed: this.todos.filter((todo) => todo.completed).length,
      overdue: this.todos.filter((todo) => !todo.completed && todo.dueDate && new Date(todo.dueDate) < now).length,
      byPriority: {
        high: this.todos.filter((todo) => !todo.completed && todo.priority === "high").length,
        medium: this.todos.filter((todo) => !todo.completed && todo.priority === "medium").length,
        low: this.todos.filter((todo) => !todo.completed && todo.priority === "low").length,
      },
    };
  }

  getUpcoming(limit = 5): Todo[] {
    this.load();
    return this.todos
      .filter((todo) => !todo.completed && todo.dueDate)
      .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
      .slice(0, limit);
  }

  getAll(): Todo[] {
    this.load();
    return [...this.todos];
  }
}

class CalendarStore {
  private events: CalendarEvent[] = readJson<CalendarEvent[]>(CALENDAR_KEY, []);

  private load() {
    this.events = readJson<CalendarEvent[]>(CALENDAR_KEY, []);
  }

  private save() {
    writeJson(CALENDAR_KEY, this.events);
  }

  add(title: string, startTime: string, endTime?: string, description?: string, location?: string): CalendarEvent {
    this.load();
    const event: CalendarEvent = {
      id: `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      description,
      startTime,
      endTime,
      location,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    this.events.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    this.save();
    return event;
  }

  delete(id: string): boolean {
    this.load();
    const before = this.events.length;
    this.events = this.events.filter((event) => event.id !== id);
    this.save();
    return this.events.length !== before;
  }

  getUpcoming(limit = 5): CalendarEvent[] {
    this.load();
    const now = new Date();
    return this.events.filter((event) => new Date(event.startTime) >= now).slice(0, limit);
  }

  getAll(): CalendarEvent[] {
    this.load();
    return [...this.events];
  }
}

class ShortcutStore {
  private shortcuts: Array<{ id: string; name: string; command: string; description: string; icon: string; createdAt: string }> =
    readJson(SHORTCUT_KEY, []);

  constructor() {
    if (this.shortcuts.length === 0) {
      this.add("Google", "https://www.google.com", "Google 搜索", "search");
      this.add("GitHub", "https://github.com", "代码仓库", "code");
    }
  }

  private save() {
    writeJson(SHORTCUT_KEY, this.shortcuts);
  }

  add(name: string, command: string, description = "", icon = "link") {
    this.shortcuts = readJson(SHORTCUT_KEY, []);
    const shortcut = {
      id: `shortcut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      command,
      description,
      icon,
      createdAt: new Date().toISOString(),
    };
    this.shortcuts.push(shortcut);
    this.save();
    return shortcut;
  }

  delete(id: string): boolean {
    this.shortcuts = readJson(SHORTCUT_KEY, []);
    const before = this.shortcuts.length;
    this.shortcuts = this.shortcuts.filter((item) => item.id !== id);
    this.save();
    return this.shortcuts.length !== before;
  }

  getAll() {
    this.shortcuts = readJson(SHORTCUT_KEY, this.shortcuts);
    return [...this.shortcuts];
  }
}

const todoStore = new TodoStore();
const calendarStore = new CalendarStore();
const shortcutStore = new ShortcutStore();

const todoTools: Tool[] = [
  {
    name: "add_todo",
    description: "添加一个待办事项",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "待办内容" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级" },
        dueDate: { type: "string", description: "截止时间，ISO 格式" },
      },
      required: ["text"],
    },
    execute: async (args) => {
      const todo = todoStore.add(args.text as string, (args.priority as any) || "medium", args.dueDate as string);
      return `已添加待办：${todo.text}`;
    },
  },
  {
    name: "list_todos",
    description: "列出待办事项",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "active", "completed"], description: "筛选条件" },
      },
    },
    execute: async (args) => {
      const filter = (args.filter as string) || "all";
      const todos = todoStore.getAll().filter((todo) => {
        if (filter === "active") return !todo.completed;
        if (filter === "completed") return todo.completed;
        return true;
      });
      if (todos.length === 0) return "暂无待办事项";
      return todos.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n");
    },
  },
  {
    name: "complete_todo",
    description: "将待办标记为完成",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "待办关键词" },
      },
      required: ["text"],
    },
    execute: async (args) => {
      const keyword = String(args.text || "").trim().toLowerCase();
      if (!keyword) return "请提供待办关键词";
      const all = todoStore.getAll();
      const todo =
        all.find((item) => !item.completed && item.text.toLowerCase().includes(keyword)) ||
        all.find((item) => item.text.toLowerCase().includes(keyword));
      if (!todo) return "未找到该待办事项";
      const updated = todoStore.update(todo.id, { completed: true });
      return `已完成：${updated?.text}`;
    },
  },
  {
    name: "delete_todo",
    description: "删除待办事项",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "待办关键词" },
      },
      required: ["text"],
    },
    execute: async (args) => {
      const keyword = String(args.text || "").trim().toLowerCase();
      if (!keyword) return "请提供待办关键词";
      const todo = todoStore.getAll().find((item) => item.text.toLowerCase().includes(keyword));
      if (!todo) return "未找到该待办事项";
      todoStore.delete(todo.id);
      return `已删除：${todo.text}`;
    },
  },
];

const calendarTools: Tool[] = [
  {
    name: "add_event",
    description: "添加日程事件",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "事件标题" },
        startTime: { type: "string", description: "开始时间，ISO 格式" },
        endTime: { type: "string", description: "结束时间，ISO 格式" },
        description: { type: "string", description: "事件描述" },
        location: { type: "string", description: "地点" },
      },
      required: ["title", "startTime"],
    },
    execute: async (args) => {
      const event = calendarStore.add(args.title as string, args.startTime as string, args.endTime as string, args.description as string, args.location as string);
      return `已添加日程：${event.title}`;
    },
  },
  {
    name: "list_events",
    description: "列出即将到来的日程",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const events = calendarStore.getUpcoming(10);
      if (events.length === 0) return "暂无即将到来的日程";
      return events.map((event) => `${new Date(event.startTime).toLocaleString("zh-CN")} - ${event.title}`).join("\n");
    },
  },
  {
    name: "delete_event",
    description: "删除日程事件",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "事件标题关键词" },
      },
      required: ["title"],
    },
    execute: async (args) => {
      const keyword = String(args.title || "").trim().toLowerCase();
      if (!keyword) return "请提供日程标题关键词";
      const event = calendarStore.getAll().find((item) => item.title.toLowerCase().includes(keyword));
      if (!event) return "未找到该日程";
      calendarStore.delete(event.id);
      return `已删除日程：${event.title}`;
    },
  },
];

const shortcutTools: Tool[] = [
  {
    name: "list_shortcuts",
    description: "列出快捷命令",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const shortcuts = shortcutStore.getAll();
      if (shortcuts.length === 0) return "暂无快捷命令";
      return shortcuts.map((item) => `${item.name}: ${item.command}`).join("\n");
    },
  },
  {
    name: "run_shortcut",
    description: "执行快捷命令",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "快捷命令名称" },
      },
      required: ["name"],
    },
    execute: async (args) => {
      const keyword = String(args.name || "").trim().toLowerCase();
      if (!keyword) return "请提供快捷命令名称";
      const shortcut = shortcutStore.getAll().find((item) => item.name.toLowerCase().includes(keyword));
      if (!shortcut) return "未找到该快捷命令";
      if (!(await confirmSystemAction(`皮卡准备执行快捷命令「${shortcut.name}」：${shortcut.command}`, "network"))) {
        return "已取消执行快捷命令。";
      }
      await open(shortcut.command);
      return `正在执行：${shortcut.name}`;
    },
  },
  {
    name: "add_shortcut",
    description: "添加快捷命令",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "命令名称" },
        command: { type: "string", description: "命令、URL 或路径" },
        description: { type: "string", description: "说明" },
        icon: { type: "string", description: "图标文本" },
      },
      required: ["name", "command"],
    },
    execute: async (args) => {
      const shortcut = shortcutStore.add(args.name as string, args.command as string, (args.description as string) || "", (args.icon as string) || "link");
      return `已添加快捷命令：${shortcut.name}`;
    },
  },
];

const clipboardTools: Tool[] = [
  {
    name: "read_clipboard",
    description: "读取剪贴板文本",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      try {
        const text = await navigator.clipboard.readText();
        return text ? `剪贴板内容：\n${text}` : "剪贴板为空";
      } catch {
        return "无法读取剪贴板";
      }
    },
  },
  {
    name: "write_clipboard",
    description: "写入剪贴板文本",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要写入的内容" },
      },
      required: ["text"],
    },
    execute: async (args) => {
      try {
        await navigator.clipboard.writeText(args.text as string);
        return "已复制到剪贴板";
      } catch {
        return "无法写入剪贴板";
      }
    },
  },
];

/** 按 ID 或名称找技能：模型通常只记得名字，拿不到 ID。 */
function findCustomSkill(ref: unknown) {
  const key = String(ref || "").trim();
  if (!key) return undefined;
  const skills = customSkillsStore.getAll();
  return (
    skills.find((skill) => skill.id === key) ||
    skills.find((skill) => skill.name === key) ||
    skills.find((skill) => skill.name.toLowerCase() === key.toLowerCase()) ||
    skills.find((skill) => skill.name.includes(key) || key.includes(skill.name))
  );
}

const customSkillTools: Tool[] = [
  {
    name: "list_custom_skills",
    description: "列出自定义技能",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "active"], description: "筛选条件" },
      },
    },
    execute: async (args) => {
      const skills = args.filter === "active" ? customSkillsStore.getActive() : customSkillsStore.getAll();
      if (skills.length === 0) return "暂无自定义技能";
      return skills
        .map((skill) => `${skill.active ? "[启用]" : "[停用]"} ${skill.name}（ID: ${skill.id}）：${skill.description}`)
        .join("\n");
    },
  },
  {
    name: "create_custom_skill",
    description: "创建自定义技能",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名称" },
        description: { type: "string", description: "技能描述" },
        category: { type: "string", description: "分类" },
        instructions: { type: "string", description: "使用说明" },
        examples: { type: "string", description: "示例，用 | 分隔" },
        tags: { type: "string", description: "标签，用逗号分隔" },
      },
      required: ["name", "description"],
    },
    execute: async (args) => {
      const skill = customSkillsStore.create({
        name: args.name as string,
        description: args.description as string,
        category: (args.category as string) || "其他",
        instructions: (args.instructions as string) || "",
        examples: args.examples ? String(args.examples).split("|").map((item) => item.trim()) : [],
        tags: args.tags ? String(args.tags).split(",").map((item) => item.trim()) : [],
        active: true,
      });
      return `已创建自定义技能：${skill.name}`;
    },
  },
  {
    name: "toggle_custom_skill",
    description: "启用或停用自定义技能（可传技能 ID 或名称）",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "技能 ID 或技能名称" },
        active: { type: "boolean", description: "true=启用，false=停用；不传则切换当前状态" },
      },
      required: ["id"],
    },
    execute: async (args) => {
      const found = findCustomSkill(args.id);
      if (!found) return `未找到技能「${String(args.id || "")}」，可先用 list_custom_skills 查看名称和 ID。`;
      const skill =
        typeof args.active === "boolean" && found.active === args.active
          ? found
          : customSkillsStore.toggleActive(found.id);
      if (!skill) return "未找到该技能";
      return skill.active ? `已启用技能：${skill.name}` : `已停用技能：${skill.name}`;
    },
  },
  {
    name: "delete_custom_skill",
    description: "删除自定义技能（可传技能 ID 或名称）",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "技能 ID 或技能名称" },
      },
      required: ["id"],
    },
    execute: async (args) => {
      const found = findCustomSkill(args.id);
      if (!found) return `未找到技能「${String(args.id || "")}」，可先用 list_custom_skills 查看名称和 ID。`;
      customSkillsStore.delete(found.id);
      return `已删除自定义技能：${found.name}`;
    },
  },
];

const knowledgeTools: Tool[] = [
  {
    name: "get_today_news",
    description: "获取今天的新闻热点，并以 Markdown 返回。适合每日简报、主动播报、用户询问今天新闻时使用。",
    parameters: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "是否忽略本地缓存重新拉取" },
      },
    },
    execute: async (args) => {
      const items = await fetchTodayNews(Boolean(args.force));
      return formatNewsMarkdown(items, "今日新闻");
    },
  },
  {
    name: "ask_pet_to_say",
    description: "让桌面宠物用气泡说一句短话。适合播报新闻、提醒、任务完成反馈。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "宠物要说的话，建议 120 字以内" },
      },
      required: ["message"],
    },
    execute: async (args) => {
      const message = String(args.message || "").trim();
      if (!message) return "没有可播报内容。";
      await emit("pet-say", { message: message.slice(0, 180) });
      return "宠物已经播报。";
    },
  },
];

const systemTools: Tool[] = [
  {
    name: "get_system_info",
    description: "获取系统基本信息",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const now = new Date();
      return [
        `时间：${now.toLocaleString("zh-CN")}`,
        `平台：${navigator.userAgent.includes("Windows") ? "Windows" : "Other"}`,
        `语言：${navigator.language}`,
        `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `屏幕：${screen.width}x${screen.height}`,
        `在线：${navigator.onLine ? "是" : "否"}`,
      ].join("\n");
    },
  },
  {
    name: "open_url",
    description: "在浏览器中打开 URL",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "网址" },
      },
      required: ["url"],
    },
    execute: async (args) => {
      const url = String(args.url || "");
      if (!url.startsWith("http")) return "请输入完整 URL";
      if (!(await confirmSystemAction(`皮卡准备打开网页：${url}`, "network"))) return "已取消打开网页。";
      await open(url);
      return `正在打开：${url}`;
    },
  },
  {
    name: "delegate_task",
    description: "把任务下发给专家模型（DeepSeek / Claude / 本地模型）并行执行并汇总，桌面宠物作为大总管",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "要委派的任务；多段用分号或换行分隔可分给不同专家" },
        mode: { type: "string", enum: ["parallel", "review"], description: "parallel=各自完成，review=各自复核挑错" },
      },
      required: ["task"],
    },
    execute: async (args) => {
      const task = String(args.task || "").trim();
      if (!task) return "请提供要下发的任务。";
      // 动态 import 打破 tools -> kernel -> tools 的循环依赖。
      const { useExpertStore } = await import("../store/experts");
      const { planDelegation, runDelegation, formatDelegationReport } = await import("./orchestrator");
      const mode = args.mode === "review" ? ("review" as const) : ("parallel" as const);
      const tasks = planDelegation(task, useExpertStore.getState().experts, mode);
      if (tasks.length === 0) {
        return "没有可用专家。请先到「总管」面板启用专家并填写对应的 API Key。";
      }
      const results = await runDelegation(tasks);
      return formatDelegationReport(results);
    },
  },
  {
    name: "open_app",
    description: "打开电脑上的应用程序",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "应用名、exe 路径、网址或系统入口" },
      },
      required: ["target"],
    },
    execute: async (args) => {
      const target = String(args.target || "");
      if (!target.trim()) return "请提供要打开的应用或路径";
      if (!(await confirmSystemAction(`皮卡准备打开：${target}`))) return "已取消打开应用。";
      try {
        return await invoke<string>("launch_app", { target });
      } catch (error) {
        return `打开失败：${error}`;
      }
    },
  },
  {
    name: "system_action",
    description: "执行常用系统动作",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open_app", "open_settings", "open_explorer", "open_notepad", "open_calc", "open_task_manager", "open_terminal", "open_url"],
          description: "系统动作类型",
        },
        target: { type: "string", description: "可选目标，例如应用名、URL 或路径" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args.action || "");
      const target = args.target ? String(args.target) : "";
      if (!(await confirmSystemAction(`皮卡准备执行系统动作：${action}${target ? `\n目标：${target}` : ""}`))) {
        return "已取消系统动作。";
      }
      try {
        return await invoke<string>("system_action", {
          action,
          target: target || undefined,
        });
      } catch (error) {
        return `系统动作失败：${error}`;
      }
    },
  },
];

const activityTools: Tool[] = [
  {
    name: "get_activity_summary",
    description: "读取今天的电脑活动摘要（软件使用时长、专注度、打开的文件、复制内容）。查其它日期或搜索具体记录用 timeline_day_report / timeline_search。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const state = useActivityStore.getState();
      if (!state.enabled) return "本地活动观察未开启。请到设置 -> AI 能力 -> 本地活动观察 开启。";
      const { dayReport } = await import("./timeline");
      const report = await dayReport("today");
      return [report, "---", state.getSummary()].join("\n\n");
    },
  },
  {
    name: "clear_activity_log",
    description: "清空本地活动观察记录",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      useActivityStore.getState().clear();
      return "本地活动记录已清空。";
    },
  },
];

export { todoStore, calendarStore };

export function getAllTools(): Tool[] {
  return [
    ...todoTools,
    ...calendarTools,
    ...shortcutTools,
    ...clipboardTools,
    ...customSkillTools,
    ...knowledgeTools,
    ...systemTools,
    ...activityTools,
  ];
}
