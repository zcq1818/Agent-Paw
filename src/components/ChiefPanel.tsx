import { useState } from "react";
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

/** 大总管面板：桌宠拆解任务、委派给 Claude / DeepSeek / 本地模型，并汇总结果。 */
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

  const localExpert = experts.find((expert) => expert.provider === "claude-local");

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
      setNotice("没有可用专家：先在下面启用专家并填写对应 API Key（本地模型可不填）。");
      return;
    }
    setNotice(`已委派给 ${tasks.length} 位专家：${tasks.map((item) => item.expert.name).join("、")}`);
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
      setNotice("复制失败，可手动选择文本。");
    }
  };

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col`}>
      <div className="ui-panel flex items-center gap-3 border-b px-4 py-3">
        <button onClick={onClose} className="ui-muted transition-colors hover:underline" aria-label="返回聊天">
          ←
        </button>
        <div>
          <div className="font-semibold">大总管</div>
          <div className="ui-muted text-xs">桌宠拆解任务 → 委派专家模型 → 汇总结果</div>
        </div>
        <span className="ui-muted ml-auto text-xs">{results.length > 0 ? `${results.length} 份结果` : "待命"}</span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <section className="ui-panel rounded-xl border p-4">
          <div className="mb-2 text-sm font-semibold">下发任务</div>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={3}
            placeholder="例如：给这款桌宠写三条宣传语；分析它的技术风险"
            className="input w-full resize-y"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className="input"
              value={mode}
              onChange={(event) => setMode(event.target.value as DelegationMode)}
              title="分派模式"
            >
              <option value="parallel">并行：各自完成</option>
              <option value="review">复核：各自挑错</option>
            </select>
            <button
              type="button"
              onClick={handleRun}
              disabled={running || !task.trim()}
              className="rounded-lg bg-yellow-500 px-4 py-1.5 text-sm font-bold text-gray-900 hover:bg-yellow-400 disabled:bg-gray-700 disabled:text-gray-400"
            >
              {running ? "专家执行中…" : "下发任务"}
            </button>
            {results.length > 0 && (
              <button type="button" onClick={copyReport} className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-100 hover:bg-gray-600">
                复制汇总
              </button>
            )}
          </div>
          {notice && <div className="ui-muted mt-2 text-xs">{notice}</div>}
        </section>

        <section className="ui-panel rounded-xl border p-4">
          <div className="mb-3 text-sm font-semibold">专家团队</div>

          <div className="ui-panel-strong mb-3 rounded-lg border p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">本机 Claude Code 通道</span>
              <button
                type="button"
                onClick={handleCheckLocal}
                disabled={checking}
                className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-gray-600 disabled:opacity-50"
              >
                {checking ? "检测中…" : "检测本机 CLI"}
              </button>
            </div>
            <div className="ui-muted mt-1.5 leading-relaxed">
              {localStatus
                ? localStatus.available
                  ? `可用 · ${localStatus.version} · ${localStatus.path}`
                  : `不可用：${localStatus.detail}`
                : "复用本机登录态，无需另配 API Key。「检测」只验证可执行文件；若登录过期需先在 Claude Code 重新登录。"}
            </div>
          </div>

          <div className="space-y-2">
            {experts.map((expert) => (
              <div key={expert.id} className="ui-panel-strong rounded-lg border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    checked={expert.enabled}
                    onChange={() => toggleExpert(expert.id)}
                    aria-label={`启用 ${expert.name}`}
                  />
                  <span className="text-sm font-semibold">{expert.name}</span>
                  <span className="ui-muted text-xs">{expert.role}</span>
                  <span className={`ml-auto text-xs ${expert.enabled ? "text-green-500" : "ui-muted"}`}>
                    {expert.enabled ? "已启用" : "未启用"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpanded((state) => ({ ...state, [expert.id]: !state[expert.id] }))}
                    className="ui-muted text-xs underline-offset-2 hover:underline"
                  >
                    {expanded[expert.id] ? "收起" : "配置"}
                  </button>
                </div>
                {expanded[expert.id] && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {expert.provider === "codebuddy-local" ? (
                      <>
                        <label className="ui-muted text-xs sm:col-span-2">
                          模型（留空用 CodeBuddy 默认）
                          <input
                            className="input mt-1"
                            value={expert.model}
                            onChange={(event) => updateExpert(expert.id, { model: event.target.value })}
                          />
                        </label>
                        <p className="ui-muted text-xs sm:col-span-2">
                          需要先在终端运行 codebuddy 并 /login 登录；桌宠不会读取或保存你的账号。
                        </p>
                      </>
                    ) : expert.provider === "claude-local" ? (
                      <>
                        <label className="ui-muted text-xs sm:col-span-2">
                          CLI 路径（留空由桌面端自动探测）
                          <input
                            className="input mt-1"
                            value={expert.command || ""}
                            placeholder="C:/.../claude-code/2.1.xxx/.../claude.exe"
                            onChange={(event) => updateExpert(expert.id, { command: event.target.value })}
                          />
                        </label>
                        <label className="ui-muted text-xs sm:col-span-2">
                          放行工具白名单（默认只读 Read；填 Edit / Bash 前请确认风险）
                          <input
                            className="input mt-1"
                            value={expert.allowedTools || "Read"}
                            onChange={(event) => updateExpert(expert.id, { allowedTools: event.target.value })}
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="ui-muted text-xs">
                          模型
                          <input
                            className="input mt-1"
                            value={expert.model}
                            onChange={(event) => updateExpert(expert.id, { model: event.target.value })}
                          />
                        </label>
                        <label className="ui-muted text-xs">
                          Base URL
                          <input
                            className="input mt-1"
                            value={expert.baseUrl}
                            onChange={(event) => updateExpert(expert.id, { baseUrl: event.target.value })}
                          />
                        </label>
                        <label className="ui-muted text-xs sm:col-span-2">
                          API Key（仅存本机浏览器，不上传）
                          <input
                            className="input mt-1"
                            type="password"
                            value={expert.apiKey}
                            placeholder={expert.provider === "custom" ? "本地端点可留空" : "sk-..."}
                            onChange={(event) => updateExpert(expert.id, { apiKey: event.target.value })}
                          />
                        </label>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {results.length > 0 && (
          <section className="ui-panel rounded-xl border p-4">
            <div className="mb-3 text-sm font-semibold">专家回执</div>
            <div className="space-y-2">
              {results.map((result) => {
                const isOpen = Boolean(expanded[result.task.id]);
                return (
                  <div key={result.task.id} className="ui-panel-strong rounded-lg border px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${result.status === "done" ? "bg-green-400" : "bg-red-400"}`} />
                      <span className="font-semibold">{result.task.expert.name}</span>
                      <span className="ui-muted">{result.task.expert.role}</span>
                      <span className="ui-muted">{result.durationMs}ms</span>
                      <button
                        type="button"
                        onClick={() => setExpanded((state) => ({ ...state, [result.task.id]: !state[result.task.id] }))}
                        className="ui-muted ml-auto underline-offset-2 hover:underline"
                      >
                        {isOpen ? "收起" : "查看"}
                      </button>
                    </div>
                    {isOpen && (
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/15 p-2 text-[11px] leading-relaxed">
                        {result.status === "done" ? result.text : `调用失败：${result.error}`}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className="ui-panel rounded-xl border p-4">
          <div className="mb-3 text-sm font-semibold">我实际能控制的电脑动作</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {LOCAL_CAPABILITIES.map((item) => (
              <div key={item.name} className="ui-panel-strong rounded-lg border px-2.5 py-2 text-xs">
                <div className="font-semibold">{item.name}</div>
                <div className="ui-muted mt-0.5">{item.detail}</div>
              </div>
            ))}
          </div>
          <div className="ui-muted mt-3 text-xs leading-relaxed">
            <div className="font-semibold">暂不支持（不冒充已完成）：</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {NOT_YET_SUPPORTED.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
