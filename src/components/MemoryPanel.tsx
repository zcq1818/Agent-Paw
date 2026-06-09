import { useEffect, useMemo, useState } from "react";
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
    const result = { total: memories.length, high: 0, expired: 0 };
    const now = Date.now();
    for (const memory of memories) {
      if (memory.priority === "high") result.high += 1;
      if (memory.expiresAt && new Date(memory.expiresAt).getTime() <= now) result.expired += 1;
    }
    return result;
  }, [memories]);

  const addManualMemory = async () => {
    const content = manualContent.trim();
    if (!content) return;
    await memoryStore.add({
      type: "important",
      content,
      tags: ["manual"],
      priority: "medium",
      importance: 6,
    });
    setManualContent("");
    refresh();
  };

  const deleteMemory = async (id: string) => {
    if (!confirm("确定删除这条记忆吗？")) return;
    await memoryStore.delete(id);
    refresh();
  };

  const cleanupExpired = async () => {
    await memoryStore.cleanupExpired();
    refresh();
  };

  const cleanupDuplicates = async () => {
    const removed = await memoryStore.cleanupDuplicates();
    await refresh();
    if (removed > 0) {
      alert(`已合并并删除 ${removed} 条重复记忆。`);
    }
  };

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col`}>
      <div className="border-b border-gray-700 bg-gray-800/80 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="text-gray-400 transition-colors hover:text-white" aria-label="返回工作台">
              ←
            </button>
            <div>
              <div className="font-semibold text-white">本地记忆</div>
              <div className="text-xs text-gray-400">只保存在本机，用来让桌宠更懂你。</div>
            </div>
          </div>
          <button onClick={refresh} className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-100 hover:bg-gray-600">
            刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 border-b border-gray-800 px-4 py-3 text-center text-xs">
        <div className="bg-gray-800/60 p-3">
          <div className="text-lg font-bold text-white">{counts.total}</div>
          <div className="text-gray-400">全部</div>
        </div>
        <div className="bg-gray-800/60 p-3">
          <div className="text-lg font-bold text-yellow-300">{counts.high}</div>
          <div className="text-gray-400">高优先级</div>
        </div>
        <div className="bg-gray-800/60 p-3">
          <div className="text-lg font-bold text-red-300">{counts.expired}</div>
          <div className="text-gray-400">已过期</div>
        </div>
      </div>

      <div className="space-y-2 border-b border-gray-800 px-4 py-3">
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆内容或标签" />
          <select className="input" value={type} onChange={(event) => setType(event.target.value as "all" | MemoryType)}>
            <option value="all">全部类型</option>
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2">
          <input
            className="input"
            value={manualContent}
            onChange={(event) => setManualContent(event.target.value)}
            placeholder="手动添加一条重要记忆"
          />
          <button onClick={addManualMemory} className="rounded-lg bg-yellow-500 px-3 text-sm font-bold text-gray-900 hover:bg-yellow-400">
            添加
          </button>
          <button onClick={cleanupDuplicates} className="rounded-lg bg-gray-700 px-3 text-sm text-gray-100 hover:bg-gray-600">
            去重
          </button>
          <button onClick={cleanupExpired} className="rounded-lg bg-gray-700 px-3 text-sm text-gray-100 hover:bg-gray-600">
            清理过期
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {loading && <div className="py-12 text-center text-sm text-gray-400">正在读取本地记忆...</div>}
        {!loading && filtered.length === 0 && <div className="py-12 text-center text-sm text-gray-500">暂时没有匹配的记忆。</div>}
        {filtered.map((memory) => (
          <article key={memory.id} className="border border-gray-700 bg-gray-800/55 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="bg-yellow-500/15 px-2 py-0.5 text-yellow-200">{TYPE_LABELS[memory.type]}</span>
                <span className="bg-gray-700 px-2 py-0.5 text-gray-300">优先级 {PRIORITY_LABELS[memory.priority]}</span>
                <span className="text-gray-500">重要度 {memory.importance}</span>
              </div>
              <button onClick={() => deleteMemory(memory.id)} className="text-xs text-red-300 hover:text-red-200">
                删除
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-100">{memory.content}</p>
            <div className="mt-2 flex flex-wrap gap-1 text-xs text-gray-500">
              {memory.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
              <span>更新于 {new Date(memory.updatedAt).toLocaleString()}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
