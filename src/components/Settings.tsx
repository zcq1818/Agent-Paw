import { useMemo, useState } from "react";
import {
  PROVIDER_PRESETS,
  getMemoryStats,
  getProviderPreset,
  getUserProfile,
  loadConfig,
  saveConfig,
  testConnection,
  type AgentConfig,
  type ProviderId,
} from "../agent/kernel";
import { usePetStore, SKIN_COLORS, type InteractionFrequency, type PetAvatar, type PetSkin, type RoamScope } from "../store/pet";
import { THEME_OPTIONS, type AppTheme, useThemeClass, useThemeStore } from "../store/theme";
import { useActivityStore } from "../store/activity";
import { DEFAULT_CHAT_HOTKEY, normalizeHotkey, useShortcutStore } from "../store/shortcut";
import { CustomSkillsSettings } from "./CustomSkillsSettings";

interface SettingsProps {
  onBack: () => void;
}

type SettingsSection = "model" | "features" | "pet" | "shortcuts";

const SKIN_OPTIONS: { value: PetSkin; label: string }[] = [
  { value: "yellow", label: "皮卡丘" },
  { value: "blue", label: "蓝色" },
  { value: "pink", label: "粉色" },
  { value: "green", label: "绿色" },
];

const FREQUENCY_OPTIONS: { value: InteractionFrequency; label: string }[] = [
  { value: "rare", label: "较少" },
  { value: "normal", label: "正常" },
  { value: "frequent", label: "频繁" },
];

const ROAM_SCOPE_OPTIONS: { value: RoamScope; label: string }[] = [
  { value: "full", label: "全桌面" },
  { value: "nearby", label: "附近活动" },
  { value: "corner", label: "角落陪伴" },
];

const AVATAR_OPTIONS: { value: PetAvatar; label: string; description: string }[] = [
  { value: "pixel_pikachu", label: "像素皮卡丘", description: "块状复古，更像桌面小伙伴。" },
  { value: "pixel_cat", label: "像素猫", description: "轻巧、活泼，适合陪伴感。" },
  { value: "pixel_dog", label: "像素狗", description: "更外向，动作看起来更明显。" },
  { value: "toon_pikachu", label: "3D 皮卡丘", description: "保留原来的立体模型。" },
];

export function Settings({ onBack }: SettingsProps) {
  const themeClass = useThemeClass();
  const [showCustomSkills, setShowCustomSkills] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>("model");
  const config = loadConfig();

  const petName = usePetStore((state) => state.name);
  const currentSkin = usePetStore((state) => state.skin);
  const currentAvatar = usePetStore((state) => state.avatar);
  const currentAutoAction = usePetStore((state) => state.autoAction);
  const currentEnableInteractions = usePetStore((state) => state.enableInteractions);
  const currentInteractionFrequency = usePetStore((state) => state.interactionFrequency);
  const currentSize = usePetStore((state) => state.size);
  const currentOpacity = usePetStore((state) => state.opacity);
  const currentRoamScope = usePetStore((state) => state.roamScope);
  const currentAvoidCursor = usePetStore((state) => state.avoidCursor);
  const currentAutonomousNews = usePetStore((state) => state.autonomousNews);
  const currentAutonomousLearning = usePetStore((state) => state.autonomousLearning);
  const currentQuietHoursEnabled = usePetStore((state) => state.quietHoursEnabled);
  const currentQuietStart = usePetStore((state) => state.quietStart);
  const currentQuietEnd = usePetStore((state) => state.quietEnd);
  const currentTheme = useThemeStore((state) => state.theme);
  const setAppTheme = useThemeStore((state) => state.setTheme);
  const activityEnabled = useActivityStore((state) => state.enabled);
  const setActivityEnabled = useActivityStore((state) => state.setEnabled);
  const getActivitySummary = useActivityStore((state) => state.getSummary);
  const clearActivity = useActivityStore((state) => state.clear);
  const currentChatHotkey = useShortcutStore((state) => state.chatHotkey);
  const setChatHotkey = useShortcutStore((state) => state.setChatHotkey);
  const setName = usePetStore((state) => state.setName);
  const setSkin = usePetStore((state) => state.setSkin);
  const setAvatar = usePetStore((state) => state.setAvatar);
  const setAutoAction = usePetStore((state) => state.setAutoAction);
  const setEnableInteractions = usePetStore((state) => state.setEnableInteractions);
  const setInteractionFrequency = usePetStore((state) => state.setInteractionFrequency);
  const setSize = usePetStore((state) => state.setSize);
  const setOpacity = usePetStore((state) => state.setOpacity);
  const setRoamScope = usePetStore((state) => state.setRoamScope);
  const setAvoidCursor = usePetStore((state) => state.setAvoidCursor);
  const setAutonomousNews = usePetStore((state) => state.setAutonomousNews);
  const setAutonomousLearning = usePetStore((state) => state.setAutonomousLearning);
  const setQuietHoursEnabled = usePetStore((state) => state.setQuietHoursEnabled);
  const setQuietStart = usePetStore((state) => state.setQuietStart);
  const setQuietEnd = usePetStore((state) => state.setQuietEnd);

  const [provider, setProvider] = useState<ProviderId>(config.provider);
  const [providerLabel, setProviderLabel] = useState(config.providerLabel || getProviderPreset(config.provider).label);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [stream, setStream] = useState(config.stream ?? false);
  const [enableTools, setEnableTools] = useState(config.enableTools ?? false);
  const [temperature, setTemperature] = useState(config.temperature ?? 0.7);
  const [maxTokens, setMaxTokens] = useState(config.maxTokens ?? 4096);
  const [embeddingModel, setEmbeddingModel] = useState(config.embeddingModel || "text-embedding-3-small");
  const [extraHeaders, setExtraHeaders] = useState(config.extraHeaders || "");
  const [extraBody, setExtraBody] = useState(config.extraBody || "");
  const [enableMemory, setEnableMemory] = useState(config.enableMemory ?? true);
  const [enablePersonality, setEnablePersonality] = useState(config.enablePersonality ?? true);
  const [enableSecurity, setEnableSecurity] = useState(config.enableSecurity ?? true);
  const [enableMultimodal, setEnableMultimodal] = useState(config.enableMultimodal ?? true);

  const [petNameInput, setPetNameInput] = useState(petName);
  const [skin, setSkinLocal] = useState<PetSkin>(currentSkin);
  const [avatar, setAvatarLocal] = useState<PetAvatar>(currentAvatar);
  const [autoAction, setAutoActionLocal] = useState(currentAutoAction);
  const [enableInteractions, setEnableInteractionsLocal] = useState(currentEnableInteractions);
  const [interactionFrequency, setInteractionFrequencyLocal] = useState<InteractionFrequency>(currentInteractionFrequency);
  const [petSize, setPetSizeLocal] = useState(currentSize);
  const [petOpacity, setPetOpacityLocal] = useState(currentOpacity);
  const [roamScope, setRoamScopeLocal] = useState<RoamScope>(currentRoamScope);
  const [avoidCursor, setAvoidCursorLocal] = useState(currentAvoidCursor);
  const [autonomousNews, setAutonomousNewsLocal] = useState(currentAutonomousNews);
  const [autonomousLearning, setAutonomousLearningLocal] = useState(currentAutonomousLearning);
  const [quietHoursEnabled, setQuietHoursEnabledLocal] = useState(currentQuietHoursEnabled);
  const [quietStart, setQuietStartLocal] = useState(currentQuietStart);
  const [quietEnd, setQuietEndLocal] = useState(currentQuietEnd);
  const [theme, setThemeLocal] = useState<AppTheme>(currentTheme);
  const [chatHotkeyInput, setChatHotkeyInput] = useState(currentChatHotkey);

  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [activitySummary, setActivitySummary] = useState<string | null>(null);

  const activePreset = useMemo(() => getProviderPreset(provider), [provider]);

  const buildConfig = (): Partial<AgentConfig> => ({
    provider,
    providerLabel,
    apiKey,
    baseUrl,
    model,
    stream,
    enableTools,
    temperature,
    maxTokens,
    embeddingModel,
    extraHeaders,
    extraBody,
    enableMemory,
    enablePersonality,
    enableSecurity,
    enableMultimodal,
  });

  const handleProviderChange = (nextProvider: ProviderId) => {
    const preset = getProviderPreset(nextProvider);
    setProvider(nextProvider);
    setProviderLabel(preset.label);
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
    setStream(preset.stream);
    setEnableTools(preset.enableTools);
    setTemperature(preset.temperature);
    setMaxTokens(preset.maxTokens);
    setTestResult(null);
  };

  const saveAll = () => {
    saveConfig(buildConfig());
    setName(petNameInput);
    setSkin(skin);
    setAvatar(avatar);
    setAutoAction(autoAction);
    setEnableInteractions(enableInteractions);
    setInteractionFrequency(interactionFrequency);
    setSize(petSize);
    setOpacity(petOpacity);
    setRoamScope(roamScope);
    setAvoidCursor(avoidCursor);
    setAutonomousNews(autonomousNews);
    setAutonomousLearning(autonomousLearning);
    setQuietHoursEnabled(quietHoursEnabled);
    setQuietStart(quietStart);
    setQuietEnd(quietEnd);
    setAppTheme(theme);
    setChatHotkey(chatHotkeyInput);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const runConnectionTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection(buildConfig());
      setTestResult(`连接成功：${result}`);
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };

  const loadStats = async () => {
    try {
      setStats(await getMemoryStats());
      setProfile(getUserProfile());
    } catch (error) {
      console.error("加载统计失败:", error);
    }
  };

  if (showCustomSkills) {
    return <CustomSkillsSettings onClose={() => setShowCustomSkills(false)} />;
  }

  return (
    <div className={`chat-window ${themeClass} flex flex-col h-screen`}>
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-800/80 backdrop-blur border-b border-gray-700">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
          ←
        </button>
        <span className="font-semibold text-white">设置</span>
      </div>

      <div className="border-b border-gray-800 bg-gray-900/70 px-4 py-2">
        <div className="flex gap-1 overflow-x-auto rounded-lg border border-gray-700 bg-gray-800/70 p-0.5 text-sm">
          {[
            ["model", "模型"],
            ["features", "能力"],
            ["pet", "桌宠"],
            ["shortcuts", "快捷键"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setActiveSection(value as SettingsSection)}
              className={`shrink-0 rounded-md px-3 py-1.5 transition-colors ${
                activeSection === value ? "bg-yellow-500 text-gray-900" : "text-gray-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {activeSection === "model" && <Section title="AI 模型">
          <Field label="Provider">
            <select className="input" value={provider} onChange={(event) => handleProviderChange(event.target.value)}>
              {PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </Field>

          {provider === "custom" && (
            <Field label="Provider 名称">
              <input className="input" value={providerLabel} onChange={(event) => setProviderLabel(event.target.value)} />
            </Field>
          )}

          <Field label="API Key">
            <input
              type="password"
              className="input"
              placeholder={activePreset.apiKeyPlaceholder || "sk-..."}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>

          <Field label="Base URL">
            <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </Field>

          <Field label="模型名">
            <input className="input" value={model} onChange={(event) => setModel(event.target.value)} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Temperature">
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                className="input"
                value={temperature}
                onChange={(event) => setTemperature(Number(event.target.value))}
              />
            </Field>
            <Field label="Max Tokens">
              <input
                type="number"
                min={1}
                step={256}
                className="input"
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Toggle label="Stream" checked={stream} onChange={setStream} />
            <Toggle label="Tools" checked={enableTools} onChange={setEnableTools} />
          </div>

          <Field label="Embedding 模型">
            <input className="input" value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} />
          </Field>

          <Field label="额外 Headers JSON">
            <textarea
              className="input min-h-[72px] resize-y"
              placeholder='{"HTTP-Referer":"https://paw.local"}'
              value={extraHeaders}
              onChange={(event) => setExtraHeaders(event.target.value)}
            />
          </Field>

          <Field label="额外 Body JSON">
            <textarea
              className="input min-h-[72px] resize-y"
              placeholder='{"top_p":0.9}'
              value={extraBody}
              onChange={(event) => setExtraBody(event.target.value)}
            />
          </Field>

          {activePreset.notes && <div className="text-xs text-gray-400 leading-relaxed">{activePreset.notes}</div>}

          <button
            onClick={runConnectionTest}
            disabled={testing}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white rounded-lg text-sm transition-colors"
          >
            {testing ? "测试中..." : "测试模型连接"}
          </button>
          {testResult && <div className="text-xs text-gray-300 bg-gray-900/70 border border-gray-700 rounded-lg p-3">{testResult}</div>}
        </Section>}

        {activeSection === "features" && <Section title="AI 功能">
          <div className="space-y-3">
            <Toggle label="智能记忆" checked={enableMemory} onChange={setEnableMemory} />
            <Toggle label="个性化学习" checked={enablePersonality} onChange={setEnablePersonality} />
            <Toggle label="安全保护" checked={enableSecurity} onChange={setEnableSecurity} />
            <Toggle label="多模态工具" checked={enableMultimodal} onChange={setEnableMultimodal} />
          </div>

          <div className="mt-4 pt-4 border-t border-gray-700 space-y-3">
            <button
              onClick={() => setShowCustomSkills(true)}
              className="w-full py-2.5 bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/50 text-yellow-400 rounded-lg text-sm transition-colors"
            >
              自定义技能管理
            </button>

            <button onClick={loadStats} className="text-xs text-yellow-400 hover:text-yellow-300">
              加载统计信息
            </button>

            {stats && (
              <div className="mt-2 text-xs text-gray-400 space-y-1">
                <div>记忆总数：{stats.total}</div>
                <div>平均重要性：{stats.avgImportance.toFixed(1)}</div>
                {profile && (
                  <>
                    <div>对话次数：{profile.stats.totalConversations}</div>
                    <div>常用工具：{Object.keys(profile.stats.toolsUsed).slice(0, 3).join("、") || "暂无"}</div>
                  </>
                )}
              </div>
            )}

            <div className="mt-4 space-y-3 border-t border-gray-700 pt-4">
              <Toggle label="本地活动观察" checked={activityEnabled} onChange={setActivityEnabled} />
              <p className="text-xs leading-relaxed text-gray-500">
                开启后只在本机记录当前活动窗口标题和进程名，用于分析你最近在电脑上做什么；不截图、不记录键盘、不上传。
              </p>
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setActivitySummary(getActivitySummary())}
                  className="rounded-lg bg-gray-800 px-2.5 py-1 text-gray-300 transition-colors hover:bg-gray-700"
                >
                  查看活动分析
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearActivity();
                    setActivitySummary("活动记录已清空。");
                  }}
                  className="rounded-lg bg-gray-800 px-2.5 py-1 text-gray-300 transition-colors hover:bg-red-900/60"
                >
                  清空记录
                </button>
              </div>
              {activitySummary && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-700 bg-gray-900/70 p-3 text-xs text-gray-300">
                  {activitySummary}
                </pre>
              )}
            </div>
          </div>
        </Section>}

        {activeSection === "pet" && <Section title="桌宠">
          <Field label="界面风格">
            <div className="grid grid-cols-2 gap-2">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setThemeLocal(option.id);
                    setAppTheme(option.id);
                  }}
                  className={`min-h-[86px] text-left rounded-lg border px-3 py-2 transition-all ${
                    theme === option.id
                      ? "bg-yellow-500/20 border-yellow-300 text-yellow-100"
                      : "bg-gray-800/70 border-gray-700 text-gray-300 hover:border-yellow-300/70"
                  }`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-1 block text-[11px] leading-relaxed opacity-75">{option.description}</span>
                </button>
              ))}
            </div>
          </Field>
          <Field label="桌面宠物形态">
            <div className="grid grid-cols-2 gap-2">
              {AVATAR_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setAvatarLocal(option.value);
                    setAvatar(option.value);
                  }}
                  className={`min-h-[86px] text-left rounded-lg border px-3 py-2 transition-all ${
                    avatar === option.value
                      ? "bg-yellow-500/20 border-yellow-300 text-yellow-100"
                      : "bg-gray-800/70 border-gray-700 text-gray-300 hover:border-yellow-300/70"
                  }`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-1 block text-[11px] leading-relaxed opacity-75">{option.description}</span>
                </button>
              ))}
            </div>
          </Field>
          <Field label="宠物名字">
            <input className="input" value={petNameInput} onChange={(event) => setPetNameInput(event.target.value)} />
          </Field>
          <Field label="皮肤">
            <div className="flex gap-2 flex-wrap">
              {SKIN_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setSkinLocal(option.value)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all ${
                    skin === option.value
                      ? "bg-yellow-500/20 border border-yellow-500 text-yellow-400"
                      : "bg-gray-700 border border-gray-600 text-gray-300 hover:border-gray-500"
                  }`}
                >
                  <span className="w-4 h-4 rounded-full border border-gray-600" style={{ backgroundColor: SKIN_COLORS[option.value].body }} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`大小：${petSize}px`}>
              <input
                className="w-full accent-yellow-500"
                type="range"
                min={96}
                max={180}
                step={4}
                value={petSize}
                onChange={(event) => setPetSizeLocal(Number(event.target.value))}
              />
            </Field>
            <Field label={`透明度：${Math.round(petOpacity * 100)}%`}>
              <input
                className="w-full accent-yellow-500"
                type="range"
                min={45}
                max={100}
                step={5}
                value={Math.round(petOpacity * 100)}
                onChange={(event) => setPetOpacityLocal(Number(event.target.value) / 100)}
              />
            </Field>
          </div>
          <Field label="活动范围">
            <div className="flex gap-2 flex-wrap">
              {ROAM_SCOPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setRoamScopeLocal(option.value)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                    roamScope === option.value
                      ? "bg-yellow-500/20 border border-yellow-500 text-yellow-400"
                      : "bg-gray-700 border border-gray-600 text-gray-300 hover:border-gray-500"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Field>
          <Toggle label="自动动作" checked={autoAction} onChange={setAutoActionLocal} />
          <Toggle label="避开鼠标" checked={avoidCursor} onChange={setAvoidCursorLocal} />
          <Toggle label="主动互动" checked={enableInteractions} onChange={setEnableInteractionsLocal} />
          <Toggle label="自主新闻播报" checked={autonomousNews} onChange={setAutonomousNewsLocal} />
          <Toggle label="自主学习记忆" checked={autonomousLearning} onChange={setAutonomousLearningLocal} />
          {enableInteractions && (
            <Field label="互动频率">
              <div className="flex gap-2 flex-wrap">
                {FREQUENCY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setInteractionFrequencyLocal(option.value)}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                      interactionFrequency === option.value
                        ? "bg-yellow-500/20 border border-yellow-500 text-yellow-400"
                        : "bg-gray-700 border border-gray-600 text-gray-300 hover:border-gray-500"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Toggle label="安静时段" checked={quietHoursEnabled} onChange={setQuietHoursEnabledLocal} />
          {quietHoursEnabled && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="开始">
                <input className="input" type="time" value={quietStart} onChange={(event) => setQuietStartLocal(event.target.value)} />
              </Field>
              <Field label="结束">
                <input className="input" type="time" value={quietEnd} onChange={(event) => setQuietEndLocal(event.target.value)} />
              </Field>
            </div>
          )}
        </Section>}

        {activeSection === "shortcuts" && <Section title="快捷键">
          <Field label="召唤/隐藏聊天窗口">
            <input
              className="input"
              value={chatHotkeyInput}
              onChange={(event) => setChatHotkeyInput(event.target.value)}
              onBlur={() => setChatHotkeyInput(normalizeHotkey(chatHotkeyInput) || DEFAULT_CHAT_HOTKEY)}
              placeholder={DEFAULT_CHAT_HOTKEY}
            />
            <p className="text-xs text-gray-500">示例：Ctrl+Shift+P、Alt+Space、CommandOrControl+Shift+K。保存后立即重新注册。</p>
          </Field>
          <Field label="当前生效">
            <kbd className="px-2 py-1 bg-gray-700 rounded text-sm text-gray-300">{currentChatHotkey}</kbd>
          </Field>
        </Section>}
      </div>

      <div className="px-4 py-3 bg-gray-800/50 border-t border-gray-700">
        <button onClick={saveAll} className="w-full py-2.5 bg-yellow-500 hover:bg-yellow-400 text-gray-900 font-bold rounded-xl transition-colors">
          {saved ? "已保存" : "保存设置"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-800/50 rounded-xl border-2 border-yellow-200/60 p-4 shadow-lg space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-400">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer group">
      <span className="text-sm text-gray-200 group-hover:text-white transition-colors">{label}</span>
      <span className="relative shrink-0">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="sr-only peer" />
        <span className="block w-9 h-5 bg-gray-600 rounded-full peer-checked:bg-yellow-500 transition-colors" />
        <span className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full peer-checked:translate-x-4 transition-transform" />
      </span>
    </label>
  );
}
