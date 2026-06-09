export interface NewsItem {
  title: string;
  link?: string;
  source?: string;
  publishedAt?: string;
}

const NEWS_CACHE_KEY = "paw_today_news_cache";
const NEWS_PUSH_KEY = "paw_today_news_pushed";
export type NewsPushTrigger = "greeting" | "ok" | "autonomous";

function todayKey() {
  return new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function stripTags(input: string) {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return (doc.body.textContent || input).replace(/\s+/g, " ").trim();
}

function parseRss(xmlText: string, source: string): NewsItem[] {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const items = Array.from(doc.querySelectorAll("item")).slice(0, 8);
  return items
    .map((item) => ({
      title: stripTags(item.querySelector("title")?.textContent || ""),
      link: item.querySelector("link")?.textContent || undefined,
      source,
      publishedAt: item.querySelector("pubDate")?.textContent || undefined,
    }))
    .filter((item) => item.title.length > 4);
}

function parseDuckDuckGo(html: string): NewsItem[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll(".result__a"))
    .slice(0, 6)
    .map((node) => ({
      title: stripTags(node.textContent || ""),
      link: (node as HTMLAnchorElement).href || undefined,
      source: "DuckDuckGo",
    }))
    .filter((item) => item.title.length > 4);
}

async function fetchText(url: string) {
  const resp = await fetch(url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.8",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

export async function fetchTodayNews(force = false): Promise<NewsItem[]> {
  const key = todayKey();
  if (!force) {
    try {
      const cached = localStorage.getItem(NEWS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { key: string; items: NewsItem[] };
        if (parsed.key === key && parsed.items?.length) return parsed.items;
      }
    } catch {}
  }

  const query = encodeURIComponent("今天 新闻 热点");
  const candidates: Array<{ url: string; parser: (text: string) => NewsItem[] }> = [
    {
      url: "https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
      parser: (text) => parseRss(text, "Google News"),
    },
    {
      url: `https://www.bing.com/news/search?q=${query}&format=rss&cc=CN`,
      parser: (text) => parseRss(text, "Bing News"),
    },
    {
      url: `https://html.duckduckgo.com/html/?q=${query}`,
      parser: parseDuckDuckGo,
    },
  ];

  for (const candidate of candidates) {
    try {
      const text = await fetchText(candidate.url);
      const items = candidate.parser(text);
      if (items.length > 0) {
        localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({ key, items, updatedAt: new Date().toISOString() }));
        return items;
      }
    } catch {
      // Try the next source.
    }
  }

  return [];
}

export function formatNewsMarkdown(items: NewsItem[], title = "今日新闻速览") {
  if (items.length === 0) {
    return `## ${title}\n\n暂时没有拉到可用新闻源，稍后我会再试一次。`;
  }

  const lines = items.slice(0, 5).map((item, index) => {
    const source = item.source ? ` _${item.source}_` : "";
    return item.link ? `${index + 1}. [${item.title}](${item.link})${source}` : `${index + 1}. ${item.title}${source}`;
  });

  return [`## ${title}`, "", ...lines, "", `> 更新时间：${new Date().toLocaleString("zh-CN")}`].join("\n");
}

export function shouldPushTodayNews(trigger: NewsPushTrigger) {
  const key = `${todayKey()}_${trigger}`;
  return localStorage.getItem(NEWS_PUSH_KEY) !== key;
}

export function markTodayNewsPushed(trigger: NewsPushTrigger) {
  localStorage.setItem(NEWS_PUSH_KEY, `${todayKey()}_${trigger}`);
}

export function formatNewsBubble(item: NewsItem, index: number, total: number) {
  const source = item.source ? `（${item.source}）` : "";
  return `今日新闻 ${index + 1}/${total}：${item.title}${source}`;
}
