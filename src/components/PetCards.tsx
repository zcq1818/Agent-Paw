import { useEffect, useState, type ReactNode } from "react";
import { FileText, Folder, Image as ImageIcon, Lock, X } from "lucide-react";
import { dropKindOf, formatSize, isCodeFile, type DroppedFile } from "../agent/documents";
import { connectorReady, type AppHint, type DailyWrap } from "../agent/petLife";
import { FOCUS_UNLOCKS, SOURCE_LABELS, daysSince, levelInfo, useBondStore, type BondSource } from "../agent/bond";
import { useBotStore, type BotRole } from "../store/bots";
import { BotAvatar } from "./BotAvatar";
import { formatDur } from "../agent/timeline";

/** 桌宠窗口里的几张小卡片：拖文件、下班小结、软件提示、专注倒计时、新版本。 */

function CardShell({ title, tag, onClose, children }: { title: ReactNode; tag?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="offer-card absolute left-3 right-3 top-3 z-40 rounded-2xl border border-line bg-surface/95 px-3.5 py-3 text-fg shadow-xl backdrop-blur pointer-events-auto">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</div>
        {tag && <div className="shrink-0 text-[11px] text-fg-muted">{tag}</div>}
        <button type="button" onClick={onClose} aria-label="关闭" className="-mr-1 rounded-md p-0.5 text-fg-muted hover:bg-surface-2 hover:text-fg">
          <X size={14} />
        </button>
      </div>
      {children}
    </div>
  );
}

function ActionButton({ children, onClick, primary = false }: { children: ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1.5 text-xs transition ${
        primary ? "bg-primary font-medium text-primary-fg hover:brightness-110" : "border border-line bg-surface text-fg hover:border-primary/50 hover:bg-primary/5"
      }`}
    >
      {children}
    </button>
  );
}

// ───────────────────────── 拖文件 ─────────────────────────

export interface DropChoice {
  label: string;
  prompt: string;
  /** 交给某个团队成员来做 */
  role?: BotRole;
}

function listPaths(files: DroppedFile[]) {
  return files.map((file) => file.path).join("\n");
}

export function dropChoices(files: DroppedFile[], canControl: boolean): DropChoice[] {
  const kinds = new Set(files.map(dropKindOf));
  const many = files.length > 1;
  const these = many ? "这几个文件" : "这个文件";
  const paths = listPaths(files);
  if (kinds.size === 1 && kinds.has("image")) {
    const img = many ? "这几张图" : "这张图";
    return [
      { label: "这是什么", prompt: `帮我看看${img}里是什么：\n${paths}` },
      { label: "识别文字", prompt: `把${img}里的文字识别出来，整理好格式给我：\n${paths}` },
      { label: "看看报错", prompt: `${img}是报错截图，帮我看看是什么问题、怎么解决：\n${paths}` },
    ];
  }
  if (kinds.size === 1 && kinds.has("folder")) {
    const choices: DropChoice[] = [{ label: "里面有什么", prompt: `看看这个文件夹里都有什么，按类型简单汇总一下：\n${paths}` }];
    if (canControl) choices.push({ label: "整理一下", prompt: `帮我整理这个文件夹：先列出整理方案给我看，我确认后再动手，不要删除任何文件：\n${paths}` });
    return choices;
  }
  if (files.every(isCodeFile)) {
    return [
      { label: "讲讲这段代码", prompt: `讲讲${these}的代码是做什么的，挑重点说：\n${paths}` },
      { label: "找找问题", prompt: `帮我检查${these}有没有 bug 或隐患，按严重程度列出来：\n${paths}`, role: "coder" },
    ];
  }
  const choices: DropChoice[] = [
    { label: "总结要点", prompt: `帮我总结${these}的要点：\n${paths}` },
    { label: "翻译", prompt: `把${these}翻译成中文（本来就是中文的话译成英文），保留原来的段落结构：\n${paths}` },
    { label: "找出要我做的事", prompt: `读一下${these}，找出里面需要我做的事情和截止时间，列给我看；我确认后再加到待办里：\n${paths}` },
  ];
  if (canControl) choices.push({ label: "改名归档", prompt: `帮${these}起个清楚的名字（日期_主题），并建议放到哪个文件夹。先把方案给我看，我确认后再动手：\n${paths}` });
  return choices;
}

function FileIcon({ file }: { file: DroppedFile }) {
  const kind = dropKindOf(file);
  if (kind === "folder") return <Folder size={14} className="shrink-0 text-accent" />;
  if (kind === "image") return <ImageIcon size={14} className="shrink-0 text-primary" />;
  return <FileText size={14} className="shrink-0 text-primary" />;
}

export function DropCard({
  files,
  canControl,
  onPick,
  onAsk,
  onClose,
}: {
  files: DroppedFile[];
  canControl: boolean;
  onPick: (choice: DropChoice) => void;
  onAsk: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const choices = dropChoices(files, canControl);
  return (
    <CardShell title={files.length > 1 ? `收到 ${files.length} 个文件` : `收到「${files[0]?.name}」`} tag="想让我做什么？" onClose={onClose}>
      <div className="mb-2 max-h-[52px] space-y-0.5 overflow-y-auto">
        {files.slice(0, 6).map((file) => (
          <div key={file.path} className="flex items-center gap-1.5 text-[11px] text-fg-muted" title={file.path}>
            <FileIcon file={file} />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            {!file.is_dir && <span className="shrink-0 tabular-nums">{formatSize(file.size)}</span>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((choice, index) => (
          <ActionButton key={choice.label} primary={index === 0} onClick={() => onPick(choice)}>
            {choice.label}
          </ActionButton>
        ))}
      </div>
      <input
        className="mt-2 w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-fg outline-none placeholder:text-fg-muted focus:border-primary/60"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && text.trim()) onAsk(`${text.trim()}\n${listPaths(files)}`);
          if (event.key === "Escape") onClose();
        }}
        placeholder="或者直接说，比如：改成 PPT 大纲"
      />
    </CardShell>
  );
}

// ───────────────────────── 下班小结 ─────────────────────────

export function WrapCard({
  wrap,
  onReport,
  onSlack,
  onJira,
  onClose,
}: {
  wrap: DailyWrap;
  onReport: () => void;
  onSlack: () => void;
  onJira: () => void;
  onClose: () => void;
}) {
  const slack = connectorReady("slack");
  const jira = connectorReady("atlassian");
  const stats: Array<[string, string]> = [];
  if (wrap.activeMs !== null) stats.push([formatDur(wrap.activeMs), "在电脑前"]);
  if (wrap.focusMin) stats.push([`${wrap.focusMin} 分钟`, "专注"]);
  stats.push([`${wrap.todosDone.length} 项`, "完成待办"]);
  return (
    <CardShell title="今天辛苦啦" tag="下班小结" onClose={onClose}>
      <div className="mb-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 3)}, minmax(0, 1fr))` }}>
        {stats.slice(0, 3).map(([value, label]) => (
          <div key={label} className="rounded-lg bg-surface-2 px-2 py-1.5 text-center">
            <div className="truncate text-sm font-semibold text-fg">{value}</div>
            <div className="text-[10px] text-fg-muted">{label}</div>
          </div>
        ))}
      </div>
      <div className="space-y-0.5 text-[11px] leading-relaxed text-fg-muted">
        {wrap.topApps.length > 0 && (
          <div className="truncate">时间主要花在：{wrap.topApps.map((app) => `${app.name} ${formatDur(app.ms)}`).join("、")}</div>
        )}
        {wrap.todosDone.length > 0 && <div className="truncate">做完了：{wrap.todosDone.slice(0, 3).join("、")}</div>}
        {wrap.todosOpen > 0 && (
          <div>
            还有 {wrap.todosOpen} 项待办没做{wrap.overdue ? <span className="text-danger">，{wrap.overdue} 项已过期</span> : null}
          </div>
        )}
        {wrap.activeMs === null && <div>开了「电脑活动」后，小结会更完整。</div>}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <ActionButton primary onClick={onReport}>
          写成日报
        </ActionButton>
        {slack && <ActionButton onClick={onSlack}>发到 Slack</ActionButton>}
        {jira && <ActionButton onClick={onJira}>记到 Jira</ActionButton>}
      </div>
    </CardShell>
  );
}

// ───────────────────────── 软件提示 ─────────────────────────

export function HintCard({ hint, onAccept, onMute, onClose }: { hint: AppHint; onAccept: () => void; onMute: () => void; onClose: () => void }) {
  const bot = useBotStore((state) => (hint.role ? state.bots.find((item) => item.role === hint.role && !item.archived) : undefined));
  // 10 秒没理会就自己走开
  useEffect(() => {
    const timer = window.setTimeout(onClose, 10_000);
    return () => window.clearTimeout(timer);
  }, [hint.id, onClose]);
  return (
    <div className="offer-card absolute left-3 right-3 top-3 z-40 flex items-center gap-2.5 rounded-2xl border border-line bg-surface/95 px-3 py-2.5 text-fg shadow-xl backdrop-blur pointer-events-auto">
      {bot && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2">
          <BotAvatar bot={bot} size={28} />
        </span>
      )}
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-fg">{hint.text}</div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <ActionButton primary onClick={onAccept}>
          {hint.actionLabel}
        </ActionButton>
        <button type="button" onClick={onMute} className="text-[10px] text-fg-muted hover:text-fg" title="这类提示 7 天内不再出现">
          不用提醒
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── 专注 ─────────────────────────

export function FocusBadge({ endsAt, minutes, onCancel }: { endsAt: number; minutes: number; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, endsAt - now);
  const progress = 1 - left / (minutes * 60_000);
  const mm = Math.floor(left / 60_000);
  const ss = Math.floor((left % 60_000) / 1000);
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <div className="group absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface/95 py-1 pl-1.5 pr-2.5 shadow-md backdrop-blur pointer-events-auto">
      <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth="3" />
        <circle cx="12" cy="12" r={r} fill="none" stroke="rgb(var(--primary))" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />
      </svg>
      <span className="text-xs font-medium tabular-nums text-fg">
        {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
      </span>
      <span className="text-[11px] text-fg-muted">专注中</span>
      <button type="button" onClick={onCancel} className="text-fg-muted hover:text-danger" aria-label="结束专注" title="提前结束（不计入成长）">
        <X size={12} />
      </button>
    </div>
  );
}

/** 右键菜单顶部：成长等级、经验进度、今天的经验、专注按钮 */
export function GrowthMenuHeader({
  todayMin,
  focusing,
  onFocus,
}: {
  todayMin: number;
  focusing: boolean;
  onFocus: (minutes: number) => void;
}) {
  const xp = useBondStore((state) => state.xp);
  const since = useBondStore((state) => state.since);
  const streak = useBondStore((state) => state.streak);
  const today = useBondStore((state) => state.today);
  const info = levelInfo(xp);
  const todayParts = (Object.keys(SOURCE_LABELS) as BondSource[])
    .map((source) => ({ label: SOURCE_LABELS[source], value: today[source] || 0 }))
    .filter((part) => part.value > 0);
  const todayTotal = todayParts.reduce((sum, part) => sum + part.value, 0);
  return (
    <div className="border-b border-line px-3 pb-2.5 pt-2">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-semibold text-primary-ink">Lv{info.level}</span>
        <span className="truncate text-xs text-fg">{info.title}</span>
      </div>
      <div
        className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2"
        title={info.toNext ? `再 ${info.toNext} 点成长升到 Lv${info.level + 1}` : "满级了"}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(info.progress * 100)}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-fg-muted tabular-nums">
        <span>
          {info.toNext ? `${info.current}/${info.needed}` : "满级"}
        </span>
        <span>
          认识 {daysSince(since)} 天{streak > 1 ? ` · 连续 ${streak} 天` : ""}
        </span>
      </div>
      <div
        className="mt-0.5 text-[10px] text-fg-muted"
        title="成长来源：陪伴（电脑前每 5 分钟 +2）、聊天（每条 +3）、互动、专注（每分钟 +1）、每日签到"
      >
        今天 +{todayTotal}
        {todayParts.length > 0 && `（${todayParts.map((part) => `${part.label} ${part.value}`).join(" · ")}）`}
        {todayMin > 0 && ` · 专注 ${todayMin} 分钟`}
      </div>
      {!focusing && (
        <div className="mt-2 flex gap-1">
          {FOCUS_UNLOCKS.map((option) => {
            const locked = info.level < option.level;
            return (
              <button
                key={option.minutes}
                type="button"
                disabled={locked}
                onClick={() => onFocus(option.minutes)}
                title={locked ? `Lv${option.level} 解锁` : `陪你专注 ${option.minutes} 分钟（每分钟 +1 成长）`}
                className="flex flex-1 items-center justify-center gap-0.5 rounded-md border border-line py-1 text-[11px] text-fg transition enabled:hover:border-primary/60 enabled:hover:bg-primary/5 disabled:text-fg-muted/60"
              >
                {locked && <Lock size={9} />}
                {option.minutes}′
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 新版本 ─────────────────────────

export function UpdateCard({
  version,
  notes,
  progress,
  error,
  onInstall,
  onSkip,
  onClose,
}: {
  version: string;
  notes: string;
  /** null = 还没开始下载 */
  progress: number | null;
  error?: string;
  onInstall: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const firstLines = notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(#+|[-*]|\d+\.)\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return (
    <CardShell title={`Paw 有新版本 ${version}`} tag={progress === null ? "更新" : `${progress}%`} onClose={onClose}>
      {firstLines.length > 0 && (
        <ul className="mb-2 space-y-0.5 text-xs leading-relaxed text-fg-muted">
          {firstLines.map((line) => (
            <li key={line} className="truncate">
              · {line}
            </li>
          ))}
        </ul>
      )}
      {progress !== null ? (
        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(4, progress)}%` }} />
          </div>
          <div className="text-[11px] text-fg-muted">{progress >= 100 ? "装好了，马上重启…" : "正在下载，聊天和记忆都不会动"}</div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <ActionButton primary onClick={onInstall}>
            更新并重启
          </ActionButton>
          <ActionButton onClick={onClose}>以后再说</ActionButton>
          <button type="button" onClick={onSkip} className="ml-auto text-[10px] text-fg-muted hover:text-fg">
            跳过这个版本
          </button>
        </div>
      )}
      {error && <div className="mt-1.5 text-[11px] text-red-500">{error}</div>}
    </CardShell>
  );
}
