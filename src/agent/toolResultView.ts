/** 把工具返回的字符串按类型解析成可视化数据。零依赖，全部有兜底。 */

export interface ListItem {
  label: string;
  done?: boolean;
}

export interface LinkItem {
  label: string;
  href: string;
}

export interface MetricItem {
  label: string;
  value: string;
}

export type ResultView =
  | { kind: "text"; text: string }
  | { kind: "list"; items: ListItem[] }
  | { kind: "links"; items: LinkItem[] }
  | { kind: "metrics"; items: MetricItem[] };

const URL_RE = /https?:\/\/[^\s<>)\]"']+/g;

function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim();
}

function hostname(href: string): string {
  return href.replace(/^https?:\/\//, "").split("/")[0] || href;
}

export function parseToolResult(name: string, result: string): ResultView {
  const text = (result || "").trim();
  if (!text) return { kind: "text", text: "" };
  const lower = name.toLowerCase();

  // 搜索 / 新闻：提取来源链接。
  const urls = text.match(URL_RE) || [];
  if ((lower.includes("search") || lower.includes("news") || urls.length >= 2) && urls.length > 0) {
    const lines = text.split("\n").map(cleanLine).filter((line) => line && !line.startsWith("http"));
    return {
      kind: "links",
      items: urls.slice(0, 8).map((href, index) => ({
        label: lines[index] || hostname(href),
        href,
      })),
    };
  }

  // 待办 / 日程 / 技能 / 快捷命令：清单。
  if (/todo|calendar|event|skill|shortcut|task|memory/i.test(lower)) {
    const items: ListItem[] = [];
    text.split("\n").forEach((line) => {
      const raw = line.trim();
      if (!raw) return;
      const checkbox = /^\[([ xX])\]\s*(.+)$/.exec(raw);
      if (checkbox) {
        items.push({ label: checkbox[2].trim(), done: checkbox[1].toLowerCase() === "x" });
        return;
      }
      const completed = /^已完成[:：]\s*(.+)$/.exec(raw);
      if (completed) {
        items.push({ label: completed[1], done: true });
        return;
      }
      if (/^(?:[-*]|\d+[.)])\s+/.test(raw) || items.length > 0) {
        items.push({ label: cleanLine(raw) });
      }
    });
    if (items.length > 0) return { kind: "list", items: items.slice(0, 12) };
  }

  // 天气 / 统计 / 系统信息：指标卡。
  if (/weather|stat|activity|info|status/i.test(lower)) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const items: MetricItem[] = Object.entries(parsed)
        .slice(0, 6)
        .map(([label, value]) => ({
          label,
          value: typeof value === "string" ? value : JSON.stringify(value),
        }));
      if (items.length > 0) return { kind: "metrics", items };
    } catch {
      // 不是 JSON，继续尝试 key: value 行。
    }
    const kv: MetricItem[] = [];
    text.split("\n").forEach((line) => {
      const match = /^([^:：]{1,16})[:：]\s*(.+)$/.exec(line.trim());
      if (match) kv.push({ label: match[1], value: match[2] });
    });
    if (kv.length >= 2) return { kind: "metrics", items: kv.slice(0, 6) };
  }

  // 通用兜底：多行 Markdown 列表。
  const bullets = text.split("\n").filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line));
  if (bullets.length >= 2) {
    return { kind: "list", items: bullets.slice(0, 12).map((line) => ({ label: cleanLine(line) })) };
  }

  return { kind: "text", text };
}
