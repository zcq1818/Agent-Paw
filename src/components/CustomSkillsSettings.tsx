import { useState, useEffect } from "react";
import { customSkillsStore, type CustomSkill } from "../agent/customSkills";
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

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = customSkillsStore.importSkill(event.target?.result as string);
        if (imported) {
          refreshSkills();
          alert(`成功导入技能：${imported.name}`);
        }
      } catch {
        alert("导入失败，请检查文件格式。");
      }
    };
    reader.readAsText(file);
  };

  const stats = customSkillsStore.getStats();

  return (
    <div className={`chat-window ${themeClass} flex flex-col h-screen`}>
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800/80 backdrop-blur border-b border-gray-700">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            ←
          </button>
          <span className="font-semibold text-white">自定义技能管理</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg cursor-pointer text-sm transition-colors">
            导入
            <input type="file" accept=".json" onChange={handleImport} className="hidden" />
          </label>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg text-sm transition-colors"
          >
            新建技能
          </button>
        </div>
      </div>

      <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-700">
        <div className="flex items-center gap-4 text-sm text-gray-300">
          <span>总技能：{stats.total}</span>
          <span>已启用：{stats.active}</span>
          {stats.categories.filter((cat) => cat.count > 0).map((cat) => (
            <span key={cat.name}>
              {cat.icon} {cat.name}：{cat.count}
            </span>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {showAddForm && (
          <div className="p-4 bg-gray-800/50 border-b border-gray-700">
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

        <div className="p-4 space-y-3">
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
              />
            ))
          )}
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
}: {
  skill: CustomSkill;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const category = CATEGORIES.find((item) => item.name === skill.category) || CATEGORIES[CATEGORIES.length - 1];

  return (
    <div className={`p-4 rounded-xl border transition-all ${skill.active ? "bg-gray-800/80 border-gray-700" : "bg-gray-800/40 border-gray-700/50 opacity-70"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{category.icon}</span>
            <h4 className="font-semibold text-white truncate">{skill.name}</h4>
            <span className={`px-2 py-0.5 rounded-full text-xs ${skill.active ? "bg-green-900/50 text-green-400" : "bg-gray-700 text-gray-400"}`}>
              {skill.active ? "已启用" : "已禁用"}
            </span>
          </div>
          <p className="text-sm text-gray-400 mb-2">{skill.description}</p>

          {skill.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {skill.tags.map((tag) => (
                <span key={tag} className="px-2 py-0.5 bg-gray-700/80 text-gray-300 rounded-full text-xs">
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
          <button onClick={onToggle} className="p-2 text-green-400 hover:bg-green-900/30 rounded-lg transition-colors" title={skill.active ? "禁用" : "启用"}>
            {skill.active ? "停用" : "启用"}
          </button>
          <button onClick={onEdit} className="p-2 text-blue-400 hover:bg-blue-900/30 rounded-lg transition-colors" title="编辑">
            编辑
          </button>
          <button onClick={onExport} className="p-2 text-purple-400 hover:bg-purple-900/30 rounded-lg transition-colors" title="导出">
            导出
          </button>
          <button onClick={onDelete} className="p-2 text-red-400 hover:bg-red-900/30 rounded-lg transition-colors" title="删除">
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
