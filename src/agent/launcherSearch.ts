import { pinyin } from "pinyin-pro";

/**
 * 启动器的搜索匹配：名字、全拼、首字母、驼峰缩写、程序文件名、自定义简称。
 * 结果带上要高亮的字符位置，界面上把命中的字标出来。
 */

export interface LauncherApp {
  name: string;
  id: string;
  path: string;
  icon: string;
}

interface Token {
  /** 在名字里的起止位置 */
  start: number;
  end: number;
  /** 小写拼音或英文单词 */
  py: string;
  latin: boolean;
}

export interface IndexedApp extends LauncherApp {
  tokens: Token[];
  compact: string;
  full: string;
  /** 每个词取首字母：Windows PowerShell → wps，企业微信 → qywx */
  initials: string;
  /** 英文词保留整词：QQ音乐 → qqyy */
  initialsLong: string;
  /** 程序文件名：Weixin.exe → weixin */
  exe: string;
  aliases: string[];
}

export interface Match {
  score: number;
  /** 名字里要高亮的字符下标 */
  highlight: Set<number>;
  /** 命中的是简称 / 文件名时，界面上说明一下 */
  via?: string;
}

const TOKEN_PATTERN = /[㐀-鿿]|[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;

export function tokenize(name: string): Token[] {
  // 连续的汉字整段取拼音，多音字按词组读（音乐 → yin yue，不是 yin le）
  const charPinyin = new Map<number, string>();
  const runs = /[㐀-鿿]+/g;
  let run: RegExpExecArray | null;
  while ((run = runs.exec(name))) {
    const syllables = pinyin(run[0], { toneType: "none", type: "array" }) as string[];
    syllables.forEach((py, offset) => charPinyin.set(run!.index + offset, py.toLowerCase()));
  }
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(name))) {
    const text = match[0];
    const chinese = /[㐀-鿿]/.test(text);
    const py = chinese ? charPinyin.get(match.index) || text : text.toLowerCase();
    tokens.push({ start: match.index, end: match.index + text.length, py, latin: !chinese });
  }
  return tokens;
}

export function indexApp(app: LauncherApp, aliases: string[] = []): IndexedApp {
  const tokens = tokenize(app.name);
  const exe = (app.path.split(/[\\/]/).pop() || "").replace(/\.(exe|lnk|bat|cmd)$/i, "").toLowerCase();
  return {
    ...app,
    tokens,
    compact: app.name.toLowerCase().replace(/[\s\-_.()（）]+/g, ""),
    full: tokens.map((t) => t.py).join(""),
    initials: tokens.map((t) => t.py[0] || "").join(""),
    initialsLong: tokens.map((t) => (t.latin ? t.py : t.py[0] || "")).join(""),
    exe,
    aliases: aliases.map((a) => a.toLowerCase()),
  };
}

function range(start: number, end: number) {
  const set = new Set<number>();
  for (let i = start; i < end; i++) set.add(i);
  return set;
}

/** 首字母从第 from 个词开始连续命中 n 个词：高亮这些词的首字。 */
function tokenHeads(tokens: Token[], from: number, n: number) {
  const set = new Set<number>();
  for (let i = from; i < from + n && i < tokens.length; i++) set.add(tokens[i].start);
  return set;
}

/** query 依次落在哪些词的首字母上（允许跳过词）：返回命中的词下标。 */
function initialsSubsequence(tokens: Token[], q: string): number[] | null {
  const hit: number[] = [];
  let i = 0;
  for (let t = 0; t < tokens.length && i < q.length; t++) {
    if (tokens[t].py[0] === q[i]) {
      hit.push(t);
      i++;
    }
  }
  return i === q.length ? hit : null;
}

/** 全拼前缀：q 能被前几个词的拼音按顺序“吃掉”（最后一个词可以只吃一部分）。 */
function fullPrefixTokens(tokens: Token[], q: string): number {
  let rest = q;
  let count = 0;
  for (const token of tokens) {
    if (!rest) break;
    if (rest.startsWith(token.py)) {
      rest = rest.slice(token.py.length);
      count++;
    } else if (token.py.startsWith(rest)) {
      rest = "";
      count++;
    } else return 0;
  }
  return rest ? 0 : count;
}

export function matchApp(app: IndexedApp, query: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return null;
  const tokens = app.tokens;
  let best: Match | null = null;
  const consider = (score: number, highlight: Set<number>, via?: string) => {
    if (!best || score > best.score) best = { score, highlight, via };
  };

  // 自定义简称最优先
  for (const alias of app.aliases) {
    if (alias === q) consider(120, new Set(), `简称 ${alias}`);
    else if (alias.startsWith(q)) consider(98, new Set(), `简称 ${alias}`);
  }

  const lowerName = app.name.toLowerCase();
  if (app.compact === q) consider(100, range(0, app.name.length));
  else if (app.compact.startsWith(q) && lowerName.startsWith(q)) consider(90, range(0, q.length));

  if (app.initials === q) consider(94, tokenHeads(tokens, 0, tokens.length));
  else if (app.initials.startsWith(q)) consider(84, tokenHeads(tokens, 0, q.length));
  if (app.initialsLong !== app.initials && app.initialsLong.startsWith(q)) consider(82, tokenHeads(tokens, 0, tokens.length));

  const fullCount = fullPrefixTokens(tokens, q);
  if (fullCount) consider(q.length >= 3 ? 80 : 70, range(tokens[0].start, tokens[fullCount - 1].end));

  if (app.exe) {
    if (app.exe === q) consider(78, new Set(), `程序 ${app.exe}.exe`);
    else if (q.length >= 2 && app.exe.startsWith(q)) consider(66, new Set(), `程序 ${app.exe}.exe`);
  }

  // 从中间某个词开始连续命中首字母：Windows PowerShell ← ps
  if (q.length >= 2) {
    const at = app.initials.indexOf(q);
    if (at > 0) consider(62, tokenHeads(tokens, at, q.length));
  }

  // 某个词以 q 开头：Google Chrome ← chrome
  tokens.forEach((token, index) => {
    if (q.length >= 2 && token.py.startsWith(q)) consider(64 - index, range(token.start, token.end));
    // 从中间某个词开始的全拼：企业微信 ← weixin
    if (index > 0 && q.length >= 3) {
      const count = fullPrefixTokens(tokens.slice(index), q);
      if (count) consider(58, range(token.start, tokens[index + count - 1].end));
    }
  });

  const at = lowerName.indexOf(q);
  if (at >= 0) consider(55, range(at, at + q.length));

  // 跳着取首字母：Windows PowerShell ← wps / ps
  if (q.length >= 2) {
    const hits = initialsSubsequence(tokens, q);
    if (hits) consider(hits[0] === 0 ? 50 : 44, new Set(hits.map((t) => tokens[t].start)));
  }

  if (q.length >= 3 && app.full.includes(q)) consider(40, new Set());

  const result = best as Match | null;
  if (!result) return null;
  // 卸载程序、帮助文档之类往后放
  if (/卸载|uninstall|帮助|help|readme|manual|说明|文档/i.test(app.name)) result.score -= 30;
  return result.score > 0 ? result : null;
}

/** 名字只有一个字的、明显不是软件的条目不进列表。 */
export function isUsefulApp(app: LauncherApp) {
  return app.name.trim().length > 1;
}
