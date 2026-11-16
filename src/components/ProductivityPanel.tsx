import { useMemo, useState } from "react";
import { CalendarDays, Check, Flag, ListTodo, Plus, Trash2 } from "lucide-react";
import { Button, EmptyState, FilterChips, PageHeader, relativeTime } from "./ui";
import { calendarStore, todoStore } from "../agent/tools";
import { useThemeClass } from "../store/theme";

interface ProductivityPanelProps {
  onClose: () => void;
}

type TodoFilter = "active" | "all" | "completed";

function dayLabel(date: Date) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const diff = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  const week = "日一二三四五六"[date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日 周${week}`;
}

export function ProductivityPanel({ onClose }: ProductivityPanelProps) {
  const themeClass = useThemeClass();
  const [version, setVersion] = useState(0);
  const [todoText, setTodoText] = useState("");
  const [todoDueDate, setTodoDueDate] = useState("");
  const [todoHigh, setTodoHigh] = useState(false);
  const [todoFilter, setTodoFilter] = useState<TodoFilter>("active");
  const [eventTitle, setEventTitle] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [showPast, setShowPast] = useState(false);

  const refresh = () => setVersion((value) => value + 1);
  const allTodos = useMemo(() => todoStore.getAll(), [version]);
  const todos = useMemo(() => {
    const list =
      todoFilter === "active"
        ? allTodos.filter((todo) => !todo.completed)
        : todoFilter === "completed"
          ? allTodos.filter((todo) => todo.completed)
          : allTodos;
    // 未完成在前；高优先在前；有截止时间的按时间
    return [...list].sort(
      (a, b) =>
        Number(a.completed) - Number(b.completed) ||
        Number(b.priority === "high") - Number(a.priority === "high") ||
        (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity)
    );
  }, [allTodos, todoFilter]);
  const stats = useMemo(() => todoStore.getStats(), [version]);

  const now = Date.now();
  const events = useMemo(
    () => [...calendarStore.getAll()].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
    [version]
  );
  const upcoming = events.filter((event) => new Date(event.startTime).getTime() >= now - 3_600_000);
  const past = events.filter((event) => new Date(event.startTime).getTime() < now - 3_600_000);
  const groups = useMemo(() => {
    const map = new Map<string, typeof upcoming>();
    for (const event of upcoming) {
      const label = dayLabel(new Date(event.startTime));
      map.set(label, [...(map.get(label) || []), event]);
    }
    return [...map.entries()];
  }, [upcoming]);

  const addTodo = () => {
    const text = todoText.trim();
    if (!text) return;
    todoStore.add(text, todoHigh ? "high" : "medium", todoDueDate ? new Date(todoDueDate).toISOString() : undefined);
    setTodoText("");
    setTodoDueDate("");
    setTodoHigh(false);
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

  const active = stats.total - stats.completed;

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader
        title="任务与日程"
        description={`${active} 项待办${stats.overdue ? `，${stats.overdue} 项已逾期` : ""} · ${upcoming.length} 个日程 · 也可以直接对桌宠说“提醒我…”`}
        onBack={onClose}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="page-pad grid gap-5 py-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* 待办 */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
                <ListTodo size={16} className="text-primary" />
                待办
              </h2>
              <FilterChips
                value={todoFilter}
                options={[
                  { value: "active", label: "未完成", count: active },
                  { value: "all", label: "全部", count: stats.total },
                  { value: "completed", label: "已完成", count: stats.completed },
                ]}
                onChange={setTodoFilter}
              />
            </div>

            <div className="rounded-xl border border-line bg-surface p-1.5 transition focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/10">
              <div className="flex items-center gap-2 pl-2">
                <Plus size={16} className="shrink-0 text-fg-muted" />
                <input
                  className="chat-composer-input min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm text-fg outline-none placeholder:text-fg-muted"
                  value={todoText}
                  onChange={(event) => setTodoText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) addTodo();
                  }}
                  placeholder="加一项待办，回车添加"
                />
                <Button size="sm" variant="primary" disabled={!todoText.trim()} onClick={addTodo}>
                  添加
                </Button>
              </div>
              {todoText.trim() && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-line px-2 pt-1.5">
                  <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                    截止
                    <input
                      type="datetime-local"
                      value={todoDueDate}
                      onChange={(event) => setTodoDueDate(event.target.value)}
                      className="input h-7 w-auto px-2 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setTodoHigh((value) => !value)}
                    className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs transition ${
                      todoHigh ? "bg-accent/15 text-accent" : "text-fg-muted hover:bg-surface-2"
                    }`}
                  >
                    <Flag size={12} />
                    重要
                  </button>
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {todos.length === 0 ? (
                <EmptyState
                  icon={<Check size={20} />}
                  title={todoFilter === "completed" ? "还没有完成的待办" : "没有待办，轻松一下"}
                  hint="在上面添加，或者对桌宠说“帮我记一下明天交周报”。"
                />
              ) : (
                <ul className="divide-y divide-line">
                  {todos.map((todo) => {
                    const overdue = Boolean(todo.dueDate && !todo.completed && new Date(todo.dueDate).getTime() < now);
                    return (
                      <li key={todo.id} className="group flex items-start gap-3 px-4 py-3 transition hover:bg-surface-2/60">
                        <button
                          type="button"
                          onClick={() => {
                            todoStore.toggle(todo.id);
                            refresh();
                          }}
                          aria-label={todo.completed ? "标记为未完成" : "标记为完成"}
                          className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition ${
                            todo.completed ? "border-primary bg-primary text-primary-fg" : "border-line hover:border-primary"
                          }`}
                        >
                          {todo.completed && <Check size={11} strokeWidth={3} />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className={`text-sm leading-relaxed ${todo.completed ? "text-fg-muted line-through" : "text-fg"}`}>
                            {todo.text}
                          </div>
                          {(todo.dueDate || todo.priority === "high") && (
                            <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                              {todo.priority === "high" && !todo.completed && (
                                <span className="flex items-center gap-0.5 text-accent">
                                  <Flag size={10} />
                                  重要
                                </span>
                              )}
                              {todo.dueDate && (
                                <span className={overdue ? "font-medium text-danger" : "text-fg-muted"}>
                                  {overdue ? "已逾期 · " : "截止 "}
                                  {relativeTime(todo.dueDate)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            todoStore.delete(todo.id);
                            refresh();
                          }}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                          aria-label="删除待办"
                          title="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* 日程 */}
          <section className="space-y-3">
            <h2 className="flex h-7 items-center gap-2 text-sm font-semibold text-fg">
              <CalendarDays size={16} className="text-primary" />
              日程
            </h2>

            <div className="space-y-1.5 rounded-xl border border-line bg-surface p-1.5 transition focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/10">
              <div className="flex items-center gap-2 pl-2">
                <Plus size={16} className="shrink-0 text-fg-muted" />
                <input
                  className="chat-composer-input min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm text-fg outline-none placeholder:text-fg-muted"
                  value={eventTitle}
                  onChange={(event) => setEventTitle(event.target.value)}
                  placeholder="加一个日程，比如“项目复盘”"
                />
              </div>
              <div className="flex items-center gap-2 border-t border-line px-2 pt-1.5">
                <input
                  type="datetime-local"
                  value={eventTime}
                  onChange={(event) => setEventTime(event.target.value)}
                  className="input h-8 min-w-0 flex-1 px-2 text-xs"
                />
                <Button size="sm" variant="primary" disabled={!eventTitle.trim() || !eventTime} onClick={addEvent}>
                  添加
                </Button>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {groups.length === 0 ? (
                <EmptyState icon={<CalendarDays size={20} />} title="接下来没有日程" hint="对桌宠说“下周一上午十点开会”也能加上。" />
              ) : (
                groups.map(([label, list]) => (
                  <div key={label}>
                    <div className="border-b border-line bg-surface-2/60 px-4 py-1.5 text-[11px] font-medium text-fg-muted">{label}</div>
                    <ul className="divide-y divide-line">
                      {list.map((event) => (
                        <li key={event.id} className="group flex items-center gap-3 px-4 py-2.5 transition hover:bg-surface-2/60">
                          <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-primary-ink">
                            {new Date(event.startTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-fg">{event.title}</span>
                          <button
                            type="button"
                            onClick={() => {
                              calendarStore.delete(event.id);
                              refresh();
                            }}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                            aria-label="删除日程"
                            title="删除"
                          >
                            <Trash2 size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>

            {past.length > 0 && (
              <div className="text-xs text-fg-muted">
                <button type="button" className="hover:text-fg" onClick={() => setShowPast((value) => !value)}>
                  {showPast ? "收起" : "查看"}已经过去的 {past.length} 个日程
                </button>
                {showPast && (
                  <ul className="mt-2 space-y-1">
                    {past
                      .slice()
                      .reverse()
                      .map((event) => (
                        <li key={event.id} className="flex items-center gap-2">
                          <span className="tabular-nums">{relativeTime(event.startTime)}</span>
                          <span className="truncate">{event.title}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
