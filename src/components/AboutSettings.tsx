import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { Loader2 } from "lucide-react";
import { Button, Card, Notice, SettingRow, Switch } from "./ui";
import {
  autoCheckEnabled,
  checkForUpdate,
  currentVersion,
  installUpdate,
  setAutoCheckEnabled,
  type UpdateInfo,
} from "../agent/updater";

const REPO_URL = "https://github.com/zcq1818/Agent-Paw";

/** 设置 → 关于：版本号、检查更新、项目主页 */
export function AboutSettingsCard() {
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState(autoCheckEnabled);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    void currentVersion().then(setVersion);
  }, []);

  const runCheck = async () => {
    setChecking(true);
    setMessage(null);
    setFound(null);
    try {
      const info = await checkForUpdate();
      if (info) setFound(info);
      else setMessage({ tone: "success", text: "已经是最新版本了。" });
    } catch (error) {
      setMessage({ tone: "error", text: `检查失败：${error instanceof Error ? error.message : String(error)}。网络不通或访问不了 GitHub 时会这样，稍后再试。` });
    } finally {
      setChecking(false);
    }
  };

  const runInstall = async () => {
    if (!found) return;
    setProgress(0);
    setMessage(null);
    try {
      await installUpdate(found, setProgress);
    } catch (error) {
      setProgress(null);
      setMessage({ tone: "error", text: `更新失败：${error instanceof Error ? error.message : String(error)}` });
    }
  };

  return (
    <Card title="关于 Paw" description="开源的 AI 桌面宠物。聊天、记忆、设置都只保存在本机。">
      <SettingRow title="当前版本" description={version ? `v${version}` : "开发版"}>
        <Button size="sm" onClick={() => void runCheck()} disabled={checking || progress !== null}>
          {checking && <Loader2 size={13} className="animate-spin" />}
          检查更新
        </Button>
      </SettingRow>

      {found && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 px-3.5 py-3">
          <div className="text-sm font-medium text-fg">有新版本 v{found.version}</div>
          {found.notes && <div className="max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">{found.notes}</div>}
          {progress === null ? (
            <Button size="sm" variant="primary" onClick={() => void runInstall()}>
              更新并重启
            </Button>
          ) : (
            <div className="space-y-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(4, progress)}%` }} />
              </div>
              <div className="text-xs text-fg-muted">{progress >= 100 ? "装好了，马上重启…" : `正在下载 ${progress}%`}</div>
            </div>
          )}
        </div>
      )}

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <SettingRow title="自动检查更新" description="启动后和每隔几小时看一眼 GitHub 有没有新版本，有的话桌宠会问你。更新不会动你的数据。">
        <Switch
          label="自动检查更新"
          checked={auto}
          onChange={(value) => {
            setAuto(value);
            setAutoCheckEnabled(value);
          }}
        />
      </SettingRow>

      <SettingRow title="项目主页" description="源码、问题反馈和更新记录都在这里。">
        <Button size="sm" onClick={() => void open(REPO_URL)}>
          打开 GitHub
        </Button>
      </SettingRow>
    </Card>
  );
}
