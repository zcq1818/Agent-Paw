interface SettingsProps {
  onBack: () => void;
}

export function Settings({ onBack }: SettingsProps) {
  return (
    <div className="chat-window flex flex-col h-screen bg-gradient-to-b from-gray-900 to-gray-950">
      {/* 头部 */}
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-800/80 backdrop-blur border-b border-gray-700">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-white transition-colors"
        >
          ←
        </button>
        <span className="font-semibold text-white">⚙️ 设置</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {/* 模型配置 */}
        <Section title="🤖 AI 模型">
          <Field label="Provider">
            <select className="input">
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </Field>
          <Field label="API Key">
            <input
              type="password"
              className="input"
              placeholder="sk-..."
            />
          </Field>
          <Field label="Base URL (可选)">
            <input
              type="text"
              className="input"
              placeholder="https://api.openai.com/v1"
            />
          </Field>
          <Field label="模型名">
            <input
              type="text"
              className="input"
              placeholder="gpt-4o-mini"
            />
          </Field>
        </Section>

        {/* 宠物设置 */}
        <Section title="🐾 宠物">
          <Field label="宠物名字">
            <input type="text" className="input" defaultValue="皮卡丘" />
          </Field>
          <Field label="自动动作">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" defaultChecked className="rounded" />
              启用随机动作
            </label>
          </Field>
        </Section>

        {/* 快捷键 */}
        <Section title="⌨️ 快捷键">
          <Field label="唤出/隐藏">
            <kbd className="px-2 py-1 bg-gray-700 rounded text-sm text-gray-300">
              Ctrl + Shift + P
            </kbd>
          </Field>
        </Section>
      </div>

      {/* 保存按钮 */}
      <div className="px-4 py-3 bg-gray-800/50 border-t border-gray-700">
        <button className="w-full py-2.5 bg-yellow-500 hover:bg-yellow-400 text-gray-900 font-bold rounded-xl transition-colors">
          保存设置
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-800/50 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-400">{label}</label>
      {children}
    </div>
  );
}
