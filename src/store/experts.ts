import { create } from "zustand";

/** 大总管可委派的专家模型。API Key 按专家独立存放，不复用主模型配置。 */
export interface Expert {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  /** 本机 CLI 的可执行文件路径（仅 claude-local 使用，留空由 Rust 侧自动探测）。 */
  command?: string;
  /** 本机 CLI 放行的工具白名单，默认只读 Read。 */
  allowedTools?: string;
}

const STORAGE_KEY = "paw_experts_v1";

export const DEFAULT_EXPERTS: Expert[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    role: "推理、代码与方案",
    provider: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    enabled: false,
  },
  {
    id: "claude",
    name: "Claude",
    role: "写作、复核与挑错",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "",
    enabled: false,
  },
  {
    id: "local",
    name: "本地模型",
    role: "离线兜底（Ollama / LM Studio）",
    provider: "custom",
    model: "qwen2.5:7b",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    enabled: false,
  },
  {
    id: "claude-local",
    name: "Claude 本机",
    role: "本机 Claude Code CLI（复用登录态，免 API Key）",
    provider: "claude-local",
    model: "",
    baseUrl: "",
    apiKey: "",
    command: "",
    allowedTools: "Read",
    enabled: false,
  },
  {
    id: "codebuddy-local",
    name: "CodeBuddy 本机",
    role: "本机 CodeBuddy Code（复用登录态，免 API Key）",
    provider: "codebuddy-local",
    model: "",
    baseUrl: "",
    apiKey: "",
    enabled: false,
  },
];

function cloneDefaults(): Expert[] {
  return DEFAULT_EXPERTS.map((expert) => ({ ...expert }));
}

function loadExperts(): Expert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const parsed = JSON.parse(raw) as Expert[];
    if (!Array.isArray(parsed)) return cloneDefaults();
    // 以默认表为准合并，保证以后新增专家能自动出现，同时保留用户已填的配置。
    return cloneDefaults().map((fallback) => {
      const saved = parsed.find((item) => item && item.id === fallback.id);
      return saved ? { ...fallback, ...saved } : fallback;
    });
  } catch {
    return cloneDefaults();
  }
}

function persist(experts: Expert[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(experts));
  } catch {
    // 隐私模式下 localStorage 可能不可写。
  }
}

export interface ExpertState {
  experts: Expert[];
  updateExpert: (id: string, patch: Partial<Omit<Expert, "id">>) => void;
  toggleExpert: (id: string) => void;
  resetExperts: () => void;
  hydrate: () => void;
}

export const useExpertStore = create<ExpertState>((set, get) => {
  const commit = (experts: Expert[]) => {
    set({ experts });
    persist(experts);
  };
  return {
    experts: loadExperts(),
    updateExpert: (id, patch) =>
      commit(get().experts.map((expert) => (expert.id === id ? { ...expert, ...patch, id: expert.id } : expert))),
    toggleExpert: (id) =>
      commit(get().experts.map((expert) => (expert.id === id ? { ...expert, enabled: !expert.enabled } : expert))),
    resetExperts: () => commit(cloneDefaults()),
    hydrate: () => set({ experts: loadExperts() }),
  };
});

/** 真正能被调用的专家：已启用，且要么有 Key，要么是本地无鉴权端点。 */
export function getAvailableExperts(experts: Expert[]): Expert[] {
  return experts.filter(
    (expert) =>
      expert.enabled &&
      (expert.apiKey.trim() ||
        expert.provider === "custom" ||
        expert.provider === "claude-local" ||
        expert.provider === "codebuddy-local")
  );
}
