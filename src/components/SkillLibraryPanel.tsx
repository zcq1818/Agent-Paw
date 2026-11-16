import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { FolderOpen, X } from "lucide-react";
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

/** 技能页用到的几块：SKILL.md 编辑器、技能来源设置、让桌宠帮忙写。 */

export const SOURCE_LABEL: Record<LibrarySkill["source"], string> = {
  paw: "桌宠",
  claude: "Claude",
  folder: "文件夹",
  app: "简单技能",
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

export function openFolder(dir: string) {
  invoke("launch_app", { target: dir }).catch((error) => alert(`打不开文件夹：${error}`));
}

/** 去聊天里让桌宠帮忙写技能：它会问清细节，再用 write_skill 存下来。 */
export async function askPetToWriteSkill(text: string) {
  const prompt = `帮我写一个技能：${text}\n\n先想清楚什么时候该用、具体步骤、要用哪些工具、输出什么格式，有不清楚的地方先问我；写好后用 write_skill 保存。`;
  try {
    await emit("open-chat");
  } catch {}
  useChatStore.getState().addMessage({ role: "user", content: prompt });
  void useAgentStore.getState().sendMessage(prompt);
}

/** 新建 / 编辑 SKILL.md。只能改桌宠技能文件夹里的技能。 */
export function SkillEditor({ skill, onDone }: { skill?: LibrarySkill; onDone: () => void }) {
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
    <div className="space-y-3 rounded-xl border border-primary/40 bg-surface p-4 shadow-sm">
      <div className="text-sm font-semibold text-fg">{skill ? `编辑「${skill.name}」` : "写一个技能"}</div>
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
        做法（Markdown，会存成 SKILL.md）
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

/** 技能从哪些文件夹加载。 */
export function SkillSources() {
  const pawDir = useSkillLibrary((state) => state.pawDir);
  const reload = useSkillLibrary((state) => state.reload);
  const [sources, setSources] = useState(loadSkillSources);
  const [folderInput, setFolderInput] = useState("");

  const update = (next: typeof sources) => {
    setSources(next);
    saveSkillSources(next);
    void reload();
  };

  const row = "flex items-center gap-3 px-4 py-2.5";
  return (
    <div className="divide-y divide-line text-sm">
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="text-fg">桌宠技能文件夹</div>
          <code className="block truncate text-[11px] text-fg-muted" title={pawDir}>
            {pawDir || "…"}
          </code>
        </div>
        <Button size="sm" variant="secondary" disabled={!pawDir} onClick={() => openFolder(pawDir)} title="别人分享的技能文件夹直接放进去">
          <FolderOpen size={14} />
          打开
        </Button>
      </div>
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="text-fg">Claude 的个人技能</div>
          <code className="block truncate text-[11px] text-fg-muted">{CLAUDE_SKILLS_DIR}</code>
        </div>
        <Switch label="读取 Claude 的个人技能" checked={sources.claude} onChange={(claude) => update({ ...sources, claude })} />
      </div>
      {sources.extra.map((path) => (
        <div key={path} className={row}>
          <div className="min-w-0 flex-1">
            <div className="text-fg">其他文件夹</div>
            <code className="block truncate text-[11px] text-fg-muted" title={path}>
              {path}
            </code>
          </div>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-danger"
            onClick={() => update({ ...sources, extra: sources.extra.filter((item) => item !== path) })}
            aria-label={`不再读取 ${path}`}
            title="不再读取这个文件夹（不会删除文件）"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className={row}>
        <input
          className="input h-8 min-w-0 flex-1 text-xs"
          value={folderInput}
          onChange={(e) => setFolderInput(e.target.value)}
          placeholder="再加一个技能文件夹，如 D:/skills 或 E:/repo/.claude/skills"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!folderInput.trim()}
          onClick={() => {
            const path = folderInput.trim().replace(/^"|"$/g, "");
            if (!sources.extra.includes(path)) update({ ...sources, extra: [...sources.extra, path] });
            setFolderInput("");
          }}
        >
          添加
        </Button>
      </div>
    </div>
  );
}
