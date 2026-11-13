import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { customSkillsStore, type CustomSkill } from "./customSkills";
import type { Tool } from "./tools";

/**
 * 技能库：把两种技能合在一起给模型用。
 *
 * 1. 技能文件夹（Agent Skills 格式）：一个文件夹里放 SKILL.md（开头 name / description），
 *    可以带脚本、模板、参考资料。来源有桌宠自己的技能文件夹、~/.claude/skills（可选）、用户添加的文件夹。
 * 2. 桌宠里的技能：以前在“技能”页面用表单建的，存在本机。
 *
 * 按需加载：系统提示里只列每个技能的名字和用途；模型判断用得上时调用 use_skill 读完整说明，
 * 需要时再用 read_skill_file 读技能里的参考文件。技能多了也不会把每条消息撑大。
 */

export interface LibrarySkill {
  /** 文件夹技能用文件夹路径，桌宠里的技能用 app:ID */
  key: string;
  name: string;
  description: string;
  source: "paw" | "claude" | "folder" | "app";
  dir?: string;
  files: string[];
  body: string;
  /** SKILL.md 原文（文件夹技能） */
  raw?: string;
  enabled: boolean;
  modified?: number;
}

interface SourceSettings {
  /** 读取 ~/.claude/skills（Claude Code 的个人技能） */
  claude: boolean;
  /** 用户另外添加的技能文件夹 */
  extra: string[];
}

const SOURCES_KEY = "paw_skill_sources";
const DISABLED_KEY = "paw_skill_disabled";
export const CLAUDE_SKILLS_DIR = "~/.claude/skills";

export function loadSkillSources(): SourceSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCES_KEY) || "{}");
    return { claude: Boolean(saved.claude), extra: Array.isArray(saved.extra) ? saved.extra : [] };
  } catch {
    return { claude: false, extra: [] };
  }
}

export function saveSkillSources(settings: SourceSettings) {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(settings));
  } catch {}
}

function loadDisabled(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(DISABLED_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** 解析 SKILL.md 开头的 YAML（只需要简单的 key: value，支持引号和 > / | 多行）。 */
export function parseSkillMarkdown(markdown: string): { meta: Record<string, string>; body: string } {
  const text = markdown.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith(">") ? " " : "\n");
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

export function buildSkillMarkdown(name: string, description: string, body: string) {
  const quote = (value: string) => (/[:#"'\n]/.test(value) ? JSON.stringify(value) : value);
  return `---\nname: ${quote(name.trim())}\ndescription: ${quote(description.trim().replace(/\s+/g, " "))}\n---\n\n${body.trim()}\n`;
}

function fromApp(skill: CustomSkill): LibrarySkill {
  const parts = [skill.instructions?.trim() || ""];
  if (skill.examples?.length) parts.push(`示例：\n${skill.examples.map((item) => `- ${item}`).join("\n")}`);
  return {
    key: `app:${skill.id}`,
    name: skill.name,
    description: skill.description,
    source: "app",
    files: [],
    body: parts.filter(Boolean).join("\n\n"),
    enabled: skill.active,
  };
}

interface LibraryState {
  folderSkills: LibrarySkill[];
  pawDir: string;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  setEnabled: (key: string, enabled: boolean) => void;
}

export const useSkillLibrary = create<LibraryState>((set, get) => ({
  folderSkills: [],
  pawDir: "",
  loading: false,
  error: "",
  reload: async () => {
    set({ loading: true, error: "" });
    try {
      const pawDir: string = await invoke("skills_root");
      const sources = loadSkillSources();
      const roots: Array<{ path: string; source: LibrarySkill["source"] }> = [{ path: pawDir, source: "paw" }];
      if (sources.claude) roots.push({ path: CLAUDE_SKILLS_DIR, source: "claude" });
      sources.extra.forEach((path) => roots.push({ path, source: "folder" }));
      const disabled = new Set(loadDisabled());
      const seen = new Set<string>();
      const skills: LibrarySkill[] = [];
      for (const root of roots) {
        type Found = Array<{ dir: string; content: string; files: string[]; modified: number }>;
        const found = await invoke<Found>("skills_scan", { roots: [root.path] }).catch((): Found => []);
        for (const item of found) {
          if (seen.has(item.dir.toLowerCase())) continue;
          seen.add(item.dir.toLowerCase());
          const { meta, body } = parseSkillMarkdown(item.content);
          const folder = item.dir.split(/[\\/]/).pop() || "skill";
          skills.push({
            key: item.dir,
            name: meta.name || folder,
            description: meta.description || body.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() || "",
            source: root.source,
            dir: item.dir,
            files: item.files,
            body,
            raw: item.content,
            enabled: !disabled.has(item.dir),
            modified: item.modified,
          });
        }
      }
      set({ folderSkills: skills, pawDir, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  setEnabled: (key, enabled) => {
    if (key.startsWith("app:")) {
      const skill = customSkillsStore.getAll().find((item) => `app:${item.id}` === key);
      if (skill && skill.active !== enabled) customSkillsStore.toggleActive(skill.id);
    } else {
      const disabled = new Set(loadDisabled());
      if (enabled) disabled.delete(key);
      else disabled.add(key);
      try {
        localStorage.setItem(DISABLED_KEY, JSON.stringify([...disabled]));
      } catch {}
    }
    set({ folderSkills: get().folderSkills.map((skill) => (skill.key === key ? { ...skill, enabled } : skill)) });
  },
}));

/** 全部技能（文件夹技能在前）。 */
export function allSkills(): LibrarySkill[] {
  const folder = useSkillLibrary.getState().folderSkills;
  const app = customSkillsStore.getAll().map(fromApp);
  return [...folder, ...app];
}

function findSkill(name: unknown): LibrarySkill | undefined {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return undefined;
  const skills = allSkills().filter((skill) => skill.enabled);
  return (
    skills.find((skill) => skill.name.toLowerCase() === key) ||
    skills.find((skill) => skill.dir && skill.dir.toLowerCase().endsWith(key)) ||
    skills.find((skill) => skill.name.toLowerCase().includes(key) || key.includes(skill.name.toLowerCase()))
  );
}

/** 系统提示里的技能目录：只有名字和用途。 */
export function skillIndexPrompt(): string {
  const skills = allSkills().filter((skill) => skill.enabled);
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}：${skill.description.replace(/\s+/g, " ").slice(0, 200)}`);
  return [
    "## 技能",
    "下面是用户装好的技能（只列了名字和用途）。用户的请求和某个技能对得上时，先调用 use_skill 读取它的完整说明，再严格按说明去做；说明里提到的参考文件用 read_skill_file 读。和哪个技能都不相关就正常回答，不要硬套。",
    ...lines,
  ].join("\n");
}

export const SKILL_TOOL_NAMES = ["use_skill", "read_skill_file", "write_skill"];

export function getSkillLibraryTools(): Tool[] {
  return [
    {
      name: "use_skill",
      description: "读取一个技能的完整说明（技能目录在系统提示的“技能”一节）。按说明执行任务前先调用。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名字" } },
        required: ["name"],
      },
      execute: async (args) => {
        const skill = findSkill(args.name);
        if (!skill) return `没有找到启用中的技能「${String(args.name || "")}」。`;
        const parts = [`# 技能：${skill.name}`, skill.description ? `用途：${skill.description}` : "", skill.body];
        if (skill.dir) {
          parts.push(`技能文件夹：${skill.dir}`);
          if (skill.files.length) {
            parts.push(
              `技能里的其他文件（用 read_skill_file 读取；说明要求运行的脚本，用 computer_run_command 在技能文件夹里运行）：\n${skill.files
                .slice(0, 60)
                .map((file) => `- ${file}`)
                .join("\n")}`
            );
          }
        }
        return parts.filter(Boolean).join("\n\n");
      },
    },
    {
      name: "read_skill_file",
      description: "读取某个技能文件夹里的文件（参考资料、模板、脚本源码），路径相对于技能文件夹。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名字" },
          path: { type: "string", description: "文件相对路径，如 references/guide.md" },
        },
        required: ["name", "path"],
      },
      execute: async (args) => {
        const skill = findSkill(args.name);
        if (!skill?.dir) return `技能「${String(args.name || "")}」没有附带文件。`;
        try {
          const text: string = await invoke("skill_read_file", { dir: skill.dir, path: String(args.path || "") });
          return text.length > 40_000 ? `${text.slice(0, 40_000)}\n…（文件太长，已截断）` : text;
        } catch (error) {
          return `读取失败：${error}`;
        }
      },
    },
    {
      name: "write_skill",
      description:
        "把一套做事方法保存成技能（标准 SKILL.md 技能文件夹，存在桌宠的技能文件夹里），以后遇到同类请求会按它来做。用户让你“写个技能 / 记住这个流程 / 以后都这样做”时使用；改已有的技能时传同样的名字。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名字，简短，如 周报助手" },
          description: {
            type: "string",
            description: "一两句话：这个技能做什么、什么时候该用（模型靠它判断何时调用，要写清触发场景）",
          },
          instructions: {
            type: "string",
            description: "完整做法（Markdown）：步骤、要用哪些工具、输出格式、注意事项、示例",
          },
        },
        required: ["name", "description", "instructions"],
      },
      execute: async (args) => {
        const name = String(args.name || "").trim();
        const description = String(args.description || "").trim();
        const instructions = String(args.instructions || "").trim();
        if (!name || !description || !instructions) return "名字、用途和做法都要写。";
        await useSkillLibrary.getState().reload();
        const existing = useSkillLibrary
          .getState()
          .folderSkills.find((skill) => skill.source === "paw" && skill.name.toLowerCase() === name.toLowerCase());
        const dir: string = await invoke("skill_save", {
          name,
          content: buildSkillMarkdown(name, description, instructions),
          existingDir: existing?.dir || null,
        });
        await useSkillLibrary.getState().reload();
        return `${existing ? "已更新" : "已保存"}技能「${name}」：${dir}\\SKILL.md。之后遇到相关请求会自动用上，也可以在“技能”页面查看和修改。`;
      },
    },
  ];
}
