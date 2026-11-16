import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, Plus, ShieldCheck, Users, X } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, PageHeader, SearchInput, Segmented, Switch, relativeTime } from "./ui";
import { useChatStore } from "../store/chat";
import { PROVIDER_PRESETS, loadConfig } from "../agent/kernel";
import type { PetAvatar, PetSkin } from "../store/pet";
import { useThemeClass } from "../store/theme";
import { BotAvatar, BotPortrait } from "./BotAvatar";
import { useAvatarOptions } from "../store/petAvatars";
import {
  ROLE_PRESETS,
  useBotStore,
  type ApprovalLevel,
  type BotModelOverride,
  type BotProfile,
  type BotRole,
} from "../store/bots";

interface BotRosterProps {
  onClose: () => void;
}

const LEVEL_LABEL: Record<ApprovalLevel, string> = {
  ask: "每次询问",
  edits: "允许编辑",
  auto: "自动放行",
};

const LEVEL_HINT: Record<ApprovalLevel, string> = {
  ask: "所有外部动作都要先弹审批卡片",
  edits: "文件类改动可放行，系统动作仍需确认",
  auto: "按成员既定规则自动执行",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  allowed: "已允许",
  denied: "已拒绝",
  expired: "已过期",
};

type Tab = "profile" | "model" | "chats" | "approvals";

type Draft = {
  name: string;
  tagline: string;
  instructions: string;
  approvalLevel: ApprovalLevel;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  tagline: "",
  instructions: "",
  approvalLevel: "ask",
  provider: "",
  model: "",
  baseUrl: "",
  apiKey: "",
};

function draftOf(bot: BotProfile): Draft {
  return {
    name: bot.name,
    tagline: bot.tagline,
    instructions: bot.instructions,
    approvalLevel: bot.approvalLevel,
    provider: bot.modelOverride?.provider || "",
    model: bot.modelOverride?.model || "",
    baseUrl: bot.modelOverride?.baseUrl || "",
    apiKey: bot.modelOverride?.apiKey || "",
  };
}

type NewBot = {
  role: BotRole;
  avatar: string;
  name: string;
  tagline: string;
  instructions: string;
  petAvatar?: PetAvatar;
  petSkin: PetSkin;
  approvalLevel: ApprovalLevel;
  skills: string[];
};

const EMPTY_NEW_BOT: NewBot = {
  role: "custom",
  avatar: "custom",
  name: "",
  tagline: "",
  instructions: "",
  petSkin: "yellow",
  approvalLevel: "ask",
  skills: [],
};

const sectionClass = "rounded-xl border border-line bg-surface p-5";
const labelClass = "block text-xs font-medium text-fg";

/** 团队：成员通讯录、每个成员的资料 / 模型 / 会话 / 审批记录。 */
export function BotRoster({ onClose }: BotRosterProps) {
  const avatarOptions = useAvatarOptions();
  const themeClass = useThemeClass();
  const bots = useBotStore((state) => state.bots);
  const approvals = useBotStore((state) => state.approvals);
  const conversations = useChatStore((state) => state.conversations);
  const createConversation = useChatStore((state) => state.createConversation);
  const activeBotId = useBotStore((state) => state.activeBotId);
  const switchBot = useBotStore((state) => state.switchBot);
  const createBot = useBotStore((state) => state.createBot);
  const createBotFromRole = useBotStore((state) => state.createBotFromRole);
  const updateBot = useBotStore((state) => state.updateBot);
  const archiveBot = useBotStore((state) => state.archiveBot);

  const [selectedId, setSelectedId] = useState(activeBotId);
  const [creating, setCreating] = useState(false);
  const [newBot, setNewBot] = useState<NewBot>(EMPTY_NEW_BOT);
  const [newBotError, setNewBotError] = useState("");
  const [switchAfterCreate, setSwitchAfterCreate] = useState(false);
  const [query, setQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [tab, setTab] = useState<Tab>("profile");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [justSaved, setJustSaved] = useState(false);

  const visibleBots = bots.filter((bot) => !bot.archived);
  const selected = visibleBots.find((bot) => bot.id === selectedId) || visibleBots[0];
  const isActive = selected?.id === activeBotId;

  useEffect(() => {
    setDraft(selected ? draftOf(selected) : EMPTY_DRAFT);
  }, [selected?.id]);

  const filteredBots = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleBots;
    return visibleBots.filter((bot) => `${bot.name} ${bot.tagline} ${bot.role}`.toLowerCase().includes(q));
  }, [visibleBots, query]);

  const dirty = useMemo(() => {
    if (!selected) return false;
    const base = draftOf(selected);
    return (Object.keys(base) as Array<keyof Draft>).some((key) => base[key] !== draft[key]);
  }, [draft, selected]);

  // conversations 已经由 useBotScopeSync 载入“当前成员”的分区
  const botConversations = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const botApprovals = selected
    ? approvals.filter((request) => request.botId === selected.id).slice().reverse()
    : [];

  // 展示的是真正生效的配置（全局 + 当前成员覆盖），而非表单草稿
  const effectiveConfig = loadConfig();

  const buildModelOverride = (): BotModelOverride | undefined => {
    const value: BotModelOverride = {
      provider: draft.provider.trim() || undefined,
      model: draft.model.trim() || undefined,
      baseUrl: draft.baseUrl.trim() || undefined,
      apiKey: draft.apiKey.trim() || undefined,
    };
    return Object.values(value).some((item) => item !== undefined) ? value : undefined;
  };

  const save = () => {
    if (!selected) return;
    updateBot(selected.id, {
      name: draft.name.trim() || selected.name,
      tagline: draft.tagline,
      instructions: draft.instructions,
      approvalLevel: draft.approvalLevel,
      modelOverride: buildModelOverride(),
    });
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 2000);
  };

  const clearModelOverride = () => {
    if (!selected) return;
    updateBot(selected.id, { modelOverride: undefined });
    setDraft({ ...draft, provider: "", model: "", baseUrl: "", apiKey: "" });
  };

  // 还没加入团队的角色模板（同角色已在团队里就不再推荐）
  const suggestions = ROLE_PRESETS.filter(
    (preset) => preset.role !== "chief" && !visibleBots.some((bot) => bot.role === preset.role)
  );

  const addSuggestion = (role: BotRole) => {
    const id = createBotFromRole(role, { activate: false });
    if (id) setSelectedId(id);
  };

  const addAllSuggestions = () => {
    suggestions.forEach((preset) => createBotFromRole(preset.role, { activate: false }));
  };

  const startCreate = () => {
    setNewBot({ ...EMPTY_NEW_BOT, petAvatar: avatarOptions[0]?.value });
    setNewBotError("");
    setCreating(true);
  };

  // 从模板开始：把模板内容填进表单，用户可以接着改
  const applyTemplate = (role: BotRole) => {
    const preset = ROLE_PRESETS.find((item) => item.role === role);
    if (!preset) return;
    setNewBot({
      role: preset.role,
      avatar: preset.avatar,
      name: preset.name,
      tagline: preset.tagline,
      instructions: preset.instructions,
      petAvatar: preset.petAvatar,
      petSkin: preset.petSkin || "yellow",
      approvalLevel: preset.approvalLevel,
      skills: [...preset.skills],
    });
    setNewBotError("");
  };

  const handleCreate = () => {
    const name = newBot.name.trim();
    if (!name) return setNewBotError("起个名字");
    if (visibleBots.some((bot) => bot.name === name)) return setNewBotError(`团队里已经有「${name}」了，换个名字`);
    const id = createBot(
      {
        name,
        role: newBot.role,
        avatar: newBot.avatar,
        petAvatar: newBot.petAvatar,
        petSkin: newBot.petSkin,
        tagline: newBot.tagline.trim(),
        instructions: newBot.instructions.trim(),
        skills: newBot.skills,
        approvalLevel: newBot.approvalLevel,
      },
      { activate: switchAfterCreate }
    );
    setCreating(false);
    setSelectedId(id);
    setTab("profile");
  };

  const hasOverride = Boolean(selected?.modelOverride && Object.values(selected.modelOverride).some(Boolean));

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col bg-app`}>
      <PageHeader
        title="团队"
        description={`${visibleBots.length} 位成员，各有各的人设、记忆和会话 · 正在使用「${bots.find((b) => b.id === activeBotId)?.name || "—"}」`}
        onBack={onClose}
      />

      <div className="flex min-h-0 flex-1">
        {/* 左：成员列表 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <span className="text-xs font-medium text-fg-muted">成员 · {visibleBots.length}</span>
            <IconButton label="新建成员" active={creating} onClick={() => (creating ? setCreating(false) : startCreate())}>
              {creating ? <X size={16} /> : <Plus size={16} />}
            </IconButton>
          </div>

          {visibleBots.length > 6 && (
            <div className="px-3 pb-2">
              <SearchInput value={query} onChange={setQuery} placeholder="找成员" className="h-8" />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <div className="space-y-0.5">
              {filteredBots.map((bot) => {
                const active = selected?.id === bot.id;
                return (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => setSelectedId(bot.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      active ? "bg-primary/10" : "hover:bg-surface-2"
                    }`}
                  >
                    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2">
                      <BotAvatar bot={bot} size={32} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={`truncate text-sm ${active ? "font-semibold text-fg" : "text-fg"}`}>{bot.name}</span>
                        {bot.id === activeBotId && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title="正在使用" />}
                      </span>
                      <span className="block truncate text-xs text-fg-muted">{bot.tagline || bot.role}</span>
                    </span>
                  </button>
                );
              })}
              {filteredBots.length === 0 && <div className="px-3 py-4 text-center text-xs text-fg-muted">没有叫这个的成员</div>}
            </div>

            {suggestions.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="flex items-center justify-between px-2 pb-1">
                  <button
                    type="button"
                    onClick={() => setShowSuggestions(!showSuggestions)}
                    className="flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
                  >
                    {showSuggestions ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    推荐成员 · {suggestions.length}
                  </button>
                  <button
                    type="button"
                    onClick={addAllSuggestions}
                    className="text-xs text-primary-ink hover:underline"
                    title="把推荐的成员都加进团队，不会切换当前成员"
                  >
                    全部加入
                  </button>
                </div>
                {showSuggestions &&
                  suggestions.map((preset) => (
                    <div key={preset.role} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 opacity-80">
                        <BotAvatar bot={{ ...preset, id: preset.role } as unknown as BotProfile} size={28} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{preset.name}</span>
                        <span className="block truncate text-xs text-fg-muted">{preset.tagline}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => addSuggestion(preset.role)}
                        className="shrink-0 rounded-md px-2 py-0.5 text-xs text-primary-ink hover:bg-primary/10"
                        aria-label={`把${preset.name}加入团队`}
                      >
                        加入
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </aside>

        {/* 右：成员详情 */}
        <main className="flex min-w-0 flex-1 flex-col">
          {creating ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="page-pad space-y-4 py-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-semibold text-fg">新建成员</h2>
                    <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                      取消
                    </Button>
                  </div>

                  <section className="rounded-xl border border-line bg-surface p-4">
                    <div className="mb-2 text-xs font-medium text-fg">
                      从模板开始 <span className="font-normal text-fg-muted">可选，点一个会把它的人设填进下面，再按你的想法改</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {ROLE_PRESETS.filter((preset) => preset.role !== "chief").map((preset) => {
                        const picked = newBot.role === preset.role;
                        return (
                          <button
                            key={preset.role}
                            type="button"
                            onClick={() => applyTemplate(preset.role)}
                            title={preset.tagline}
                            className={`flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition ${
                              picked ? "border-primary bg-primary/10 text-fg" : "border-line text-fg-muted hover:border-primary/50 hover:text-fg"
                            }`}
                          >
                            <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-surface-2">
                              <BotAvatar bot={{ ...preset, id: preset.role } as unknown as BotProfile} size={22} />
                            </span>
                            {preset.name}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => setNewBot({ ...EMPTY_NEW_BOT, petAvatar: newBot.petAvatar })}
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          newBot.role === "custom" ? "border-primary bg-primary/10 text-fg" : "border-line text-fg-muted hover:text-fg"
                        }`}
                      >
                        从空白开始
                      </button>
                    </div>
                  </section>

                  <section className="flex gap-5 rounded-xl border border-line bg-surface p-5">
                    <div className="hidden w-28 shrink-0 flex-col items-center gap-2 sm:flex">
                      <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-primary/15 to-surface-2">
                        <BotPortrait
                          bot={{ ...newBot, id: "new", name: newBot.name || "新成员" } as unknown as BotProfile}
                          size={100}
                        />
                      </div>
                      <span className="max-w-full truncate text-xs text-fg-muted">{newBot.name || "新成员"}</span>
                    </div>
                    <div className="min-w-0 flex-1 space-y-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className={labelClass}>
                          名字 <span className="text-danger">*</span>
                          <input
                            autoFocus
                            className="input mt-1.5 w-full"
                            value={newBot.name}
                            onChange={(event) => setNewBot({ ...newBot, name: event.target.value })}
                            placeholder="比如：健身教练"
                          />
                        </label>
                        <label className={labelClass}>
                          一句话简介
                          <input
                            className="input mt-1.5 w-full"
                            value={newBot.tagline}
                            onChange={(event) => setNewBot({ ...newBot, tagline: event.target.value })}
                            placeholder="比如：排训练计划、盯饮食"
                          />
                        </label>
                      </div>
                      <label className={labelClass}>
                        人设和工作规则
                        <span className="ml-2 font-normal text-fg-muted">它是谁、怎么说话、遇到什么事怎么做</span>
                        <textarea
                          className="input mt-1.5 min-h-[140px] w-full resize-y leading-relaxed"
                          value={newBot.instructions}
                          onChange={(event) => setNewBot({ ...newBot, instructions: event.target.value })}
                          placeholder={"比如：\n你是我的健身教练，说话简短、有点严格。\n每次先问我今天的状态，再给当天的训练安排；\n饮食建议给具体的量，不说空话。"}
                        />
                      </label>
                      <div className="grid gap-4 xl:grid-cols-2">
                        <label className={labelClass}>
                          形象
                          <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_76px] gap-2">
                            <select
                              className="input"
                              value={newBot.petAvatar || ""}
                              onChange={(event) => setNewBot({ ...newBot, petAvatar: (event.target.value || undefined) as PetAvatar | undefined })}
                            >
                              {avatarOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                              <option value="">仅 emoji</option>
                            </select>
                          </div>
                        </label>
                        <label className={labelClass}>
                          动手前要不要问我
                          <select
                            className="input mt-1.5 w-full"
                            value={newBot.approvalLevel}
                            onChange={(event) => setNewBot({ ...newBot, approvalLevel: event.target.value as ApprovalLevel })}
                          >
                            {(Object.keys(LEVEL_LABEL) as ApprovalLevel[]).map((level) => (
                              <option key={level} value={level}>
                                {LEVEL_LABEL[level]}
                              </option>
                            ))}
                          </select>
                          <span className="mt-1 block font-normal text-fg-muted">{LEVEL_HINT[newBot.approvalLevel]}</span>
                        </label>
                      </div>
                    </div>
                  </section>
                  <p className="text-xs text-fg-muted">建好以后还能在「模型」里给它单独换个模型。</p>
                </div>
              </div>
              <div className="border-t border-line bg-surface px-6 py-3">
                <div className="mx-auto flex max-w-[64rem] items-center gap-3">
                  <label className="flex flex-1 items-center gap-2 text-xs text-fg-muted">
                    <Switch label="建好后切换过去" checked={switchAfterCreate} onChange={setSwitchAfterCreate} />
                    建好后切换过去
                  </label>
                  {newBotError && <span className="text-xs text-danger">{newBotError}</span>}
                  <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                    取消
                  </Button>
                  <Button size="sm" variant="primary" disabled={!newBot.name.trim()} onClick={handleCreate}>
                    创建
                  </Button>
                </div>
              </div>
            </>
          ) : !selected ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState icon={<Users size={20} />} title="团队里还没有成员" hint="点左上角的 + 新建一个，可以自己写人设，也可以从模板开始。" />
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="page-pad space-y-4 py-5">
                  {/* 资料卡 */}
                  <section className="flex items-center gap-5 rounded-xl border border-line bg-surface p-5">
                    <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-primary/15 to-surface-2">
                      <BotPortrait bot={selected} size={88} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-lg font-semibold text-fg">{selected.name}</h2>
                        {isActive && <Badge tone="primary">正在使用</Badge>}
                        <Badge>{LEVEL_LABEL[selected.approvalLevel]}</Badge>
                        {hasOverride && <Badge tone="accent">独立模型</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{selected.tagline || "还没写简介"}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {!isActive && (
                          <Button size="sm" variant="primary" onClick={() => switchBot(selected.id)}>
                            切换到它
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          className="hover:!text-danger"
                          disabled={visibleBots.length <= 1}
                          onClick={() => {
                            if (confirm(`归档「${selected.name}」？它的会话和记忆会保留，只是不再出现在团队里。`)) archiveBot(selected.id);
                          }}
                        >
                          归档
                        </Button>
                      </div>
                    </div>
                  </section>

                  <Segmented
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: "profile", label: "人设" },
                      { value: "model", label: "模型" },
                      { value: "chats", label: "会话" },
                      { value: "approvals", label: `审批记录${botApprovals.length ? ` ${botApprovals.length}` : ""}` },
                    ]}
                  />

                  {tab === "profile" && (
                    <section className={`${sectionClass} space-y-4`}>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className={labelClass}>
                          名字
                          <input className="input mt-1.5 w-full" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                        </label>
                        <label className={labelClass}>
                          一句话简介
                          <input
                            className="input mt-1.5 w-full"
                            value={draft.tagline}
                            onChange={(event) => setDraft({ ...draft, tagline: event.target.value })}
                          />
                        </label>
                      </div>

                      <label className={labelClass}>
                        人设和工作规则
                        <span className="ml-2 font-normal text-fg-muted">每次聊天都会带上</span>
                        <textarea
                          className="input mt-1.5 min-h-[120px] w-full resize-y leading-relaxed"
                          value={draft.instructions}
                          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                          placeholder="比如：你是团队里的测试员，说话直接，先列出风险再给建议。"
                        />
                      </label>

                      <div className="grid gap-4 lg:grid-cols-2">
                        <label className={labelClass}>
                          形象
                          <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_76px] gap-2">
                            <select
                              className="input"
                              value={selected.petAvatar || ""}
                              title="成员形象"
                              onChange={(event) =>
                                updateBot(selected.id, { petAvatar: (event.target.value || undefined) as PetAvatar | undefined })
                              }
                            >
                              {avatarOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                              <option value="">仅 emoji</option>
                            </select>
                          </div>
                        </label>
                        <label className={labelClass}>
                          动手前要不要问我
                          <select
                            className="input mt-1.5 w-full"
                            value={draft.approvalLevel}
                            onChange={(event) => setDraft({ ...draft, approvalLevel: event.target.value as ApprovalLevel })}
                          >
                            {(Object.keys(LEVEL_LABEL) as ApprovalLevel[]).map((level) => (
                              <option key={level} value={level}>
                                {LEVEL_LABEL[level]}
                              </option>
                            ))}
                          </select>
                          <span className="mt-1 block font-normal text-fg-muted">{LEVEL_HINT[draft.approvalLevel]}</span>
                        </label>
                      </div>

                      {selected.skills.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="text-fg-muted">擅长：</span>
                          {selected.skills.map((skill) => (
                            <Badge key={skill}>{skill}</Badge>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {tab === "model" && (
                    <section className={`${sectionClass} space-y-4`}>
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-xs leading-relaxed text-fg-muted">
                          给这个成员单独换个模型，比如写代码的用更强的、闲聊的用便宜的。留空的字段沿用全局设置。
                        </p>
                        {hasOverride && (
                          <Button size="sm" variant="ghost" onClick={clearModelOverride}>
                            恢复全局
                          </Button>
                        )}
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className={labelClass}>
                          服务商
                          <select
                            className="input mt-1.5 w-full"
                            value={draft.provider}
                            onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
                          >
                            <option value="">沿用全局</option>
                            {PROVIDER_PRESETS.map((preset) => (
                              <option key={preset.id} value={preset.id}>
                                {preset.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className={labelClass}>
                          模型
                          <input
                            className="input mt-1.5 w-full"
                            value={draft.model}
                            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                            placeholder="留空沿用全局"
                          />
                        </label>
                        <label className={labelClass}>
                          Base URL
                          <input
                            className="input mt-1.5 w-full"
                            value={draft.baseUrl}
                            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                            placeholder="留空沿用全局"
                          />
                        </label>
                        <label className={labelClass}>
                          API Key
                          <input
                            className="input mt-1.5 w-full"
                            type="password"
                            value={draft.apiKey}
                            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                            placeholder="留空沿用全局"
                          />
                        </label>
                      </div>
                      {isActive && (
                        <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">
                          现在实际在用：
                          <span className="text-fg">
                            {effectiveConfig.providerLabel || effectiveConfig.provider} · {effectiveConfig.model}
                          </span>
                        </div>
                      )}
                    </section>
                  )}

                  {tab === "chats" && (
                    <section className="overflow-hidden rounded-xl border border-line bg-surface">
                      {!isActive ? (
                        <EmptyState
                          icon={<MessageSquare size={20} />}
                          title={`切换到「${selected.name}」后才能看到它的会话`}
                          hint="每个成员的会话、记忆和画像是分开存的，切换成员就会载入它自己的那一份。"
                        />
                      ) : (
                        <>
                          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                            <span className="text-xs text-fg-muted">
                              {botConversations.length} 个会话 · {botConversations.reduce((sum, t) => sum + t.messages.length, 0)} 条消息
                            </span>
                            <Button size="sm" variant="ghost" onClick={() => createConversation()}>
                              <Plus size={14} />
                              新会话
                            </Button>
                          </div>
                          {botConversations.length === 0 ? (
                            <EmptyState title="还没有会话" />
                          ) : (
                            <ul className="divide-y divide-line">
                              {botConversations.map((conversation) => (
                                <li key={conversation.id} className="flex items-center gap-3 px-4 py-2.5">
                                  <MessageSquare size={14} className="shrink-0 text-fg-muted" />
                                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{conversation.title}</span>
                                  <span className="shrink-0 text-xs text-fg-muted">
                                    {conversation.messages.length} 条 · {relativeTime(conversation.updatedAt)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </section>
                  )}

                  {tab === "approvals" && (
                    <section className="overflow-hidden rounded-xl border border-line bg-surface">
                      {botApprovals.length === 0 ? (
                        <EmptyState
                          icon={<ShieldCheck size={20} />}
                          title="还没有审批记录"
                          hint="这个成员要打开网页、启动软件、做系统操作时，会先弹卡片问你，记录会出现在这里。"
                        />
                      ) : (
                        <ul className="divide-y divide-line">
                          {botApprovals.slice(0, 30).map((request) => (
                            <li key={request.id} className="flex items-center gap-3 px-4 py-2.5">
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  request.status === "allowed" ? "bg-success" : request.status === "pending" ? "bg-accent" : "bg-fg-muted/40"
                                }`}
                              />
                              <span className="min-w-0 flex-1 truncate text-sm text-fg">{request.summary}</span>
                              <span className="shrink-0 text-xs text-fg-muted">{STATUS_LABEL[request.status] || request.status}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                </div>
              </div>

              {(tab === "profile" || tab === "model") && (dirty || justSaved) && (
                <div className="border-t border-line bg-surface px-6 py-3">
                  <div className="mx-auto flex max-w-[64rem] items-center gap-3">
                    <span className="flex-1 text-xs text-fg-muted">{dirty ? "有修改还没保存" : "已保存"}</span>
                    {dirty && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setDraft(draftOf(selected))}>
                          撤销
                        </Button>
                        <Button size="sm" variant="primary" onClick={save}>
                          保存
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
