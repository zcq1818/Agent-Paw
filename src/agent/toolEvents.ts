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
