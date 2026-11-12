import { useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  Cpu,
  Eye,
  EyeOff,
  Keyboard,
  Loader2,
  Menu,
  Palette,
  PlugZap,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  ChoiceCard,
  Field,
  IconButton,
  Notice,
  Segmented,
  SettingRow,
  Switch,
  useElementWidth,
} from "./ui";
import { MarkdownContent } from "./MarkdownContent";
import {
  PROVIDER_PRESETS,
  ensureModelProfiles,
  getMemoryStats,
  getProviderPreset,
  getUserProfile,
  loadConfig,
  modelSettingsFromPreset,
  saveConfig,
  testConnection,
  type AgentConfig,
  type ProviderId,
} from "../agent/kernel";
import {
  defaultProfileName,
  deleteModelProfile,
  setActiveModelProfile,
  upsertModelProfile,
  useModelProfileStore,
  type ModelSettings,
} from "../agent/modelProfiles";
import { getActiveBot, useBotStore } from "../store/bots";
import { usePetStore, SKIN_COLORS, type InteractionFrequency, type PetAvatar, type PetSkin, type RoamScope } from "../store/pet";
import { THEME_OPTIONS, type AppTheme, useThemeClass, useThemeStore } from "../store/theme";
import { useActivityStore } from "../store/activity";
import { DEFAULT_CHAT_HOTKEY, normalizeHotkey, useShortcutStore } from "../store/shortcut";
import { CustomSkillsSettings } from "./CustomSkillsSettings";

interface SettingsProps {
  onBack: () => void;
  /** 窄窗口下打开侧边栏抽屉。 */
  onOpenSidebar?: () => void;
}

type SettingsSection = "model" | "features" | "pet" | "appearance" | "shortcuts";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  { id: "model", label: "模型", icon: <Cpu size={15} /> },
  { id: "features", label: "AI 能力", icon: <Sparkles size={15} /> },
  { id: "pet", label: "桌宠", icon: <Bot size={15} /> },
  { id: "appearance", label: "外观", icon: <Palette size={15} /> },
  { id: "shortcuts", label: "快捷键", icon: <Keyboard size={15} /> },
];

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

export function Settings({ onBack, onOpenSidebar }: SettingsProps) {
  const themeClass = useThemeClass();
  const [showCustomSkills, setShowCustomSkills] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>("model");
  // 能力开关读全局配置；模型字段读“正在编辑的那套模型”（不能用 loadConfig()，那会带上当前 Bot 的覆盖）。
  const config = loadConfig();
  const [initialProfiles] = useState(() => ensureModelProfiles());
  const profiles = useModelProfileStore((state) => state.profiles);
  const activeProfileId = useModelProfileStore((state) => state.activeId);
  const [editingId, setEditingId] = useState<string>(() => activeProfileId || initialProfiles[0]?.id || "new");
  const editingProfile = initialProfiles.find((item) => item.id === editingId) || initialProfiles[0];
  const activeBotOverride = useBotStore((state) => getActiveBot(state)?.modelOverride);
  const botOverridesModel = Boolean(
    activeBotOverride && (activeBotOverride.model || activeBotOverride.baseUrl || activeBotOverride.apiKey || activeBotOverride.provider)
  );

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

  const initialModel: Partial<ModelSettings> = editingProfile || config;
  const [profileName, setProfileName] = useState(editingProfile?.name || "");
  const [provider, setProvider] = useState<ProviderId>(initialModel.provider || config.provider);
  const [providerLabel, setProviderLabel] = useState(initialModel.providerLabel || getProviderPreset(initialModel.provider || config.provider).label);
  const [apiKey, setApiKey] = useState(initialModel.apiKey || "");
  const [baseUrl, setBaseUrl] = useState(initialModel.baseUrl || "");
  const [model, setModel] = useState(initialModel.model || "");
  const [stream, setStream] = useState(initialModel.stream ?? false);
  const [enableTools, setEnableTools] = useState(initialModel.enableTools ?? true);
  const [temperature, setTemperature] = useState(initialModel.temperature ?? 0.7);
  const [maxTokens, setMaxTokens] = useState(initialModel.maxTokens ?? 4096);
  const [embeddingModel, setEmbeddingModel] = useState(initialModel.embeddingModel || "text-embedding-3-small");
  const [extraHeaders, setExtraHeaders] = useState(initialModel.extraHeaders || "");
  const [extraBody, setExtraBody] = useState(initialModel.extraBody || "");
  const [modelNotice, setModelNotice] = useState<string | null>(null);
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
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [showKey, setShowKey] = useState(false);
  const { ref: contentRef, width: contentWidth } = useElementWidth<HTMLDivElement>();
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

  const buildModelSettings = (): ModelSettings => ({
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
  });

  const loadModelIntoForm = (settings: Partial<ModelSettings>, name: string) => {
    const nextProvider = settings.provider || "custom";
    setProfileName(name);
    setProvider(nextProvider);
    setProviderLabel(settings.providerLabel || getProviderPreset(nextProvider).label);
    setApiKey(settings.apiKey || "");
    setBaseUrl(settings.baseUrl || "");
    setModel(settings.model || "");
    setStream(settings.stream ?? false);
    setEnableTools(settings.enableTools ?? true);
    setTemperature(settings.temperature ?? 0.7);
    setMaxTokens(settings.maxTokens ?? 4096);
    setEmbeddingModel(settings.embeddingModel || "text-embedding-3-small");
    setExtraHeaders(settings.extraHeaders || "");
    setExtraBody(settings.extraBody || "");
    setTestResult(null);
    setModelNotice(null);
  };

  const editProfile = (id: string) => {
    const target = profiles.find((item) => item.id === id);
    if (!target) return;
    setEditingId(id);
    loadModelIntoForm(target, target.name);
  };

  const startNewProfile = () => {
    setEditingId("new");
    loadModelIntoForm(modelSettingsFromPreset("custom"), "");
  };

  /** 保存正在编辑的模型；返回它的 id。 */
  const saveEditingProfile = (): string => {
    const saved = upsertModelProfile({
      ...buildModelSettings(),
      id: editingId === "new" ? undefined : editingId,
      name: profileName,
    });
    setEditingId(saved.id);
    setProfileName(saved.name);
    return saved.id;
  };

  const handleSaveProfile = () => {
    saveEditingProfile();
    setModelNotice("已保存这个模型。");
  };

  const handleUseProfile = () => {
    const id = saveEditingProfile();
    setActiveModelProfile(id);
    setModelNotice("已保存，并切换为当前使用的模型。");
  };

  const handleDeleteProfile = () => {
    if (editingId === "new") {
      editProfile(activeProfileId || profiles[0]?.id || "");
      return;
    }
    if (profiles.length <= 1) {
      setModelNotice("至少要保留一个模型。");
      return;
    }
    const target = profiles.find((item) => item.id === editingId);
    if (!confirm(`确定删除模型「${target?.name || ""}」吗？`)) return;
    deleteModelProfile(editingId);
    const next = useModelProfileStore.getState();
    const fallback = next.profiles.find((item) => item.id === next.activeId) || next.profiles[0];
    if (fallback) {
      setEditingId(fallback.id);
      loadModelIntoForm(fallback, fallback.name);
    }
  };

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

  /** 桌宠设置：本地表单和全局 store 一起更新，改动立即生效并同步到桌宠窗口。 */
  const live =
    <T,>(local: (value: T) => void, apply: (value: T) => void) =>
    (value: T) => {
      local(value);
      apply(value);
    };

  // 底部“保存设置”只用于「AI 能力」和「快捷键」：不再顺带保存模型编辑器里的内容
  // （之前在桌宠页点保存，会把模型表单也存一遍，编辑中的“新模型”会被重复创建）。
  const saveAll = () => {
    saveConfig({ enableMemory, enablePersonality, enableSecurity, enableMultimodal });
    setName(petNameInput.trim() || "皮卡丘");
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
      setTestOk(true);
      setTestResult(`连接成功，模型回复：${result}`);
    } catch (error) {
      setTestOk(false);
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

  const editingIsActive = editingId === activeProfileId;
  const wide = contentWidth >= 760;

  return (
    <div ref={contentRef} className="flex h-full min-h-0 flex-col bg-app">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
        {onOpenSidebar ? (
          <IconButton label="打开侧边栏" onClick={onOpenSidebar}>
            <Menu size={18} />
          </IconButton>
        ) : (
          <IconButton label="返回聊天" onClick={onBack}>
            <ArrowLeft size={18} />
          </IconButton>
        )}
        <h1 className="text-sm font-semibold text-fg">设置</h1>
      </header>

      <div className="shrink-0 border-b border-line bg-surface px-3 sm:px-6">
        <nav className="mx-auto flex max-w-4xl gap-1 overflow-x-auto" aria-label="设置分类">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveSection(section.id)}
              aria-current={activeSection === section.id ? "page" : undefined}
              className={`relative flex h-11 shrink-0 items-center gap-1.5 px-3 text-sm transition ${
                activeSection === section.id ? "font-medium text-fg" : "text-fg-muted hover:text-fg"
              }`}
            >
              {section.icon}
              {section.label}
              {activeSection === section.id && (
                <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-5 px-3 py-5 sm:px-6 sm:py-6">
          {activeSection === "model" && (
            <div className={wide ? "grid grid-cols-[260px_minmax(0,1fr)] items-start gap-5" : "space-y-5"}>
              {/* 模型列表 */}
              <Card
                title="我的模型"
                description="可以保存多套模型，随时切换。"
                actions={
                  <Button size="sm" variant="secondary" onClick={startNewProfile}>
                    <Plus size={14} />
                    添加
                  </Button>
                }
                className={wide ? "sticky top-0" : ""}
              >
                <div className="-mx-2 -my-1 space-y-1">
                  {profiles.map((item) => {
                    const isActive = item.id === activeProfileId;
                    const isEditing = item.id === editingId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => editProfile(item.id)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                          isEditing ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-surface-2"
                        }`}
                      >
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-primary" : "bg-fg-muted/30"}`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">{item.name}</span>
                          <span className="block truncate text-xs text-fg-muted">
                            {(item.providerLabel || item.provider) + " · " + item.model}
                          </span>
                        </span>
                        {isActive ? <Badge tone="primary">使用中</Badge> : !item.apiKey ? <Badge tone="accent">未填 Key</Badge> : null}
                      </button>
                    );
                  })}
                  {editingId === "new" && (
                    <div className="flex items-center gap-2.5 rounded-lg bg-primary/10 px-2.5 py-2 ring-1 ring-primary/40">
                      <Plus size={14} className="text-primary-ink" />
                      <span className="text-sm text-fg">新模型</span>
                    </div>
                  )}
                </div>
                {botOverridesModel && (
                  <Notice tone="warning">当前 Bot 在“团队”里设置了专属模型，聊天时会优先使用 Bot 的设置。</Notice>
                )}
              </Card>

              {/* 模型编辑 */}
              <Card
                title={editingId === "new" ? "添加模型" : profileName || "编辑模型"}
                description={editingId === "new" ? "填好连接信息后保存。" : editingIsActive ? "当前正在使用这个模型。" : "保存后可以设为当前使用。"}
                actions={
                  editingId === "new" ? (
                    <Button size="sm" variant="ghost" onClick={handleDeleteProfile}>
                      取消
                    </Button>
                  ) : (
                    <IconButton label="删除这个模型" onClick={handleDeleteProfile} className="hover:!text-danger">
                      <Trash2 size={16} />
                    </IconButton>
                  )
                }
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="服务商">
                    <select className="input" value={provider} onChange={(event) => handleProviderChange(event.target.value)}>
                      {PROVIDER_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="显示名称">
                    <input
                      className="input"
                      placeholder={defaultProfileName({ providerLabel, provider, model })}
                      value={profileName}
                      onChange={(event) => setProfileName(event.target.value)}
                    />
                  </Field>
                </div>

                {activePreset.notes && <Notice>{activePreset.notes}</Notice>}

                {provider === "custom" && (
                  <Field label="服务商名称">
                    <input className="input" value={providerLabel} onChange={(event) => setProviderLabel(event.target.value)} />
                  </Field>
                )}

                <Field label="API Key">
                  <div className="relative">
                    <input
                      type={showKey ? "text" : "password"}
                      className="input pr-10"
                      placeholder={activePreset.apiKeyPlaceholder || "sk-..."}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((value) => !value)}
                      aria-label={showKey ? "隐藏 Key" : "显示 Key"}
                      title={showKey ? "隐藏 Key" : "显示 Key"}
                      className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
                    >
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </Field>

                <div className="grid gap-4 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <Field label="接口地址（Base URL）">
                    <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
                  </Field>
                  <Field label="模型名">
                    <input className="input" value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
                  </Field>
                </div>

                <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                  <Field label={`随机性（Temperature）：${temperature}`} hint="越低越稳定，越高越有创意。">
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.1}
                      className="w-full"
                      value={temperature}
                      onChange={(event) => setTemperature(Number(event.target.value))}
                    />
                  </Field>
                  <Field label="单次回复上限（Max Tokens）">
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

                <div className="space-y-3">
                  <SettingRow title="流式输出" description="边生成边显示。个别服务商不支持时关掉。">
                    <Switch label="流式输出" checked={stream} onChange={setStream} />
                  </SettingRow>
                  <SettingRow title="工具调用" description="允许模型搜索、管理待办、打开应用等。模型不支持时关掉。">
                    <Switch label="工具调用" checked={enableTools} onChange={setEnableTools} />
                  </SettingRow>
                </div>

                <details className="group rounded-lg border border-line">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm text-fg">
                    高级选项
                    <ChevronDown size={16} className="text-fg-muted transition group-open:rotate-180" />
                  </summary>
                  <div className="space-y-4 border-t border-line px-3 py-3">
                    <Field label="Embedding 模型" hint="用于记忆的语义检索；服务商不支持时会自动跳过。">
                      <input className="input" value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} />
                    </Field>
                    <Field label="额外请求头（JSON）">
                      <textarea
                        className="input min-h-[72px] resize-y font-mono text-xs"
                        placeholder='{"HTTP-Referer":"https://paw.local"}'
                        value={extraHeaders}
                        onChange={(event) => setExtraHeaders(event.target.value)}
                      />
                    </Field>
                    <Field label="额外请求体（JSON）">
                      <textarea
                        className="input min-h-[72px] resize-y font-mono text-xs"
                        placeholder='{"top_p":0.9}'
                        value={extraBody}
                        onChange={(event) => setExtraBody(event.target.value)}
                      />
                    </Field>
                  </div>
                </details>

                {testResult && <Notice tone={testOk ? "success" : "error"}>{testResult}</Notice>}
                {modelNotice && <Notice tone="success">{modelNotice}</Notice>}

                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                  <Button variant="secondary" onClick={runConnectionTest} disabled={testing}>
                    {testing ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}
                    {testing ? "测试中…" : "测试连接"}
                  </Button>
                  <div className="flex-1" />
                  <Button variant="secondary" onClick={handleSaveProfile}>
                    保存
                  </Button>
                  <Button variant="primary" onClick={handleUseProfile}>
                    <Check size={15} />
                    {editingIsActive ? "保存" : "保存并使用"}
                  </Button>
                </div>
              </Card>
            </div>
          )}

          {activeSection === "features" && (
            <>
              <Card title="AI 能力" description="关闭后对应功能不再参与对话。">
                <SettingRow title="智能记忆" description="自动记住你的偏好和重要信息，回答时参考。">
                  <Switch label="智能记忆" checked={enableMemory} onChange={setEnableMemory} />
                </SettingRow>
                <SettingRow title="个性化学习" description="根据聊天习惯调整说话风格和建议。">
                  <Switch label="个性化学习" checked={enablePersonality} onChange={setEnablePersonality} />
                </SettingRow>
                <SettingRow title="安全保护" description="输入长度检查和调用频率限制。">
                  <Switch label="安全保护" checked={enableSecurity} onChange={setEnableSecurity} />
                </SettingRow>
                <SettingRow title="多模态工具" description="语音、图片分析、截屏等工具。">
                  <Switch label="多模态工具" checked={enableMultimodal} onChange={setEnableMultimodal} />
                </SettingRow>
              </Card>

              <Card
                title="本地活动观察"
                description="只在本机记录当前活动窗口的标题和进程名，用于分析你的电脑使用情况；不截图、不记录键盘、不上传。"
                actions={<Switch label="本地活动观察" checked={activityEnabled} onChange={setActivityEnabled} />}
              >
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setActivitySummary(getActivitySummary())}>
                    <Activity size={14} />
                    查看活动分析
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (!confirm("确定清空本地活动记录吗？")) return;
                      clearActivity();
                      setActivitySummary("活动记录已清空。");
                    }}
                  >
                    <Trash2 size={14} />
                    清空记录
                  </Button>
                </div>
                {activitySummary && (
                  <div className="max-h-64 overflow-auto rounded-lg border border-line bg-surface-2 px-4 py-3">
                    <div className="markdown-body text-xs">
                      <MarkdownContent content={activitySummary} />
                    </div>
                  </div>
                )}
              </Card>

              <Card title="技能与统计">
                <SettingRow title="自定义技能" description="创建、导入或停用技能。">
                  <Button size="sm" onClick={() => setShowCustomSkills(true)}>
                    <Sparkles size={14} />
                    管理技能
                  </Button>
                </SettingRow>
                <SettingRow title="使用统计" description="记忆数量、对话次数和常用工具。">
                  <Button size="sm" onClick={loadStats}>
                    <BarChart3 size={14} />
                    {stats ? "刷新" : "查看"}
                  </Button>
                </SettingRow>
                {stats && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="记忆总数" value={stats.total} />
                    <Stat label="平均重要性" value={stats.avgImportance.toFixed(1)} />
                    {profile && <Stat label="对话次数" value={profile.stats.totalConversations} />}
                    {profile && (
                      <Stat label="常用工具" value={Object.keys(profile.stats.toolsUsed).slice(0, 2).join("、") || "暂无"} />
                    )}
                  </div>
                )}
              </Card>
            </>
          )}

          {activeSection === "pet" && (
            <>
              <p className="text-xs text-fg-muted">桌宠设置改动后立即生效。</p>
              <Card title="形象">
                <Field label="形态">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {AVATAR_OPTIONS.map((option) => (
                      <ChoiceCard
                        key={option.value}
                        selected={avatar === option.value}
                        title={option.label}
                        description={option.description}
                        onClick={() => {
                          setAvatarLocal(option.value);
                          setAvatar(option.value);
                        }}
                      />
                    ))}
                  </div>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="名字">
                    <input className="input" value={petNameInput} onChange={(event) => setPetNameInput(event.target.value)}
                      onBlur={() => setName(petNameInput.trim() || "皮卡丘")}
                    />
                  </Field>
                  <Field label="配色" hint="皮卡丘系形态生效。">
                    <div className="flex flex-wrap gap-2">
                      {SKIN_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => live(setSkinLocal, setSkin)(option.value)}
                          aria-pressed={skin === option.value}
                          className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm transition ${
                            skin === option.value ? "border-primary bg-primary/10 text-fg" : "border-line text-fg-muted hover:text-fg"
                          }`}
                        >
                          <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ backgroundColor: SKIN_COLORS[option.value].body }} />
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={`大小：${petSize}px`}>
                    <input type="range" min={96} max={180} step={4} className="w-full" value={petSize} onChange={(event) => live(setPetSizeLocal, setSize)(Number(event.target.value))} />
                  </Field>
                  <Field label={`不透明度：${Math.round(petOpacity * 100)}%`}>
                    <input
                      type="range"
                      min={45}
                      max={100}
                      step={5}
                      className="w-full"
                      value={Math.round(petOpacity * 100)}
                      onChange={(event) => live(setPetOpacityLocal, setOpacity)(Number(event.target.value) / 100)}
                    />
                  </Field>
                </div>
              </Card>

              <Card title="行为">
                <SettingRow title="活动范围">
                  <Segmented value={roamScope} options={ROAM_SCOPE_OPTIONS} onChange={live(setRoamScopeLocal, setRoamScope)} />
                </SettingRow>
                <SettingRow title="自动走动" description="空闲时在桌面上溜达、做小动作。">
                  <Switch label="自动走动" checked={autoAction} onChange={live(setAutoActionLocal, setAutoAction)} />
                </SettingRow>
                <SettingRow title="避开鼠标" description="走动时躲开你的鼠标。">
                  <Switch label="避开鼠标" checked={avoidCursor} onChange={live(setAvoidCursorLocal, setAvoidCursor)} />
                </SettingRow>
                <SettingRow title="主动互动" description="偶尔说句话、讲个笑话。">
                  <Switch label="主动互动" checked={enableInteractions} onChange={live(setEnableInteractionsLocal, setEnableInteractions)} />
                </SettingRow>
                {enableInteractions && (
                  <SettingRow title="互动频率">
                    <Segmented value={interactionFrequency} options={FREQUENCY_OPTIONS} onChange={live(setInteractionFrequencyLocal, setInteractionFrequency)} />
                  </SettingRow>
                )}
                <SettingRow title="自主新闻播报" description="每天主动整理一次新闻。">
                  <Switch label="自主新闻播报" checked={autonomousNews} onChange={live(setAutonomousNewsLocal, setAutonomousNews)} />
                </SettingRow>
                <SettingRow title="自主学习" description="发现重复需求时自动沉淀为技能。">
                  <Switch label="自主学习" checked={autonomousLearning} onChange={live(setAutonomousLearningLocal, setAutonomousLearning)} />
                </SettingRow>
                <SettingRow title="安静时段" description="这段时间里宠物不打扰你。">
                  <Switch label="安静时段" checked={quietHoursEnabled} onChange={live(setQuietHoursEnabledLocal, setQuietHoursEnabled)} />
                </SettingRow>
                {quietHoursEnabled && (
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="开始">
                      <input className="input" type="time" value={quietStart} onChange={(event) => live(setQuietStartLocal, setQuietStart)(event.target.value)} />
                    </Field>
                    <Field label="结束">
                      <input className="input" type="time" value={quietEnd} onChange={(event) => live(setQuietEndLocal, setQuietEnd)(event.target.value)} />
                    </Field>
                  </div>
                )}
              </Card>
            </>
          )}

          {activeSection === "appearance" && (
            <Card title="主题" description="选好后立即生效，宠物气泡也会跟着换。">
              <div className="grid gap-2 sm:grid-cols-3">
                {THEME_OPTIONS.map((option) => (
                  <ChoiceCard
                    key={option.id}
                    selected={theme === option.id}
                    title={option.label}
                    description={option.description}
                    leading={<ThemeSwatch theme={option.id} />}
                    onClick={() => {
                      setThemeLocal(option.id);
                      setAppTheme(option.id);
                    }}
                  />
                ))}
              </div>
            </Card>
          )}

          {activeSection === "shortcuts" && (
            <Card title="快捷键">
              <Field
                label="显示 / 隐藏工作台"
                hint="例如 Ctrl+Shift+P、Alt+Space、CommandOrControl+Shift+K。保存后立即生效。"
              >
                <input
                  className="input font-mono"
                  value={chatHotkeyInput}
                  onChange={(event) => setChatHotkeyInput(event.target.value)}
                  onBlur={() => setChatHotkeyInput(normalizeHotkey(chatHotkeyInput) || DEFAULT_CHAT_HOTKEY)}
                  placeholder={DEFAULT_CHAT_HOTKEY}
                />
              </Field>
              <SettingRow title="当前生效">
                <kbd className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs text-fg">{currentChatHotkey}</kbd>
              </SettingRow>
            </Card>
          )}
        </div>
      </div>

      {(activeSection === "features" || activeSection === "shortcuts") && (
        <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-line bg-surface px-4 py-3 sm:px-6">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check size={14} />
              已保存
            </span>
          )}
          <Button variant="primary" onClick={saveAll}>
            保存设置
          </Button>
        </footer>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-fg">{value}</div>
    </div>
  );
}

/** 主题选项前的小预览。 */
function ThemeSwatch({ theme }: { theme: AppTheme }) {
  const light = (
    <span className="flex h-full w-full flex-col gap-0.5 bg-[#F4F5F7] p-1">
      <span className="h-1.5 w-3/4 rounded-sm bg-[#041E42]" />
      <span className="h-1.5 w-1/2 rounded-sm bg-[#00B2A9]" />
    </span>
  );
  const dark = (
    <span className="flex h-full w-full flex-col gap-0.5 bg-[#031228] p-1">
      <span className="h-1.5 w-3/4 rounded-sm bg-[#F0F2F5]" />
      <span className="h-1.5 w-1/2 rounded-sm bg-[#00B2A9]" />
    </span>
  );
  return (
    <span className="mt-0.5 flex h-9 w-12 shrink-0 overflow-hidden rounded-md border border-line">
      {theme === "light" ? light : theme === "dark" ? dark : (
        <>
          <span className="w-1/2 overflow-hidden">{light}</span>
          <span className="w-1/2 overflow-hidden">{dark}</span>
        </>
      )}
    </span>
  );
}
