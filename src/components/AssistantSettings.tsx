import { useEffect, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { Button, Card, Notice, Segmented, SettingRow, Switch } from "./ui";
import {
  loadTimelineSettings,
  saveTimelineSettings,
  timelineStatus,
  type TimelineSettings,
  type TimelineStatus,
} from "../agent/timeline";
import { AUTOMATIONS_KEY, describeAutomation, useAutomationStore } from "../agent/automations";
import { loadInitiativeMode, saveInitiativeMode, type InitiativeMode } from "../agent/initiative";
import { allFlows, runFlow, type FlowResult, type UiFlow } from "../agent/uiFlow";
import { ALWAYS_ALLOW_KEY, loadAlwaysAllow, removeAlwaysAllow } from "../agent/tools";

const RETENTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 本地活动观察卡片里的细项：记录范围、保留天数、排除软件。 */
export function TimelineOptions({ enabled }: { enabled: boolean }) {
  const [settings, setSettings] = useState<TimelineSettings>(loadTimelineSettings);
  const [excludeInput, setExcludeInput] = useState(settings.exclude.join("，"));
  const [status, setStatus] = useState<TimelineStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => timelineStatus().then((value) => alive && setStatus(value));
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  const update = async (patch: Partial<TimelineSettings>) => {
    setSettings(await saveTimelineSettings(patch));
  };

  return (
    <div className={`space-y-3 rounded-lg border border-line bg-surface-2 px-4 py-3 ${enabled ? "" : "opacity-60"}`}>
      <div className="text-xs text-fg-muted">
        开启后按时间线记录：用过的软件和窗口标题、离开 / 锁屏时段
        {settings.files ? "、打开的文件" : ""}
        {settings.clipboard ? "、复制的文字" : ""}。只存在本机
        {status?.days ? `，目前 ${status.days} 天、${formatBytes(status.bytes)}` : ""}。密码管理器、无痕窗口和疑似密码的内容自动跳过。
      </div>
      <SettingRow title="记录打开的文件" description="从窗口标题和系统“最近使用”里识别文件名。">
        <Switch label="记录打开的文件" checked={settings.files} onChange={(files) => update({ files })} />
      </SettingRow>
      <SettingRow title="记录复制的文字" description="复制报错、外文、会议信息时，桌宠还能主动提议帮忙。">
        <Switch label="记录复制的文字" checked={settings.clipboard} onChange={(clipboard) => update({ clipboard })} />
      </SettingRow>
      <SettingRow title="保留时间" description="超过的记录每天自动删除。">
        <Segmented
          value={String(settings.retentionDays)}
          options={RETENTION_OPTIONS}
          onChange={(value) => update({ retentionDays: Number(value) })}
        />
      </SettingRow>
      <div className="space-y-1.5">
        <div className="text-sm text-fg">不记录的软件或窗口</div>
        <input
          className="input w-full"
          placeholder="软件名或标题关键词，用逗号分隔，如：WeChat, 网银, 病历"
          value={excludeInput}
          onChange={(event) => setExcludeInput(event.target.value)}
          onBlur={() =>
            update({
              exclude: excludeInput
                .split(/[,，、\n]/)
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
    </div>
  );
}

const INITIATIVE_OPTIONS: Array<{ value: InitiativeMode; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "suggest", label: "主动提议" },
];

/** 审批卡片上点过“一直允许”的操作，可以在这里撤销。 */
export function AlwaysAllowList() {
  const [entries, setEntries] = useState(loadAlwaysAllow);

  useEffect(() => {
    const refresh = () => setEntries(loadAlwaysAllow());
    const onStorage = (event: StorageEvent) => {
      if (event.key === ALWAYS_ALLOW_KEY || event.key === null) refresh();
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, []);

  const scopes = Object.entries(entries);
  return (
    <div className="space-y-1.5">
      <div className="text-sm text-fg">一直允许的操作</div>
      {scopes.length === 0 ? (
        <p className="text-xs text-fg-muted">还没有。确认卡片上点“一直允许”后会出现在这里；高风险操作不会被一直允许。</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {scopes.map(([scope, entry]) => (
            <span key={scope} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1.5 text-xs text-fg">
              {entry.label}
              <button
                type="button"
                onClick={() => {
                  removeAlwaysAllow(scope);
                  setEntries(loadAlwaysAllow());
                }}
                className="flex h-5 w-5 items-center justify-center rounded-full text-fg-muted hover:bg-surface hover:text-danger"
                aria-label={`撤销一直允许${entry.label}`}
                title="撤销，下次重新询问"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** 软件签到：内置 / 教过的流程，可以马上跑一次，或设成每天自动。 */
function AppFlowsSection() {
  const items = useAutomationStore((state) => state.items);
  const add = useAutomationStore((state) => state.add);
  const [flows] = useState(allFlows);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, FlowResult>>({});
  const [times, setTimes] = useState<Record<string, string>>({});

  const run = async (flow: UiFlow) => {
    setRunning(flow.id);
    try {
      const result = await runFlow(flow);
      setResults((current) => ({ ...current, [flow.id]: result }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-fg">软件签到</div>
      <p className="text-xs leading-relaxed text-fg-muted">
        桌宠按固定步骤去点按钮，不用大模型：能读到界面结构就直接按按钮名字点，读不到就截图认字再点。别的软件对桌宠说“教你 XX 的签到：先点…再点…”就能学会。
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {flows.map((flow) => {
          const scheduled = items.find((item) => item.action.type === "flow" && item.action.flowId === flow.id);
          const result = results[flow.id];
          return (
            <li key={flow.id} className="space-y-1.5 px-3 py-2">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg">{flow.name}</div>
                  <div className="truncate text-xs text-fg-muted">
                    {scheduled ? `已设为${describeAutomation(scheduled).split("：")[0]} 自动执行` : flow.description}
                  </div>
                </div>
                <Button size="sm" variant="secondary" disabled={running !== null} onClick={() => run(flow)}>
                  {running === flow.id ? "执行中…" : "立即执行"}
                </Button>
                {!scheduled && (
                  <>
                    <input
                      type="time"
                      className="input h-8 w-[92px] px-2 text-xs"
                      value={times[flow.id] || "09:30"}
                      onChange={(event) => setTimes((current) => ({ ...current, [flow.id]: event.target.value }))}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        add({
                          name: flow.name,
                          time: times[flow.id] || "09:30",
                          days: [],
                          action: { type: "flow", flowId: flow.id, label: flow.name },
                          source: "user",
                        })
                      }
                    >
                      每天自动
                    </Button>
                  </>
                )}
              </div>
              {result && (
                <div className={`text-xs ${result.ok ? "text-success" : "text-danger"}`}>
                  {result.ok ? "✓" : "✕"} {result.summary}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 主动助手：主动提议开关 + 自动任务列表。 */
export function InitiativeCard({ activityEnabled }: { activityEnabled: boolean }) {
  const [mode, setMode] = useState<InitiativeMode>(loadInitiativeMode);
  const items = useAutomationStore((state) => state.items);
  const update = useAutomationStore((state) => state.update);
  const remove = useAutomationStore((state) => state.remove);

  useEffect(() => {
    // 桌宠窗口跑完任务会改 lastRunDay，这边跟着刷新
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTOMATIONS_KEY || event.key === null) useAutomationStore.getState().reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <Card
      title="主动助手"
      description="根据本地活动记录发现能帮忙的时机，主动提出来，你点“好呀”才动手；也可以让它定时自己干活。"
      actions={
        <Segmented
          value={mode}
          options={INITIATIVE_OPTIONS}
          onChange={(value) => {
            saveInitiativeMode(value);
            setMode(value);
          }}
        />
      }
    >
      <ul className="space-y-1 text-xs leading-relaxed text-fg-muted">
        <li>· 复制了报错 → 帮你分析；复制外文 → 翻译；复制会议时间 → 加日程（需开启“记录复制的文字”）</li>
        <li>· 每天固定时间打开同一个软件 → 提议设成自动任务</li>
        <li>· 早上回顾昨天停在哪、傍晚帮你写工作日志、连续用电脑太久提醒休息、下载文件夹太乱提议整理</li>
        <li>· 同一类提议连续拒绝两次会自动少提</li>
      </ul>
      {!activityEnabled && mode !== "off" && (
        <Notice tone="warning">需要先打开上面的「本地活动观察」，主动提议才有依据。</Notice>
      )}

      <AppFlowsSection />

      <div className="space-y-2">
        <div className="text-sm font-medium text-fg">自动任务</div>
        {items.length === 0 ? (
          <p className="text-xs text-fg-muted">还没有。对桌宠说“工作日每天 9 点帮我打开邮箱”就能创建。</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-sm ${item.enabled ? "text-fg" : "text-fg-muted line-through"}`}>{item.name}</div>
                  <div className="truncate text-xs text-fg-muted">{describeAutomation(item)}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => update(item.id, { enabled: !item.enabled })}
                  title={item.enabled ? "暂停" : "恢复"}
                >
                  {item.enabled ? <Pause size={14} /> : <Play size={14} />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm(`删除自动任务「${item.name}」？`)) remove(item.id);
                  }}
                  title="删除"
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
