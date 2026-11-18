import { emit } from "@tauri-apps/api/event";
import { getAllWindows } from "@tauri-apps/api/window";
import type { Tool } from "./kernel";
import { BUILTIN_AVATARS, describeAvatar, loadCustomAvatars } from "../store/petAvatars";
import { usePetStore, type InteractionFrequency, type PetAvatar, type RoamScope } from "../store/pet";
import { useThemeStore, type AppTheme } from "../store/theme";
import { FOCUS_UNLOCKS, daysSince, levelInfo, useBondStore } from "./bond";
import { todayFocusMinutes } from "./petLife";
import { loadJobs, jobProgress } from "./jobs";

/**
 * 桌宠认识并会操作 Paw 自己：
 * - paw_help：按主题查使用手册（怎么用、在哪设置）
 * - paw_settings：看 / 改桌宠和外观设置（不碰模型、密钥、电脑控制这类权限设置）
 * - paw_pet_action：让桌宠做事（专注、动作、讲笑话、下班小结…），由桌宠窗口执行
 * - paw_open：打开工作台的某个页面
 * - paw_status：等级、陪伴天数、今天专注、手上的工作
 */

/** 桌宠窗口执行的动作：其他窗口发 PET_COMMAND_EVENT，桌宠窗口里的 Pet.tsx 监听执行 */
export const PET_COMMAND_EVENT = "pet-command";

export type PetCommand =
  | "focus"
  | "cancel_focus"
  | "dance"
  | "sit"
  | "sleep"
  | "stretch"
  | "excited"
  | "wander"
  | "come_to_cursor"
  | "feed"
  | "train"
  | "play"
  | "joke"
  | "hot_topic"
  | "fact"
  | "news"
  | "daily_wrap"
  | "squad"
  | "hide"
  | "show";

export interface PetCommandPayload {
  action: PetCommand;
  minutes?: number;
}

const ACTION_LABELS: Record<PetCommand, string> = {
  focus: "开始专注陪伴",
  cancel_focus: "结束专注",
  dance: "跳个舞",
  sit: "坐下",
  sleep: "睡觉",
  stretch: "伸懒腰",
  excited: "开心跳",
  wander: "自己逛逛",
  come_to_cursor: "靠近鼠标",
  feed: "喂食",
  train: "训练",
  play: "陪玩",
  joke: "讲个笑话",
  hot_topic: "聊聊热搜",
  fact: "讲个冷知识",
  news: "播报今日新闻",
  daily_wrap: "下班小结",
  squad: "叫团队出来 / 收回去",
  hide: "把桌宠藏起来",
  show: "把桌宠叫出来",
};

// ───────── 使用手册 ─────────

const MANUAL: Record<string, { title: string; body: string }> = {
  overview: {
    title: "Paw 是什么",
    body: `Paw 是住在桌面上的 AI 桌宠，也是一个能干活的助手。
- 桌宠窗口：桌面上的小宠物。单击互动、拖拽移动、双击开聊天框、右键打开菜单（成长、专注、交代工作、下班小结、叫团队、切换形态、动作、喂食训练陪玩、笑话热搜冷知识、设置）。
- 工作台：完整窗口，左边是对话列表，下面分“协作”（工作、团队、房间、总管、MCP 服务）和“数据”（记忆、技能、任务与日程、电脑活动、日志），最下面是设置。
- 启动器：Alt+Space 呼出，输入软件名、拼音或首字母回车打开；也能搜到 Paw 自己的功能（点爪印图标列出全部）。
- 托盘图标：右下角，可以显示 / 隐藏桌宠和工作台、退出。
主题：growth（成长）、focus（专注）、chat（聊天）、jobs（工作任务）、team（团队/房间/总管）、skills（技能）、memory（记忆）、tasks（待办日程/定时任务）、tools（能用的工具：搜索、电脑控制、浏览器、MCP）、activity（电脑活动/下班小结）、settings（设置项）、hotkeys（快捷键）、launcher（启动器）、update（更新/安装）。`,
  },
  growth: {
    title: "陪伴成长",
    body: `- 经验来源：在电脑前陪着（每 5 分钟 +2，每天最多 96）、聊天（每次 +3，每天最多 60）、摸头喂食等互动（每天最多 20）、专注（每分钟 +1，完成再 +5）、每天第一次见面签到（+10，连续签到每多一天再 +2，最多一次 +30）。
- 等级 1～30，有称号：刚来的小家伙(1) → 熟悉起来了(3) → 贴心小伙伴(5) → 默契搭子(8) → 得力助手(11) → 老朋友(15) → 灵魂伴侣(20) → 传说中的搭子(25) → 一生挚友(30)。
- 升级会庆祝，并解锁更长的专注：Lv1 25 分钟，Lv3 45 分钟，Lv5 60 分钟。
- 右键桌宠，菜单顶上就是成长卡片：等级、经验条、认识天数、连续签到、今天专注了多久。用 paw_status 能查到这些数。`,
  },
  focus: {
    title: "专注陪伴",
    body: `- 右键桌宠，在成长卡片里点专注时长；或者直接跟桌宠说“陪我专注 25 分钟”（用 paw_pet_action focus）。
- 专注时桌宠坐下安静陪着，不主动打扰；时间到了会提醒你起来活动，并加经验。
- 能选的时长随等级解锁：25（Lv1）、45（Lv3）、60（Lv5）分钟。想提前结束说“不专注了”（cancel_focus）。`,
  },
  chat: {
    title: "聊天",
    body: `- 双击桌宠或按 Alt+Shift+C 打开小聊天框；点别处会自动收起，回复写完会冒泡提醒。
- 工作台的聊天能看完整对话、切换和管理多个会话。
- 桌宠干活时可以继续打字补充，它下一步就能看到；Alt+Shift+X 立即停止。
- 先 Ctrl+C 复制，再按 Alt+Shift+V：报错帮你分析、外文帮你翻译、长文帮你总结。Alt+Shift+S 截屏让它看屏幕。
- 主动搭话：它会主动讲笑话、聊百度热搜、讲冷知识、关心你一句，频率跟着“互动频率”走（较少 30 分钟、正常 15 分钟、频繁 7 分钟左右一次）；安静时段和专注时不打扰。`,
  },
  jobs: {
    title: "工作任务（工作模式）",
    body: `- 交代方式：工作台“工作”页写下要做什么点“交给它干”；聊天里说“这个交给你干：……”；右键桌宠“交代工作”。
- 它在后台自己干：先列 3～8 步计划，一步步做并打勾，每次搜索、读网页、调用工具都记进工作日志；干完写报告（结果 / 过程 / 产出 / 没做完需要你决定），桌宠头顶显示“干活中 x/y”。
- 干完自己复盘打星，把经验写回用到的技能；会重复做的多步骤工作会沉淀成新技能。用户可以点“干得好 / 不太行”加一句意见，它带着意见重新复盘。
- 一次干一件，其他排队；可以停止、再干一次、删除。问进度用 get_jobs。`,
  },
  team: {
    title: "团队、房间、总管",
    body: `- 团队：可以有多个成员（bot），各有各的人设、模型、记忆和会话，在“团队”页添加和切换；右键桌宠“叫团队出来”会在桌面上显示团队小窗。
- 房间：几个团队成员一起讨论同一件事，用 @ 指定谁来回答。
- 总管：把一件事同时交给几个不同的模型去做，回来对比、汇总。`,
  },
  skills: {
    title: "技能",
    body: `- 技能是一套做事方法，遇到相关请求时按它来做（use_skill）。内置 8 个：深度思考、先查再答、任务拆解执行、写作润色、讲明白、报错排查、帮我做决定、开心果。
- “技能”页可以新建、导入、编辑、停用；也可以在聊天里让桌宠自己写一个（write_skill）。
- 工作任务复盘出来的经验会写进技能的“经验教训”一节，越用越熟。
- 设置里开着“自主学习”时，发现你重复提的需求会自动沉淀成技能。`,
  },
  memory: {
    title: "记忆",
    body: `- 桌宠会记住你说过的重要信息和偏好（设置 → AI 能力 → 智能记忆），回答时参考。
- “记忆”页可以查看、搜索、编辑、删除。想让它记住什么直接说“记住……”，想忘掉就在记忆页删。`,
  },
  tasks: {
    title: "待办、日程、定时任务",
    body: `- 待办和日程：聊天里说“提醒我明天下午三点开会”“加个待办……”，在“任务与日程”页查看管理。
- 定时任务：说“每天 / 每周 / 工作日 几点帮我做某事”，它会建定时任务（create_automation），到点自动做。
- 软件签到流程：教会它一套点击步骤（create_app_flow），以后可以一句话或每天自动去某个软件签到领积分。`,
  },
  tools: {
    title: "它能用的工具",
    body: `- 联网：web_search 搜索（中文百度、英文 Bing），read_webpage 读网页正文。
- 电脑控制（设置 → AI 能力 → 电脑控制：关闭 / 每次确认 / 信任模式）：看窗口和屏幕、点击、打字、按键、读写文件、运行命令。危险操作会先弹卡片确认。
- 浏览器（MCP 服务页 → 浏览器）：按网页结构操作，不动鼠标键盘。“后台浏览器”是独立的 Edge，登录状态存在数据文件夹；“用我的 Chrome”通过扩展用你 Chrome 里的登录状态。点击、输入会先问你。
- MCP 服务：在“MCP 服务”页接入 Jira、Notion、Slack 或公司内部系统等外部工具，接好后聊天里就能直接用。
- 其他：打开网址和软件、剪贴板、语音播报、看图、读文档、交给本机 Claude Code / Trae / WorkBuddy 去做。`,
  },
  activity: {
    title: "电脑活动和下班小结",
    body: `- 设置 → AI 能力 → 本地活动观察：只记前台窗口名称，不截图、不记按键、不上传，用来回答“我今天都干了什么”。“电脑活动”页能看时间线。
- 下班小结：每天到点（默认 18:00）自动整理今天干了什么，也可以右键桌宠“下班小结”马上看，能导出成日报。`,
  },
  settings: {
    title: "设置项",
    body: `设置在工作台左下角，分区：
- 模型：服务商、API Key、接口地址、模型名，可以存多个模型切换。（这些只能用户自己改）
- AI 能力：智能记忆、个性化学习、安全保护、多模态工具、电脑控制、本地活动观察。（电脑控制这类权限只能用户自己改）
- MCP 服务：接入外部工具和浏览器。
- 桌宠：形态（橘子小狐狸、团子小猫、豆芽小恐龙、小柚机器人、布丁小企鹅，以及数据文件夹 pets 里的私人定制形象）、名字、大小、透明度、活动范围、自动走动、避开鼠标、主动互动、互动频率、自主新闻播报、自主学习、安静时段。
- 外观：浅色 / 深色 / 跟随系统。
- 快捷键、关于（版本和检查更新）。
桌宠和外观这些可以让桌宠直接帮你改（paw_settings）。`,
  },
  hotkeys: {
    title: "快捷键（默认建议，可在设置 → 快捷键里改）",
    body: `- Alt+Space：启动器（快捷打开软件）
- Alt+Shift+C：和桌宠聊天
- Alt+Shift+V：处理刚复制的内容
- Alt+Shift+S：看看我的屏幕
- Ctrl+Shift+P：显示 / 隐藏工作台
- Alt+Shift+H：显示 / 隐藏桌宠
- Alt+Shift+X：停止当前任务`,
  },
  launcher: {
    title: "启动器",
    body: `- Alt+Space 呼出，输入软件名、拼音或首字母回车打开，常用的排在前面。
- 也能搜到 Paw 自己的功能：设置、模型、MCP、快捷键、技能、团队、记忆、显示 / 隐藏桌宠等；点爪印图标列出全部。
- 输入一句话回车可以直接问桌宠。装了新软件后用“刷新软件列表”。`,
  },
  update: {
    title: "更新和安装",
    body: `- 自动更新：有新版时会提示，设置 → 关于 里也能手动检查。
- 安装包在 GitHub Release 下载：Windows 用 setup.exe；Mac 用 universal.dmg（Intel 和 Apple 芯片通用）。Mac 版没有苹果开发者证书，第一次打开要在“系统设置 → 隐私与安全性”里点“仍要打开”；提示“已损坏”时在终端执行 xattr -cr /Applications/Paw.app。
- Mac 上操作别的窗口、截窗口识别文字、剪贴板、闲置检测这些暂时只有 Windows 版支持。
- 私人定制的宠物形象放在数据文件夹的 pets 里，不会打进安装包。`,
  },
};

const TOPIC_ALIASES: Array<[RegExp, string]> = [
  [/成长|等级|经验|升级|签到|称号/, "growth"],
  [/专注|番茄/, "focus"],
  [/聊天|对话|搭话|笑话|热搜/, "chat"],
  [/工作|任务模式|干活|job/i, "jobs"],
  [/团队|房间|总管|成员|bot/i, "team"],
  [/技能|skill/i, "skills"],
  [/记忆|memory/i, "memory"],
  [/待办|日程|提醒|定时|签到流程|自动/, "tasks"],
  [/工具|浏览器|mcp|电脑控制|搜索/i, "tools"],
  [/活动|小结|日报/, "activity"],
  [/设置|配置|形态|形象|主题|名字/, "settings"],
  [/快捷键|热键|hotkey/i, "hotkeys"],
  [/启动器|launcher/i, "launcher"],
  [/更新|安装|mac|版本|下载/i, "update"],
];

function lookupManual(topic: string): string {
  const key = topic.trim().toLowerCase();
  if (!key || key === "all" || key === "全部") return Object.values(MANUAL).map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
  const direct = MANUAL[key] || MANUAL[TOPIC_ALIASES.find(([pattern]) => pattern.test(key))?.[1] || ""];
  if (direct) return `## ${direct.title}\n${direct.body}`;
  return `## ${MANUAL.overview.title}\n${MANUAL.overview.body}`;
}

// ───────── 设置 ─────────

const FREQUENCY_LABELS: Record<InteractionFrequency, string> = { rare: "较少", normal: "正常", frequent: "频繁" };
const ROAM_LABELS: Record<RoamScope, string> = { full: "全桌面", nearby: "附近活动", corner: "角落陪伴" };
const THEME_LABELS: Record<AppTheme, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

async function avatarChoices(): Promise<Array<{ value: PetAvatar; label: string }>> {
  const custom = await loadCustomAvatars().catch(() => []);
  return [...BUILTIN_AVATARS, ...custom].map((option) => ({ value: option.value, label: option.label }));
}

async function describeSettings(): Promise<string> {
  const pet = usePetStore.getState();
  const theme = useThemeStore.getState().theme;
  const avatars = await avatarChoices();
  return [
    `名字：${pet.name}`,
    `形态：${describeAvatar(pet.avatar).label}（${pet.avatar}）；可选：${avatars.map((item) => `${item.label}=${item.value}`).join("，")}`,
    `大小：${pet.size}（96～180）`,
    `透明度：${Math.round(pet.opacity * 100)}%（45%～100%）`,
    `活动范围：${ROAM_LABELS[pet.roamScope]}（full/nearby/corner）`,
    `自动走动：${pet.autoAction ? "开" : "关"}；避开鼠标：${pet.avoidCursor ? "开" : "关"}`,
    `主动互动：${pet.enableInteractions ? "开" : "关"}，频率：${FREQUENCY_LABELS[pet.interactionFrequency]}（rare/normal/frequent）`,
    `自主新闻播报：${pet.autonomousNews ? "开" : "关"}；自主学习：${pet.autonomousLearning ? "开" : "关"}`,
    `安静时段：${pet.quietHoursEnabled ? `开，${pet.quietStart}～${pet.quietEnd}` : `关（设定 ${pet.quietStart}～${pet.quietEnd}）`}`,
    `主题：${THEME_LABELS[theme] || theme}（light/dark/system）`,
  ].join("\n");
}

const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

function normalizeTime(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!TIME_PATTERN.test(text)) return null;
  const [hour, minute] = text.split(":");
  return `${hour.padStart(2, "0")}:${minute}`;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "开" || value === "on") return true;
  if (value === "false" || value === "关" || value === "off") return false;
  return undefined;
}

async function applySettings(args: Record<string, unknown>): Promise<string> {
  const pet = usePetStore.getState();
  const changed: string[] = [];
  const problems: string[] = [];

  if (args.name !== undefined) {
    const name = String(args.name).trim().slice(0, 20);
    if (name) {
      pet.setName(name);
      changed.push(`名字改成「${name}」`);
    }
  }
  if (args.avatar !== undefined) {
    const wanted = String(args.avatar).trim();
    const choices = await avatarChoices();
    const match = choices.find((item) => item.value === wanted || item.label.includes(wanted));
    if (match) {
      pet.setAvatar(match.value);
      changed.push(`形态换成「${match.label}」`);
    } else {
      problems.push(`没有“${wanted}”这个形态，可选：${choices.map((item) => item.label).join("、")}`);
    }
  }
  if (args.size !== undefined) {
    const size = Number(args.size);
    if (Number.isFinite(size)) {
      pet.setSize(size);
      changed.push(`大小 ${usePetStore.getState().size}`);
    }
  }
  if (args.opacity !== undefined) {
    let opacity = Number(args.opacity);
    if (opacity > 1) opacity /= 100;
    if (Number.isFinite(opacity)) {
      pet.setOpacity(opacity);
      changed.push(`透明度 ${Math.round(usePetStore.getState().opacity * 100)}%`);
    }
  }
  if (args.roam_scope !== undefined) {
    const scope = String(args.roam_scope) as RoamScope;
    if (scope in ROAM_LABELS) {
      pet.setRoamScope(scope);
      changed.push(`活动范围 ${ROAM_LABELS[scope]}`);
    }
  }
  const toggles: Array<[string, (value: boolean) => void, string]> = [
    ["auto_action", pet.setAutoAction, "自动走动"],
    ["avoid_cursor", pet.setAvoidCursor, "避开鼠标"],
    ["interactions", pet.setEnableInteractions, "主动互动"],
    ["news", pet.setAutonomousNews, "自主新闻播报"],
    ["learning", pet.setAutonomousLearning, "自主学习"],
    ["quiet_hours", pet.setQuietHoursEnabled, "安静时段"],
  ];
  for (const [key, setter, label] of toggles) {
    const value = asBool(args[key]);
    if (value === undefined) continue;
    setter(value);
    changed.push(`${label}${value ? "开" : "关"}`);
  }
  if (args.frequency !== undefined) {
    const frequency = String(args.frequency) as InteractionFrequency;
    if (frequency in FREQUENCY_LABELS) {
      pet.setInteractionFrequency(frequency);
      changed.push(`互动频率${FREQUENCY_LABELS[frequency]}`);
    }
  }
  for (const [key, setter, label] of [
    ["quiet_start", pet.setQuietStart, "安静开始"],
    ["quiet_end", pet.setQuietEnd, "安静结束"],
  ] as const) {
    if (args[key] === undefined) continue;
    const time = normalizeTime(args[key]);
    if (time) {
      setter(time);
      changed.push(`${label} ${time}`);
    } else {
      problems.push(`${label}时间格式要像 23:00`);
    }
  }
  if (args.theme !== undefined) {
    const theme = String(args.theme) as AppTheme;
    if (theme in THEME_LABELS) {
      useThemeStore.getState().setTheme(theme);
      changed.push(`主题${THEME_LABELS[theme]}`);
    }
  }

  if (changed.length === 0 && problems.length === 0) return "没有要改的设置。";
  return [changed.length ? `已改好：${changed.join("，")}。` : "", problems.join("；")].filter(Boolean).join("\n");
}

// ───────── 打开页面 ─────────

const VIEWS: Record<string, { view: string; section?: string; label: string }> = {
  chat: { view: "chat", label: "聊天" },
  jobs: { view: "jobs", label: "工作" },
  team: { view: "team", label: "团队" },
  rooms: { view: "rooms", label: "房间" },
  chief: { view: "chief", label: "总管" },
  mcp: { view: "mcp", label: "MCP 服务" },
  memory: { view: "memory", label: "记忆" },
  skills: { view: "skills", label: "技能" },
  tasks: { view: "tasks", label: "任务与日程" },
  activity: { view: "activity", label: "电脑活动" },
  logs: { view: "logs", label: "日志" },
  settings: { view: "settings", section: "model", label: "设置" },
  settings_model: { view: "settings", section: "model", label: "设置 · 模型" },
  settings_features: { view: "settings", section: "features", label: "设置 · AI 能力" },
  settings_pet: { view: "settings", section: "pet", label: "设置 · 桌宠" },
  settings_appearance: { view: "settings", section: "appearance", label: "设置 · 外观" },
  settings_shortcuts: { view: "settings", section: "shortcuts", label: "设置 · 快捷键" },
  settings_about: { view: "settings", section: "about", label: "设置 · 关于" },
};

async function openView(key: string): Promise<string> {
  const target = VIEWS[key];
  if (!target) return `没有这个页面，可选：${Object.keys(VIEWS).join("、")}`;
  await emit("open-view", { view: target.view, section: target.section });
  const main = (await getAllWindows()).find((w) => w.label === "main");
  if (main) {
    await main.show();
    await main.unminimize().catch(() => {});
    await main.setFocus().catch(() => {});
  }
  const lockedSettings = target.view === "settings" && target.section !== "pet" && target.section !== "appearance";
  return `已打开工作台「${target.label}」，用户可以自己在页面上操作。${!lockedSettings ? "" : "这一页的设置你不能替用户改（你只能改 paw_settings 里的桌宠和主题设置），别说“告诉我我帮你改”，告诉用户在页面上怎么改就行。"}`;
}

// ───────── 状态 ─────────

function describeStatus(): string {
  useBondStore.getState().reload();
  const bond = useBondStore.getState();
  const info = levelInfo(bond.xp);
  const unlocked = FOCUS_UNLOCKS.filter((item) => info.level >= item.level).map((item) => item.minutes);
  const next = FOCUS_UNLOCKS.find((item) => info.level < item.level);
  const jobs = loadJobs();
  const active = jobs.filter((job) => job.status === "running" || job.status === "queued");
  const lines = [
    `关系等级 Lv${info.level}「${info.title}」，经验 ${info.current}/${info.needed}${info.level < 30 ? `，再 ${info.toNext} 点升级` : "（满级）"}`,
    `认识 ${daysSince(bond.since)} 天，一起度过 ${bond.daysTogether} 天，连续签到 ${bond.streak} 天`,
    `累计：聊天 ${bond.totals.chats} 次，互动 ${bond.totals.interactions} 次，专注 ${bond.totals.focusMin} 分钟，陪伴约 ${Math.round(bond.totals.presenceMin / 60)} 小时`,
    `今天专注 ${todayFocusMinutes()} 分钟；能选的专注时长：${unlocked.join("、")} 分钟${next ? `（Lv${next.level} 解锁 ${next.minutes} 分钟）` : ""}`,
  ];
  if (active.length) {
    lines.push(
      `手上的工作：${active
        .map((job) => {
          const progress = jobProgress(job);
          return `「${job.title}」${job.status === "running" ? `进行中 ${progress.done}/${progress.total}` : "排队中"}`;
        })
        .join("，")}`
    );
  } else {
    lines.push("手上没有工作任务。");
  }
  return lines.join("\n");
}

// ───────── 桌宠动作 ─────────

async function petAction(action: PetCommand, minutes?: number): Promise<string> {
  if (!(action in ACTION_LABELS)) return `不认识这个动作，可选：${Object.keys(ACTION_LABELS).join("、")}`;
  if (action === "hide" || action === "show") {
    const pet = (await getAllWindows()).find((w) => w.label === "pet");
    if (!pet) return "找不到桌宠窗口。";
    if (action === "hide") await pet.hide();
    else await pet.show();
    return action === "hide" ? "桌宠已经藏起来了，按 Alt+Shift+H 或托盘图标能叫回来。" : "桌宠出来了。";
  }
  let payload: PetCommandPayload = { action };
  if (action === "focus") {
    useBondStore.getState().reload();
    const level = levelInfo(useBondStore.getState().xp).level;
    const unlocked = FOCUS_UNLOCKS.filter((item) => level >= item.level).map((item) => item.minutes);
    const wanted = Number(minutes) || 25;
    const pick = unlocked.filter((value) => value <= wanted).pop() || unlocked[0];
    payload = { action, minutes: pick };
    await emit(PET_COMMAND_EVENT, payload);
    return pick === wanted
      ? `已开始专注 ${pick} 分钟，桌宠会安静陪着。`
      : `现在 Lv${level} 能选 ${unlocked.join("、")} 分钟，已按 ${pick} 分钟开始专注。`;
  }
  await emit(PET_COMMAND_EVENT, payload);
  return `桌宠去${ACTION_LABELS[action]}了。`;
}

// ───────── 工具 ─────────

export function getSelfControlTools(): Tool[] {
  return [
    {
      name: "paw_help",
      description:
        "查 Paw（你自己这个桌宠软件）的使用手册：有什么功能、怎么用、在哪设置、快捷键。用户问“你会什么 / 怎么用 / 在哪设置 / 怎么升级 / 快捷键是啥”时先查再答，不要凭印象编。",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "主题：overview、growth、focus、chat、jobs、team、skills、memory、tasks、tools、activity、settings、hotkeys、launcher、update，或者直接写关键词；all 返回全部",
          },
        },
      },
      execute: async (args) => lookupManual(String(args.topic || "overview")),
    },
    {
      name: "paw_settings",
      description:
        "查看或修改桌宠自己的设置：名字、形态、大小、透明度、活动范围、自动走动、避开鼠标、主动互动和频率、新闻播报、自主学习、安静时段、主题。用户说“搭话少一点 / 换成小猫 / 大一点 / 晚上别吵我 / 换深色”时用。只改用户要求的项；模型、API Key、电脑控制权限这些不能改，请用户自己去设置页。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set"], description: "get 查看当前设置；set 修改" },
          name: { type: "string", description: "桌宠名字" },
          avatar: { type: "string", description: "形态的值或名字（先 get 看可选项）" },
          size: { type: "number", description: "大小 96～180，默认 128" },
          opacity: { type: "number", description: "透明度 0.45～1" },
          roam_scope: { type: "string", enum: ["full", "nearby", "corner"], description: "活动范围：整个屏幕 / 附近 / 角落" },
          auto_action: { type: "boolean", description: "自动走动" },
          avoid_cursor: { type: "boolean", description: "避开鼠标" },
          interactions: { type: "boolean", description: "主动互动（讲笑话、聊热搜等）" },
          frequency: { type: "string", enum: ["rare", "normal", "frequent"], description: "主动互动频率" },
          news: { type: "boolean", description: "自主新闻播报" },
          learning: { type: "boolean", description: "自主学习（重复需求沉淀成技能）" },
          quiet_hours: { type: "boolean", description: "安静时段开关" },
          quiet_start: { type: "string", description: "安静开始时间，如 23:00" },
          quiet_end: { type: "string", description: "安静结束时间，如 08:00" },
          theme: { type: "string", enum: ["light", "dark", "system"], description: "界面主题" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        if (args.action === "set") {
          const result = await applySettings(args);
          return `${result}\n\n当前设置：\n${await describeSettings()}`;
        }
        return await describeSettings();
      },
    },
    {
      name: "paw_pet_action",
      description:
        "让桌宠（你自己）在桌面上做事：focus 开始专注陪伴（带 minutes）、cancel_focus 结束专注、dance/sit/sleep/stretch/excited 做动作、wander 自己逛逛、come_to_cursor 靠近鼠标、feed/train/play 喂食训练陪玩、joke/hot_topic/fact 讲笑话聊热搜冷知识、news 播报今日新闻、daily_wrap 下班小结、squad 叫团队出来、hide/show 藏起来或出来。用户叫你做这些时用，不要只口头答应。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: Object.keys(ACTION_LABELS) },
          minutes: { type: "number", description: "专注分钟数（25 / 45 / 60，按等级解锁）" },
        },
        required: ["action"],
      },
      execute: async (args) => petAction(String(args.action) as PetCommand, Number(args.minutes) || undefined),
    },
    {
      name: "paw_open",
      description: "打开工作台的某个页面给用户看：chat、jobs、team、rooms、chief、mcp、memory、skills、tasks、activity、logs、settings、settings_model、settings_features、settings_pet、settings_appearance、settings_shortcuts、settings_about。用户说“打开设置 / 带我去技能页 / 我要配模型”时用。",
      parameters: {
        type: "object",
        properties: { page: { type: "string", enum: Object.keys(VIEWS) } },
        required: ["page"],
      },
      execute: async (args) => openView(String(args.page || "")),
    },
    {
      name: "paw_status",
      description: "查你和用户的关系等级、经验、认识天数、连续签到、今天专注多久、能选的专注时长、手上的工作任务。用户问“我们几级了 / 还差多少升级 / 今天专注了多久 / 你在忙啥”时用。",
      parameters: { type: "object", properties: {} },
      execute: async () => describeStatus(),
    },
  ];
}

/** 系统提示里的一小段：只给入口，细节靠 paw_help 按需查，省 token */
export const SELF_PROMPT =
  "## 你自己（Paw）\n你就是 Paw 这个桌宠软件。用户问你有什么功能、怎么用、在哪设置时，先用 paw_help 查手册再答；要改桌宠设置（形态、名字、大小、搭话频率、安静时段、主题等）用 paw_settings；让你专注陪伴、做动作、讲笑话、下班小结用 paw_pet_action；带用户去某个页面用 paw_open；问等级、专注、你在忙啥用 paw_status。说做就做，不要只口头答应。";
