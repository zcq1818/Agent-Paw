/**
 * 自定义 Skill 系统
 * - 创建、编辑、删除自定义技能
 * - 基于本地存储
 * - 支持 AI 调用
 */

export interface CustomSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  instructions: string;
  examples: string[];
  tags: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  name: string;
  icon: string;
  count: number;
}

const STORAGE_KEY = "paw_custom_skills";

const DEFAULT_CATEGORIES: Category[] = [
  { name: "生产力", icon: "⚡", count: 0 },
  { name: "创意", icon: "🎨", count: 0 },
  { name: "生活", icon: "🏠", count: 0 },
  { name: "学习", icon: "📚", count: 0 },
  { name: "娱乐", icon: "🎮", count: 0 },
  { name: "其他", icon: "📦", count: 0 },
];

class CustomSkillsStore {
  private skills: CustomSkill[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.skills = JSON.parse(saved);
    } catch {
      this.skills = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.skills));
    } catch {}
  }

  getAll(): CustomSkill[] {
    return [...this.skills].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  getActive(): CustomSkill[] {
    return this.getAll().filter((skill) => skill.active);
  }

  getById(id: string): CustomSkill | undefined {
    return this.skills.find((skill) => skill.id === id);
  }

  getByCategory(category: string): CustomSkill[] {
    return this.getAll().filter((skill) => skill.category === category);
  }

  search(query: string): CustomSkill[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter(
      (skill) =>
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery) ||
        skill.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
    );
  }

  create(skillData: Omit<CustomSkill, "id" | "createdAt" | "updatedAt">): CustomSkill {
    const newSkill: CustomSkill = {
      ...skillData,
      id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.skills.push(newSkill);
    this.save();
    return newSkill;
  }

  update(id: string, updates: Partial<Omit<CustomSkill, "id" | "createdAt" | "updatedAt">>): CustomSkill | undefined {
    const index = this.skills.findIndex((skill) => skill.id === id);
    if (index === -1) return undefined;
    this.skills[index] = {
      ...this.skills[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.skills[index];
  }

  delete(id: string): boolean {
    const index = this.skills.findIndex((skill) => skill.id === id);
    if (index === -1) return false;
    this.skills.splice(index, 1);
    this.save();
    return true;
  }

  toggleActive(id: string): CustomSkill | undefined {
    const skill = this.getById(id);
    if (!skill) return undefined;
    return this.update(id, { active: !skill.active });
  }

  getCategories(): Category[] {
    const categoryMap: Record<string, number> = {};
    this.skills.forEach((skill) => {
      categoryMap[skill.category] = (categoryMap[skill.category] || 0) + 1;
    });

    return DEFAULT_CATEGORIES.map((category) => ({
      ...category,
      count: categoryMap[category.name] || 0,
    }));
  }

  getStats() {
    const total = this.skills.length;
    const active = this.getActive().length;
    const categories = this.getCategories();
    return { total, active, categories };
  }

  exportSkill(id: string): string | undefined {
    const skill = this.getById(id);
    return skill ? JSON.stringify(skill, null, 2) : undefined;
  }

  exportAll(): string {
    return JSON.stringify(this.skills, null, 2);
  }

  importSkill(jsonString: string): CustomSkill | undefined {
    try {
      const skill = JSON.parse(jsonString) as CustomSkill;
      if (!skill.name || !skill.description) {
        throw new Error("Invalid skill");
      }
      return this.create({
        name: skill.name,
        description: skill.description,
        category: skill.category || "其他",
        instructions: skill.instructions || "",
        examples: skill.examples || [],
        tags: skill.tags || [],
        active: skill.active !== false,
      });
    } catch {
      return undefined;
    }
  }

  importAll(jsonString: string): number {
    try {
      const skills = JSON.parse(jsonString) as CustomSkill[];
      let imported = 0;
      skills.forEach((skill) => {
        if (this.importSkill(JSON.stringify(skill))) imported += 1;
      });
      return imported;
    } catch {
      return 0;
    }
  }

  /** 导出为带 YAML frontmatter 的 SKILL.md，与 OpenMausBot / Agent Skills 的文件格式对齐。 */
  exportSkillMarkdown(id: string): string | undefined {
    const skill = this.getById(id);
    if (!skill) return undefined;

    const quote = (value: string) =>
      `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

    const lines = [
      "---",
      `name: ${quote(skill.name)}`,
      `description: ${quote(skill.description)}`,
      `category: ${quote(skill.category)}`,
      "permissions: []",
      `tags: [${skill.tags.map(quote).join(", ")}]`,
      "---",
      "",
      `# ${skill.name}`,
      "",
      skill.description,
      "",
      skill.instructions || "",
    ];
    if (skill.examples.length > 0) {
      lines.push("", "## 示例", ...skill.examples.map((example) => `- ${example}`));
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  /** 导入 SKILL.md：解析 frontmatter，正文作为 instructions；也兼容无 frontmatter 的纯 Markdown。 */
  importSkillMarkdown(markdown: string): CustomSkill | undefined {
    try {
      const text = markdown.replace(/\r\n/g, "\n");
      const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/.exec(text);
      const frontmatter: Record<string, string> = {};
      let body = text;

      if (match) {
        match[1].split("\n").forEach((line) => {
          const idx = line.indexOf(":");
          if (idx < 1) return;
          const key = line.slice(0, idx).trim();
          let value = line.slice(idx + 1).trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/\\(["\\n])/g, (_, ch: string) => (ch === "n" ? "\n" : ch));
          }
          frontmatter[key] = value;
        });
        body = text.slice(match[0].length);
      }

      const parseTags = (raw?: string): string[] =>
        (raw || "")
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((tag) => tag.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);

      const examples: string[] = [];
      const exampleIndex = body.search(/^##\s*示例\s*$/m);
      let instructionBody = body;
      if (exampleIndex >= 0) {
        instructionBody = body.slice(0, exampleIndex);
        body
          .slice(exampleIndex)
          .split("\n")
          .forEach((line) => {
            const item = /^-\s+(.+)$/.exec(line.trim());
            if (item) examples.push(item[1].trim());
          });
      }
      instructionBody = instructionBody.replace(/^#\s+.*\n/, "").trim();
      const exportedDescription = frontmatter.description?.trim();
      if (exportedDescription && instructionBody.startsWith(exportedDescription)) {
        instructionBody = instructionBody.slice(exportedDescription.length).trim();
      }

      const name = frontmatter.name || /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || "";
      if (!name) return undefined;
      const description =
        frontmatter.description || instructionBody.split("\n")[0]?.trim() || name;

      return this.create({
        name,
        description: description.slice(0, 200),
        category: frontmatter.category || "其他",
        instructions: instructionBody,
        examples,
        tags: parseTags(frontmatter.tags),
        active: true,
      });
    } catch {
      return undefined;
    }
  }
}

export const customSkillsStore = new CustomSkillsStore();

export function getSkillsContext(): string {
  const activeSkills = customSkillsStore.getActive();
  if (activeSkills.length === 0) return "";

  let context = "\n\n## 自定义技能\n";
  activeSkills.forEach((skill) => {
    context += `### ${skill.name}\n`;
    context += `**描述**: ${skill.description}\n`;
    context += `**分类**: ${skill.category}\n`;
    context += `**标签**: ${skill.tags.join(", ")}\n`;
    if (skill.instructions) {
      context += `**使用说明**: ${skill.instructions}\n`;
    }
    if (skill.examples.length > 0) {
      context += `**示例**:\n`;
      skill.examples.forEach((example) => {
        context += `- ${example}\n`;
      });
    }
    context += "\n";
  });

  return context;
}

export function buildSkillPrompt(skill: CustomSkill): string {
  let prompt = `## ${skill.name}\n\n`;
  prompt += `**描述**: ${skill.description}\n\n`;
  if (skill.instructions) {
    prompt += `${skill.instructions}\n\n`;
  }
  if (skill.examples.length > 0) {
    prompt += `**使用示例**:\n`;
    skill.examples.forEach((example) => {
      prompt += `- ${example}\n`;
    });
  }
  return prompt;
}
