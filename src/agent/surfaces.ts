import { calendarStore, todoStore } from "./tools";

export type SurfaceIntent = "help" | "task" | "system" | "weather" | "memory" | "skill";

export type SurfaceSpec = {
  id: string;
  title: string;
  intent: SurfaceIntent;
  createdAt: string;
  summary?: string;
  metrics?: Array<{ label: string; value: string | number; tone?: "default" | "good" | "warn" | "danger" }>;
  items?: Array<{ id: string; title: string; meta?: string; tone?: "default" | "good" | "warn" | "danger"; done?: boolean }>;
  actions?: Array<{ id: string; label: string; prompt: string; style?: "primary" | "secondary" | "danger" }>;
};

function surfaceId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createTaskSurface(): SurfaceSpec {
  const stats = todoStore.getStats();
  const todos = todoStore.getAll().slice(0, 8);
  const events = calendarStore.getUpcoming(5);
  return {
    id: surfaceId("surface_task"),
    title: "任务与日程",
    intent: "task",
    createdAt: new Date().toISOString(),
    summary: todos.length || events.length ? "这里是最近的待办和即将到来的日程。" : "暂时没有待办和日程。",
    metrics: [
      { label: "未完成", value: stats.total - stats.completed, tone: stats.total - stats.completed > 0 ? "warn" : "good" },
      { label: "已逾期", value: stats.overdue, tone: stats.overdue > 0 ? "danger" : "default" },
      { label: "高优先", value: stats.byPriority.high, tone: stats.byPriority.high > 0 ? "danger" : "default" },
    ],
    items: [
      ...todos.map((todo) => ({
        id: todo.id,
        title: todo.text,
        meta: todo.dueDate ? `截止：${new Date(todo.dueDate).toLocaleString("zh-CN")}` : `优先级：${todo.priority}`,
        tone: todo.completed ? "good" as const : todo.priority === "high" ? "danger" as const : "default" as const,
        done: todo.completed,
      })),
      ...events.map((event) => ({
        id: event.id,
        title: event.title,
        meta: `日程：${new Date(event.startTime).toLocaleString("zh-CN")}`,
        tone: "warn" as const,
      })),
    ],
    actions: [
      { id: "open_tasks", label: "打开任务面板", prompt: "打开任务面板", style: "primary" },
      { id: "add_todo", label: "新增待办", prompt: "帮我新增一个待办：", style: "secondary" },
    ],
  };
}

export function createSystemSurface(): SurfaceSpec {
  return {
    id: surfaceId("surface_system"),
    title: "系统快捷操作",
    intent: "system",
    createdAt: new Date().toISOString(),
    summary: "这些操作会在执行前再次确认。",
    metrics: [
      { label: "平台", value: navigator.userAgent.includes("Windows") ? "Windows" : "Other" },
      { label: "网络", value: navigator.onLine ? "在线" : "离线", tone: navigator.onLine ? "good" : "danger" },
      { label: "语言", value: navigator.language || "zh-CN" },
    ],
    items: [
      { id: "notepad", title: "记事本", meta: "打开 notepad.exe" },
      { id: "calc", title: "计算器", meta: "打开 calc.exe" },
      { id: "settings", title: "系统设置", meta: "打开 Windows 设置" },
      { id: "explorer", title: "资源管理器", meta: "打开文件管理器" },
    ],
    actions: [
      { id: "open_notepad", label: "记事本", prompt: "打开记事本", style: "secondary" },
      { id: "open_calc", label: "计算器", prompt: "打开计算器", style: "secondary" },
      { id: "open_settings", label: "设置", prompt: "打开系统设置", style: "primary" },
    ],
  };
}

export function createHelpSurface(): SurfaceSpec {
  return {
    id: surfaceId("surface_help"),
    title: "Paw 能做什么",
    intent: "help",
    createdAt: new Date().toISOString(),
    summary: "参考 Meow-Pilot 的思路，Paw 正在向“桌面 Agent 宠物”靠近。",
    metrics: [
      { label: "聊天", value: "支持" },
      { label: "记忆", value: "本地" },
      { label: "工具", value: "确认后执行" },
    ],
    items: [
      { id: "chat", title: "随手聊天", meta: "主窗口或小窗口都能对话" },
      { id: "tasks", title: "待办和日程", meta: "创建、查看、完成、删除任务" },
      { id: "apps", title: "打开应用", meta: "打开记事本、计算器、设置、网页等" },
      { id: "memory", title: "长期记忆", meta: "保存偏好和重要信息" },
      { id: "skills", title: "自定义技能", meta: "维护可复用工作流" },
    ],
    actions: [
      { id: "show_tasks", label: "查看任务", prompt: "查看我的任务", style: "primary" },
      { id: "show_system", label: "系统快捷操作", prompt: "打开系统快捷操作", style: "secondary" },
    ],
  };
}
