import { BROWSER_USER_AGENT, fetchExternal } from "./http";
import {
  buildAnthropicRequest,
  buildChatCompletionsUrl,
  buildRequestHeaders,
  fetchModelApi,
  isAnthropicProvider,
  loadConfig,
  parseConfigJson,
} from "./kernel";
import { DEFAULT_PET_NAME, usePetStore } from "../store/pet";

/**
 * 主动搭话：讲笑话、聊热搜、冷知识、关心一句、找个话题。
 * 内容由用户自己配置的模型现编，热搜来自百度热搜榜（公开接口，不需要登录）。
 * 模型不可用时（没填 Key、用的是本机 Claude 等）返回空，调用方就不说话。
 */

export type ChatterKind = "joke" | "hot" | "fact" | "care" | "topic";

export interface HotTopic {
  title: string;
  link?: string;
}

export interface Chatter {
  kind: ChatterKind;
  /** 气泡里的一句话 */
  bubble: string;
  /** 放进聊天记录的完整内容（Markdown） */
  detail: string;
}

const HOT_CACHE_KEY = "paw_hot_topics_cache";
const HOT_CACHE_MS = 60 * 60_000;
const HISTORY_KEY = "paw_chatter_history";
const HISTORY_LIMIT = 30;

function loadHistory(): Array<{ kind: ChatterKind; text: string; at: number }> {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function remember(kind: ChatterKind, text: string) {
  const history = [...loadHistory(), { kind, text, at: Date.now() }].slice(-HISTORY_LIMIT);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}
}

/** 递归找出带 word 字段的条目（百度热搜接口的层级偶尔会变）。 */
function collectWords(node: unknown, out: Array<{ word: string; url?: string; isTop?: boolean }>) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectWords(item, out));
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.word === "string") {
    out.push({ word: record.word, url: typeof record.url === "string" ? record.url : undefined, isTop: Boolean(record.isTop) });
    return;
  }
  Object.values(record).forEach((value) => collectWords(value, out));
}

export async function fetchHotTopics(): Promise<HotTopic[]> {
  try {
    const cached = JSON.parse(localStorage.getItem(HOT_CACHE_KEY) || "null");
    if (cached && Date.now() - cached.at < HOT_CACHE_MS && cached.items?.length) return cached.items;
  } catch {}

  try {
    const resp = await fetchExternal("https://top.baidu.com/api/board?platform=wise&tab=realtime", {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
    });
    if (!resp.ok) return [];
    const words: Array<{ word: string; url?: string; isTop?: boolean }> = [];
    collectWords(await resp.json(), words);
    const seen = new Set<string>();
    const items = words
      // 置顶条目基本是时政通稿，不适合拿来闲聊
      .filter((item) => !item.isTop && item.word.trim() && !seen.has(item.word) && seen.add(item.word))
      .slice(0, 20)
      .map((item) => ({ title: item.word.trim(), link: item.url?.replace("m.baidu.com", "www.baidu.com") }));
    if (items.length) {
      try {
        localStorage.setItem(HOT_CACHE_KEY, JSON.stringify({ at: Date.now(), items }));
      } catch {}
    }
    return items;
  } catch {
    return [];
  }
}

/** 本机 Claude / CodeBuddy 之类走命令行的模型太慢，闲聊不用它们。 */
export function chatterAvailable(): boolean {
  const config = loadConfig();
  if (!config.apiKey || !config.baseUrl || !config.model) return false;
  return !/local/i.test(config.provider || "");
}

// 推理模型（如星火 X2、DeepSeek R1）会先花几百个 token 思考，上限给小了正文会是空的
async function quickComplete(system: string, prompt: string, maxTokens = 1500): Promise<string> {
  const config = loadConfig();
  if (isAnthropicProvider(config)) {
    const request = buildAnthropicRequest(config, system, prompt);
    const resp = await fetchModelApi(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ ...request.body, max_tokens: maxTokens, temperature: 1 }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return (data?.content || []).map((block: any) => (block?.type === "text" ? block.text : "")).join("");
  }
  const resp = await fetchModelApi(buildChatCompletionsUrl(config), {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify({
      ...parseConfigJson(config.extraBody),
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 1,
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) return "";
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

function nowText() {
  const now = new Date();
  const week = "日一二三四五六"[now.getDay()];
  return `${now.getMonth() + 1}月${now.getDate()}日 星期${week} ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function parseReply(raw: string): { bubble: string; detail: string } | null {
  // 去掉推理模型的思考过程
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const bubble = String(parsed.bubble || "").trim();
      const detail = String(parsed.detail || "").trim();
      if (bubble) return { bubble, detail: detail || bubble };
    } catch {}
  }
  const plain = text.replace(/^["“]|["”]$/g, "").trim();
  return plain ? { bubble: plain.slice(0, 80), detail: plain } : null;
}

const KIND_PROMPTS: Record<Exclude<ChatterKind, "hot">, string> = {
  joke: "讲一个新鲜的中文笑话或冷笑话：短、有梗、不低俗，别用烂大街的老段子。bubble 放完整笑话（不超过 60 字），detail 同样放这个笑话，可以在末尾加一句俏皮的吐槽。",
  fact: "分享一个让人“哇哦”的冷知识（科学、历史、动物、生活都行），必须是真实准确的。bubble 用一句话说出最有意思的那部分（不超过 50 字），detail 用两三句补充来龙去脉。",
  care: "结合现在的时间，像朋友一样关心用户一句：比如提醒喝水、活动肩颈、按时吃饭、早点休息、周末放松，要具体自然，别说教。bubble 不超过 40 字，detail 同 bubble。",
  topic: "主动找一个轻松的话题跟用户聊两句，最后抛一个容易回答的小问题（比如今天吃什么、最近在追什么剧、周末计划）。bubble 不超过 45 字，detail 同 bubble。",
};

/** 生成一条搭话。失败或模型不可用时返回 null。 */
export async function generateChatter(kind: ChatterKind, hotTopics: HotTopic[] = []): Promise<Chatter | null> {
  if (!chatterAvailable()) return null;
  const petName = usePetStore.getState().name?.trim() || DEFAULT_PET_NAME;
  const recent = loadHistory()
    .slice(-10)
    .map((item) => `- ${item.text}`)
    .join("\n");

  const system = `你是住在用户桌面上的宠物“${petName}”，性格活泼、机灵、温暖，说话口语化，可以带一个合适的 emoji。现在是 ${nowText()}。只输出 JSON：{"bubble":"气泡里说的一句话","detail":"放进聊天记录的完整内容，可用 Markdown"}，不要输出别的。`;

  let prompt: string;
  let topic: HotTopic | undefined;
  if (kind === "hot") {
    if (!hotTopics.length) return null;
    const usedTitles = new Set(loadHistory().filter((item) => item.kind === "hot").map((item) => item.text));
    const fresh = hotTopics.filter((item) => ![...usedTitles].some((used) => used.includes(item.title)));
    const pool = (fresh.length ? fresh : hotTopics).slice(0, 12);
    prompt = [
      "下面是此刻的热搜，挑一条最有意思、适合闲聊的（优先科技、生活、娱乐、体育、奇闻；跳过时政、灾难、伤亡、争议性话题）：",
      ...pool.map((item, index) => `${index + 1}. ${item.title}`),
      "",
      "像朋友分享八卦一样跟用户说说它，加一句你自己的看法或吐槽。只根据标题说，不确定的细节不要编。",
      `bubble 不超过 50 字；detail 用两三句展开，并在 detail 第一行写上你选的序号，格式“#序号”。`,
      recent ? `\n最近说过的话（别重复）：\n${recent}` : "",
    ].join("\n");
  } else {
    prompt = `${KIND_PROMPTS[kind]}${recent ? `\n\n最近说过的话（别重复类似内容）：\n${recent}` : ""}`;
  }

  const raw = await quickComplete(system, prompt, 1500).catch(() => "");
  const reply = parseReply(raw);
  if (!reply) return null;

  let detail = reply.detail;
  if (kind === "hot") {
    const picked = /#\s*(\d+)/.exec(detail);
    const index = picked ? Number(picked[1]) - 1 : -1;
    const pool = hotTopics.slice(0, 12);
    topic = pool[index] || pool.find((item) => reply.bubble.includes(item.title.slice(0, 6)));
    detail = detail.replace(/^\s*#\s*\d+\s*\n?/, "").trim();
    if (topic) {
      const title = topic.link ? `[${topic.title}](${topic.link})` : topic.title;
      detail = `**🔥 热搜：${title}**\n\n${detail}`;
    }
  }

  remember(kind, kind === "hot" && topic ? `${topic.title}：${reply.bubble}` : reply.bubble);
  return { kind, bubble: reply.bubble, detail };
}
