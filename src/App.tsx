import { Suspense, lazy, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useChatHotkeyRegistration } from "./store/shortcut";
import { useBotRosterSync } from "./store/bots";
import { ApprovalOverlay } from "./components/ApprovalOverlay";
import { useBotScopeSync } from "./agent/botScopeSync";
import { useCrossWindowSync } from "./store/windowSync";
import { useThemeClass } from "./store/theme";

const Pet = lazy(() => import("./components/Pet").then((module) => ({ default: module.Pet })));
const Workbench = lazy(() => import("./components/Workbench").then((module) => ({ default: module.Workbench })));

function LoadingShell() {
  const themeClass = useThemeClass();
  return <div className={`${themeClass} flex h-screen w-screen items-center justify-center bg-app text-sm text-fg-muted`}>加载中…</div>;
}

function resolveWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // 浏览器 dev 预览没有 Tauri 运行时；?window=main 可直接查看工作台。
    const forced = new URLSearchParams(window.location.search).get("window");
    return forced === "main" ? "main" : "pet";
  }
}

export default function App() {
  const [windowLabel] = useState<string>(resolveWindowLabel);

  useChatHotkeyRegistration(windowLabel === "pet");
  useBotRosterSync();
  useBotScopeSync();
  useCrossWindowSync();

  useEffect(() => {
    if (windowLabel !== "main") return;

    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (promise: Promise<() => void>) =>
      promise
        .then((fn) => (disposed ? fn() : unlisteners.push(fn)))
        .catch(() => {});

    try {
      track(
        getCurrentWindow().onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await getCurrentWindow().hide();
          } catch {
            // Browser dev fallback.
          }
        })
      );
    } catch {
      // Browser dev fallback.
    }

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [windowLabel]);

  if (windowLabel === "pet") {
    return (
      <>
        <Suspense fallback={null}>
          <Pet />
        </Suspense>
        <ApprovalOverlay compact />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<LoadingShell />}>
        <Workbench />
      </Suspense>
      <ApprovalOverlay />
    </>
  );
}
