import { useMemo, useState } from "react";
import { calendarStore, todoStore } from "../agent/tools";
import { useThemeClass } from "../store/theme";

interface ProductivityPanelProps {
  onClose: () => void;
}

export function ProductivityPanel({ onClose }: ProductivityPanelProps) {
  const themeClass = useThemeClass();
  const [version, setVersion] = useState(0);
  const [todoText, setTodoText] = useState("");
  const [todoDueDate, setTodoDueDate] = useState("");
  const [todoPriority, setTodoPriority] = useState<"high" | "medium" | "low">("medium");
  const [todoFilter, setTodoFilter] = useState<"active" | "all" | "completed">("active");
  const [eventTitle, setEventTitle] = useState("");
  const [eventTime, setEventTime] = useState("");

  const refresh = () => setVersion((value) => value + 1);
  const todos = useMemo(() => {
    const all = todoStore.getAll();
    if (todoFilter === "active") return all.filter((todo) => !todo.completed);
    if (todoFilter === "completed") return all.filter((todo) => todo.completed);
    return all;
  }, [todoFilter, version]);
  const events = useMemo(() => calendarStore.getAll(), [version]);
  const stats = useMemo(() => todoStore.getStats(), [version]);

  const addTodo = () => {
    const text = todoText.trim();
    if (!text) return;
    todoStore.add(text, todoPriority, todoDueDate ? new Date(todoDueDate).toISOString() : undefined);
    setTodoText("");
    setTodoDueDate("");
    setTodoPriority("medium");
    refresh();
  };

  const addEvent = () => {
    const title = eventTitle.trim();
    if (!title || !eventTime) return;
    calendarStore.add(title, new Date(eventTime).toISOString());
    setEventTitle("");
    setEventTime("");
    refresh();
  };

  return (
    <div className={`chat-window ${themeClass} flex flex-col h-screen`}>
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800/80 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            ←
          </button>
          <span className="font-semibold text-white">任务与日程</span>
        </div>
        <span className="text-xs text-gray-400">
          待办 {stats.total - stats.completed} / {stats.total}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">
        <section className="grid grid-cols-3 gap-2">
          <StatCard label="未完成" value={stats.total - stats.completed} tone="yellow" />
          <StatCard label="已逾期" value={stats.overdue} tone={stats.overdue > 0 ? "red" : "gray"} />
          <StatCard label="高优先" value={stats.byPriority.high} tone="blue" />
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">新增待办</h3>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              className="input"
              value={todoText}
              onChange={(event) => setTodoText(event.target.value)}
              placeholder="例如：整理项目发布清单"
            />
            <button onClick={addTodo} className="px-3 bg-yellow-500 hover:bg-yellow-400 rounded-lg text-sm font-bold text-gray-900">
              添加
            </button>
          </div>
          <div className="grid grid-cols-[1fr_116px] gap-2">
            <input
              className="input"
              type="datetime-local"
              value={todoDueDate}
              onChange={(event) => setTodoDueDate(event.target.value)}
            />
            <select className="input" value={todoPriority} onChange={(event) => setTodoPriority(event.target.value as typeof todoPriority)}>
              <option value="high">高优先</option>
              <option value="medium">普通</option>
              <option value="low">低优先</option>
            </select>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-300">待办列表</h3>
            <div className="flex rounded-lg border border-gray-700 bg-gray-800/70 p-0.5 text-xs">
              {[
                ["active", "未完成"],
                ["all", "全部"],
                ["completed", "已完成"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTodoFilter(value as typeof todoFilter)}
                  className={`rounded-md px-2 py-1 transition-colors ${
                    todoFilter === value ? "bg-yellow-500 text-gray-900" : "text-gray-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {todos.length === 0 ? (
            <p className="text-sm text-gray-500">暂无待办。</p>
          ) : (
            todos.map((todo) => {
              const overdue = Boolean(todo.dueDate && !todo.completed && new Date(todo.dueDate) < new Date());
              const priorityLabel = todo.priority === "high" ? "高" : todo.priority === "low" ? "低" : "中";
              const priorityClass =
                todo.priority === "high"
                  ? "bg-red-500/15 text-red-300 border-red-500/30"
                  : todo.priority === "low"
                    ? "bg-gray-700 text-gray-300 border-gray-600"
                    : "bg-blue-500/15 text-blue-300 border-blue-500/30";

              return (
                <div
                  key={todo.id}
                  className={`flex items-start gap-2 rounded-lg border p-3 ${
                    overdue ? "border-red-500/40 bg-red-950/30" : "border-gray-700 bg-gray-800/70"
                  }`}
                >
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => {
                      todoStore.toggle(todo.id);
                      refresh();
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] ${priorityClass}`}>{priorityLabel}</span>
                      {overdue && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-300">逾期</span>}
                    </div>
                    <div className={`text-sm ${todo.completed ? "line-through text-gray-500" : "text-gray-100"}`}>{todo.text}</div>
                    {todo.dueDate && <div className="mt-1 text-xs text-gray-500">截止：{new Date(todo.dueDate).toLocaleString("zh-CN")}</div>}
                  </div>
                  <button
                    className="text-xs text-red-300 hover:text-red-200"
                    onClick={() => {
                      todoStore.delete(todo.id);
                      refresh();
                    }}
                  >
                    删除
                  </button>
                </div>
              );
            })
          )}
        </section>

        <section className="space-y-3 pt-3 border-t border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300">新增日程</h3>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              className="input"
              value={eventTitle}
              onChange={(event) => setEventTitle(event.target.value)}
              placeholder="例如：项目复盘"
            />
            <button onClick={addEvent} className="px-3 bg-yellow-500 hover:bg-yellow-400 rounded-lg text-sm font-bold text-gray-900">
              添加
            </button>
          </div>
          <input className="input" type="datetime-local" value={eventTime} onChange={(event) => setEventTime(event.target.value)} />
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-300">即将到来的日程</h3>
          {events.length === 0 ? (
            <p className="text-sm text-gray-500">暂无日程。</p>
          ) : (
            events.map((event) => (
              <div key={event.id} className="flex items-start gap-3 rounded-lg bg-gray-800/70 border border-gray-700 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-100">{event.title}</div>
                  <div className="text-xs text-gray-500 mt-1">{new Date(event.startTime).toLocaleString("zh-CN")}</div>
                </div>
                <button
                  className="text-xs text-red-300 hover:text-red-200"
                  onClick={() => {
                    calendarStore.delete(event.id);
                    refresh();
                  }}
                >
                  删除
                </button>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: "yellow" | "red" | "blue" | "gray" }) {
  const toneClass =
    tone === "yellow"
      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-300"
      : tone === "red"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : tone === "blue"
          ? "border-blue-500/30 bg-blue-500/10 text-blue-300"
          : "border-gray-700 bg-gray-800/70 text-gray-400";

  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="text-lg font-semibold leading-none">{value}</div>
      <div className="mt-1 text-xs opacity-80">{label}</div>
    </div>
  );
}
