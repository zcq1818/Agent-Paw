import { useState } from "react";
import { Briefcase } from "lucide-react";
import { Card, Notice, Switch } from "./ui";
import { useMcpStore, isWorkerServer } from "../agent/mcpServers";
import { loadWorkerConfig, saveWorkerConfig, useWorkerModeStore, type WorkerModeConfig } from "../agent/worker";

/** 设置 → AI 能力：员工模式（这台电脑经 MCP 给别的系统当 AI 员工，见 agent/worker.ts） */
export function WorkerModeCard() {
  const [config, setConfig] = useState<WorkerModeConfig>(() => loadWorkerConfig());
  const servers = useMcpStore((state) => state.servers);
  const mcpState = useMcpStore((state) => state.state);
  const statuses = useWorkerModeStore((state) => state.sources);
  const capable = servers.filter((server) => isWorkerServer(mcpState[server.id]));

  const patch = (next: Partial<WorkerModeConfig>) => {
    const merged = { ...config, ...next };
    setConfig(merged);
    saveWorkerConfig(merged);
  };

  const toggleServer = (id: string, on: boolean) =>
    patch({ serverIds: on ? [...new Set([...config.serverIds, id])] : config.serverIds.filter((item) => item !== id) });

  const statusText = (id: string) => {
    const s = statuses[id];
    if (!config.enabled || !config.serverIds.includes(id)) return "";
    if (!s) return "准备中";
    if (s.status === "working") return `正在干任务 #${s.taskId}`;
    if (s.status === "error") return `出错了：${s.error}`;
    return "在岗，暂时没活";
  };

  return (
    <Card
      title="员工模式"
      description="让这台电脑给别的系统（山衡、见山、移山……）当 AI 员工：自动去领派给它的活，在后台干完把报告交回去，派活人验收。活经 MCP 来，接几家都行，轮着领。"
      actions={<Switch label="员工模式" checked={config.enabled} onChange={(enabled) => patch({ enabled })} />}
    >
      {capable.length === 0 ? (
        <Notice tone="info">
          还没有能派活的 MCP 服务。先在「MCP 服务」里加一个：比如山衡，地址填 https://你的山衡/api/mcp，请求头填 Authorization: Bearer 接入密钥（在山衡「组织架构」里把员工设成「外地电脑」后生成），连上后回到这里勾上。
        </Notice>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">勾上要领活的来源（带领活工具 claim_task 的 MCP 服务）：</p>
          {capable.map((server) => {
            const on = config.serverIds.includes(server.id);
            const text = statusText(server.id);
            return (
              <label key={server.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm">
                <input type="checkbox" checked={on} onChange={(e) => toggleServer(server.id, e.target.checked)} />
                <span className="font-medium text-fg">{server.name}</span>
                {!server.enabled && <span className="text-xs text-fg-muted">（MCP 服务已停用）</span>}
                {text && (
                  <span className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted">
                    <Briefcase size={12} />
                    {text}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
      {config.enabled && (
        <p className="text-xs leading-relaxed text-fg-muted">
          领到的活出现在工作台 →「工作」里，跟你交代的工作一起排队，一次干一件。干活时能问那一家的同事；改电脑上的东西照样按「电脑控制」的规则先问你。
        </p>
      )}
    </Card>
  );
}
