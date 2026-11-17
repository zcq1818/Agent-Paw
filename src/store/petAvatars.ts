import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PetAvatar } from "./pet";

/**
 * 桌宠形态清单。
 * - rigged：Blender 生成的带骨骼 + 动作片段的 GLB（RiggedPet3D），
 *   源码见 tools/pets/build_pets.py
 * 私人定制形象放在数据文件夹的 pets 里（发布版是安装目录下的 data\pets），不进 git，也不打进安装包：
 *   manifest.json + xxx.glb + thumbs/xxx.png，由后端读出来转成 blob 地址。
 * 开发时数据文件夹里没有的话，再看 public/models/pets/custom/（只有 vite 开发服务器能访问，打包时会被删掉）。
 */
export interface AvatarOption {
  value: PetAvatar;
  label: string;
  description: string;
  kind: "rigged";
  model?: string;
  /** 头像图（Blender 渲染的待机半身照），用于 Bot 头像。 */
  thumb?: string;
}

export const BUILTIN_AVATARS: AvatarOption[] = [
  { value: "fox", label: "橘子 · 小狐狸", description: "橙色大尾巴，最活泼。", kind: "rigged", model: "/models/pets/fox.glb", thumb: "/models/pets/thumbs/fox.png" },
  { value: "cat", label: "团子 · 小猫", description: "圆滚滚的奶灰猫，安静黏人。", kind: "rigged", model: "/models/pets/cat.glb", thumb: "/models/pets/thumbs/cat.png" },
  { value: "dino", label: "豆芽 · 小恐龙", description: "头顶两片小叶子，憨憨的。", kind: "rigged", model: "/models/pets/dino.glb", thumb: "/models/pets/thumbs/dino.png" },
  { value: "robot", label: "小柚 · 机器人", description: "发光眼睛，天线会晃。", kind: "rigged", model: "/models/pets/robot.glb", thumb: "/models/pets/thumbs/robot.png" },
  { value: "penguin", label: "布丁 · 小企鹅", description: "摇摇摆摆，挥着小鳍。", kind: "rigged", model: "/models/pets/penguin.glb", thumb: "/models/pets/thumbs/penguin.png" },
];

const CUSTOM_MANIFEST = "/models/pets/custom/manifest.json";

interface ManifestEntry {
  id: string;
  label?: string;
  description?: string;
}

let customCache: AvatarOption[] | null = null;
let customPromise: Promise<AvatarOption[]> | null = null;

function toOption(entry: ManifestEntry, model: string, thumb?: string): AvatarOption {
  return {
    value: `custom:${entry.id}` as PetAvatar,
    label: entry.label || entry.id,
    description: entry.description || "私人定制形象（只保存在本机）。",
    kind: "rigged",
    model,
    thumb,
  };
}

async function fileUrl(id: string, thumb: boolean): Promise<string> {
  const data = await invoke<ArrayBuffer>("custom_pet_file", { id, thumb });
  return URL.createObjectURL(new Blob([data], { type: thumb ? "image/png" : "model/gltf-binary" }));
}

/** 数据文件夹 pets 里的形象 */
async function loadFromDataDir(): Promise<AvatarOption[]> {
  const entries = await invoke<ManifestEntry[]>("custom_pets_list").catch(() => []);
  const options = await Promise.all(
    entries.map(async (entry) => {
      try {
        const model = await fileUrl(entry.id, false);
        const thumb = await fileUrl(entry.id, true).catch(() => undefined);
        return toOption(entry, model, thumb);
      } catch {
        return null;
      }
    })
  );
  return options.filter((option): option is AvatarOption => Boolean(option));
}

/** 开发服务器上 public/models/pets/custom 里的形象 */
async function loadFromDevServer(): Promise<AvatarOption[]> {
  try {
    const resp = await fetch(CUSTOM_MANIFEST, { cache: "no-cache" });
    if (!resp.ok || !(resp.headers.get("content-type") || "").includes("json")) return [];
    const entries: ManifestEntry[] = await resp.json();
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && /^[\w-]+$/.test(entry.id || ""))
      .map((entry) => toOption(entry, `/models/pets/custom/${entry.id}.glb`, `/models/pets/custom/thumbs/${entry.id}.png`));
  } catch {
    return [];
  }
}

export function loadCustomAvatars(): Promise<AvatarOption[]> {
  if (customCache) return Promise.resolve(customCache);
  if (!customPromise) {
    customPromise = loadFromDataDir()
      .then(async (list) => (list.length ? list : loadFromDevServer()))
      .catch(() => [])
      .then((list) => {
        customCache = list;
        notifyLoaded();
        return list;
      });
  }
  return customPromise;
}

const loadedListeners = new Set<() => void>();
function notifyLoaded() {
  loadedListeners.forEach((listener) => listener());
}

/** 用了私人定制形象时，等清单读出来后刷新一次（读出来之前先显示内置形象）。 */
export function useCustomAvatarsLoaded(): boolean {
  const [loaded, setLoaded] = useState(Boolean(customCache));
  useEffect(() => {
    if (customCache) return;
    const listener = () => setLoaded(true);
    loadedListeners.add(listener);
    void loadCustomAvatars();
    return () => {
      loadedListeners.delete(listener);
    };
  }, []);
  return loaded;
}

/** 内置形态 + 本机私人定制形态。 */
export function useAvatarOptions(): AvatarOption[] {
  const [custom, setCustom] = useState<AvatarOption[]>(customCache || []);
  useEffect(() => {
    let alive = true;
    loadCustomAvatars().then((list) => alive && setCustom(list));
    return () => {
      alive = false;
    };
  }, []);
  return [...custom, ...BUILTIN_AVATARS];
}

export function describeAvatar(avatar: PetAvatar): AvatarOption {
  const builtin = BUILTIN_AVATARS.find((item) => item.value === avatar);
  if (builtin) return builtin;
  if (avatar.startsWith("custom:")) {
    const found = customCache?.find((item) => item.value === avatar);
    if (found) return found;
    // 清单还没读出来，或者这个形象的文件不在了：先用默认形象
    void loadCustomAvatars();
  }
  return BUILTIN_AVATARS[0];
}
