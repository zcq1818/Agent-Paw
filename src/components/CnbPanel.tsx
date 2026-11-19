import { useMemo, useState } from "react";
import {
  Bot,
  CircleAlert,
  CircleCheck,
  Clock,
  ExternalLink,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, EmptyState, Notice, PageHeader, Switch, relativeTime, useElementWidth, type BadgeTone } from "./ui";
import { MarkdownContent } from "./MarkdownContent";
import {
  CNB_NPC,
  checkConnection,
  cnbReady,
  createTask,
  issueUrl,
  loadCnbConfig,
  normalizeRepo,
  proposeIssues,
  pullUrl,
  refreshTask,
  repoUrl,
  requestRework,
  reviewTask,
  saveCnbConfig,
  summonNpc,
  trackIssue,
  useCnbStore,
  useCnbSync,
  type CnbConfig,
  type CnbTask,
  type CnbTaskStatus,
  type IssueProposal,
} from "../agent/cnb";
import { quickModelAvailable } from "../agent/llm";

const STATUS: Record<CnbTaskStatus, { label: string; tone: BadgeTone; icon: LucideIcon; bar: string }> = {
  working: { label: "NPC 在做", tone: "primary", icon: Loader2, bar: "bg-primary" },
  review: { label: "待审核", tone: "accent", icon: ShieldCheck, bar: "bg-accent" },
  approved: { label: "待合并", tone: "success", icon: GitPullRequest, bar: "bg-success/60" },
  new: { label: "新建", tone: "neutral", icon: Clock, bar: "bg-fg-muted/40" },
  failed: { label: "失败", tone: "danger", icon: CircleAlert, bar: "bg-danger" },
  done: { label: "已完成", tone: "success", icon: CircleCheck, bar: "bg-success" },
};

const STATUS_ORDER: CnbTaskStatus[] = ["working", "review", "approved", "new", "failed", "done"];

type Filter = "all" | CnbTaskStatus;

async function openLink(url: string) {
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    }
  } catch {
    /* 退回浏览器打开 */
  }
  window.open(url, "_blank", "noopener");
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 工作台「CNB 协作」：读仓库找问题 → 建 Issue → @CodeBuddy 去改 → Paw 审核 PR → 你合并 */
export function CnbPanel({ onClose }: { onClose: () => void }) {
  useCnbSync();
  const tasks = useCnbStore((state) => state.tasks);
  const [config, setConfig] = useState<CnbConfig>(() => loadCnbConfig());
  const [showSetup, setShowSetup] = useState(() => !cnbReady());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const wide = width >= 760;

  const ready = cnbReady(config);
  const repoTasks = tasks.filter((task) => !config.repo || task.repo === config.repo);
  const selected = repoTasks.find((task) => task.id === selectedId) || null;

  const counts = useMemo(() => {
    const result = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0])) as Record<CnbTaskStatus, number>;
    for (const task of repoTasks) result[task.status] += 1;
    return result;
  }, [repoTasks]);

  const groups = useMemo(
    () =>
      STATUS_ORDER.filter((status) => filter === "all" || filter === status)
        .map((status) => ({ status, items: repoTasks.filter((task) => task.status === status).sort((a, b) => b.updatedAt - a.updatedAt) }))
        .filter((group) => group.items.length > 0),
    [repoTasks, filter]
  );

  const list = (
    <div className="space-y-3">
      {(showSetup || !ready) && (
        <SetupCard
          config={config}
          onSaved={(next) => {
            setConfig(next);
            if (cnbReady(next)) setShowSetup(false);
          }}
        />
      )}
      {ready && <NewWorkCard repo={config.repo} onCreated={setSelectedId} />}
      {ready &&
        (repoTasks.length === 0 ? (
          <EmptyState icon={<Bot size={20} />} title="还没有协作任务" hint={`上面让它找找问题，或者直接写一个 Issue 交给 ${CNB_NPC}。`} />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Chip label="全部" count={repoTasks.length} active={filter === "all"} onClick={() => setFilter("all")} />
              {STATUS_ORDER.map((status) => (
                <Chip key={status} label={STATUS[status].label} count={counts[status]} bar={STATUS[status].bar} active={filter === status} onClick={() => setFilter(status)} />
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
                        <Icon size={13} className={status === "working" ? "animate-spin text-primary" : ""} />
                        {STATUS[status].label}
                        <span className="font-normal">{items.length}</span>
                      </div>
                      <div className="space-y-2">
                        {items.map((task) => (
                          <TaskRow key={task.id} task={task} selected={task.id === selectedId} onSelect={() => setSelectedId(task.id)} />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        ))}
    </div>
  );

  return (
    <div ref={ref} className="flex h-screen flex-col bg-app">
      <PageHeader
        title="CNB 协作"
        description={ready ? `${config.repo} · 找问题建 Issue，交给 ${CNB_NPC} 改，Paw 审核，你来合并` : "连接 cnb.cool 仓库，让 AI 帮你提问题、改代码、做审核"}
        onBack={selected && !wide ? () => setSelectedId(null) : onClose}
        actions={
          ready && (
            <>
              <Button size="sm" variant="ghost" onClick={() => openLink(repoUrl(config.repo))}>
                <ExternalLink size={14} />
                打开仓库
              </Button>
              <Button size="sm" variant={showSetup ? "secondary" : "ghost"} onClick={() => setShowSetup((value) => !value)}>
                <Settings2 size={14} />
                连接设置
              </Button>
            </>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {wide ? (
          <div className="grid h-full grid-cols-[minmax(300px,380px)_1fr]">
            <div className="min-h-0 overflow-y-auto border-r border-line p-4">{list}</div>
            <div className="min-h-0 overflow-y-auto">
              {selected ? (
                <TaskDetail task={selected} onDeleted={() => setSelectedId(null)} />
              ) : (
                <EmptyState icon={<GitPullRequest size={20} />} title="选一个任务看进展" hint={`能看到 Issue、${CNB_NPC} 的回复、它开的 PR 和 Paw 的审核意见。`} />
              )}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-4">{selected ? <TaskDetail task={selected} onDeleted={() => setSelectedId(null)} /> : list}</div>
        )}
      </div>
    </div>
  );
}

function Chip({ label, count, active, bar, onClick }: { label: string; count: number; active: boolean; bar?: string; onClick: () => void }) {
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

/* ------------------------------ 连接设置 ------------------------------ */

function SetupCard({ config, onSaved }: { config: CnbConfig; onSaved: (config: CnbConfig) => void }) {
  const [draft, setDraft] = useState<CnbConfig>(config);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    const next = { ...draft, repo: normalizeRepo(draft.repo), token: draft.token.trim() };
    setBusy(true);
    setResult(null);
    try {
      const text = await checkConnection(next);
      saveCnbConfig(next);
      setResult({ ok: true, text });
      onSaved(next);
    } catch (error) {
      setResult({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="text-sm font-semibold text-fg">连接 CNB</div>
      <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
        在 cnb.cool → 个人设置 → 访问令牌 新建一个令牌，授权范围勾选：repo-code:r（读代码）、repo-issue:rw（Issue）、repo-pr:r（合并请求）、repo-notes:rw（评论和评审）。不需要仓库管理权限。令牌只保存在本机，只发给 api.cnb.cool。
      </p>
      <label className="mt-3 block text-xs text-fg-muted">访问令牌</label>
      <div className="mt-1 flex gap-2">
        <input
          className="input h-9 flex-1 text-sm"
          type={showToken ? "text" : "password"}
          value={draft.token}
          onChange={(event) => setDraft({ ...draft, token: event.target.value })}
          placeholder="CNB 访问令牌"
          spellCheck={false}
          autoComplete="off"
        />
        <Button size="sm" variant="ghost" onClick={() => setShowToken((value) => !value)}>
          {showToken ? "隐藏" : "显示"}
        </Button>
      </div>
      <label className="mt-3 block text-xs text-fg-muted">仓库</label>
      <input
        className="input mt-1 h-9 text-sm"
        value={draft.repo}
        onChange={(event) => setDraft({ ...draft, repo: event.target.value })}
        placeholder="组织/仓库，或直接粘贴仓库网址"
        spellCheck={false}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-fg">自动审核</div>
          <div className="text-[11px] text-fg-muted">{CNB_NPC} 开出 PR 后，用当前模型审一遍并把意见发到 PR 上</div>
        </div>
        <Switch label="自动审核" checked={draft.autoReview} onChange={(value) => setDraft({ ...draft, autoReview: value })} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-fg">自动返工轮数</div>
          <div className="text-[11px] text-fg-muted">审核不通过时自动让 {CNB_NPC} 按意见再改，最多几轮（0 = 只提意见不返工）</div>
        </div>
        <select className="input h-8 w-20 text-sm" value={draft.maxRounds} onChange={(event) => setDraft({ ...draft, maxRounds: Number(event.target.value) })}>
          {[0, 1, 2, 3].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      {result && (
        <div className="mt-3">
          <Notice tone={result.ok ? "success" : "error"}>{result.text}</Notice>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="primary" size="sm" disabled={busy || !draft.token.trim() || !draft.repo.trim()} onClick={save}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          检查并保存
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------ 新活 ------------------------------ */

type Mode = "scan" | "write" | "track";

function NewWorkCard({ repo, onCreated }: { repo: string; onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<Mode>("scan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState("");
  const [proposals, setProposals] = useState<Array<IssueProposal & { picked: boolean }>>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [issueNo, setIssueNo] = useState("");
  const modelOk = quickModelAvailable();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const scan = () =>
    run(async () => {
      const list = await proposeIssues(focus, repo);
      setProposals(list.map((item) => ({ ...item, picked: true })));
    });

  const createPicked = (summon: boolean) =>
    run(async () => {
      const picked = proposals.filter((item) => item.picked);
      let last = "";
      for (const item of picked) {
        const task = await createTask({ title: item.title, body: item.body, summon });
        last = task.id;
        setProposals((current) => current.filter((proposal) => proposal !== item));
      }
      if (last) onCreated(last);
    });

  const createOne = (summon: boolean) =>
    run(async () => {
      const task = await createTask({ title, body, summon });
      setTitle("");
      setBody("");
      onCreated(task.id);
    });

  const track = () =>
    run(async () => {
      const number = Number(issueNo.replace(/[^\d]/g, ""));
      if (!number) throw new Error("填 Issue 编号");
      const task = await trackIssue(number);
      setIssueNo("");
      onCreated(task.id);
    });

  const picked = proposals.filter((item) => item.picked).length;

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5 text-xs">
        {(
          [
            ["scan", "帮我找问题"],
            ["write", "自己写 Issue"],
            ["track", "跟进已有 Issue"],
          ] as Array<[Mode, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`flex-1 rounded-md px-2 py-1.5 transition ${mode === value ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "scan" && (
        <div className="mt-3 space-y-2">
          <p className="text-xs leading-relaxed text-fg-muted">读仓库的目录、README 和已有 Issue，列出几条范围小、能直接交给 {CNB_NPC} 的改进。你勾选后再建。</p>
          {!modelOk && <Notice tone="warning">找问题要用 API 模型：到 设置 → 模型 选一个填好 API Key 的服务商（本机 Claude / CodeBuddy 不行）。</Notice>}
          <input className="input h-9 text-sm" value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="重点看什么（可不填），比如：安装和更新、文档、错误处理" />
          <Button variant="primary" size="sm" disabled={busy || !modelOk} onClick={scan}>
            {busy && !proposals.length ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {proposals.length ? "重新找" : "开始找"}
          </Button>
          {proposals.length > 0 && (
            <div className="space-y-2 pt-1">
              {proposals.map((item, index) => (
                <label key={index} className="flex cursor-pointer gap-2 rounded-lg border border-line p-2.5 hover:border-primary/40">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={item.picked}
                    onChange={(event) => setProposals((current) => current.map((p, i) => (i === index ? { ...p, picked: event.target.checked } : p)))}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
                      {item.priority && <Badge tone={item.priority === "P1" ? "accent" : "neutral"}>{item.priority}</Badge>}
                      <span className="min-w-0 flex-1">{item.title}</span>
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[11px] text-fg-muted">看详情</summary>
                      <div className="markdown-body mt-1 max-w-none break-words text-xs">
                        <MarkdownContent content={item.body} />
                      </div>
                    </details>
                  </div>
                </label>
              ))}
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" disabled={busy || !picked} onClick={() => createPicked(false)}>
                  只建 Issue
                </Button>
                <Button variant="primary" size="sm" disabled={busy || !picked} onClick={() => createPicked(true)}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                  建 {picked} 个并交给 {CNB_NPC}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === "write" && (
        <div className="mt-3 space-y-2">
          <input className="input h-9 text-sm" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Issue 标题" />
          <textarea
            className="input min-h-[110px] resize-y py-2 text-sm"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="现状是什么、要改成什么样、改哪些文件、怎么算改好了。写得越具体，它改得越准。"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" disabled={busy || !title.trim()} onClick={() => createOne(false)}>
              只建 Issue
            </Button>
            <Button variant="primary" size="sm" disabled={busy || !title.trim()} onClick={() => createOne(true)}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
              建好交给 {CNB_NPC}
            </Button>
          </div>
        </div>
      )}

      {mode === "track" && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-fg-muted">仓库里已经有的 Issue，加进来跟进；之后可以交给 {CNB_NPC}，开出 PR 后会自动审核。</p>
          <div className="flex gap-2">
            <input className="input h-9 flex-1 text-sm" value={issueNo} onChange={(event) => setIssueNo(event.target.value)} placeholder="Issue 编号，比如 12" />
            <Button variant="primary" size="sm" disabled={busy || !issueNo.trim()} onClick={track}>
              跟进
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <p className="mt-3 text-[11px] text-fg-muted">建的 Issue 和评论在公开仓库里所有人都能看到。</p>
    </div>
  );
}

/* ------------------------------ 列表与详情 ------------------------------ */

function rowSummary(task: CnbTask) {
  if (task.error) return `出错：${task.error}`;
  if (task.reviewing) return "正在审核 PR…";
  if (task.status === "working") return task.prNumber ? `${CNB_NPC} 正在按意见修改 PR #${task.prNumber}` : `${CNB_NPC} 正在改，还没开 PR`;
  if (task.status === "review") return task.review ? `要修改：${task.review.summary}` : `PR #${task.prNumber} 等待审核`;
  if (task.status === "approved") return `审核通过，去 CNB 合并 PR #${task.prNumber}`;
  if (task.status === "done") return task.prNumber ? `PR #${task.prNumber} 已合并` : "已关闭";
  return "还没交给 NPC";
}

function TaskRow({ task, selected, onSelect }: { task: CnbTask; selected: boolean; onSelect: () => void }) {
  const status = STATUS[task.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative w-full overflow-hidden rounded-xl border bg-surface py-2.5 pl-4 pr-3 text-left transition ${
        selected ? "border-primary/60 ring-2 ring-primary/10" : "border-line hover:border-primary/40"
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${status.bar}`} />
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-fg-muted">#{task.issueNumber}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{task.title}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div className={`mt-1 truncate text-xs ${task.error ? "text-danger" : "text-fg-muted"}`}>{rowSummary(task)}</div>
      <div className="mt-1 text-[11px] text-fg-muted/80">
        {relativeTime(task.updatedAt)} 更新{task.rounds ? ` · 返工 ${task.rounds} 轮` : ""}
      </div>
    </button>
  );
}

function TaskDetail({ task, onDeleted }: { task: CnbTask; onDeleted: () => void }) {
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const status = STATUS[task.status];
  const update = useCnbStore((state) => state.update);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <div>
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold text-fg">
            <span className="mr-1.5 text-fg-muted">#{task.issueNumber}</span>
            {task.title}
          </h2>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => openLink(issueUrl(task.repo, task.issueNumber))}>
            <ExternalLink size={14} />
            Issue #{task.issueNumber}
          </Button>
          {task.prNumber && (
            <Button size="sm" variant="ghost" onClick={() => openLink(pullUrl(task.repo, task.prNumber!))}>
              <GitPullRequest size={14} />
              PR #{task.prNumber}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => act("refresh", () => refreshTask(task.id))}>
            <RefreshCw size={14} className={busy === "refresh" ? "animate-spin" : ""} />
            刷新进展
          </Button>
        </div>
      </div>

      {(error || task.error) && <Notice tone="error">{error || task.error}</Notice>}

      {task.status === "approved" && (
        <Notice tone="success">
          审核通过了。合并由你来决定：点上面的「PR #{task.prNumber}」到 CNB 上看一眼再合并，合并后这里会自动变成已完成。
        </Notice>
      )}

      <div className="flex flex-wrap gap-2">
        {(task.status === "new" || task.status === "failed") && (
          <Button variant="primary" size="sm" disabled={Boolean(busy)} onClick={() => act("summon", () => summonNpc(task.id))}>
            {busy === "summon" ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
            交给 {CNB_NPC}
          </Button>
        )}
        {task.prNumber && task.status !== "done" && (
          <Button size="sm" disabled={Boolean(busy) || task.reviewing} onClick={() => act("review", () => reviewTask(task.id, { post: true }))}>
            {busy === "review" || task.reviewing ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {task.review ? "重新审核" : "审核 PR"}
          </Button>
        )}
        {task.status !== "done" && (
          <Button size="sm" variant="ghost" onClick={() => update(task.id, { status: "done", error: undefined })}>
            <CircleCheck size={14} />
            标记完成
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            useCnbStore.getState().remove(task.id);
            onDeleted();
          }}
        >
          <Trash2 size={14} />
          不再跟进
        </Button>
      </div>

      {task.prNumber && task.status !== "done" && (
        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="text-xs font-semibold text-fg">让 {CNB_NPC} 返工</div>
          <textarea
            className="input mt-2 min-h-[64px] resize-y py-2 text-sm"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="补充你的要求（可不填，不填就按审核意见改）"
          />
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={Boolean(busy) || (!note.trim() && task.review?.verdict !== "request_changes")}
              onClick={() =>
                act("rework", async () => {
                  await requestRework(task.id, task.review?.verdict === "request_changes" ? task.review : undefined, note);
                  setNote("");
                })
              }
            >
              {busy === "rework" ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
              发给 {CNB_NPC}
            </Button>
          </div>
        </div>
      )}

      {task.review && (
        <section className="rounded-xl border border-line bg-surface p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            <ShieldCheck size={14} className="text-primary" />
            Paw 的审核
            <Badge tone={task.review.verdict === "approve" ? "success" : "accent"}>{task.review.verdict === "approve" ? "通过" : "要修改"}</Badge>
            <span className="ml-auto text-[11px] font-normal text-fg-muted">
              {relativeTime(task.review.at)}
              {task.review.posted ? " · 已发到 PR" : ""}
            </span>
          </div>
          <p className="text-sm text-fg">{task.review.summary}</p>
          {task.review.problems.length > 0 && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg">
              {task.review.problems.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ol>
          )}
        </section>
      )}

      {task.npcReply && (
        <section className="rounded-xl border border-line bg-surface p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            <Bot size={14} className="text-primary" />
            {CNB_NPC} 最近的回复
          </div>
          <div className="markdown-body max-w-none break-words text-sm">
            <MarkdownContent content={task.npcReply} />
          </div>
        </section>
      )}

      {task.body && (
        <details className="rounded-xl border border-line bg-surface p-3">
          <summary className="cursor-pointer text-sm font-semibold text-fg">Issue 内容</summary>
          <div className="markdown-body mt-2 max-w-none break-words text-sm">
            <MarkdownContent content={task.body} />
          </div>
        </details>
      )}

      <section>
        <div className="mb-1.5 text-xs font-semibold text-fg-muted">经过</div>
        <ol className="space-y-1.5 border-l border-line pl-3">
          {[...task.events].reverse().map((event, index) => (
            <li key={index} className="text-xs text-fg">
              <span className="mr-2 text-fg-muted">{relativeTime(event.at)}</span>
              {event.text}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
