import { create } from "zustand";

export type Emotion = "idle" | "thinking" | "excited" | "sleepy" | "happy";
export type PetSkin = "yellow" | "blue" | "pink" | "green";
/** 形态清单与说明见 store/petAvatars.ts；custom:xxx 是本机私人定制的模型。 */
export type PetAvatar =
  | "fox"
  | "cat"
  | "dino"
  | "robot"
  | "penguin"
  | "toon_pikachu"
  | `custom:${string}`;

/** 像素形态已移除：旧配置里的像素形态换成对应的 3D 形态。 */
const LEGACY_AVATARS: Record<string, PetAvatar> = {
  pixel_pikachu: "fox",
  pixel_cat: "cat",
  pixel_dog: "fox",
};

export function migrateAvatar(value: unknown): PetAvatar | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return LEGACY_AVATARS[value] || (value as PetAvatar);
}
export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";
export type InteractionFrequency = "rare" | "normal" | "frequent";
export type RoamScope = "full" | "nearby" | "corner";

/** 桌宠生命值：Pet.tsx 的 LifeBar 按 0-100 渲染。 */
export interface LifeStats {
  energy: number;
  affection: number;
  curiosity: number;
}

interface PetConfig {
  name: string;
  skin: PetSkin;
  avatar: PetAvatar;
  autoAction: boolean;
  enableInteractions: boolean;
  interactionFrequency: InteractionFrequency;
  size: number;
  opacity: number;
  roamScope: RoamScope;
  avoidCursor: boolean;
  autonomousNews: boolean;
  autonomousLearning: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}

interface PetState extends PetConfig {
  emotion: Emotion;
  timeOfDay: TimeOfDay;
  life: LifeStats;
  setEmotion: (emotion: Emotion) => void;
  adjustLife: (delta: Partial<LifeStats>) => void;
  tickLife: () => void;
  setName: (name: string) => void;
  setSkin: (skin: PetSkin) => void;
  setAvatar: (avatar: PetAvatar) => void;
  setAutoAction: (value: boolean) => void;
  setEnableInteractions: (value: boolean) => void;
  setInteractionFrequency: (value: InteractionFrequency) => void;
  setSize: (value: number) => void;
  setOpacity: (value: number) => void;
  setRoamScope: (value: RoamScope) => void;
  setAvoidCursor: (value: boolean) => void;
  setAutonomousNews: (value: boolean) => void;
  setAutonomousLearning: (value: boolean) => void;
  setQuietHoursEnabled: (value: boolean) => void;
  setQuietStart: (value: string) => void;
  setQuietEnd: (value: string) => void;
  refreshTimeOfDay: () => void;
  /** 设置页在工作台窗口保存后，宠物窗口据此重新载入配置。 */
  syncFromStorage: () => void;
}

const DEFAULT_LIFE: LifeStats = { energy: 80, affection: 60, curiosity: 55 };

function clampLife(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export const SKIN_COLORS: Record<PetSkin, { body: string; dark: string; cheek: string }> = {
  yellow: { body: "#F7DC6F", dark: "#F1C40F", cheek: "#E74C3C" },
  blue: { body: "#85C1E9", dark: "#5DADE2", cheek: "#F1948A" },
  pink: { body: "#F5B7B1", dark: "#F1948A", cheek: "#E74C3C" },
  green: { body: "#A9DFBF", dark: "#7DCEA0", cheek: "#FAD7A0" },
};

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

export const PET_CONFIG_KEY = "paw_pet_config";

function loadPetConfig(): Partial<PetConfig> {
  try {
    const saved = localStorage.getItem(PET_CONFIG_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
}

function savePetConfig(config: PetConfig) {
  localStorage.setItem(PET_CONFIG_KEY, JSON.stringify(config));
}

function persist(get: () => PetState, updates: Partial<PetConfig> = {}) {
  const state = get();
  savePetConfig({
    name: state.name,
    skin: state.skin,
    avatar: state.avatar,
    autoAction: state.autoAction,
    enableInteractions: state.enableInteractions,
    interactionFrequency: state.interactionFrequency,
    size: state.size,
    opacity: state.opacity,
    roamScope: state.roamScope,
    avoidCursor: state.avoidCursor,
    autonomousNews: state.autonomousNews,
    autonomousLearning: state.autonomousLearning,
    quietHoursEnabled: state.quietHoursEnabled,
    quietStart: state.quietStart,
    quietEnd: state.quietEnd,
    ...updates,
  });
}

const defaultConfig = loadPetConfig();

export const usePetStore = create<PetState>((set, get) => ({
  emotion: "idle",
  name: defaultConfig.name || "皮卡丘",
  skin: defaultConfig.skin || "yellow",
  avatar: migrateAvatar(defaultConfig.avatar) || "fox",
  autoAction: defaultConfig.autoAction ?? true,
  enableInteractions: defaultConfig.enableInteractions ?? true,
  interactionFrequency: defaultConfig.interactionFrequency || "normal",
  size: defaultConfig.size || 128,
  opacity: defaultConfig.opacity ?? 1,
  roamScope: defaultConfig.roamScope || "full",
  avoidCursor: defaultConfig.avoidCursor ?? true,
  autonomousNews: defaultConfig.autonomousNews ?? true,
  autonomousLearning: defaultConfig.autonomousLearning ?? true,
  quietHoursEnabled: defaultConfig.quietHoursEnabled ?? false,
  quietStart: defaultConfig.quietStart || "23:00",
  quietEnd: defaultConfig.quietEnd || "08:00",
  timeOfDay: getTimeOfDay(),
  life: { ...DEFAULT_LIFE },
  setEmotion: (emotion) => set({ emotion }),
  adjustLife: (delta) =>
    set((state) => ({
      life: {
        energy: clampLife(state.life.energy + (delta.energy ?? 0)),
        affection: clampLife(state.life.affection + (delta.affection ?? 0)),
        curiosity: clampLife(state.life.curiosity + (delta.curiosity ?? 0)),
      },
    })),
  tickLife: () =>
    set((state) => ({
      life: {
        energy: clampLife(state.life.energy + 1.5),
        affection: clampLife(state.life.affection - 0.2),
        curiosity: clampLife(state.life.curiosity + 0.8),
      },
    })),
  setName: (name) => {
    set({ name });
    persist(get, { name });
  },
  setSkin: (skin) => {
    set({ skin });
    persist(get, { skin });
  },
  setAvatar: (avatar) => {
    set({ avatar });
    persist(get, { avatar });
  },
  setAutoAction: (autoAction) => {
    set({ autoAction });
    persist(get, { autoAction });
  },
  setEnableInteractions: (enableInteractions) => {
    set({ enableInteractions });
    persist(get, { enableInteractions });
  },
  setInteractionFrequency: (interactionFrequency) => {
    set({ interactionFrequency });
    persist(get, { interactionFrequency });
  },
  setSize: (size) => {
    const nextSize = Math.max(96, Math.min(180, Math.round(size)));
    set({ size: nextSize });
    persist(get, { size: nextSize });
  },
  setOpacity: (opacity) => {
    const nextOpacity = Math.max(0.45, Math.min(1, opacity));
    set({ opacity: nextOpacity });
    persist(get, { opacity: nextOpacity });
  },
  setRoamScope: (roamScope) => {
    set({ roamScope });
    persist(get, { roamScope });
  },
  setAvoidCursor: (avoidCursor) => {
    set({ avoidCursor });
    persist(get, { avoidCursor });
  },
  setAutonomousNews: (autonomousNews) => {
    set({ autonomousNews });
    persist(get, { autonomousNews });
  },
  setAutonomousLearning: (autonomousLearning) => {
    set({ autonomousLearning });
    persist(get, { autonomousLearning });
  },
  setQuietHoursEnabled: (quietHoursEnabled) => {
    set({ quietHoursEnabled });
    persist(get, { quietHoursEnabled });
  },
  setQuietStart: (quietStart) => {
    set({ quietStart });
    persist(get, { quietStart });
  },
  setQuietEnd: (quietEnd) => {
    set({ quietEnd });
    persist(get, { quietEnd });
  },
  refreshTimeOfDay: () => set({ timeOfDay: getTimeOfDay() }),
  syncFromStorage: () => {
    const config = loadPetConfig();
    const state = get();
    set({
      name: config.name || state.name,
      skin: config.skin || state.skin,
      avatar: migrateAvatar(config.avatar) || state.avatar,
      autoAction: config.autoAction ?? state.autoAction,
      enableInteractions: config.enableInteractions ?? state.enableInteractions,
      interactionFrequency: config.interactionFrequency || state.interactionFrequency,
      size: config.size || state.size,
      opacity: config.opacity ?? state.opacity,
      roamScope: config.roamScope || state.roamScope,
      avoidCursor: config.avoidCursor ?? state.avoidCursor,
      autonomousNews: config.autonomousNews ?? state.autonomousNews,
      autonomousLearning: config.autonomousLearning ?? state.autonomousLearning,
      quietHoursEnabled: config.quietHoursEnabled ?? state.quietHoursEnabled,
      quietStart: config.quietStart || state.quietStart,
      quietEnd: config.quietEnd || state.quietEnd,
    });
  },
}));
