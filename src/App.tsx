import { Suspense, lazy, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useChatHotkeyRegistration } from "./store/shortcut";
import { useBotRosterSync } from "./store/bots";
import { ApprovalOverlay } from "./components/ApprovalOverlay";
import { useBotScopeSync } from "./agent/botScopeSync";
import { useCrossWindowSync } from "./store/windowSync";

type MainView = "chat" | "settings";

const Pet = lazy(() => import("./components/Pet").then((module) => ({ default: module.Pet })));
const ChatPanel = lazy(() => import("./components/ChatPanel").then((module) => ({ default: module.ChatPanel })));
const Settings = lazy(() => import("./components/Settings").then((module) => ({ default: module.Settings })));

function LoadingShell() {
  return <div className="chat-window flex h-screen w-screen items-center justify-center text-sm text-gray-400">Loading...</div>;
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
  const [mainView, setMainView] = useState<MainView>("chat");

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

    track(listen("open-chat", () => setMainView("chat")));
    track(listen("open-settings", () => setMainView("settings")));
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
        {mainView === "settings" ? (
          <Settings onBack={() => setMainView("chat")} />
        ) : (
          <ChatPanel
            onOpenSettings={() => setMainView("settings")}
            onBack={() => {
              try {
                getCurrentWindow().hide();
              } catch {
                // Browser dev fallback.
              }
            }}
          />
        )}
      </Suspense>
      <ApprovalOverlay />
    </>
  );
}
