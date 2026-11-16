import { useEffect, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 自动更新：从 GitHub Releases 的 latest.json 检查新版本（地址和公钥在 tauri.conf.json）。
 * - 桌宠启动 1 分钟后查一次，之后每 6 小时查一次；有新版本时桌宠弹一张卡片问要不要更新；
 * - “跳过这个版本”后，同一个版本不再提醒；
 * - 开发版不检查。
 * 更新只替换程序，安装目录下的 data 文件夹（聊天、记忆、设置）不会动。
 */

const SKIP_KEY = "paw_update_skip";
const AUTO_KEY = "paw_update_auto_check";
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

export type UpdateInfo = { version: string; notes: string; update: Update };

export function autoCheckEnabled() {
  return localStorage.getItem(AUTO_KEY) !== "off";
}

export function setAutoCheckEnabled(on: boolean) {
  localStorage.setItem(AUTO_KEY, on ? "on" : "off");
}

export function skipVersion(version: string) {
  localStorage.setItem(SKIP_KEY, version);
}

export async function currentVersion() {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

/** 查一次；没有新版本返回 null，出错抛出 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check({ timeout: 20_000 });
  if (!update) return null;
  return { version: update.version, notes: (update.body || "").trim(), update };
}

/** 下载并安装，完成后重启。onProgress 收到 0-100 */
export async function installUpdate(info: UpdateInfo, onProgress?: (percent: number) => void) {
  let total = 0;
  let done = 0;
  await info.update.downloadAndInstall((event) => {
    if (event.event === "Started") total = event.data.contentLength || 0;
    if (event.event === "Progress") {
      done += event.data.chunkLength;
      if (total) onProgress?.(Math.min(99, Math.round((done / total) * 100)));
    }
    if (event.event === "Finished") onProgress?.(100);
  });
  await relaunch();
}

/** 桌宠窗口用：后台定时检查，发现没跳过的新版本就回调 */
export function useUpdateCheck(onFound: (info: UpdateInfo) => void) {
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;
  useEffect(() => {
    // 开发版（vite 开发服务器）不检查
    if (window.location.hostname === "localhost") return;
    let stopped = false;
    const run = async () => {
      if (stopped || !autoCheckEnabled()) return;
      try {
        const info = await checkForUpdate();
        if (info && !stopped && localStorage.getItem(SKIP_KEY) !== info.version) onFoundRef.current(info);
      } catch {
        // 没网、GitHub 访问不了都正常，下次再查
      }
    };
    const first = window.setTimeout(run, FIRST_CHECK_MS);
    const timer = window.setInterval(run, CHECK_EVERY_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
}
