import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, FileText, FolderOpen, Pencil, Plus, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import { Button, EmptyState, FilterChips, PageHeader, SearchInput, Switch } from "./ui";
import { customSkillsStore, type CustomSkill } from "../agent/customSkills";
import { useSkillLibrary, type LibrarySkill } from "../agent/skillLibrary";
import { SOURCE_LABEL, SkillEditor, SkillSources, askPetToWriteSkill, openFolder } from "./SkillLibraryPanel";
import { useThemeClass } from "../store/theme";
import { invoke } from "@tauri-apps/api/core";

interface CustomSkillsSettingsProps {
  onClose: () => void;
}

type SourceFilter = "all" | LibrarySkill["source"];

type Row =
  | { kind: "folder"; key: string; skill: LibrarySkill }
  | { kind: "app"; key: string; skill: CustomSkill };

interface SimpleDraft {
  name: string;
  description: string;
  instructions: string;
  examples: string;
}

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** 只有说明文字的“简单技能”（存在本机设置里）的编辑表单。 */
function SimpleSkillForm({ skill, onDone }: { skill?: CustomSkill; onDone: () => void }) {
  const [draft, setDraft] = useState<SimpleDraft>({
    name: skill?.name || "",
    description: skill?.description || "",
    instructions: skill?.instructions || "",
    examples: skill?.examples.join("\n") || "",
  });
  const patch = (value: Partial<SimpleDraft>) => setDraft((current) => ({ ...current, ...value }));
  const save = () => {
    if (!draft.name.trim() || !draft.description.trim()) return;
    const data = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      instructions: draft.instructions,
      examples: draft.examples.split("\n").map((item) => item.trim()).filter(Boolean),
      category: skill?.category || "其他",
      tags: skill?.tags || [],
      active: skill?.active ?? true,
    };
    if (skill) customSkillsStore.update(skill.id, data);
    else customSkillsStore.create(data);
    onDone();
  };
  return (
    <div className="space-y-3 rounded-xl border border-primary/40 bg-surface p-4 shadow-sm">
      <div className="text-sm font-semibold text-fg">{skill ? `编辑「${skill.name}」` : "新建简单技能"}</div>
      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <label className="block text-xs text-fg-muted">
          名字
          <input className="input mt-1 w-full" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="block text-xs text-fg-muted">
          用途（做什么、什么时候用）
          <input className="input mt-1 w-full" value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
        </label>
      </div>
      <label className="block text-xs text-fg-muted">
        做法
        <textarea className="input mt-1 min-h-[120px] w-full resize-y text-sm" value={draft.instructions} onChange={(e) => patch({ instructions: e.target.value })} />
      </label>
      <label className="block text-xs text-fg-muted">
        触发示例（每行一个，可选）
        <textarea className="input mt-1 min-h-[64px] w-full resize-y text-sm" value={draft.examples} onChange={(e) => patch({ examples: e.target.value })} />
      </label>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!draft.name.trim() || !draft.description.trim()} onClick={save}>
          保存
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </div>
  );
}

/** 技能页：所有技能放在一个列表里，按来源筛选；技能从哪些文件夹加载放在最下面。 */
export function CustomSkillsSettings({ onClose }: CustomSkillsSettingsProps) {
  const themeClass = useThemeClass();
  const folderSkills = useSkillLibrary((state) => state.folderSkills);
  const loading = useSkillLibrary((state) => state.loading);
  const reload = useSkillLibrary((state) => state.reload);
  const setFolderEnabled = useSkillLibrary((state) => state.setEnabled);
  const [appSkills, setAppSkills] = useState<CustomSkill[]>(() => customSkillsStore.getAll());
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ type: "folder"; skill?: LibrarySkill } | { type: "app"; skill?: CustomSkill } | null>(null);
  const [askText, setAskText] = useState("");
  const [showSources, setShowSources] = useState(false);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshApp = () => setAppSkills(customSkillsStore.getAll());

  const rows: Row[] = useMemo(
    () => [
      ...folderSkills.map((skill) => ({ kind: "folder" as const, key: skill.key, skill })),
      ...appSkills.map((skill) => ({ kind: "app" as const, key: `app:${skill.id}`, skill })),
    ],
    [folderSkills, appSkills]
  );

  const sourceOf = (row: Row): LibrarySkill["source"] => (row.kind === "folder" ? row.skill.source : "app");
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    rows.forEach((row) => (result[sourceOf(row)] = (result[sourceOf(row)] || 0) + 1));
    return result;
  }, [rows]);
  const enabledCount = rows.filter((row) => (row.kind === "folder" ? row.skill.enabled : row.skill.active)).length;

  const visible = rows.filter((row) => {
    if (source !== "all" && sourceOf(row) !== source) return false;
    const keyword = query.trim().toLowerCase();
    if (!keyword) return true;
    return `${row.skill.name} ${row.skill.description}`.toLowerCase().includes(keyword);
  });

  const sourceOptions = [
    { value: "all" as const, label: "全部", count: rows.length },
    ...(["paw", "claude", "folder", "app"] as const)
      .filter((key) => counts[key])
      .map((key) => ({ value: key, label: SOURCE_LABEL[key], count: counts[key] })),
  ];

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isMarkdown = /\.(md|markdown)$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const imported = isMarkdown ? customSkillsStore.importSkillMarkdown(content) : customSkillsStore.importSkill(content);
      if (imported) refreshApp();
      else alert("导入失败：需要技能 JSON 或 SKILL.md。整个技能文件夹请直接放进“桌宠技能文件夹”。");
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const iconButton = "flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-2 hover:text-fg";

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader
        title="技能"
        description={`教桌宠一套做事方法，遇到相关请求时按它来做 · ${rows.length} 个技能，${enabledCount} 个启用`}
        onBack={onClose}
        actions={
          <>
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-fg-muted transition hover:bg-surface-2 hover:text-fg" title="导入单个 SKILL.md 或 JSON">
              <Upload size={14} />
              导入
              <input type="file" accept=".json,.md,.markdown" onChange={handleImport} className="hidden" />
            </label>
            <Button size="sm" variant="primary" onClick={() => setEditing({ type: "folder" })}>
              <Plus size={14} />
              写一个技能
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="page-pad space-y-4 py-5">
          {/* 让桌宠帮忙写 */}
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-1.5 pl-3 transition focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/10">
            <Sparkles size={16} className="shrink-0 text-primary" />
            <input
              className="chat-composer-input min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm text-fg outline-none placeholder:text-fg-muted"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && askText.trim()) {
                  void askPetToWriteSkill(askText.trim());
                  setAskText("");
                }
              }}
              placeholder="让桌宠帮你写：比如“每周五根据我的活动记录和 Jira 写周报”"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!askText.trim()}
              onClick={() => {
                void askPetToWriteSkill(askText.trim());
                setAskText("");
              }}
            >
              去聊天里写
            </Button>
          </div>

          {editing?.type === "folder" && !editing.skill && <SkillEditor onDone={() => setEditing(null)} />}
          {editing?.type === "app" && !editing.skill && (
            <SimpleSkillForm
              onDone={() => {
                setEditing(null);
                refreshApp();
              }}
            />
          )}

          <div className="flex flex-wrap items-center gap-3">
            <SearchInput value={query} onChange={setQuery} placeholder="搜索技能" className="w-full sm:w-56" />
            <FilterChips value={source} options={sourceOptions} onChange={setSource} />
            <button
              type="button"
              onClick={() => {
                void reload();
                refreshApp();
              }}
              className="ml-auto flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
              title="重新扫描技能文件夹"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              重新扫描
            </button>
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {visible.length === 0 ? (
              <EmptyState
                icon={<Sparkles size={20} />}
                title={rows.length ? "没有匹配的技能" : "还没有技能"}
                hint="点右上角“写一个技能”，或让桌宠帮你写；也可以把别人分享的技能文件夹放进桌宠技能文件夹。"
              />
            ) : (
              <ul className="divide-y divide-line">
                {visible.map((row) => {
                  const enabled = row.kind === "folder" ? row.skill.enabled : row.skill.active;
                  const open = expanded === row.key;
                  const editable = row.kind === "app" || row.skill.source === "paw";
                  const isEditing =
                    editing &&
                    ((editing.type === "folder" && row.kind === "folder" && editing.skill?.key === row.key) ||
                      (editing.type === "app" && row.kind === "app" && editing.skill?.id === row.skill.id));
                  if (isEditing) {
                    return (
                      <li key={row.key} className="p-3">
                        {row.kind === "folder" ? (
                          <SkillEditor skill={row.skill} onDone={() => setEditing(null)} />
                        ) : (
                          <SimpleSkillForm
                            skill={row.skill}
                            onDone={() => {
                              setEditing(null);
                              refreshApp();
                            }}
                          />
                        )}
                      </li>
                    );
                  }
                  return (
                    <li key={row.key} className={`group ${enabled ? "" : "opacity-60"}`}>
                      <div className="flex items-start gap-3 px-4 py-3 transition hover:bg-surface-2/60">
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : row.key)}
                          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                          aria-label={open ? "收起" : "查看完整说明"}
                        >
                          {row.kind === "folder" ? <FileText size={15} /> : <Sparkles size={15} />}
                        </button>
                        <button type="button" onClick={() => setExpanded(open ? null : row.key)} className="min-w-0 flex-1 text-left">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-fg">{row.skill.name}</span>
                            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px] text-fg-muted">{SOURCE_LABEL[sourceOf(row)]}</span>
                            {row.kind === "folder" && row.skill.files.length > 0 && (
                              <span className="shrink-0 text-[10px] text-fg-muted">附带 {row.skill.files.length} 个文件</span>
                            )}
                            {open ? <ChevronDown size={13} className="shrink-0 text-fg-muted" /> : <ChevronRight size={13} className="shrink-0 text-fg-muted opacity-0 group-hover:opacity-100" />}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-muted">
                            {row.skill.description || "（没有写用途，桌宠不容易判断什么时候用）"}
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                          {row.kind === "folder" && row.skill.dir && (
                            <button type="button" className={iconButton} onClick={() => openFolder(row.skill.dir!)} title="打开技能文件夹">
                              <FolderOpen size={14} />
                            </button>
                          )}
                          {editable && (
                            <button
                              type="button"
                              className={iconButton}
                              onClick={() => setEditing(row.kind === "folder" ? { type: "folder", skill: row.skill } : { type: "app", skill: row.skill })}
                              title="编辑"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {row.kind === "app" && (
                            <button
                              type="button"
                              className={iconButton}
                              onClick={() => {
                                const markdown = customSkillsStore.exportSkillMarkdown(row.skill.id);
                                if (markdown) download(`${row.skill.name.replace(/[^a-zA-Z0-9一-鿿_-]/g, "_")}.md`, markdown, "text/markdown");
                              }}
                              title="导出为 SKILL.md"
                            >
                              <Download size={14} />
                            </button>
                          )}
                          {editable && (
                            <button
                              type="button"
                              className={`${iconButton} hover:bg-danger/10 hover:text-danger`}
                              onClick={async () => {
                                if (!confirm(`删除技能「${row.skill.name}」？`)) return;
                                if (row.kind === "app") {
                                  customSkillsStore.delete(row.skill.id);
                                  refreshApp();
                                } else {
                                  try {
                                    await invoke("skill_delete", { dir: row.skill.dir });
                                    await reload();
                                  } catch (e) {
                                    alert(String(e));
                                  }
                                }
                              }}
                              title="删除"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                        <Switch
                          label={`启用 ${row.skill.name}`}
                          checked={enabled}
                          onChange={(value) => {
                            if (row.kind === "folder") setFolderEnabled(row.key, value);
                            else {
                              if (row.skill.active !== value) customSkillsStore.toggleActive(row.skill.id);
                              refreshApp();
                            }
                          }}
                        />
                      </div>
                      {open && (
                        <div className="border-t border-line bg-surface-2/40 px-4 py-3 pl-[60px]">
                          {row.kind === "folder" && row.skill.files.length > 0 && (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {row.skill.files.slice(0, 30).map((file) => (
                                <span key={file} className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-fg-muted">
                                  {file}
                                </span>
                              ))}
                            </div>
                          )}
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-fg">
                            {row.kind === "folder" ? row.skill.raw : [row.skill.instructions, ...row.skill.examples.map((e) => `- ${e}`)].filter(Boolean).join("\n")}
                          </pre>
                          {row.kind === "folder" && !editable && (
                            <p className="mt-2 text-[11px] text-fg-muted">这个技能在别的文件夹里，要修改请直接改原文件，桌宠每次聊天前会重新读取。</p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-fg-muted">
            <button type="button" className="hover:text-fg" onClick={() => setEditing({ type: "app" })}>
              + 新建简单技能（只有说明文字，不建文件夹）
            </button>
          </div>

          {/* 技能来源 */}
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <button
              type="button"
              onClick={() => setShowSources((value) => !value)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-fg hover:bg-surface-2/60"
            >
              {showSources ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
              <span className="font-medium">技能从哪里加载</span>
              <span className="text-xs text-fg-muted">桌宠技能文件夹、Claude 的技能、其他文件夹</span>
            </button>
            {showSources && (
              <div className="border-t border-line">
                <SkillSources />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
