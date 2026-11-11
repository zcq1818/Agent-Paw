import { useEffect, useState } from "react";
import { useChatStore } from "../store/chat";
import { PROVIDER_PRESETS, loadConfig } from "../agent/kernel";
import type { PetAvatar, PetSkin } from "../store/pet";
import { useThemeClass } from "../store/theme";
import { BotAvatar, BotPortrait } from "./BotAvatar";
import {
  ROLE_PRESETS,
  useBotStore,
  type ApprovalLevel,
  type BotModelOverride,
  type BotRole,
} from "../store/bots";

interface BotRosterProps {
  onClose: () => void;
}

const PET_AVATAR_OPTIONS: { value: PetAvatar | ""; label: string }[] = [
  { value: "pixel_pikachu", label: "像素皮卡丘" },
  { value: "pixel_cat", label: "像素猫" },
  { value: "pixel_dog", label: "像素狗" },
  { value: "toon_pikachu", label: "3D 皮卡丘" },
  { value: "", label: "仅 emoji" },
];

const PET_SKIN_OPTIONS: { value: PetSkin; label: string }[] = [
  { value: "yellow", label: "黄" },
  { value: "blue", label: "蓝" },
  { value: "pink", label: "粉" },
  { value: "green", label: "绿" },
];

const LEVEL_LABEL: Record<ApprovalLevel, string> = {
  ask: "每次询问",
  edits: "允许编辑",
  auto: "自动放行",
};

const LEVEL_HINT: Record<ApprovalLevel, string> = {
  ask: "所有外部动作都要先弹审批卡片",
  edits: "文件类改动可放行，系统动作仍需确认",
  auto: "按 Bot 既定规则自动执行",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  allowed: "已允许",
  denied: "已拒绝",
  expired: "已过期",
};

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

/** 团队工作台：多 Bot 通讯录、独立会话线程、审批记录。 */
export function BotRoster({ onClose }: BotRosterProps) {
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
  const [newRole, setNewRole] = useState<BotRole>("coder");
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const visibleBots = bots.filter((bot) => !bot.archived);
  const selected = visibleBots.find((bot) => bot.id === selectedId) || visibleBots[0];

  useEffect(() => {
    if (!selected) {
      setDraft(EMPTY_DRAFT);
      return;
    }
    setDraft({
      name: selected.name,
      tagline: selected.tagline,
      instructions: selected.instructions,
      approvalLevel: selected.approvalLevel,
      provider: selected.modelOverride?.provider || "",
      model: selected.modelOverride?.model || "",
      baseUrl: selected.modelOverride?.baseUrl || "",
      apiKey: selected.modelOverride?.apiKey || "",
    });
  }, [selected?.id]);

  // conversations 已经由 useBotScopeSync 载入当前 Bot 的分区。
  const botConversations = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const botApprovals = selected
    ? approvals.filter((request) => request.botId === selected.id).slice().reverse()
    : [];

  // 展示的是真正生效的配置（全局 + 当前 Bot 覆盖），而非表单草稿。
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

  const clearModelOverride = () => {
    if (!selected) return;
    updateBot(selected.id, { modelOverride: undefined });
    setDraft({ ...draft, provider: "", model: "", baseUrl: "", apiKey: "" });
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    switchBot(id);
  };

  const handleCreate = () => {
    const preset = ROLE_PRESETS.find((item) => item.role === newRole);
    const name = newName.trim();
    const id =
      name && preset
        ? createBot({
            name,
            role: preset.role,
            avatar: preset.avatar,
            tagline: preset.tagline,
            instructions: preset.instructions,
            skills: [...preset.skills],
            approvalLevel: preset.approvalLevel,
          })
        : createBotFromRole(newRole);
    if (!id) return;
    setNewName("");
    setSelectedId(id);
    switchBot(id);
  };

  return (
    <div className={`chat-window ${themeClass} flex h-screen flex-col`}>
      <div className="flex items-center gap-3 border-b border-gray-700 ui-panel px-4 py-3">
        <button onClick={onClose} className="text-gray-400 transition-colors hover:text-white" aria-label="返回聊天">
          ←
        </button>
        <div>
          <div className="font-semibold">Paw 团队</div>
          <div className="text-xs ui-muted">
            通讯录式 Bot 团队 · 当前 {visibleBots.length} 位 · 正在使用「{bots.find((b) => b.id === activeBotId)?.name || "—"}」
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-700 p-3">
          <div className="mb-4 space-y-2 rounded-xl border border-gray-700 ui-panel p-3">
            <div className="text-xs font-semibold ui-muted">新建 Bot</div>
            <select
              className="input"
              value={newRole}
              onChange={(event) => setNewRole(event.target.value as BotRole)}
              title="角色模板"
            >
              {ROLE_PRESETS.map((preset) => (
                <option key={preset.role} value={preset.role}>
                  {preset.name} · {preset.tagline}
                </option>
              ))}
            </select>
            <input
              className="input"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="自定义名字（留空用模板名）"
            />
            <button
              type="button"
              onClick={handleCreate}
              className="w-full rounded-lg bg-yellow-500 px-3 py-1.5 text-sm font-bold text-gray-900 hover:bg-yellow-400"
            >
              添加到团队
            </button>
          </div>

          <div className="space-y-1">
            {visibleBots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => handleSelect(bot.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  selected?.id === bot.id ? "bg-yellow-500/15 ring-1 ring-yellow-500/50" : "hover:bg-gray-800"
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-700">
                  <BotAvatar bot={bot} size={30} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{bot.name}</span>
                  <span className="block truncate text-xs ui-muted">{bot.tagline || bot.role}</span>
                </span>
                {bot.id === activeBotId && <span className="text-xs text-yellow-300">当前</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {!selected ? (
            <div className="text-sm ui-muted">团队里还没有 Bot，先从左侧添加一个。</div>
          ) : (
            <>
              <section className="rounded-xl border border-gray-700 ui-panel p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl ui-panel-strong">
                      <BotPortrait bot={selected} size={76} />
                    </div>
                    <div>
                      <div className="font-semibold">Bot 资料</div>
                      <div className="mt-1 text-xs ui-muted">形象直接复用桌宠精灵</div>
                      <div className="mt-2 flex gap-2">
                        <select
                          className="input"
                          value={selected.petAvatar || ""}
                          title="Bot 形象"
                          onChange={(event) =>
                            updateBot(selected.id, {
                              petAvatar: (event.target.value || undefined) as PetAvatar | undefined,
                            })
                          }
                        >
                          {PET_AVATAR_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <select
                          className="input"
                          value={selected.petSkin || "yellow"}
                          title="形象配色"
                          onChange={(event) =>
                            updateBot(selected.id, { petSkin: event.target.value as PetSkin })
                          }
                        >
                          {PET_SKIN_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => switchBot(selected.id)}
                      disabled={selected.id === activeBotId}
                      className="rounded-lg bg-yellow-500 px-3 py-1 text-xs font-bold text-gray-900 hover:bg-yellow-400 disabled:bg-gray-700 disabled:text-gray-400"
                    >
                      {selected.id === activeBotId ? "正在使用" : "设为当前"}
                    </button>
                    <button
                      type="button"
                      onClick={() => archiveBot(selected.id)}
                      disabled={visibleBots.length <= 1}
                      className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-red-900/60 disabled:opacity-40"
                    >
                      归档
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs ui-muted">
                    名字
                    <input
                      className="input mt-1"
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  </label>
                  <label className="block text-xs ui-muted">
                    一句话简介
                    <input
                      className="input mt-1"
                      value={draft.tagline}
                      onChange={(event) => setDraft({ ...draft, tagline: event.target.value })}
                    />
                  </label>
                </div>

                <label className="mt-3 block text-xs ui-muted">
                  常驻指令（会注入聊天 system prompt）
                  <textarea
                    className="input mt-1 min-h-[88px] w-full resize-y"
                    value={draft.instructions}
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                    placeholder="这个 Bot 的人设与工作规则"
                  />
                </label>

                <label className="mt-3 block text-xs ui-muted">
                  权限级别
                  <select
                    className="input mt-1"
                    value={draft.approvalLevel}
                    onChange={(event) => setDraft({ ...draft, approvalLevel: event.target.value as ApprovalLevel })}
                  >
                    {(Object.keys(LEVEL_LABEL) as ApprovalLevel[]).map((level) => (
                      <option key={level} value={level}>
                        {LEVEL_LABEL[level]}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs ui-muted">{LEVEL_HINT[draft.approvalLevel]}</span>
                </label>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-xs ui-muted">
                    技能：{selected.skills.length ? selected.skills.join("、") : "未绑定"} · 消息 {botConversations.reduce((sum, t) => sum + t.messages.length, 0)} 条
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      updateBot(selected.id, {
                        name: draft.name.trim() || selected.name,
                        tagline: draft.tagline,
                        instructions: draft.instructions,
                        approvalLevel: draft.approvalLevel,
                        modelOverride: buildModelOverride(),
                      })
                    }
                    className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-gray-600"
                  >
                    保存资料
                  </button>
                </div>
              </section>

              <section className="rounded-xl border border-gray-700 ui-panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-semibold">模型覆盖（按 Bot 换脑）</span>
                  <button
                    type="button"
                    onClick={clearModelOverride}
                    className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-red-900/60"
                  >
                    清空覆盖
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs ui-muted">
                    服务商
                    <select
                      className="input mt-1"
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
                  <label className="block text-xs ui-muted">
                    模型
                    <input
                      className="input mt-1"
                      value={draft.model}
                      onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                      placeholder="留空沿用全局"
                    />
                  </label>
                  <label className="block text-xs ui-muted">
                    Base URL
                    <input
                      className="input mt-1"
                      value={draft.baseUrl}
                      onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                      placeholder="留空沿用全局"
                    />
                  </label>
                  <label className="block text-xs ui-muted">
                    API Key
                    <input
                      className="input mt-1"
                      type="password"
                      value={draft.apiKey}
                      onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                      placeholder="留空沿用全局"
                    />
                  </label>
                </div>
                <p className="mt-3 text-xs leading-relaxed ui-muted">
                  留空的字段自动沿用全局设置，保存资料后生效。当前生效：
                  <span className="text-gray-300">
                    {" "}{effectiveConfig.providerLabel || effectiveConfig.provider} · {effectiveConfig.model} · {effectiveConfig.baseUrl}
                  </span>
                </p>
              </section>

              <section className="rounded-xl border border-gray-700 ui-panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-semibold">独立会话</span>
                  <button
                    type="button"
                    onClick={() => createConversation()}
                    className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-gray-100 hover:bg-gray-600"
                  >
                    新建会话
                  </button>
                </div>
                {botConversations.length === 0 ? (
                  <div className="text-xs ui-muted">当前 Bot 还没有会话。</div>
                ) : (
                  <ul className="space-y-1.5">
                    {botConversations.map((conversation) => (
                      <li key={conversation.id} className="flex items-center justify-between rounded-lg ui-panel-strong px-3 py-2 text-xs">
                        <span className="truncate">{conversation.title}</span>
                        <span className="ml-3 shrink-0 ui-muted">
                          {conversation.messages.length} 条 · {new Date(conversation.updatedAt).toLocaleString("zh-CN")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs leading-relaxed ui-muted">
                  会话、记忆与用户画像已按 Bot 分区：切换 Bot 会载入它自己的数据。默认 Bot 沿用原有数据，未迁移、未丢失。
                </p>
              </section>

              <section className="rounded-xl border border-gray-700 ui-panel p-4">
                <div className="mb-3 font-semibold">审批记录</div>
                {botApprovals.length === 0 ? (
                  <div className="text-xs ui-muted">
                    暂无审批。打开网页、打开应用、系统动作等外部操作会弹出内联审批卡片。
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {botApprovals.slice(0, 8).map((request) => (
                      <li key={request.id} className="flex items-center justify-between rounded-lg ui-panel-strong px-3 py-2 text-xs">
                        <span className="min-w-0 truncate">{request.summary}</span>
                        <span
                          className={`ml-3 shrink-0 ${
                            request.status === "allowed"
                              ? "text-green-400"
                              : request.status === "pending"
                                ? "text-yellow-300"
                                : "text-gray-400"
                          }`}
                        >
                          {STATUS_LABEL[request.status] || request.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
