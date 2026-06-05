import { useEffect, useState } from "react";
import { Pet } from "./components/Pet";
import { ChatPanel } from "./components/ChatPanel";
import { Settings } from "./components/Settings";

type View = "pet" | "chat" | "settings";

export default function App() {
  const [view, setView] = useState<View>("pet");

  // 根据窗口标签判断当前是宠物窗口还是主窗口
  useEffect(() => {
    const label = window.__TAURI__?.window?.label;
    if (label === "main") {
      setView("chat");
    }
  }, []);

  switch (view) {
    case "pet":
      return <Pet onOpenChat={() => setView("chat")} />;
    case "chat":
      return (
        <ChatPanel
          onOpenSettings={() => setView("settings")}
          onBack={() => setView("pet")}
        />
      );
    case "settings":
      return <Settings onBack={() => setView("chat")} />;
  }
}
