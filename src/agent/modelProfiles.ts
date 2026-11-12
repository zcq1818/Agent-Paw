import { create } from "zustand";
import type { AgentConfig } from "./kernel";

/**
 * 多模型配置：可以保存多套“服务商 + Key + 地址 + 模型名”，随时切换当前使用哪一套。
 *
 * 只保存与模型连接有关的字段；记忆、人格、安全等能力开关仍是全局设置（paw_config）。
 * 本模块只 import kernel 的类型，避免与 kernel.ts 形成运行时循环依赖。
 */

export const MODEL_FIELDS = [
  "provider",
  "providerLabel",
  "apiKey",
  "baseUrl",
  "model",
  "stream",
  "enableTools",
  "temperature",
  "maxTokens",
  "embeddingModel",
  "extraHeaders",
  "extraBody",
  "claudeReadOnlyBuiltins",
] as const;

export type ModelSettings = Pick<AgentConfig, (typeof MODEL_FIELDS)[number]>;

export interface ModelProfile extends ModelSettings {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const MODEL_PROFILES_KEY = "paw_model_profiles";
export const ACTIVE_MODEL_PROFILE_KEY = "paw_active_model_profile";

function readProfiles(): ModelProfile[] {
  try {
    const raw = localStorage.getItem(MODEL_PROFILES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.id === "string" && typeof item.baseUrl === "string")
      : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles: ModelProfile[]) {
  localStorage.setItem(MODEL_PROFILES_KEY, JSON.stringify(profiles));
}

function readActiveId(profiles: ModelProfile[]): string {
  const saved = localStorage.getItem(ACTIVE_MODEL_PROFILE_KEY) || "";
  return profiles.some((profile) => profile.id === saved) ? saved : profiles[0]?.id || "";
}

export function pickModelSettings(config: Partial<AgentConfig>): Partial<ModelSettings> {
  const result: Partial<ModelSettings> = {};
  for (const field of MODEL_FIELDS) {
    if (config[field] !== undefined) (result as Record<string, unknown>)[field] = config[field];
  }
  return result;
}

export function listModelProfiles(): ModelProfile[] {
  return readProfiles();
}

export function getActiveModelProfile(): ModelProfile | undefined {
  const profiles = readProfiles();
  const activeId = readActiveId(profiles);
  return profiles.find((profile) => profile.id === activeId);
}

export function defaultProfileName(settings: Partial<ModelSettings>): string {
  const label = settings.providerLabel || settings.provider || "模型";
  return settings.model ? `${label} · ${settings.model}` : label;
}

/** 新增（不带 id）或更新（带 id）一套模型配置。 */
export function upsertModelProfile(
  input: Partial<ModelSettings> & { id?: string; name?: string }
): ModelProfile {
  const profiles = readProfiles();
  const now = new Date().toISOString();
  const existing = input.id ? profiles.find((profile) => profile.id === input.id) : undefined;
  const settings = pickModelSettings(input);
  const name = input.name?.trim() || existing?.name || defaultProfileName(settings);

  let saved: ModelProfile;
  let next: ModelProfile[];
  if (existing) {
    saved = { ...existing, ...settings, name, updatedAt: now };
    next = profiles.map((profile) => (profile.id === existing.id ? saved : profile));
  } else {
    saved = {
      ...(settings as ModelSettings),
      id: `model_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: now,
      updatedAt: now,
    };
    next = [...profiles, saved];
  }
  writeProfiles(next);
  if (!localStorage.getItem(ACTIVE_MODEL_PROFILE_KEY)) localStorage.setItem(ACTIVE_MODEL_PROFILE_KEY, saved.id);
  useModelProfileStore.getState().reload();
  return saved;
}

export function deleteModelProfile(id: string) {
  const next = readProfiles().filter((profile) => profile.id !== id);
  writeProfiles(next);
  if (localStorage.getItem(ACTIVE_MODEL_PROFILE_KEY) === id) {
    if (next[0]) localStorage.setItem(ACTIVE_MODEL_PROFILE_KEY, next[0].id);
    else localStorage.removeItem(ACTIVE_MODEL_PROFILE_KEY);
  }
  useModelProfileStore.getState().reload();
}

export function setActiveModelProfile(id: string) {
  if (!readProfiles().some((profile) => profile.id === id)) return;
  localStorage.setItem(ACTIVE_MODEL_PROFILE_KEY, id);
  useModelProfileStore.getState().reload();
}

interface ModelProfileState {
  profiles: ModelProfile[];
  activeId: string;
  /** 从 localStorage 重新读取（本窗口写入后、或另一个窗口写入后调用）。 */
  reload: () => void;
}

export const useModelProfileStore = create<ModelProfileState>((set) => {
  const profiles = readProfiles();
  return {
    profiles,
    activeId: readActiveId(profiles),
    reload: () => {
      const latest = readProfiles();
      set({ profiles: latest, activeId: readActiveId(latest) });
    },
  };
});
