import { BROWSER_USER_AGENT, fetchExternal } from "./http";

/**
 * 联网搜索和读网页。
 * - 中文查询先搜百度（中文结果比 Bing 好得多），英文查询先搜 Bing，两边结果合并去重。
 * - read_webpage 抓网页正文给模型读，不再只靠搜索结果里的一小段摘要回答。
 * 都是普通的网页请求，不登录、不带用户的 Cookie。
 */

export interface SearchItem {
  title: string;
  link: string;
  snippet?: string;
  source: "百度" | "Bing";
}

const HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function clean(text: string | null | undefined) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function parseHtml(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

async function searchBaidu(query: string): Promise<SearchItem[]> {
  const resp = await fetchExternal(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=10`, { headers: HEADERS });
  if (!resp.ok) throw new Error(`百度 HTTP ${resp.status}`);
  const doc = parseHtml(await resp.text());
  if (/安全验证|wappass/.test(doc.title)) throw new Error("百度要求验证");
  const items: SearchItem[] = [];
  doc.querySelectorAll("div.c-container[mu]").forEach((node) => {
    const link = node.getAttribute("mu") || "";
    // 百度自己的推荐、相关搜索等模块没有真实网址
    if (!/^https?:\/\//.test(link) || /(^|\.)baidu\.com\/(?!item)|nourl\.|recommend_list/.test(link.replace(/^https?:\/\//, ""))) return;
    const title = clean(node.querySelector("h3")?.textContent);
    if (!title) return;
    node.querySelectorAll("script,style").forEach((el) => el.remove());
    const snippetNode = node.querySelector('[class*="summary-text"],[class*="abstract"],[class*="content-right"],.c-abstract');
    let snippet = clean(snippetNode?.textContent);
    if (!snippet) snippet = clean(node.textContent).replace(title, "").trim();
    items.push({ title, link, snippet: snippet.slice(0, 260), source: "百度" });
  });
  return items;
}

async function searchBing(query: string): Promise<SearchItem[]> {
  const resp = await fetchExternal(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`, { headers: HEADERS });
  if (!resp.ok) throw new Error(`Bing HTTP ${resp.status}`);
  const doc = parseHtml(await resp.text());
  const items: SearchItem[] = [];
  doc.querySelectorAll("li.b_algo").forEach((node) => {
    const anchor = node.querySelector("h2 a");
    const link = anchor?.getAttribute("href") || "";
    const title = clean(anchor?.textContent);
    if (!title || !/^https?:\/\//.test(link)) return;
    const snippet = clean(node.querySelector(".b_caption p, p")?.textContent).replace(/^.{0,20}?·\s*/, "");
    items.push({ title, link, snippet: snippet.slice(0, 260), source: "Bing" });
  });
  return items;
}

function keyOf(link: string) {
  try {
    const url = new URL(link);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return link;
  }
}

export async function searchWeb(query: string, limit = 8): Promise<{ items: SearchItem[]; error?: string }> {
  const chinese = /[一-鿿]/.test(query);
  const engines = chinese ? [searchBaidu, searchBing] : [searchBing, searchBaidu];
  const results = await Promise.allSettled(engines.map((engine) => engine(query)));
  const merged: SearchItem[] = [];
  const seen = new Set<string>();
  // 主引擎多取几条，副引擎补充
  const quotas = [Math.ceil(limit * 0.65), limit];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    for (const item of result.value) {
      if (merged.length >= quotas[index]) break;
      const key = keyOf(item.link);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  });
  if (merged.length) return { items: merged.slice(0, limit) };
  const errors = results
    .map((result) => (result.status === "rejected" ? String(result.reason) : ""))
    .filter(Boolean)
    .join("；");
  return { items: [], error: errors || undefined };
}

export function formatSearchResults(query: string, items: SearchItem[]) {
  const lines = items.map(
    (item, index) => `${index + 1}. ${item.title}\n   ${item.link}${item.snippet ? `\n   ${item.snippet}` : ""}`
  );
  return [
    `搜索“${query}”的结果（${items.length} 条）：`,
    ...lines,
    "",
    "提示：摘要不够回答时，用 read_webpage 打开 1～3 个最相关的链接读正文再答；结果不对题就换个更具体的关键词再搜。回答里附上用到的来源链接。",
  ].join("\n");
}

const BLOCK_SELECTOR = "h1,h2,h3,h4,p,li,pre,blockquote,td,th,dd,dt,figcaption";

/** 抓网页正文：去掉导航、脚本、广告位，优先取 article / main。 */
export async function readWebpage(url: string, maxChars = 8000): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "只能读取 http / https 网址。";
  const resp = await fetchExternal(url, { headers: HEADERS });
  if (!resp.ok) {
    return resp.status === 403 || resp.status === 401 || resp.status === 429
      ? `这个网站不允许自动读取（HTTP ${resp.status}）。换搜索结果里另一个来源的链接来读，别再试这个网址。`
      : `打开失败：HTTP ${resp.status}。换一个链接试试。`;
  }
  const type = resp.headers.get("content-type") || "";
  const raw = await resp.text();
  if (!/html|xml/i.test(type) && !/^\s*</.test(raw)) {
    return `网页：${url}\n\n${raw.slice(0, maxChars)}`;
  }
  const doc = parseHtml(raw);
  const title = clean(doc.querySelector("meta[property='og:title']")?.getAttribute("content")) || clean(doc.title);
  const published =
    doc.querySelector("meta[property='article:published_time'],meta[name='publishdate'],meta[itemprop='datePublished']")?.getAttribute("content") ||
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ||
    "";
  doc
    .querySelectorAll("script,style,noscript,svg,iframe,nav,header,footer,aside,form,button,select,[role=navigation],[aria-hidden=true],.ad,.ads,.advertisement,.comment,.comments,.recommend,.related,.share,.sidebar")
    .forEach((node) => node.remove());

  // 正文容器：article / main，没有就选段落字数最多的那个块
  let root: Element | null = doc.querySelector("article") || doc.querySelector("main") || doc.querySelector("[role=main]");
  if (!root || clean(root.textContent).length < 200) {
    let best: Element | null = null;
    let bestScore = 0;
    doc.querySelectorAll("div,section").forEach((node) => {
      const score = Array.from(node.children)
        .filter((child) => child.tagName === "P")
        .reduce((sum, child) => sum + clean(child.textContent).length, 0);
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    });
    root = best && bestScore > 200 ? best : doc.body;
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  root?.querySelectorAll(BLOCK_SELECTOR).forEach((node) => {
    // 只取最内层的块，避免 li 里套 p 时重复
    if (node.querySelector(BLOCK_SELECTOR)) return;
    const text = clean(node.textContent);
    if (text.length < 2 || seen.has(text)) return;
    seen.add(text);
    const tag = node.tagName.toLowerCase();
    lines.push(/^h[1-4]$/.test(tag) ? `\n## ${text}` : tag === "li" ? `- ${text}` : text);
  });
  let body = lines.join("\n").trim();
  if (body.length < 200) body = clean(root?.textContent);
  if (!body) return `网页 ${url} 没有读到正文（可能需要登录或是动态加载的页面）。`;
  const truncated = body.length > maxChars;
  return [
    `标题：${title || "（无）"}`,
    `网址：${url}`,
    published ? `发布时间：${published}` : "",
    "",
    truncated ? `${body.slice(0, maxChars)}\n…（正文太长，只读了前 ${maxChars} 字）` : body,
  ]
    .filter((line, index) => line || index === 3)
    .join("\n");
}
