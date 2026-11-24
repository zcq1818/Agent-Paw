import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore, type ChatTarget, type Message } from "./chat";
import { loadConfig, streamChat } from "../agent/kernel";
import { prepareHistory } from "../agent/compaction";
import { contextWindowFor, usageKey, useContextUsageStore } from "../agent/contextUsage";
import { memoryStore, type MemoryType } from "../agent/memory";
import { createHelpSurface, createSystemSurface, createTaskSurface, type SurfaceSpec } from "../agent/surfaces";
import { useActivityStore } from "./activity";
import { BOND_GAIN_EVENT } from "../agent/bond";
import { reduceToolRuns, subscribeToolEvents, type ToolEvent, type ToolRun } from "../agent/toolEvents";
import { confirmSystemAction } from "../agent/tools";
import { getActiveBotId } from "../agent/scope";
import { bubbleText } from "../utils/bubbleText";
import { clearInterjections, pushInterjection, takeInterjections } from "../agent/interjections";

interface AgentState {
  isStreaming: boolean;
  streamText: string;
  error: string | null;
  /** 本次回复期间实时累积的工具调用，供流式气泡展示。 */
  currentToolRuns: ToolRun[];
  /** 正在把前面的对话压缩成摘要 */
  compacting: boolean;
  /** 手动压缩当前对话（保留最近几条），返回给用户看的结果 */
  compactNow: () => Promise<string>;
  sendMessage: (text: string, options?: { followUp?: boolean }) => Promise<void>;
  /** 运行中插话：消息先显示出来，模型在下一轮（或这次回复结束后）处理。 */
  interject: (text: string) => void;
  stopGeneration: () => void;
  retryLast: () => Promise<void>;
  continueLast: () => Promise<void>;
}

let activeController: AbortController | null = null;

/** 最近几条带工具调用的回复，把工具结果摘要一起放进历史 */
const TOOL_CONTEXT_REPLIES = 3;
const TOOL_CONTEXT_CHARS = 2400;
/** 这些工具的结果很长、需要时可以重新读，只记一笔调用过 */
const BRIEF_RESULT_TOOLS = new Set(["use_skill", "read_skill_file"]);

function toolContext(runs?: ToolRun[]): string {
  const useful = (runs || []).filter((run) => run.name !== "审批" && run.result);
  if (useful.length === 0) return "";
  let budget = TOOL_CONTEXT_CHARS;
  const lines: string[] = [];
  for (const run of useful) {
    if (budget <= 0) break;
    let args = "";
    try {
      args = JSON.stringify(JSON.parse(run.args || "{}"));
    } catch {
      args = run.args || "";
    }
    const result = BRIEF_RESULT_TOOLS.has(run.name)
      ? "（已读取）"
      : (run.result || "").replace(/\s+/g, " ").slice(0, Math.min(1200, budget));
    budget -= result.length;
    lines.push(`- ${run.name} ${args.slice(0, 200)} → ${result}`);
  }
  return `\n\n<tool_history>\n（这条回复调用过的工具和结果摘要，用户看不到；接着聊时直接引用，不用重复搜索）\n${lines.join("\n")}\n</tool_history>`;
}

/**
 * 组装发给模型的历史：太长就把较早的消息压缩成摘要（存回会话），
 * 最近几条回复用过的工具结果一起带上。
 */
async function buildHistory(target: ChatTarget, messages: Message[], force: boolean, setCompacting: (value: boolean) => void) {
  const conversation = useChatStore.getState().conversations.find((item) => item.id === target.conversationId);
  const config = loadConfig();
  const key = usageKey(target.botId, target.conversationId);
  const last = useContextUsageStore.getState().byKey[key];
  const overhead = last
    ? last.parts
        .filter((part) => !part.deferred && part.key !== "messages" && part.key !== "summary" && part.key !== "toolResults")
        .reduce((sum, part) => sum + part.tokens, 0)
    : 9000;
  let prepared;
  try {
    prepared = await prepareHistory({
      messages: messages.filter((message) => message.content.trim()),
      summary: conversation?.summary,
      summaryUpTo: conversation?.summaryUpTo,
      summarizedCount: conversation?.summarizedCount,
      window: contextWindowFor(config.model),
      overhead,
      reserve: config.maxTokens ?? 4096,
      force,
      onCompacting: () => setCompacting(true),
    });
  } finally {
    setCompacting(false);
  }
  if (prepared.updated) useChatStore.getState().setSummary(target, prepared.updated);

  const recent = prepared.recent as Message[];
  // 最近几条回复用过的工具（搜到了什么、读了哪个网页）一起带上，追问“第二条展开说说”时模型才接得上
  const withTools = new Set(
    recent
      .map((message, index) => (message.role === "assistant" && message.toolRuns?.length ? index : -1))
      .filter((index) => index >= 0)
      .slice(-TOOL_CONTEXT_REPLIES)
  );
  const history = recent.map((message, index) => ({
    role: message.role,
    content: withTools.has(index) ? `${message.content}${toolContext(message.toolRuns)}` : message.content,
  }));
  return { history, summary: prepared.summary, compacted: prepared.compacted, newlyCompacted: prepared.updated ? prepared.updated.count : 0, key };
}

/** 发给桌宠气泡的摘要：保留 Markdown，表格 / 代码换成提示，按行截断。 */
function summarizeForBubble(text: string) {
  return bubbleText(text);
}

async function notifyPet(event: string, payload?: Record<string, unknown>) {
  try {
    await emit(event, payload);
  } catch {
    // Browser dev fallback.
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function detectLocalAppTarget(text: string): string | null {
  const input = text.trim().replace(/[。.!！?？]+$/, "");
  const command = input.match(/^(?:帮我|请帮我|请|皮卡|麻烦)?\s*(?:打开|启动|运行|open|launch|start)\s*(.+)$/i);
  if (!command || input.length > 40) return null;
  const subject = command[1].trim();

  const url = subject.match(/^https?:\/\/\S+$/i)?.[0];
  if (url) return url;

  const aliases: Array<[RegExp, string]> = [
    [/记事本|notepad/i, "notepad"],
    [/计算器|calculator|calc/i, "calculator"],
    [/资源管理器|文件管理器|explorer/i, "explorer"],
    [/任务管理器|task\s*manager|taskmgr/i, "task manager"],
    [/系统设置|设置|settings/i, "settings"],
    [/命令行|终端|terminal|cmd/i, "terminal"],
    [/画图|paint|mspaint/i, "paint"],
    [/浏览器|browser|edge/i, "https://www.bing.com"],
    [/github/i, "https://github.com"],
    [/百度|baidu/i, "https://www.baidu.com"],
    [/谷歌|google/i, "https://www.google.com"],
  ];

  // 别名必须匹配整个目标：“打开记事本，输入一句话”这类带后续步骤的指令要交给模型，
  // 否则只打开软件就结束了。也避免 "knowledge" 里的 "edge" 之类误命中。
  for (const [pattern, target] of aliases) {
    if (new RegExp(`^(${pattern.source})\\s*(一下|吧)?$`, "i").test(subject)) return target;
  }

  // 自定义目标只接受路径 / exe，或不含空格的短名称（如“微信”“steam”）；
  // 其余像句子的输入（“start a React project”）交给模型处理。
  const looksLikePath = /^[a-z]:[\\/]|^\\\\|\.exe$/i.test(subject);
  const looksLikeName = !/\s/.test(subject) && subject.length >= 2 && subject.length <= 12;
  return looksLikePath || looksLikeName ? subject : null;
}

async function tryHandleLocalSystemCommand(text: string): Promise<string | null> {
  const target = detectLocalAppTarget(text);
  if (!target) return null;

  // 与工具调用统一走内联审批卡片（window.confirm 会阻塞整个窗口）。
  if (!(await confirmSystemAction(`皮卡准备打开：${target}`))) {
    return "已取消打开应用。";
  }

  try {
    const result = await invoke<string>("launch_app", { target });
    return `${result}。`;
  } catch (error) {
    return `我尝试打开“${target}”，但是失败了：${error}`;
  }
}

function createLocalSurface(text: string): { content: string; surface: SurfaceSpec } | null {
  const input = text.trim();
  if (/^(你|皮卡)?(能|会|可以)?(做|干)?(什么|啥)[?？]*$|^(你有)?(哪些|什么)功能[?？]*$|^(帮助|help|功能介绍|使用说明)[?？!！]*$/i.test(input)) {
    return {
      content: "我整理了一张能力卡片，你可以从这里继续点选。",
      surface: createHelpSurface(),
    };
  }

  if (input.length <= 20 && /^(查看|打开|列出|看看|看下|看一下|show|list)\s*(我的)?(今天的)?(任务|待办|日程|todo|todos|schedule)/i.test(input)) {
    return {
      content: "这是你最近的任务和日程。",
      surface: createTaskSurface(),
    };
  }

  if (input.length <= 20 && /^(系统快捷|快捷操作|系统状态|system)/i.test(input)) {
    return {
      content: "我准备了一张系统快捷操作卡片，执行前都会再次确认。",
      surface: createSystemSurface(),
    };
  }

  return null;
}

function extractExplicitMemory(text: string): string | null {
  const patterns = [
    /^(?:请|帮我|皮卡)?\s*(?:记住|记一下|记下)[:：,，\s]\s*(.+)$/is,
    /^(?:你要|你需要|要|请)记得[:：,，\s]\s*(.+)$/is,
  ];
  const input = text.trim();
  for (const pattern of patterns) {
    const value = input.match(pattern)?.[1]?.trim();
    if (value && value.length >= 2) return value;
  }
  return null;
}

function inferMemoryType(text: string): MemoryType {
  if (/(喜欢|偏好|讨厌|希望|风格)/.test(text)) return "preference";
  if (/(习惯|每天|经常|通常|常用)/.test(text)) return "habit";
  if (/(待办|任务|计划|提醒|要做)/.test(text)) return "task";
  if (/(重要|必须|关键|不要忘)/.test(text)) return "important";
  return "fact";
}

async function tryHandleMemoryCommand(text: string): Promise<string | null> {
  const explicit = extractExplicitMemory(text);
  if (explicit) {
    const existing = await memoryStore.search(explicit, 3);
    const duplicate = existing.some((memory) => memory.content.includes(explicit) || explicit.includes(memory.content));
    if (!duplicate) {
      await memoryStore.add({
        type: inferMemoryType(text),
        content: explicit,
        tags: [],
        priority: /(重要|必须|不要忘)/.test(text) ? "high" : "medium",
        importance: /(重要|必须|不要忘)/.test(text) ? 8 : 6,
      });
    }
    return `我已经记住了：${explicit}`;
  }

  if (/^(你都?记得(什么|啥)|读取记忆|查看记忆|我的记忆|你知道我(什么|啥)|我喜欢什么|我的偏好(是什么)?)[?？]*$/i.test(text.trim())) {
    const memories = await memoryStore.search(text, 8);
    if (memories.length === 0) return "我现在还没有保存到可用记忆。你可以直接说“记住：我喜欢……”。";
    return `我找到这些相关记忆：\n${memories.map((memory) => `- [${memory.type}] ${memory.content}`).join("\n")}`;
  }

  return null;
}

function tryHandleActivityCommand(text: string): string | null {
  if (!/(活动观察|活动监控|活动记录|活动日志|电脑活动|电脑使用|使用情况|我(今天|最近)?(都)?在(电脑上)?(干嘛|做什么|干什么)|用了哪些(应用|软件))/.test(text)) return null;
  const activity = useActivityStore.getState();
  if (/(开启|打开|启用).*(活动|观察|监控)/.test(text)) {
    activity.setEnabled(true);
    return "已开启本地活动观察。我只会在本机记录当前活动窗口标题和进程名，不截图、不记录键盘、不上传。";
  }
  if (/(关闭|停止|停用).*(活动|观察|监控)/.test(text)) {
    activity.setEnabled(false);
    return "已关闭本地活动观察。";
  }
  if (/(清空|删除).*(活动|记录|日志)/.test(text)) {
    activity.clear();
    return "本地活动记录已清空。";
  }
  if (/(分析|总结|查看|读取|今天|最近)/.test(text)) {
    if (!activity.enabled) return "本地活动观察还没开启。你可以说“开启本地活动观察”。";
    return activity.getSummary();
  }
  return null;
}

export const useAgentStore = create<AgentState>((set) => ({
  isStreaming: false,
  streamText: "",
  error: null,
  currentToolRuns: [],
  compacting: false,

  compactNow: async () => {
    if (useAgentStore.getState().isStreaming || useAgentStore.getState().compacting) return "正在回复中，等这条回完再压缩。";
    const target = { botId: getActiveBotId(), conversationId: useChatStore.getState().activeConversationId };
    const before = useChatStore.getState().conversations.find((item) => item.id === target.conversationId)?.summarizedCount || 0;
    const result = await buildHistory(target, useChatStore.getState().messages, true, (value) => set({ compacting: value }));
    useContextUsageStore.getState().patch(result.key, { compacted: result.compacted });
    if (result.newlyCompacted > before) return `已把前面 ${result.newlyCompacted} 条消息整理成摘要，之后只带摘要和最近几条。`;
    return "没有可以压缩的内容，或者当前模型不支持（本机 Claude / CodeBuddy 不能用来总结）。";
  },

  sendMessage: async (text: string, sendOptions?: { followUp?: boolean }) => {
    activeController?.abort();
    if (!sendOptions?.followUp) clearInterjections();
    // 用局部变量持有本次的 controller：如果上一轮还没结束，它的 finally
    // 不能把这一轮的 controller 清空、也不能把 isStreaming 置回 false。
    const controller = new AbortController();
    activeController = controller;
    set({ isStreaming: true, streamText: "", error: null, currentToolRuns: [] });
    notifyPet("pet-thinking");
    // 成长：每条消息记聊天经验（桌宠窗口统一记账）
    if (!sendOptions?.followUp) notifyPet(BOND_GAIN_EVENT, { source: "chat" });

    // 记住发起时的 Bot 和会话：生成期间切换 Bot / 会话，回复也写回原处。
    const target = { botId: getActiveBotId(), conversationId: useChatStore.getState().activeConversationId };
    const addMessage = (msg: Parameters<ReturnType<typeof useChatStore.getState>["addMessage"]>[0]) =>
      useChatStore.getState().addMessageTo(target, msg);
    let messages = useChatStore.getState().messages;
    if (sendOptions?.followUp) {
      // 插话已经显示在上一条回复之前；作为新一轮发送时挪到最后，模型才知道这是现在要回应的话
      const parts = new Set(text.split("\n").map((line) => line.trim()));
      const kept = [...messages];
      for (let i = kept.length - 1; i >= 0 && parts.size; i -= 1) {
        if (kept[i].role === "user" && parts.has(kept[i].content.trim())) {
          parts.delete(kept[i].content.trim());
          kept.splice(i, 1);
        }
      }
      messages = [...kept, { ...messages[messages.length - 1], role: "user", content: text }];
    }
    let toolRuns: ToolRun[] = [];
    const unsubscribeToolEvents = subscribeToolEvents((event) => {
      toolRuns = reduceToolRuns(toolRuns, event);
      set({ currentToolRuns: [...toolRuns] });
    });

    try {
      const memoryResult = await tryHandleMemoryCommand(text);
      if (memoryResult) {
        set({ streamText: memoryResult });
        await sleep(160);
        addMessage({ role: "assistant", content: memoryResult });
        set({ streamText: "" });
        notifyPet("pet-say", { message: summarizeForBubble(memoryResult) });
        return;
      }

      const activityResult = tryHandleActivityCommand(text);
      if (activityResult) {
        set({ streamText: activityResult });
        await sleep(160);
        addMessage({ role: "assistant", content: activityResult });
        set({ streamText: "" });
        notifyPet("pet-say", { message: summarizeForBubble(activityResult) });
        return;
      }

      const localSurface = createLocalSurface(text);
      if (localSurface) {
        addMessage({ role: "assistant", content: localSurface.content, surface: localSurface.surface });
        set({ streamText: "" });
        notifyPet("pet-say", { message: summarizeForBubble(localSurface.content) });
        return;
      }

      const localResult = await tryHandleLocalSystemCommand(text);
      if (localResult) {
        set({ streamText: localResult });
        await sleep(220);
        addMessage({ role: "assistant", content: localResult });
        set({ streamText: "" });
        notifyPet("pet-say", { message: summarizeForBubble(localResult) });
        return;
      }

      const prepared = await buildHistory(target, messages, false, (value) => set({ compacting: value }));
      if (controller.signal.aborted) throw new DOMException("生成已停止", "AbortError");
      const fullText = await streamChat(
        { messages: prepared.history, userMessage: text },
        (chunk) => {
          set((state) => ({ streamText: state.streamText + chunk }));
        },
        {
          signal: controller.signal,
          conversationKey: prepared.key,
          summary: prepared.summary,
          compacted: prepared.compacted,
          onUsage: (usage) => useContextUsageStore.getState().record(prepared.key, usage),
          onToolEvent: (event: ToolEvent) => {
            toolRuns = reduceToolRuns(toolRuns, event);
            set({ currentToolRuns: [...toolRuns] });
          },
        }
      );

      addMessage({ role: "assistant", content: fullText, toolRuns });
      set({ streamText: "", currentToolRuns: [] });
      notifyPet("pet-say", { message: summarizeForBubble(fullText) });
    } catch (err: unknown) {
      // Tauri HTTP 插件取消请求时抛出的是字符串 "Request cancelled"，不是 AbortError，
      // 所以以 signal 状态为准判断是不是用户点了停止。
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        // 用户点了停止：还没处理的插话也一起作废
        if (activeController === controller) clearInterjections();
        const partial = useAgentStore.getState().streamText.trim();
        if (partial) addMessage({ role: "assistant", content: `${partial}\n\n[已停止]`, toolRuns });
        set({ streamText: "", error: null, currentToolRuns: [] });
        notifyPet("pet-say", { message: "已停止回复。" });
        return;
      }

      const errorMsg = err instanceof Error ? err.message : "未知错误";
      const message = `出错了：${errorMsg}\n\n请检查 API Key、模型配置和网络连接。`;
      set({ error: errorMsg });
      addMessage({ role: "assistant", content: message });
      notifyPet("pet-say", { message: `皮卡... ${errorMsg}` });
    } finally {
      unsubscribeToolEvents();
      if (activeController === controller) {
        activeController = null;
        set({ isStreaming: false, currentToolRuns: [] });
        // 这一轮没来得及处理的插话（本机智能体、或者刚好在结束时发的）：接着发一轮
        const leftover = controller.signal.aborted ? [] : takeInterjections();
        if (leftover.length) {
          window.setTimeout(() => {
            void useAgentStore.getState().sendMessage(leftover.join("\n"), { followUp: true });
          }, 50);
        }
      }
    }
  },

  interject: (text: string) => {
    const value = text.trim();
    if (!value) return;
    useChatStore.getState().addMessage({ role: "user", content: value });
    if (useAgentStore.getState().isStreaming) {
      pushInterjection(value);
    } else {
      void useAgentStore.getState().sendMessage(value);
    }
  },

  stopGeneration: () => {
    activeController?.abort();
  },

  retryLast: async () => {
    const chat = useChatStore.getState();
    const lastUser = [...chat.messages].reverse().find((message) => message.role === "user");
    if (!lastUser || useAgentStore.getState().isStreaming) return;
    chat.removeLastAssistant();
    await useAgentStore.getState().sendMessage(lastUser.content);
  },

  continueLast: async () => {
    if (useAgentStore.getState().isStreaming) return;
    const text = "继续刚才的回答。";
    useChatStore.getState().addMessage({ role: "user", content: text });
    await useAgentStore.getState().sendMessage(text);
  },
}));
