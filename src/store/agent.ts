import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "./chat";
import { streamChat } from "../agent/kernel";
import { memoryStore, type MemoryType } from "../agent/memory";
import { customSkillsStore } from "../agent/customSkills";
import { createHelpSurface, createSystemSurface, createTaskSurface, type SurfaceSpec } from "../agent/surfaces";
import { fetchTodayNews, formatNewsMarkdown, markTodayNewsPushed, shouldPushTodayNews } from "../agent/news";
import { useActivityStore } from "./activity";
import { reduceToolRuns, subscribeToolEvents, type ToolEvent, type ToolRun } from "../agent/toolEvents";
import { confirmSystemAction } from "../agent/tools";
import { getActiveBotId } from "../agent/scope";

interface AgentState {
  isStreaming: boolean;
  streamText: string;
  error: string | null;
  /** 本次回复期间实时累积的工具调用，供流式气泡展示。 */
  currentToolRuns: ToolRun[];
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => void;
  retryLast: () => Promise<void>;
  continueLast: () => Promise<void>;
}

let activeController: AbortController | null = null;

/** 发给模型的历史条数上限；不设上限时长对话会超出上下文窗口直接报错。 */
const MAX_HISTORY_MESSAGES = 40;

function summarizeForBubble(text: string) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "我写好了一段代码，详细内容在聊天窗口里。")
    .replace(/[#*_`>\[\]\(\)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 140 ? `${cleaned.slice(0, 140)}...` : cleaned;
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

  // 别名只匹配目标开头，避免 "knowledge" 里的 "edge" 之类误命中。
  for (const [pattern, target] of aliases) {
    if (new RegExp(`^(${pattern.source})`, "i").test(subject)) return target;
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

function isAcknowledgementResponse(text: string) {
  const cleaned = text.trim().replace(/\s+/g, "");
  return /^(好的|收到|可以|行|没问题|ok|okay|好呀|好的，|好的。|收到，|收到。)$/i.test(cleaned) || cleaned.length <= 14 && /^(好的|收到|可以|行|没问题)/.test(cleaned);
}

async function maybePushTodayNews(addMessage: (message: { role: "assistant"; content: string }) => void, trigger: "ok" | "greeting") {
  if (!shouldPushTodayNews(trigger)) return;
  const items = await fetchTodayNews();
  if (items.length === 0) return;
  const content = formatNewsMarkdown(items);
  addMessage({ role: "assistant", content });
  markTodayNewsPushed(trigger);
  notifyPet("pet-say", { message: summarizeForBubble("我给你带来今天新闻速览。") });
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

async function tryHandleSkillCommand(text: string): Promise<string | null> {
  if (/^(列出|查看|看看)?\s*(你的|当前的?)?(自定义)?\s*(skill|技能)(列表)?[?？]*$|^(你)?有哪些(自定义)?\s*(skill|技能)[?？]*$/i.test(text.trim())) {
    const skills = customSkillsStore.getAll();
    if (skills.length === 0) return "现在还没有自定义 Skill。你可以说“帮你自己创建一个 xxx 技能，用来……”。";
    return `当前自定义 Skill：\n${skills.map((skill) => `- ${skill.active ? "启用" : "停用"} ${skill.name}: ${skill.description}`).join("\n")}`;
  }

  // 必须以“(帮你自己/给自己)创建…技能”开头，避免“生成一个 Python 技能学习计划”之类误触发。
  if (!/^(?:请|帮我|帮你自己|给你自己|给自己|你)?\s*(?:创建|新建|写一个|做一个)/i.test(text.trim())) return null;
  const createMatch = text.match(/(?:创建|新建|写一个|做一个|生成).{0,8}(?:skill|技能).{0,8}(?:叫|名为|名称是)?\s*([^，。,.：:]+)?[，。,.：:]?\s*(?:用来|用于|可以|能够|功能是|作用是)?\s*(.*)$/i);
  if (!createMatch || !/(skill|技能)/i.test(text)) return null;

  const rawName = (createMatch[1] || "").trim();
  const rawGoal = (createMatch[2] || "").trim();
  const name = rawName && rawName.length <= 24 ? rawName : `自定义技能 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  const description = rawGoal || text.replace(/创建|新建|写一个|做一个|生成|skill|技能/gi, "").trim() || "按用户指定流程完成任务";
  const skill = customSkillsStore.create({
    name,
    description,
    category: "其他",
    instructions: [
      `当用户请求“${description}”相关任务时，先澄清目标和输入。`,
      "给出可执行步骤，必要时调用已有工具完成任务。",
      "输出结果时保持简洁，并说明已经完成了什么。",
    ].join("\n"),
    examples: [`帮我${description}`],
    tags: ["ai-generated", "local"],
    active: true,
  });
  return `我已经给自己创建了 Skill：${skill.name}\n用途：${skill.description}\n之后相关请求会自动带上这个 Skill 的说明。`;
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

  sendMessage: async (text: string) => {
    activeController?.abort();
    // 用局部变量持有本次的 controller：如果上一轮还没结束，它的 finally
    // 不能把这一轮的 controller 清空、也不能把 isStreaming 置回 false。
    const controller = new AbortController();
    activeController = controller;
    set({ isStreaming: true, streamText: "", error: null, currentToolRuns: [] });
    notifyPet("pet-thinking");

    // 记住发起时的 Bot 和会话：生成期间切换 Bot / 会话，回复也写回原处。
    const target = { botId: getActiveBotId(), conversationId: useChatStore.getState().activeConversationId };
    const addMessage = (msg: Parameters<ReturnType<typeof useChatStore.getState>["addMessage"]>[0]) =>
      useChatStore.getState().addMessageTo(target, msg);
    const messages = useChatStore.getState().messages;
    const history = messages
      .filter((message) => message.content.trim())
      .slice(-MAX_HISTORY_MESSAGES)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
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

      const skillResult = await tryHandleSkillCommand(text);
      if (skillResult) {
        set({ streamText: skillResult });
        await sleep(160);
        addMessage({ role: "assistant", content: skillResult });
        set({ streamText: "" });
        notifyPet("pet-say", { message: summarizeForBubble(skillResult) });
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

      const fullText = await streamChat(
        { messages: history, userMessage: text },
        (chunk) => {
          set((state) => ({ streamText: state.streamText + chunk }));
        },
        {
          signal: controller.signal,
          onToolEvent: (event: ToolEvent) => {
            toolRuns = reduceToolRuns(toolRuns, event);
            set({ currentToolRuns: [...toolRuns] });
          },
        }
      );

      addMessage({ role: "assistant", content: fullText, toolRuns });
      set({ streamText: "", currentToolRuns: [] });
      notifyPet("pet-say", { message: summarizeForBubble(fullText) });

      if (isAcknowledgementResponse(fullText) || /新闻|热点|今天有什么|今日新闻/.test(text)) {
        maybePushTodayNews(addMessage, "ok").catch(() => {});
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
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
      }
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
