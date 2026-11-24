/**
 * 工具按需加载：常用工具每次都带完整定义；不常用的内置工具和所有外部 MCP 工具
 * 只在系统提示里列名字，模型要用时先调 load_tools 把定义加载进来，下一轮就能调用。
 * 工具一多（尤其接了几个 MCP 服务）能省下大量 token，也不会撞上部分模型的工具数量上限。
 */

type ToolLike = { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> };

export const LOAD_TOOLS_NAME = "load_tools";

/** 每次都带完整定义的内置工具（其余内置工具和全部 MCP 工具按需加载） */
const CORE_TOOLS = new Set([
  "web_search",
  "read_webpage",
  "get_time",
  "get_weather",
  "calculate",
  "add_memory",
  "search_memory",
  "add_todo",
  "list_todos",
  "complete_todo",
  "add_event",
  "list_events",
  "open_url",
  "open_app",
  "system_action",
  "read_clipboard",
  "write_clipboard",
  "ask_pet_to_say",
  "delegate_task",
  "use_skill",
  "read_skill_file",
  "start_job",
  "get_jobs",
  "create_automation",
  "list_app_flows",
  "run_app_flow",
  "read_document",
  "look_at_image",
  "timeline_search",
  "timeline_day_report",
  "paw_help",
  "paw_settings",
  "paw_open",
  "paw_status",
  "paw_pet_action",
]);

const DEFER_KEY = "paw_defer_tools";

/** 默认开启；在上下文面板里可以关掉（每次都带全部工具） */
export function deferToolsEnabled() {
  try {
    return localStorage.getItem(DEFER_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDeferToolsEnabled(enabled: boolean) {
  localStorage.setItem(DEFER_KEY, enabled ? "on" : "off");
}

/** 可加载工具少于这个数就不折腾了，全部直接带上 */
const MIN_DEFERRED = 6;
/** 一次 load_tools 按关键词最多加载几个 */
const MAX_PER_QUERY = 8;

const MCP_PREFIX = /^\[外部 MCP：([^\]]+)\]\s*/;

export function isMcpTool(tool: ToolLike) {
  return tool.name.startsWith("mcp_") || MCP_PREFIX.test(tool.description);
}

function isCore(tool: ToolLike) {
  return CORE_TOOLS.has(tool.name) || tool.name.startsWith("computer_") || tool.name.startsWith("work_");
}

/** 每个会话记住已经加载过的工具，后面几轮接着用不用重新加载 */
const loadedByConversation = new Map<string, Set<string>>();

export function loadedToolsFor(key: string | undefined): Set<string> {
  if (!key) return new Set();
  let set = loadedByConversation.get(key);
  if (!set) {
    set = new Set();
    loadedByConversation.set(key, set);
  }
  return set;
}

export interface ToolPlan<T extends ToolLike> {
  /** 全部工具（执行时按名字找） */
  all: T[];
  /** 每轮都带完整定义的 */
  core: T[];
  /** 只列名字、按需加载的 */
  deferred: T[];
  /** 本会话已加载的工具名 */
  loaded: Set<string>;
  /** 是否启用了按需加载 */
  enabled: boolean;
}

export function planTools<T extends ToolLike>(tools: T[], extraNames: Set<string>, conversationKey?: string, enabled = true): ToolPlan<T> {
  const loaded = loadedToolsFor(conversationKey);
  const core: T[] = [];
  const deferred: T[] = [];
  for (const tool of tools) {
    if (extraNames.has(tool.name) || isCore(tool)) core.push(tool);
    else deferred.push(tool);
  }
  if (!enabled || deferred.length < MIN_DEFERRED) return { all: tools, core: tools, deferred: [], loaded, enabled: false };
  return { all: tools, core, deferred, loaded, enabled: true };
}

/** 这一轮要发给模型的工具：常用的 + 已加载的 + load_tools */
export function activeTools<T extends ToolLike>(plan: ToolPlan<T>, loader?: T): T[] {
  if (!plan.enabled) return plan.core;
  const loaded = plan.deferred.filter((tool) => plan.loaded.has(tool.name));
  return [...plan.core, ...loaded, ...(loader ? [loader] : [])];
}

function shortDescription(tool: ToolLike, max = 80) {
  const text = tool.description.replace(MCP_PREFIX, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 系统提示里的“可加载工具”目录：内置的列名字，MCP 按服务分组列名字 */
export function deferredIndexPrompt<T extends ToolLike>(plan: ToolPlan<T>): string {
  if (!plan.enabled) return "";
  const builtin: string[] = [];
  const byServer = new Map<string, string[]>();
  for (const tool of plan.deferred) {
    if (plan.loaded.has(tool.name)) continue;
    const server = tool.description.match(MCP_PREFIX)?.[1];
    if (server || tool.name.startsWith("mcp_")) {
      const key = server || "外部 MCP";
      byServer.set(key, [...(byServer.get(key) || []), tool.name]);
    } else {
      builtin.push(tool.name);
    }
  }
  if (!builtin.length && !byServer.size) return "";
  const lines = [
    "## 可按需加载的工具",
    `下面这些工具只列了名字，定义还没加载，不能直接调用。要用时先调用 ${LOAD_TOOLS_NAME}：names 填确切的工具名（可以一次填多个），不确定名字就用 query 写关键词搜索。加载后下一步就能调用。用户的需求明显要用到它们时不要说自己做不到。`,
  ];
  if (builtin.length) lines.push(`- 内置：${builtin.join(", ")}`);
  for (const [server, names] of byServer) lines.push(`- ${server}（外部 MCP，${names.length} 个）：${names.join(", ")}`);
  return lines.join("\n");
}

function score(tool: ToolLike, terms: string[]) {
  const name = tool.name.toLowerCase();
  const desc = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (name === term) total += 10;
    else if (name.includes(term)) total += 4;
    if (desc.includes(term)) total += 1;
  }
  return total;
}

/** load_tools：按名字或关键词把工具定义加载进来 */
export function createLoaderTool<T extends ToolLike>(plan: ToolPlan<T>, onLoaded?: (names: string[]) => void): ToolLike {
  return {
    name: LOAD_TOOLS_NAME,
    description: "加载“可按需加载的工具”的完整定义，加载后下一步就能调用。names 填确切工具名；不知道名字时用 query 写关键词搜索。",
    parameters: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "要加载的工具名" },
        query: { type: "string", description: "关键词，按名字和用途搜索" },
      },
    },
    execute: async (args) => {
      const names = Array.isArray(args.names) ? args.names.map((item) => String(item).trim()).filter(Boolean) : [];
      const query = String(args.query || "").trim().toLowerCase();
      const picked: T[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const tool = plan.deferred.find((item) => item.name === name) || plan.core.find((item) => item.name === name);
        if (tool) picked.push(tool);
        else missing.push(name);
      }
      if (query) {
        const terms = query.split(/[\s,，、]+/).filter(Boolean);
        plan.deferred
          .map((tool) => ({ tool, value: score(tool, terms) }))
          .filter((item) => item.value > 0)
          .sort((a, b) => b.value - a.value)
          .slice(0, MAX_PER_QUERY)
          .forEach((item) => {
            if (!picked.includes(item.tool)) picked.push(item.tool);
          });
      }
      if (!picked.length) {
        const hint = missing.length ? `没有叫 ${missing.join("、")} 的工具。` : "没有找到相关工具。";
        return `${hint}可加载的工具名见系统提示里的“可按需加载的工具”。`;
      }
      const fresh = picked.filter((tool) => !plan.loaded.has(tool.name) && plan.deferred.includes(tool));
      for (const tool of fresh) plan.loaded.add(tool.name);
      if (fresh.length) onLoaded?.(fresh.map((tool) => tool.name));
      const lines = picked.map((tool) => `- ${tool.name}：${shortDescription(tool, 120)}`);
      return `已加载，下一步可以直接调用：\n${lines.join("\n")}${missing.length ? `\n（没找到：${missing.join("、")}）` : ""}`;
    },
  };
}
