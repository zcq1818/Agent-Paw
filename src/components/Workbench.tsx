import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Brain,
  EyeOff,
  ListTodo,
  MessagesSquare,
  Network,
  Plus,
  ScrollText,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useChatStore, type Conversation } from "../store/chat";
import { getActiveBot, useBotStore } from "../store/bots";
import { useAgentStore } from "../store/agent";
import { useThemeClass } from "../store/theme";
import { BotAvatar } from "./BotAvatar";
import { ChatView } from "./ChatView";
import { Settings } from "./Settings";
import { BotRoster } from "./BotRoster";
import { RoomPanel } from "./RoomPanel";
import { ChiefPanel } from "./ChiefPanel";
import { MemoryPanel } from "./MemoryPanel";
import { CustomSkillsSettings } from "./CustomSkillsSettings";
import { ProductivityPanel } from "./ProductivityPanel";
import { ActivityPanel } from "./ActivityPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { useElementWidth } from "./ui";

export type WorkbenchView =
  | "chat"
  | "team"
  | "rooms"
  | "chief"
  | "memory"
  | "skills"
  | "tasks"
  | "activity"
  | "logs"
  | "settings";

const NAV_GROUPS: Array<{ title: string; items: Array<{ view: WorkbenchView; label: string; icon: ReactNode }> }> = [
  {
    title: "协作",
    items: [
      { view: "team", label: "团队", icon: <Users size={16} /> },
      { view: "rooms", label: "房间", icon: <MessagesSquare size={16} /> },
      { view: "chief", label: "总管", icon: <Network size={16} /> },
    ],
  },
  {
    title: "数据",
    items: [
      { view: "memory", label: "记忆", icon: <Brain size={16} /> },
      { view: "skills", label: "技能", icon: <Sparkles size={16} /> },
      { view: "tasks", label: "任务与日程", icon: <ListTodo size={16} /> },
      { view: "activity", label: "电脑活动", icon: <Activity size={16} /> },
      { view: "logs", label: "日志", icon: <ScrollText size={16} /> },
    ],
  },
];

/** 窄于这个宽度时侧边栏收起成抽屉。 */
const SIDEBAR_BREAKPOINT = 760;

function hideWindow() {
  try {
    getCurrentWindow().hide();
  } catch {
    // Browser dev fallback.
  }
}

function formatRelative(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = date.getTime();
  if (time >= startOfToday) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (time >= startOfToday - 86_400_000) return "昨天";
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.toLocaleDateString("zh-CN");
}

export function Workbench() {
  const themeClass = useThemeClass();
  const [view, setView] = useState<WorkbenchView>("chat");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const narrow = width < SIDEBAR_BREAKPOINT;

  // 托盘 / 宠物菜单通过事件切换视图。
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (promise: Promise<() => void>) =>
      promise.then((fn) => (disposed ? fn() : unlisteners.push(fn))).catch(() => {});
    track(listen("open-chat", () => setView("chat")));
    track(listen("open-settings", () => setView("settings")));
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  const navigate = useCallback((next: WorkbenchView) => {
    setView(next);
    setDrawerOpen(false);
  }, []);

  const openSidebar = narrow ? () => setDrawerOpen(true) : undefined;
  const backToChat = () => setView("chat");

  let content: ReactNode;
  switch (view) {
    case "chat":
      content = <ChatView onOpenSidebar={openSidebar} onOpenSettings={() => navigate("settings")} />;
      break;
    case "settings":
      content = <Settings onBack={backToChat} onOpenSidebar={openSidebar} />;
      break;
    case "team":
      content = <BotRoster onClose={backToChat} />;
      break;
    case "rooms":
      content = <RoomPanel onClose={backToChat} />;
      break;
    case "chief":
      content = <ChiefPanel onClose={backToChat} />;
      break;
    case "memory":
      content = <MemoryPanel onClose={backToChat} />;
      break;
    case "skills":
      content = <CustomSkillsSettings onClose={backToChat} />;
      break;
    case "tasks":
      content = <ProductivityPanel onClose={backToChat} />;
      break;
    case "activity":
      content = <ActivityPanel onClose={backToChat} />;
      break;
    case "logs":
      content = <DiagnosticsPanel onClose={backToChat} />;
      break;
  }

  const sidebar = (
    <Sidebar
      view={view}
      onNavigate={navigate}
      onClose={narrow ? () => setDrawerOpen(false) : undefined}
    />
  );

  return (
    <div ref={ref} className={`${themeClass} flex h-screen w-screen overflow-hidden bg-app text-fg`}>
      {!narrow && <div className="w-[248px] shrink-0">{sidebar}</div>}

      {narrow && drawerOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="drawer-in h-full w-[272px] max-w-[85vw] shadow-pop">{sidebar}</div>
          <button
            type="button"
            aria-label="关闭侧边栏"
            className="h-full flex-1 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      )}

      <main className="panel-host relative flex h-full min-w-0 flex-1 flex-col">{content}</main>
    </div>
  );
}

function Sidebar({
  view,
  onNavigate,
  onClose,
}: {
  view: WorkbenchView;
  onNavigate: (view: WorkbenchView) => void;
  onClose?: () => void;
}) {
  const activeBot = useBotStore((state) => getActiveBot(state));
  const conversations = useChatStore((state) => state.conversations);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const createConversation = useChatStore((state) => state.createConversation);
  const switchConversation = useChatStore((state) => state.switchConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const renameConversation = useChatStore((state) => state.renameConversation);
  const isStreaming = useAgentStore((state) => state.isStreaming);

  const sorted = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
    [conversations]
  );

  return (
    <aside className="flex h-full flex-col bg-sidebar text-sidebar-fg">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        {activeBot ? (
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10">
            <BotAvatar bot={activeBot} size={28} />
          </span>
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-fg">P</span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">Paw 工作台</div>
          <div className="flex items-center gap-1.5 truncate text-xs text-sidebar-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${isStreaming ? "bg-accent" : "bg-primary"}`} aria-hidden="true" />
            {activeBot?.name || "皮卡丘"}
            {isStreaming ? " · 回复中" : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose || hideWindow}
          aria-label={onClose ? "关闭侧边栏" : "隐藏窗口"}
          title={onClose ? "关闭侧边栏" : "隐藏窗口"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-muted transition hover:bg-sidebar-hover hover:text-sidebar-fg"
        >
          {onClose ? <X size={16} /> : <EyeOff size={16} />}
        </button>
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={() => {
            createConversation();
            onNavigate("chat");
          }}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-fg transition hover:brightness-110"
        >
          <Plus size={16} />
          新对话
        </button>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="px-4 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-sidebar-muted">对话</div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
          {sorted.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              active={view === "chat" && conversation.id === activeConversationId}
              onSelect={() => {
                switchConversation(conversation.id);
                onNavigate("chat");
              }}
              onRename={(title) => renameConversation(conversation.id, title)}
              onDelete={() => {
                if (confirm(`删除对话「${conversation.title}」？`)) deleteConversation(conversation.id);
              }}
            />
          ))}
        </div>
      </div>

      <nav className="border-t border-white/10 px-2 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="mb-2">
            <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-sidebar-muted">{group.title}</div>
            {group.items.map((item) => (
              <NavItem key={item.view} active={view === item.view} icon={item.icon} label={item.label} onClick={() => onNavigate(item.view)} />
            ))}
          </div>
        ))}
        <NavItem active={view === "settings"} icon={<SettingsIcon size={16} />} label="设置" onClick={() => onNavigate("settings")} />
      </nav>
    </aside>
  );
}

function NavItem({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-sm transition ${
        active ? "bg-sidebar-hover text-sidebar-fg" : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg"
      }`}
    >
      <span className={active ? "text-primary" : ""}>{icon}</span>
      {label}
    </button>
  );
}

function ConversationItem({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          onRename(draft);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onRename(draft);
            setEditing(false);
          }
          if (event.key === "Escape") setEditing(false);
        }}
        className="h-9 w-full rounded-lg border border-primary bg-sidebar-hover px-2.5 text-sm text-sidebar-fg outline-none"
      />
    );
  }

  return (
    <div
      className={`group relative flex h-9 items-center rounded-lg transition ${
        active ? "bg-sidebar-hover" : "hover:bg-sidebar-hover/70"
      }`}
    >
      {active && <span className="absolute left-0 top-2 h-5 w-0.5 rounded-full bg-primary" aria-hidden="true" />}
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => {
          setDraft(conversation.title);
          setEditing(true);
        }}
        title="双击重命名"
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-left"
      >
        <span className={`min-w-0 flex-1 truncate text-sm ${active ? "text-sidebar-fg" : "text-sidebar-fg/85"}`}>
          {conversation.title || "新对话"}
        </span>
        <span className="shrink-0 text-[11px] text-sidebar-muted group-hover:hidden">{formatRelative(conversation.updatedAt)}</span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label="删除对话"
        title="删除对话"
        className="mr-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted hover:bg-white/10 hover:text-sidebar-fg group-hover:flex"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
