import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Monitor, Settings2, Sparkles } from "lucide-react";
import { Button, IconButton, Notice, PageHeader, Segmented, Switch } from "./ui";
import { useThemeClass } from "../store/theme";
import { useExpertStore } from "../store/experts";
import { checkLocalClaude, type LocalClaudeStatus } from "../agent/localClaude";
import {
  formatDelegationReport,
  LOCAL_CAPABILITIES,
  NOT_YET_SUPPORTED,
  planDelegation,
  runDelegation,
  type DelegationMode,
  type ExpertResult,
} from "../agent/orchestrator";

interface ChiefPanelProps {
  onClose: () => void;
}

const labelClass = "block text-xs font-medium text-fg";

function formatMs(ms: number) {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

/** 总管：桌宠把一件事拆给多个专家模型同时做，再汇总结果。 */
export function ChiefPanel({ onClose }: ChiefPanelProps) {
  const themeClass = useThemeClass();
  const experts = useExpertStore((state) => state.experts);
  const updateExpert = useExpertStore((state) => state.updateExpert);
  const toggleExpert = useExpertStore((state) => state.toggleExpert);

  const [task, setTask] = useState("");
  const [mode, setMode] = useState<DelegationMode>("parallel");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ExpertResult[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [localStatus, setLocalStatus] = useState<LocalClaudeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [showCapabilities, setShowCapabilities] = useState(false);

  const localExpert = experts.find((expert) => expert.provider === "claude-local");
  const enabledExperts = experts.filter((expert) => expert.enabled);

  const toggle = (id: string) => setExpanded((state) => ({ ...state, [id]: !state[id] }));

  const handleCheckLocal = async () => {
    setChecking(true);
    try {
      setLocalStatus(await checkLocalClaude(localExpert?.command));
    } finally {
      setChecking(false);
    }
  };

  const handleRun = async () => {
    const text = task.trim();
    if (!text || running) return;
    const tasks = planDelegation(text, experts, mode);
    if (tasks.length === 0) {
      setNotice("没有可用的专家：先在下面打开至少一位，并填好它的 API Key（本机的不用填）。");
      return;
    }
    setNotice(`交给了 ${tasks.length} 位专家：${tasks.map((item) => item.expert.name).join("、")}`);
    setResults([]);
    setRunning(true);
    try {
      await runDelegation(tasks, (result) => setResults((current) => [...current, result]));
    } finally {
      setRunning(false);
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(formatDelegationReport(results));
      setNotice("汇总已复制。");
    } catch {
      setNotice("复制失败，可以手动选中文字复制。");
    }
  };

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader title="总管" description="把一件事同时交给几个不同的模型去做，回来对比、汇总" onBack={onClose} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="page-pad space-y-5 py-5">
          {/* 下发任务 */}
          <section className="rounded-2xl border border-line bg-surface shadow-sm transition focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/10">
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void handleRun();
                }
              }}
              rows={3}
              placeholder="想让专家们做什么？例如：给这款桌宠写三条宣传语；分析它的技术风险"
              className="chat-composer-input block w-full resize-none border-0 bg-transparent px-5 pb-2 pt-4 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-muted"
            />
            <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: "parallel", label: "各自完成" },
                  { value: "review", label: "互相挑错" },
                ]}
              />
              <span className="text-xs text-fg-muted">
                {enabledExperts.length ? `交给 ${enabledExperts.map((expert) => expert.name).join("、")}` : "还没打开任何专家"}
              </span>
              <Button size="sm" variant="primary" className="ml-auto" disabled={running || !task.trim()} onClick={handleRun} title="Ctrl + Enter">
                <Sparkles size={14} />
                {running ? "专家们在做…" : "开始"}
              </Button>
            </div>
          </section>
          {notice && <Notice>{notice}</Notice>}

          {/* 结果 */}
          {(results.length > 0 || running) && (
            <section className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                <span className="text-sm font-semibold text-fg">专家的回复</span>
                {results.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={copyReport}>
                    <Copy size={14} />
                    复制汇总
                  </Button>
                )}
              </div>
              <ul className="divide-y divide-line">
                {results.map((result) => {
                  const isOpen = Boolean(expanded[result.task.id]);
                  const ok = result.status === "done";
                  return (
                    <li key={result.task.id}>
                      <button
                        type="button"
                        onClick={() => toggle(result.task.id)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60"
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? "bg-success" : "bg-danger"}`} />
                        <span className="text-sm font-medium text-fg">{result.task.expert.name}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                          {ok ? result.text.replace(/\s+/g, " ").slice(0, 80) : `失败：${result.error}`}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">{formatMs(result.durationMs)}</span>
                        {isOpen ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
                      </button>
                      {isOpen && (
                        <pre className="mx-4 mb-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs leading-relaxed text-fg">
                          {ok ? result.text : `调用失败：${result.error}`}
                        </pre>
                      )}
                    </li>
                  );
                })}
                {running && (
                  <li className="flex items-center gap-3 px-4 py-3 text-xs text-fg-muted">
                    <span className="typing-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    还有专家在做，做完一个出现一个
                  </li>
                )}
              </ul>
            </section>
          )}

          {/* 专家 */}
          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-sm font-semibold text-fg">专家</span>
              <span className="text-xs text-fg-muted">
                已打开 {enabledExperts.length} / {experts.length}
              </span>
            </div>
            <ul className="divide-y divide-line">
              {experts.map((expert) => {
                const open = Boolean(expanded[expert.id]);
                return (
                  <li key={expert.id}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-medium ${expert.enabled ? "text-fg" : "text-fg-muted"}`}>{expert.name}</div>
                        <div className="truncate text-xs text-fg-muted">
                          {expert.role}
                          {expert.model ? ` · ${expert.model}` : ""}
                        </div>
                      </div>
                      <IconButton label={open ? "收起设置" : "设置"} active={open} onClick={() => toggle(expert.id)}>
                        <Settings2 size={15} />
                      </IconButton>
                      <Switch label={`启用 ${expert.name}`} checked={expert.enabled} onChange={() => toggleExpert(expert.id)} />
                    </div>
                    {open && (
                      <div className="grid gap-3 bg-surface-2/50 px-4 py-3 sm:grid-cols-2">
                        {expert.provider === "codebuddy-local" ? (
                          <>
                            <label className={`${labelClass} sm:col-span-2`}>
                              模型（留空用 CodeBuddy 默认）
                              <input
                                className="input mt-1.5"
                                value={expert.model}
                                onChange={(event) => updateExpert(expert.id, { model: event.target.value })}
                              />
                            </label>
                            <p className="text-xs text-fg-muted sm:col-span-2">
                              需要先在终端运行 codebuddy 并 /login 登录；桌宠不会读取或保存你的账号。
                            </p>
                          </>
                        ) : expert.provider === "claude-local" ? (
                          <>
                            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 sm:col-span-2">
                              <Monitor size={15} className="shrink-0 text-fg-muted" />
                              <span className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">
                                {localStatus
                                  ? localStatus.available
                                    ? `可以用 · ${localStatus.version} · ${localStatus.path}`
                                    : `用不了：${localStatus.detail}`
                                  : "复用本机 Claude Code 的登录，不用另配 API Key。检测只看能不能找到程序；登录过期要先去 Claude Code 里重新登录。"}
                              </span>
                              <Button size="sm" variant="secondary" disabled={checking} onClick={handleCheckLocal}>
                                {checking ? "检测中…" : "检测"}
                              </Button>
                            </div>
                            <label className={`${labelClass} sm:col-span-2`}>
                              程序路径（留空自动找）
                              <input
                                className="input mt-1.5"
                                value={expert.command || ""}
                                placeholder="C:/.../claude-code/2.1.xxx/.../claude.exe"
                                onChange={(event) => updateExpert(expert.id, { command: event.target.value })}
                              />
                            </label>
                            <label className={`${labelClass} sm:col-span-2`}>
                              允许它用的工具（默认只读 Read；加 Edit / Bash 前想清楚风险）
                              <input
                                className="input mt-1.5"
                                value={expert.allowedTools || "Read"}
                                onChange={(event) => updateExpert(expert.id, { allowedTools: event.target.value })}
                              />
                            </label>
                          </>
                        ) : (
                          <>
                            <label className={labelClass}>
                              模型
                              <input
                                className="input mt-1.5"
                                value={expert.model}
                                onChange={(event) => updateExpert(expert.id, { model: event.target.value })}
                              />
                            </label>
                            <label className={labelClass}>
                              Base URL
                              <input
                                className="input mt-1.5"
                                value={expert.baseUrl}
                                onChange={(event) => updateExpert(expert.id, { baseUrl: event.target.value })}
                              />
                            </label>
                            <label className={`${labelClass} sm:col-span-2`}>
                              API Key（只存在本机，不上传）
                              <input
                                className="input mt-1.5"
                                type="password"
                                value={expert.apiKey}
                                placeholder={expert.provider === "custom" ? "本地端点可以不填" : "sk-..."}
                                onChange={(event) => updateExpert(expert.id, { apiKey: event.target.value })}
                              />
                            </label>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* 能力说明 */}
          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <button
              type="button"
              onClick={() => setShowCapabilities(!showCapabilities)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-surface-2/60"
            >
              {showCapabilities ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
              <span className="font-medium text-fg">桌宠在电脑上能做什么</span>
              <span className="text-xs text-fg-muted">以及暂时做不到的</span>
            </button>
            {showCapabilities && (
              <div className="space-y-4 border-t border-line px-4 py-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  {LOCAL_CAPABILITIES.map((item) => (
                    <div key={item.name} className="rounded-lg bg-surface-2 px-3 py-2">
                      <div className="text-sm text-fg">{item.name}</div>
                      <div className="mt-0.5 text-xs text-fg-muted">{item.detail}</div>
                    </div>
                  ))}
                </div>
                <div className="text-xs leading-relaxed text-fg-muted">
                  <div className="font-medium text-fg">暂时做不到（不会假装做完）</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {NOT_YET_SUPPORTED.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
