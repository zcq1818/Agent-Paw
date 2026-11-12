/** 工具调用 / 审批的结构化事件与状态。零依赖，便于独立测试。 */

export type ToolRunStatus = "pending" | "running" | "done" | "error";

export interface ToolRun {
  id: string;
  name: string;
  /** 原始参数 JSON 字符串，展示时再解析。 */
  args?: string;
  status: ToolRunStatus;
  result?: string;
  /** 审批类事件的补充说明。 */
  detail?: string;
  startedAt: number;
  durationMs?: number;
}

export type ToolEvent =
  | { type: "start"; id: string; name: string; args: string; at: number }
  | { type: "finish"; id: string; name: string; status: "done" | "error"; result: string; at: number }
  | {
      type: "approval";
      id: string;
      status: "pending" | "done" | "error";
      detail: string;
      at: number;
    };

/** 把事件流归约成可渲染的工具调用列表。 */
export function reduceToolRuns(runs: ToolRun[], event: ToolEvent): ToolRun[] {
  if (event.type === "start") {
    return [
      ...runs,
      { id: event.id, name: event.name, args: event.args, status: "running", startedAt: event.at },
    ];
  }
  if (event.type === "approval" && event.status === "pending") {
    return [
      ...runs,
      {
        id: event.id,
        name: "审批",
        status: "pending",
        detail: event.detail,
        startedAt: event.at,
      },
    ];
  }
  if (event.type === "approval") {
    return runs.map((run) =>
      run.id === event.id
        ? {
            ...run,
            status: event.status,
            result: event.status === "done" ? "已允许" : "已拒绝",
            durationMs: Math.max(0, event.at - run.startedAt),
          }
        : run
    );
  }
  return runs.map((run) =>
    run.id === event.id
      ? {
          ...run,
          status: event.status,
          result: event.result,
          durationMs: Math.max(0, event.at - run.startedAt),
        }
      : run
  );
}

/** 进度提示里给用户看的动作名（“正在查天气…”），没列出的退回工具名。 */
const TOOL_ACTIONS: Record<string, string> = {
  get_weather: "查天气",
  web_search: "上网搜索",
  get_today_news: "看今天的新闻",
  get_time: "看时间",
  calculate: "算一下",
  add_todo: "记待办",
  list_todos: "翻待办",
  complete_todo: "勾掉待办",
  delete_todo: "删待办",
  get_todo_stats: "统计待办",
  add_event: "加日程",
  list_events: "翻日程",
  delete_event: "删日程",
  get_upcoming_schedule: "看接下来的安排",
  add_memory: "记下来",
  search_memory: "翻记忆",
  read_clipboard: "看剪贴板",
  write_clipboard: "写剪贴板",
  open_app: "打开应用",
  open_url: "打开网页",
  system_action: "执行系统动作",
  run_shortcut: "运行快捷命令",
  get_system_info: "看电脑状态",
  get_activity_summary: "回顾你的活动",
  timeline_search: "翻活动记录",
  timeline_day_report: "整理今天做了什么",
  capture_screen: "截屏",
  capture_and_analyze: "看屏幕",
  analyze_image: "看图片",
  upload_and_analyze: "看图片",
  computer_read_screen: "读屏幕",
  computer_list_windows: "看开着的窗口",
  computer_click: "点击",
  computer_type: "输入文字",
  computer_press_keys: "按快捷键",
  computer_scroll: "滚动",
  computer_window: "切换窗口",
  computer_run_command: "执行命令",
  computer_read_file: "读文件",
  computer_write_file: "写文件",
  computer_list_files: "看文件夹",
  run_app_flow: "执行签到流程",
  list_app_flows: "看签到流程",
  create_app_flow: "学新流程",
  create_automation: "建自动任务",
  list_automations: "看自动任务",
  open_in_trae: "用 Trae 打开",
  open_workbuddy: "打开 WorkBuddy",
  list_ai_apps: "找 AI 软件",
  delegate_task: "请专家帮忙",
  speak: "说话",
  ask_pet_to_say: "说话",
  审批: "等你确认",
};

/** 外部 MCP 工具在加载时登记自己的显示名（“用 GitHub 的 search_issues”）。 */
const dynamicActions = new Map<string, string>();

export function registerToolAction(name: string, label: string) {
  dynamicActions.set(name, label);
}

export function toolActionLabel(name: string): string {
  return TOOL_ACTIONS[name] || dynamicActions.get(name) || `调用 ${name}`;
}

/** 从参数 JSON 里挑出最有信息量的几个字段做摘要。 */
export function summarizeArgs(raw?: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed).slice(0, 2);
    return entries
      .map(([key, value]) => {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
      })
      .join(" · ");
  } catch {
    return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  }
}

/**
 * 模块级事件总线：让 tools.ts 里的审批等待能通知到 agent store，
 * 不必把回调一路透传进 kernel 的工具循环。
 */
type Listener = (event: ToolEvent) => void;
const listeners = new Set<Listener>();

export function subscribeToolEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitToolEvent(event: ToolEvent): void {
  listeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // 单个订阅者出错不影响其他订阅者与工具执行。
    }
  });
}
