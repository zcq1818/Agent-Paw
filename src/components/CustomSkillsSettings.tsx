import { useState, useEffect } from "react";
import { PageHeader } from "./ui";
import { customSkillsStore, type CustomSkill } from "../agent/customSkills";
import { SkillLibraryPanel } from "./SkillLibraryPanel";
import { useThemeClass } from "../store/theme";

interface CustomSkillsSettingsProps {
  onClose: () => void;
}

const CATEGORIES = [
  { name: "生产力", icon: "⚡" },
  { name: "创意", icon: "🎨" },
  { name: "生活", icon: "🏠" },
  { name: "学习", icon: "📚" },
  { name: "娱乐", icon: "🎮" },
  { name: "其他", icon: "📦" },
];

export function CustomSkillsSettings({ onClose }: CustomSkillsSettingsProps) {
  const themeClass = useThemeClass();
  const [skills, setSkills] = useState<CustomSkill[]>([]);
  const [editingSkill, setEditingSkill] = useState<CustomSkill | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    category: "其他",
    instructions: "",
    examples: "",
    tags: "",
  });

  useEffect(() => {
    refreshSkills();
  }, []);

  const refreshSkills = () => setSkills(customSkillsStore.getAll());

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      category: "其他",
      instructions: "",
      examples: "",
      tags: "",
    });
    setEditingSkill(null);
    setShowAddForm(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const skillData = {
      name: formData.name,
      description: formData.description,
      category: formData.category,
      instructions: formData.instructions,
      examples: formData.examples ? formData.examples.split("\n").filter((item) => item.trim()) : [],
      tags: formData.tags ? formData.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
      active: true,
    };

    if (editingSkill) customSkillsStore.update(editingSkill.id, skillData);
    else customSkillsStore.create(skillData);

    resetForm();
    refreshSkills();
  };

  const handleEdit = (skill: CustomSkill) => {
    setEditingSkill(skill);
    setFormData({
      name: skill.name,
      description: skill.description,
      category: skill.category,
      instructions: skill.instructions,
      examples: skill.examples.join("\n"),
      tags: skill.tags.join(", "),
    });
    setShowAddForm(true);
  };

  const handleDelete = (id: string) => {
    if (confirm("确定要删除这个技能吗？")) {
      customSkillsStore.delete(id);
      refreshSkills();
    }
  };

  const handleExport = (skill: CustomSkill) => {
    const json = customSkillsStore.exportSkill(skill.id);
    if (!json) return;

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${skill.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportMarkdown = (skill: CustomSkill) => {
    const markdown = customSkillsStore.exportSkillMarkdown(skill.id);
    if (!markdown) return;

    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${skill.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isMarkdown = /\.(md|markdown)$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const imported = isMarkdown
        ? customSkillsStore.importSkillMarkdown(content)
        : customSkillsStore.importSkill(content);
      if (imported) {
        refreshSkills();
        alert(`成功导入技能：${imported.name}`);
      } else {
        alert("导入失败，请检查文件格式：需要技能 JSON 或 SKILL.md。");
      }
    };
    reader.readAsText(file);
    // 清空 value，否则再次选择同一个文件不会触发 onChange。
    e.target.value = "";
  };

  const stats = customSkillsStore.getStats();

  return (
    <div className={`chat-window ${themeClass} flex flex-col h-screen`}>
      <PageHeader
        title="技能"
        description="教桌宠一套做事方法，遇到相关请求时按它来做"
        onBack={onClose}
        actions={
        <div className="flex items-center gap-2">
          <label
            className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs text-fg transition hover:bg-surface-2"
            title="导入单个 .md 或 .json，加到下面“桌宠内的技能”。整个技能文件夹请放进“桌宠技能文件夹”"
          >
            导入单个文件
            <input type="file" accept=".json,.md,.markdown" onChange={handleImport} className="hidden" />
          </label>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg transition hover:bg-surface-2"
            title="用表单建一个只有说明文字的简单技能"
          >
            新建简单技能
          </button>
        </div>
        }
      />

      <div className="flex-1 overflow-y-auto">
      <SkillLibraryPanel />
      <div className="page-pad pt-6 text-base font-semibold text-fg">桌宠内的技能</div>
      <p className="page-pad pb-1 text-xs text-fg-muted">用右上角“新建技能”表单建的简单技能（只有说明文字），和上面的技能一样按需使用。</p>
      <div className="page-pad py-2">
        <div className="flex items-center gap-4 text-xs text-fg-muted">
          <span>总技能：{stats.total}</span>
          <span>已启用：{stats.active}</span>
          {stats.categories.filter((cat) => cat.count > 0).map((cat) => (
            <span key={cat.name}>
              {cat.icon} {cat.name}：{cat.count}
            </span>
          ))}
        </div>
      </div>

      <div>
        {showAddForm && (
          <div className="page-pad py-4">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingSkill ? "编辑技能" : "新建技能"}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="技能名称">
                  <input
                    type="text"
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-yellow-500"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="例如：编程助手"
                    required
                  />
                </Field>
                <Field label="分类">
                  <select
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-yellow-500"
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat.name} value={cat.name}>
                        {cat.icon} {cat.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="描述">
                <input
                  type="text"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-yellow-500"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="简要描述这个技能的用途"
                  required
                />
              </Field>

              <Field label="标签（逗号分隔）">
                <input
                  type="text"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-yellow-500"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  placeholder="例如：编程, 代码, 助手"
                />
              </Field>

              <Field label="使用说明（系统提示词）">
                <textarea
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-yellow-500 min-h-[120px]"
                  value={formData.instructions}
                  onChange={(e) => setFormData({ ...formData, instructions: e.target.value })}
                  placeholder="说明这个技能该如何工作。"
                />
              </Field>

              <Field label="使用示例（每行一个）">
                <textarea
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-yellow-500 min-h-[80px]"
                  value={formData.examples}
                  onChange={(e) => setFormData({ ...formData, examples: e.target.value })}
                  placeholder="例如：帮我写一个 Python 函数"
                />
              </Field>

              <div className="flex gap-3">
                <button type="submit" className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg transition-colors">
                  {editingSkill ? "保存修改" : "创建技能"}
                </button>
                <button type="button" onClick={resetForm} className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors">
                  取消
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="page-pad space-y-3 pb-6 pt-2">
          {skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <div className="text-5xl mb-4">⚡</div>
              <p className="text-lg">还没有自定义技能</p>
              <p className="text-sm">点击上方“新建技能”创建第一个技能。</p>
            </div>
          ) : (
            skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onEdit={() => handleEdit(skill)}
                onToggle={() => {
                  customSkillsStore.toggleActive(skill.id);
                  refreshSkills();
                }}
                onDelete={() => handleDelete(skill.id)}
                onExport={() => handleExport(skill)}
                onExportMarkdown={() => handleExportMarkdown(skill)}
              />
            ))
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm text-gray-400">{label}</label>
      {children}
    </div>
  );
}

function SkillCard({
  skill,
  onEdit,
  onToggle,
  onDelete,
  onExport,
  onExportMarkdown,
}: {
  skill: CustomSkill;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onExport: () => void;
  onExportMarkdown: () => void;
}) {
  const category = CATEGORIES.find((item) => item.name === skill.category) || CATEGORIES[CATEGORIES.length - 1];

  return (
    <div className={`rounded-xl border border-line bg-surface px-4 py-3.5 transition ${skill.active ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{category.icon}</span>
            <h4 className="font-semibold text-fg truncate">{skill.name}</h4>
            <span className={`px-2 py-0.5 rounded-full text-[11px] ${skill.active ? "bg-primary/10 text-primary-ink" : "bg-surface-2 text-fg-muted"}`}>
              {skill.active ? "已启用" : "已禁用"}
            </span>
          </div>
          <p className="mb-2 text-sm text-fg-muted">{skill.description}</p>

          {skill.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {skill.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {skill.examples.length > 0 && (
            <div className="text-xs text-gray-500">示例：{skill.examples[0]}</div>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* 操作按钮统一成浅色小按钮，只有删除用红色 */}
          <button onClick={onToggle} className="rounded-lg px-2.5 py-1.5 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg" title={skill.active ? "停用" : "启用"}>
            {skill.active ? "停用" : "启用"}
          </button>
          <button onClick={onEdit} className="rounded-lg px-2.5 py-1.5 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg" title="编辑">
            编辑
          </button>
          <button onClick={onExportMarkdown} className="rounded-lg px-2.5 py-1.5 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg" title="导出 SKILL.md（Agent Skills 格式）">
            导出
          </button>
          <button onClick={onExport} className="rounded-lg px-2.5 py-1.5 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg" title="导出 JSON">
            JSON
          </button>
          <button onClick={onDelete} className="rounded-lg px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger/10" title="删除">
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
