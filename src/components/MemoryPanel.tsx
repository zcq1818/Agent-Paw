import { useEffect, useMemo, useState } from "react";
import { Brain, Plus, Trash2 } from "lucide-react";
import { Button, EmptyState, FilterChips, PageHeader, SearchInput, relativeTime } from "./ui";
import { memoryStore, type Memory, type MemoryPriority, type MemoryType } from "../agent/memory";
import { useThemeClass } from "../store/theme";

interface MemoryPanelProps {
  onClose: () => void;
}

const TYPE_LABELS: Record<MemoryType, string> = {
  preference: "偏好",
  fact: "事实",
  habit: "习惯",
  important: "重要",
  task: "任务",
};

/** 类型用不同的小色点区分，颜色都在品牌色系里 */
const TYPE_DOT: Record<MemoryType, string> = {
  preference: "bg-primary",
  fact: "bg-[#8D99AE]",
  habit: "bg-[#041E42] dark:bg-[#8D99AE]",
  important: "bg-accent",
  task: "bg-primary/50",
};

const PRIORITY_LABELS: Record<MemoryPriority, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export function MemoryPanel({ onClose }: MemoryPanelProps) {
  const themeClass = useThemeClass();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | MemoryType>("all");
  const [loading, setLoading] = useState(true);
  const [manualContent, setManualContent] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const all = await memoryStore.getAll();
      setMemories(all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return memories.filter((memory) => {
      const matchesType = type === "all" || memory.type === type;
      const haystack = `${memory.content} ${memory.tags.join(" ")}`.toLowerCase();
      return matchesType && (!keyword || haystack.includes(keyword));
    });
  }, [memories, query, type]);

  const counts = useMemo(() => {
    const byType: Record<string, number> = {};
    let high = 0;
    let expired = 0;
    const now = Date.now();
    for (const memory of memories) {
      byType[memory.type] = (byType[memory.type] || 0) + 1;
      if (memory.priority === "high") high += 1;
      if (memory.expiresAt && new Date(memory.expiresAt).getTime() <= now) expired += 1;
    }
    return { byType, high, expired };
  }, [memories]);

  const addManualMemory = async () => {
    const content = manualContent.trim();
    if (!content) return;
    await memoryStore.add({ type: "important", content, tags: ["manual"], priority: "medium", importance: 6 });
    setManualContent("");
    setNotice("记住了。");
    refresh();
  };

  const deleteMemory = async (id: string) => {
    if (!confirm("确定删除这条记忆吗？")) return;
    await memoryStore.delete(id);
    refresh();
  };

  const cleanupExpired = async () => {
    await memoryStore.cleanupExpired();
    setNotice(counts.expired ? `清理了 ${counts.expired} 条过期记忆。` : "没有过期的记忆。");
    refresh();
  };

  const cleanupDuplicates = async () => {
    const removed = await memoryStore.cleanupDuplicates();
    await refresh();
    setNotice(removed > 0 ? `合并并删除了 ${removed} 条重复记忆。` : "没有重复的记忆。");
  };

  const typeOptions = [
    { value: "all" as const, label: "全部", count: memories.length },
    ...(Object.keys(TYPE_LABELS) as MemoryType[])
      .filter((key) => counts.byType[key])
      .map((key) => ({ value: key, label: TYPE_LABELS[key], count: counts.byType[key] })),
  ];

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader
        title="记忆"
        description={`桌宠记住的关于你的事，回答时会参考 · 共 ${memories.length} 条${counts.high ? `，${counts.high} 条重要` : ""}`}
        onBack={onClose}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={cleanupDuplicates} title="合并内容重复的记忆">
              去重
            </Button>
            <Button size="sm" variant="ghost" onClick={cleanupExpired} title="删除已经过期的记忆">
              清理过期{counts.expired ? ` ${counts.expired}` : ""}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="page-pad space-y-4 py-5">
          {/* 手动记一条 */}
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-1.5 pl-3 transition focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/10">
            <Brain size={16} className="shrink-0 text-primary" />
            <input
              className="chat-composer-input min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm text-fg outline-none placeholder:text-fg-muted"
              value={manualContent}
              onChange={(event) => setManualContent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) addManualMemory();
              }}
              placeholder="让桌宠记住一件事，比如“我周三下午固定开组会”"
            />
            <Button size="sm" variant="primary" disabled={!manualContent.trim()} onClick={addManualMemory}>
              <Plus size={14} />
              记住
            </Button>
          </div>

          {/* 搜索 + 分类 */}
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput value={query} onChange={setQuery} placeholder="搜索内容或标签" className="w-full sm:w-64" />
            <FilterChips value={type} options={typeOptions} onChange={setType} />
            {notice && <span className="ml-auto text-xs text-fg-muted">{notice}</span>}
          </div>

          {/* 列表 */}
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {loading ? (
              <div className="py-12 text-center text-sm text-fg-muted">正在读取…</div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Brain size={20} />}
                title={memories.length ? "没有匹配的记忆" : "还没有记忆"}
                hint={memories.length ? "换个关键词或分类试试。" : "聊天时说“记住……”，或者在上面直接添加。"}
              />
            ) : (
              <ul className="divide-y divide-line">
                {filtered.map((memory) => (
                  <li key={memory.id} className="group flex items-start gap-3 px-4 py-3 transition hover:bg-surface-2/60">
                    <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${TYPE_DOT[memory.type]}`} title={TYPE_LABELS[memory.type]} />
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{memory.content}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
                        <span>{TYPE_LABELS[memory.type]}</span>
                        {memory.priority === "high" && <span className="text-accent">重要</span>}
                        {memory.priority === "low" && <span>优先级 {PRIORITY_LABELS[memory.priority]}</span>}
                        <span>{relativeTime(memory.updatedAt)}</span>
                        {memory.tags
                          .filter((tag) => tag !== "manual")
                          .slice(0, 4)
                          .map((tag) => (
                            <span key={tag} className="rounded bg-surface-2 px-1.5 py-px">
                              {tag}
                            </span>
                          ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteMemory(memory.id)}
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                      title="删除这条记忆"
                      aria-label="删除这条记忆"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
