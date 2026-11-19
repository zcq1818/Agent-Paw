import { useMemo, useState } from "react";
import {
  Ban,
  Briefcase,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  FileText,
  Loader2,
  RotateCcw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, EmptyState, PageHeader, relativeTime, useElementWidth, type BadgeTone } from "./ui";
import { MarkdownContent } from "./MarkdownContent";
import { giveFeedback, jobProgress, reportHeadline, reviewJob, useJobStore, useJobSync, type Job, type JobLogEntry, type JobStatus } from "../agent/jobs";

const STATUS: Record<JobStatus, { label: string; tone: BadgeTone; icon: LucideIcon; bar: string }> = {
  running: { label: "进行中", tone: "primary", icon: Loader2, bar: "bg-primary" },
  queued: { label: "新建", tone: "neutral", icon: Clock, bar: "bg-fg-muted/40" },
  failed: { label: "失败", tone: "danger", icon: CircleAlert, bar: "bg-danger" },
  done: { label: "已完成", tone: "success", icon: CircleCheck, bar: "bg-success" },
  cancelled: { label: "已停止", tone: "neutral", icon: Ban, bar: "bg-fg-muted/30" },
};

/** 分组顺序：先看在做的，再看待开始和出问题的，最后是做完的 */
const STATUS_ORDER: JobStatus[] = ["running", "queued", "failed", "done", "cancelled"];

type Filter = "all" | JobStatus;

const EXAMPLES = [
  "调研一下目前主流的 AI 编程助手，对比价格、功能和适合的人群，写一份对比报告",
  "把我桌面上的截图按日期整理到一个文件夹里，整理完告诉我放在哪",
  "查一下这周有哪些值得关注的科技新闻，挑 5 条写个简报，附上链接",
];

function formatDuration(job: Job) {
  if (!job.startedAt) return "";
  const ms = (job.finishedAt || Date.now()) - job.startedAt;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return min ? `${min} 分 ${sec} 秒` : `${sec} 秒`;
}

/** 工作台“工作”页：交代任务、看它干活、看报告和复盘 */
export function JobsPanel({ onClose }: { onClose: () => void }) {
  useJobSync();
  const jobs = useJobStore((state) => state.jobs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const wide = width >= 700;

  const [filter, setFilter] = useState<Filter>("all");

  const selected = jobs.find((job) => job.id === selectedId) || null;
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const counts = useMemo(() => {
    const result = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 } as Record<JobStatus, number>;
    for (const job of jobs) result[job.status] += 1;
    return result;
  }, [jobs]);
  const groups = useMemo(
    () =>
      STATUS_ORDER.filter((status) => filter === "all" || filter === status)
        .map((status) => ({
          status,
          items: jobs
            .filter((job) => job.status === status)
            .sort((a, b) => (b.finishedAt || b.startedAt || b.createdAt) - (a.finishedAt || a.startedAt || a.createdAt)),
        }))
        .filter((group) => group.items.length > 0),
    [jobs, filter]
  );

  const submit = () => {
    const text = goal.trim();
    if (!text) return;
    const job = useJobStore.getState().create(text, title);
    setGoal("");
    setTitle("");
    setSelectedId(job.id);
  };

  const list = (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
        <div className="text-sm font-semibold text-fg">交代一件事</div>
        <p className="mt-0.5 text-xs text-fg-muted">它会自己列计划、一步步做、记工作日志，干完写报告并复盘，把经验记进技能。</p>
        <input
          className="input mt-3 h-9 text-sm"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="任务名（可不填）"
        />
        <textarea
          className="input mt-2 min-h-[96px] resize-y py-2 text-sm"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit();
          }}
          placeholder="要做什么、做到什么程度、有什么要求。写得越具体，干得越好。"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-fg-muted">Ctrl + Enter 提交</span>
          <Button variant="primary" size="sm" disabled={!goal.trim()} onClick={submit}>
            <Briefcase size={14} />
            交给它干
          </Button>
        </div>
        {jobs.length === 0 && (
          <div className="mt-3 space-y-1.5">
            <div className="text-[11px] text-fg-muted">试试这些：</div>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setGoal(example)}
                className="block w-full rounded-lg border border-dashed border-line px-3 py-2 text-left text-xs text-fg-muted transition hover:border-primary/50 hover:text-fg"
              >
                {example}
              </button>
            ))}
          </div>
        )}
      </div>

      {jobs.length === 0 ? (
        <EmptyState icon={<Briefcase size={20} />} title="还没有工作任务" hint="上面写一件事交给它；聊天里说“这个交给你干”也会建任务。" />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip label="全部" count={jobs.length} active={filter === "all"} onClick={() => setFilter("all")} />
            {STATUS_ORDER.filter((status) => status !== "cancelled" || counts.cancelled > 0).map((status) => (
              <FilterChip
                key={status}
                label={STATUS[status].label}
                count={counts[status]}
                bar={STATUS[status].bar}
                active={filter === status}
                onClick={() => setFilter(status)}
              />
            ))}
          </div>
          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-fg-muted">
              没有「{filter === "all" ? "全部" : STATUS[filter].label}」的任务
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map(({ status, items }) => {
                const Icon = STATUS[status].icon;
                return (
                  <section key={status}>
                    <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-semibold text-fg-muted">
                      <Icon size={13} className={status === "running" ? "animate-spin text-primary" : ""} />
                      {STATUS[status].label}
                      <span className="font-normal">{items.length}</span>
                    </div>
                    <div className="space-y-2">
                      {items.map((job) => (
                        <JobRow key={job.id} job={job} selected={job.id === selectedId} onSelect={() => setSelectedId(job.id)} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div ref={ref} className="flex h-screen flex-col bg-app">
      <PageHeader
        title="工作"
        description={active ? `${active} 件在做或排队 · 一次干一件，干完会冒泡告诉你` : "交给桌宠的活：它自己做，做完写报告和复盘"}
        onBack={selected && !wide ? () => setSelectedId(null) : onClose}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {wide ? (
          <div className="grid h-full grid-cols-[minmax(260px,330px)_1fr]">
            <div className="min-h-0 overflow-y-auto border-r border-line p-4">{list}</div>
            <div className="min-h-0 overflow-y-auto">
              {selected ? (
                <JobDetail job={selected} onDeleted={() => setSelectedId(null)} onRetried={setSelectedId} />
              ) : (
                <EmptyState icon={<Briefcase size={20} />} title="选一个任务看详情" hint="能看到它的计划、每一步做了什么、最后的报告和复盘。" />
              )}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-4">
            {selected ? <JobDetail job={selected} onDeleted={() => setSelectedId(null)} onRetried={setSelectedId} /> : list}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  bar,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  bar?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
        active ? "border-primary bg-primary/10 font-medium text-primary-ink" : "border-line bg-surface text-fg-muted hover:border-primary/40 hover:text-fg"
      }`}
    >
      {bar && <span className={`h-1.5 w-1.5 rounded-full ${bar}`} />}
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function rowSummary(job: Job) {
  const progress = jobProgress(job);
  if (job.status === "running" && progress.current) return `第 ${job.steps.indexOf(progress.current) + 1}/${progress.total} 步：${progress.current.text}`;
  if (job.status === "running") return "正在列计划…";
  if (job.status === "queued") return "等前面的活干完就开工";
  if (job.status === "failed" && job.error) return `出错：${job.error}`;
  if (job.status === "done") return job.review?.summary || reportHeadline(job.report) || job.goal;
  return job.goal;
}

function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  const progress = jobProgress(job);
  const status = STATUS[job.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative block w-full overflow-hidden rounded-xl border py-3 pl-4 pr-3.5 text-left transition ${
        selected ? "border-primary/60 bg-primary/5" : "border-line bg-surface hover:border-primary/40"
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${status.bar}`} />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{job.title}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div className={`mt-1 truncate text-xs ${job.status === "failed" ? "text-danger" : "text-fg-muted"}`}>{rowSummary(job)}</div>
      {progress.total > 0 && job.status === "running" && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      )}
      <div className="mt-1.5 text-[11px] text-fg-muted">
        {job.finishedAt ? `${relativeTime(job.finishedAt)} 结束` : `${relativeTime(job.createdAt)} 创建`}
        {job.startedAt && job.status !== "running" ? ` · 用时 ${formatDuration(job)}` : ""}
        {job.source === "chat" ? " · 聊天里交代的" : ""}
        {job.review ? ` · 自评 ${"★".repeat(job.review.score)}` : ""}
      </div>
    </button>
  );
}

function StepIcon({ status }: { status: Job["steps"][number]["status"] }) {
  if (status === "done") return <Check size={13} className="text-primary" />;
  if (status === "doing") return <Loader2 size={13} className="animate-spin text-primary" />;
  if (status === "skipped") return <X size={13} className="text-fg-muted" />;
  return <CircleDashed size={13} className="text-fg-muted/60" />;
}

const LOG_ICON: Record<JobLogEntry["kind"], string> = {
  plan: "📋",
  step: "▸",
  note: "📝",
  tool: "🔧",
  error: "⚠️",
  system: "·",
};

function JobDetail({ job, onDeleted, onRetried }: { job: Job; onDeleted: () => void; onRetried: (id: string) => void }) {
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const status = STATUS[job.status];
  const finished = job.status === "done" || job.status === "failed";
  const log = useMemo(() => [...job.log].reverse(), [job.log]);

  const feedback = async (good: boolean) => {
    setSending(true);
    try {
      await giveFeedback(job.id, good, comment);
      setComment("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-fg">{job.title}</h2>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">{job.goal}</p>
          <p className="mt-1 text-[11px] text-fg-muted">
            {relativeTime(job.createdAt)} 创建{job.startedAt ? ` · 用时 ${formatDuration(job)}` : ""}
            {job.skillsUsed?.length ? ` · 用了技能：${job.skillsUsed.join("、")}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {(job.status === "queued" || job.status === "running") && (
            <Button size="sm" onClick={() => useJobStore.getState().cancel(job.id)}>
              <Square size={12} />
              停止
            </Button>
          )}
          {(finished || job.status === "cancelled") && (
            <Button
              size="sm"
              onClick={() => {
                const next = useJobStore.getState().retry(job.id);
                if (next) onRetried(next.id);
              }}
            >
              <RotateCcw size={12} />
              再干一次
            </Button>
          )}
          {job.status !== "running" && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                useJobStore.getState().remove(job.id);
                onDeleted();
              }}
            >
              <Trash2 size={12} />
            </Button>
          )}
        </div>
      </div>

      {job.error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">出错停下了：{job.error}</div>}

      {job.steps.length > 0 && (
        <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="mb-2 text-sm font-semibold text-fg">计划</div>
          <ol className="space-y-1.5">
            {job.steps.map((step, index) => (
              <li key={index} className="flex gap-2 text-xs">
                <span className="mt-0.5 shrink-0">
                  <StepIcon status={step.status} />
                </span>
                <div className="min-w-0">
                  <div className={step.status === "skipped" ? "text-fg-muted line-through" : "text-fg"}>
                    {index + 1}. {step.text}
                  </div>
                  {step.note && <div className="mt-0.5 text-fg-muted">{step.note}</div>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {job.status === "queued" && <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-fg-muted">排队中，前面的活干完就开工。</div>}

      {job.report && (
        <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="mb-3 flex items-center gap-2 border-b border-line pb-2 text-sm font-semibold text-fg">
            <FileText size={14} className="text-primary" />
            工作报告
          </div>
          <div className="markdown-body max-w-none break-words">
            <MarkdownContent content={job.report} />
          </div>
        </section>
      )}

      {(job.review || job.reviewing) && (
        <section className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            复盘
            {job.review && <span className="text-xs font-normal text-accent">{"★".repeat(job.review.score)}{"☆".repeat(5 - job.review.score)}</span>}
            {job.reviewing && <Loader2 size={13} className="animate-spin text-primary" />}
          </div>
          {job.review ? (
            <div className="space-y-2 text-xs leading-relaxed text-fg">
              {job.review.summary && <p>{job.review.summary}</p>}
              {job.review.wentWell.length > 0 && <ReviewList title="做得好" items={job.review.wentWell} />}
              {job.review.problems.length > 0 && <ReviewList title="走了弯路" items={job.review.problems} />}
              {job.review.lessons.length > 0 && <ReviewList title="下次这样做" items={job.review.lessons} />}
              {job.review.skill && (
                <p className="text-primary-ink">
                  ✓ 经验已{job.review.skill.action === "created" ? "写成新技能" : "写进技能"}「{job.review.skill.name}」，下次同类工作会照着做。
                </p>
              )}
              {job.review.skillNote && <p className="text-fg-muted">{job.review.skillNote}</p>}
            </div>
          ) : (
            <p className="text-xs text-fg-muted">正在复盘…</p>
          )}
        </section>
      )}

      {finished && (
        <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="text-sm font-semibold text-fg">评价一下</div>
          <p className="mt-0.5 text-xs text-fg-muted">
            {job.feedback ? `你上次给了 ${job.feedback.good ? "👍" : "👎"}${job.feedback.comment ? `：${job.feedback.comment}` : ""}。` : ""}
            说说哪里好、哪里不对，它会带着你的意见重新复盘，下次改进。
          </p>
          <textarea
            className="input mt-2 min-h-[60px] resize-y py-2 text-sm"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="比如：报告太长了，下次只要结论和链接"
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={sending || job.reviewing} onClick={() => void feedback(true)}>
              <ThumbsUp size={13} />
              干得好
            </Button>
            <Button size="sm" disabled={sending || job.reviewing} onClick={() => void feedback(false)}>
              <ThumbsDown size={13} />
              不太行
            </Button>
            {!job.review && !job.reviewing && (
              <Button size="sm" variant="ghost" onClick={() => void reviewJob(job.id)}>
                重新复盘
              </Button>
            )}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
        <div className="mb-2 text-sm font-semibold text-fg">工作日志</div>
        <ul className="space-y-1">
          {log.map((entry, index) => (
            <li key={index} className="text-xs">
              <button
                type="button"
                disabled={!entry.detail}
                onClick={() => setOpenLog(openLog === index ? null : index)}
                className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition enabled:hover:bg-surface-2"
              >
                <span className="w-12 shrink-0 tabular-nums text-fg-muted">
                  {new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="shrink-0">{LOG_ICON[entry.kind]}</span>
                <span className={`min-w-0 flex-1 break-words ${entry.ok === false ? "text-danger" : "text-fg"}`}>{entry.text}</span>
                {entry.detail && <span className="shrink-0 text-fg-muted">{openLog === index ? "收起" : "详情"}</span>}
              </button>
              {openLog === index && entry.detail && (
                <pre className="ml-14 mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 text-[11px] text-fg-muted">{entry.detail}</pre>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="font-medium text-fg-muted">{title}</div>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
