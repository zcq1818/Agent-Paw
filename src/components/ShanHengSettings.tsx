import { useState } from "react";
import { Briefcase, PlugZap } from "lucide-react";
import { Button, Card, Field, Notice, Switch } from "./ui";
import { loadShanHengConfig, saveShanHengConfig, shanHeng, useShanHengStore, type ShanHengConfig } from "../agent/shanheng";

/** 设置 → AI 能力：员工模式（这台电脑当山衡里的一位 AI 员工，见 agent/shanheng.ts） */
export function ShanHengWorkerCard() {
  const [config, setConfig] = useState<ShanHengConfig>(() => loadShanHengConfig());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const status = useShanHengStore((state) => state.status);
  const lastError = useShanHengStore((state) => state.lastError);
  const currentTaskId = useShanHengStore((state) => state.currentTaskId);

  const patch = (next: Partial<ShanHengConfig>) => {
    const merged = { ...config, ...next };
    setConfig(merged);
    saveShanHengConfig(merged);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const me = await shanHeng.me({ ...config, baseUrl: config.baseUrl.trim().replace(/\/+$/, ""), key: config.key.trim() });
      const where = [me?.department, me?.title].filter(Boolean).join(" · ");
      setTestResult({ ok: true, text: `连上了：这台电脑是「${me?.name}」${where ? `（${where}）` : ""}` });
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const statusText =
    !config.enabled
      ? "没开"
      : status === "working"
        ? `正在干山衡任务 #${currentTaskId}`
        : status === "error"
          ? `出错了：${lastError}`
          : status === "idle"
            ? "在岗，暂时没活"
            : "准备中";

  return (
    <Card
      title="员工模式（山衡）"
      description="让这台电脑当山衡里的一位 AI 员工：自动去山衡领派给它的活，在后台干完把报告交回去，派活人验收。干活时能当场问山衡里的同事。"
      actions={<Switch label="员工模式" checked={config.enabled} onChange={(enabled) => patch({ enabled })} />}
    >
      <Field label="山衡地址" hint="比如 https://www.vipcc.cn，不带 /api">
        <input className="input w-full" placeholder="https://" value={config.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} />
      </Field>
      <Field label="接入密钥" hint="在山衡「组织架构」里把员工设成「外地电脑」，点「生成接入密钥」。只存在这台电脑上">
        <input className="input w-full" type="password" autoComplete="off" value={config.key} onChange={(e) => patch({ key: e.target.value })} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={test} disabled={testing || !config.baseUrl.trim() || !config.key.trim()}>
          <PlugZap size={14} />
          {testing ? "连接中…" : "测试连接"}
        </Button>
        <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
          <Briefcase size={13} />
          {statusText}
        </span>
      </div>
      {testResult && <Notice tone={testResult.ok ? "success" : "error"}>{testResult.text}</Notice>}
      {config.enabled && (
        <p className="text-xs leading-relaxed text-fg-muted">
          领到的活会出现在工作台 →「工作」里，跟你交代的工作一起排队。改电脑上的东西照样按「电脑控制」的规则先问你；山衡里的数据它改不了，只交报告。
        </p>
      )}
    </Card>
  );
}
