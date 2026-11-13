import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, FolderOpen, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { Button, Notice, Switch } from "./ui";
import {
  CLAUDE_SKILLS_DIR,
  buildSkillMarkdown,
  loadSkillSources,
  parseSkillMarkdown,
  saveSkillSources,
  useSkillLibrary,
  type LibrarySkill,
} from "../agent/skillLibrary";
import { useAgentStore } from "../store/agent";
import { useChatStore } from "../store/chat";

const SOURCE_LABEL: Record<LibrarySkill["source"], string> = {
  paw: "桌宠",
  claude: "Claude",
  folder: "文件夹",
  app: "桌宠内",
};

const TEMPLATE = `## 什么时候用
（用户说了什么、遇到什么情况时用这个技能）

## 怎么做
1. 第一步……
2. 第二步……

## 输出格式
（希望回答长什么样）

## 注意
- ……
`;

function openFolder(dir: string) {
  invoke("launch_app", { target: dir }).catch((error) => alert(`打不开文件夹：${error}`));
}

/** 新建 / 编辑 SKILL.md。只能改桌宠技能文件夹里的技能。 */
function SkillEditor({ skill, onDone }: { skill?: LibrarySkill; onDone: () => void }) {
  const parsed = skill?.raw ? parseSkillMarkdown(skill.raw) : null;
  const [name, setName] = useState(skill?.name || "");
  const [description, setDescription] = useState(skill?.description || "");
  const [body, setBody] = useState(parsed?.body ?? TEMPLATE);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const reload = useSkillLibrary((state) => state.reload);

  const save = async () => {
    if (!name.trim()) return setError("起个名字，比如“周报助手”");
    if (!description.trim()) return setError("写一句用途：做什么、什么时候用（桌宠靠这句判断何时调用）");
    if (!body.trim()) return setError("写一下具体做法");
    setSaving(true);
    try {
      await invoke("skill_save", {
        name: name.trim(),
        content: buildSkillMarkdown(name, description, body),
        existingDir: skill?.dir || null,
      });
      await reload();
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-4">
      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <label className="block text-xs text-fg-muted">
          名字
          <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="周报助手" />
        </label>
        <label className="block text-xs text-fg-muted">
          用途（做什么、什么时候用）
          <input
            className="input mt-1 w-full"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="根据本周活动和待办写周报。用户说“写周报”“总结这周”时使用。"
          />
        </label>
      </div>
      <label className="block text-xs text-fg-muted">
        做法（Markdown，会存成 SKILL.md 正文）
        <textarea className="input mt-1 min-h-[220px] w-full resize-y font-mono text-xs leading-relaxed" value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={saving} onClick={save}>
          {saving ? "保存中…" : "保存"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </div>
  );
}

/** “技能”页面上半部分：技能文件夹（标准 SKILL.md 格式）的来源、列表、编辑。 */
export function SkillLibraryPanel() {
  const folderSkills = useSkillLibrary((state) => state.folderSkills);
  const pawDir = useSkillLibrary((state) => state.pawDir);
  const loading = useSkillLibrary((state) => state.loading);
  const loadError = useSkillLibrary((state) => state.error);
  const reload = useSkillLibrary((state) => state.reload);
  const setEnabled = useSkillLibrary((state) => state.setEnabled);
  const [sources, setSources] = useState(loadSkillSources);
  const [folderInput, setFolderInput] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<LibrarySkill | "new" | null>(null);
  const [askText, setAskText] = useState("");

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateSources = (next: typeof sources) => {
    setSources(next);
    saveSkillSources(next);
    void reload();
  };

  const grouped = useMemo(() => {
    const order: LibrarySkill["source"][] = ["paw", "claude", "folder"];
    return [...folderSkills].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source) || a.name.localeCompare(b.name));
  }, [folderSkills]);

  /** 让桌宠在聊天里帮你写：发一条消息，它会用 write_skill 存成技能。 */
  const askPet = async () => {
    const text = askText.trim();
    if (!text) return;
    setAskText("");
    const prompt = `帮我写一个技能：${text}\n\n先想清楚什么时候该用、具体步骤、要用哪些工具、输出什么格式，有不清楚的地方先问我；写好后用 write_skill 保存。`;
    try {
      await emit("open-chat");
    } catch {}
    useChatStore.getState().addMessage({ role: "user", content: prompt });
    void useAgentStore.getState().sendMessage(prompt);
  };

  return (
    <div className="space-y-4 border-b border-line bg-app px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-fg">技能文件夹</div>
          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-fg-muted">
            标准 Agent Skills 格式：一个文件夹里放 SKILL.md（开头写 name 和 description），可以带脚本、模板、参考资料。
            桌宠平时只看每个技能的名字和用途，用得上时才读完整说明，技能再多也不拖慢聊天。
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => reload()} title="重新扫描技能文件夹">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            重新扫描
          </Button>
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus size={14} />
            写一个技能
          </Button>
        </div>
      </div>

      {/* 让桌宠帮忙写 */}
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <Sparkles size={15} className="shrink-0 text-primary" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
          value={askText}
          onChange={(e) => setAskText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) askPet();
          }}
          placeholder="让桌宠帮你写：比如“每周五根据我的活动记录和 Jira 写周报”"
        />
        <Button size="sm" variant="secondary" disabled={!askText.trim()} onClick={askPet}>
          去聊天里写
        </Button>
      </div>

      {editing === "new" && <SkillEditor onDone={() => setEditing(null)} />}

      {/* 来源 */}
      <div className="space-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-fg">桌宠技能文件夹</span>
          <code className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={pawDir}>
            {pawDir || "…"}
          </code>
          <Button size="sm" variant="ghost" disabled={!pawDir} onClick={() => openFolder(pawDir)} title="在资源管理器里打开，可以直接把技能文件夹拖进去">
            <FolderOpen size={14} />
            打开
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-fg">Claude 的技能</span>
          <code className="min-w-0 flex-1 truncate text-xs text-fg-muted">{CLAUDE_SKILLS_DIR}</code>
          <Switch label="读取 Claude 的个人技能" checked={sources.claude} onChange={(claude) => updateSources({ ...sources, claude })} />
        </div>
        {sources.extra.map((path) => (
          <div key={path} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-fg">其他文件夹</span>
            <code className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={path}>
              {path}
            </code>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-danger"
              onClick={() => updateSources({ ...sources, extra: sources.extra.filter((item) => item !== path) })}
              aria-label={`不再读取 ${path}`}
              title="不再读取这个文件夹（不会删除文件）"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-fg-muted">添加文件夹</span>
          <input
            className="input h-8 min-w-0 flex-1 text-xs"
            value={folderInput}
            onChange={(e) => setFolderInput(e.target.value)}
            placeholder="技能库或单个技能的文件夹路径，如 D:/skills 或 E:/repo/.claude/skills"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!folderInput.trim()}
            onClick={() => {
              const path = folderInput.trim().replace(/^"|"$/g, "");
              if (!sources.extra.includes(path)) updateSources({ ...sources, extra: [...sources.extra, path] });
              setFolderInput("");
            }}
          >
            添加
          </Button>
        </div>
      </div>

      {loadError && <Notice tone="error">读取技能失败：{loadError}</Notice>}

      {/* 列表 */}
      {grouped.length === 0 ? (
        <p className="text-xs text-fg-muted">
          还没有技能文件夹。可以点“写一个技能”、让桌宠帮你写，或者把别人分享的技能文件夹放进“桌宠技能文件夹”。
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {grouped.map((skill) => {
            const open = Boolean(expanded[skill.key]);
            const editable = skill.source === "paw";
            if (editing && editing !== "new" && editing.key === skill.key) {
              return (
                <li key={skill.key} className="p-3">
                  <SkillEditor skill={skill} onDone={() => setEditing(null)} />
                </li>
              );
            }
            return (
              <li key={skill.key} className="px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="mt-0.5 text-fg-muted hover:text-fg"
                    onClick={() => setExpanded((current) => ({ ...current, [skill.key]: !open }))}
                    aria-label={open ? "收起" : "查看 SKILL.md"}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-sm font-medium ${skill.enabled ? "text-fg" : "text-fg-muted"}`}>{skill.name}</span>
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">{SOURCE_LABEL[skill.source]}</span>
                      {skill.files.length > 0 && (
                        <span className="shrink-0 text-[11px] text-fg-muted">附带 {skill.files.length} 个文件</span>
                      )}
                    </div>
                    <div className="line-clamp-2 text-xs text-fg-muted">{skill.description || "（没有写用途，桌宠不容易判断什么时候用）"}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {skill.dir && (
                      <Button size="sm" variant="ghost" onClick={() => openFolder(skill.dir!)} title="打开技能文件夹">
                        <FolderOpen size={14} />
                      </Button>
                    )}
                    {editable && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(skill)}>
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (!confirm(`删除技能「${skill.name}」？整个技能文件夹会被删除。`)) return;
                            try {
                              await invoke("skill_delete", { dir: skill.dir });
                              await reload();
                            } catch (e) {
                              alert(String(e));
                            }
                          }}
                          title="删除"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </>
                    )}
                    <Switch label={`启用 ${skill.name}`} checked={skill.enabled} onChange={(enabled) => setEnabled(skill.key, enabled)} />
                  </div>
                </div>
                {open && (
                  <div className="ml-6 mt-2 space-y-2">
                    {skill.files.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {skill.files.slice(0, 30).map((file) => (
                          <span key={file} className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-fg-muted">
                            {file}
                          </span>
                        ))}
                      </div>
                    )}
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg">
                      {skill.raw}
                    </pre>
                    {!editable && <p className="text-[11px] text-fg-muted">这个技能在别的文件夹里，要修改请直接改原文件；桌宠每次聊天前会重新读取。</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
