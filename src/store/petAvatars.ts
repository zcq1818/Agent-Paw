import { useEffect, useState } from "react";
import type { PetAvatar } from "./pet";

/**
 * 桌宠形态清单。
 * - pikachu：原来的 AI 生成 3D 模型（Pikachu3D，无骨骼）
 * - rigged：Blender 生成的带骨骼 + 动作片段的 GLB（RiggedPet3D），
 *   源码见 tools/pets/build_pets.py
 * 私人定制形象放在 public/models/pets/custom/（不进 git），通过同目录的 manifest.json 发现。
 */
export interface AvatarOption {
  value: PetAvatar;
  label: string;
  description: string;
  kind: "pikachu" | "rigged";
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
  { value: "toon_pikachu", label: "3D 皮卡丘", description: "原来的立体模型（无骨骼动作）。", kind: "pikachu" },
];

const CUSTOM_MANIFEST = "/models/pets/custom/manifest.json";

interface ManifestEntry {
  id: string;
  label?: string;
  description?: string;
}

let customCache: AvatarOption[] | null = null;
let customPromise: Promise<AvatarOption[]> | null = null;

export function loadCustomAvatars(): Promise<AvatarOption[]> {
  if (customCache) return Promise.resolve(customCache);
  if (!customPromise) {
    customPromise = fetch(CUSTOM_MANIFEST, { cache: "no-cache" })
      .then((resp) => (resp.ok ? resp.json() : []))
      .then((entries: ManifestEntry[]) =>
        (Array.isArray(entries) ? entries : [])
          .filter((entry) => entry && /^[\w-]+$/.test(entry.id || ""))
          .map<AvatarOption>((entry) => ({
            value: `custom:${entry.id}` as PetAvatar,
            label: entry.label || entry.id,
            description: entry.description || "私人定制形象（只保存在本机）。",
            kind: "rigged",
            model: `/models/pets/custom/${entry.id}.glb`,
            thumb: `/models/pets/custom/thumbs/${entry.id}.png`,
          }))
      )
      .catch(() => [])
      .then((list) => (customCache = list));
  }
  return customPromise;
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
    const id = avatar.slice("custom:".length);
    return (
      customCache?.find((item) => item.value === avatar) || {
        value: avatar,
        label: id,
        description: "",
        kind: "rigged",
        model: `/models/pets/custom/${id}.glb`,
        thumb: `/models/pets/custom/thumbs/${id}.png`,
      }
    );
  }
  return BUILTIN_AVATARS[0];
}
