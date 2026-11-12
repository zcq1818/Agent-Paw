import { useState } from "react";
import { PikachuSprite } from "./PikachuSprite";
import { describeAvatar } from "../store/petAvatars";
import type { BotProfile } from "../store/bots";

/**
 * Bot 头像：用桌宠 3D 形象的头像图（tools/pets/build_pets.py 渲染）。
 * - BotAvatar：通讯录 / 房间消息 / 审批卡片用的小图标
 * - BotPortrait：资料卡的大幅预览
 * 没有头像图的形态（3D 皮卡丘）和“仅 emoji”的 Bot 退回 emoji / 矢量皮卡丘。
 */

const EMOJI_FALLBACK: Record<string, string> = {
  pikachu: "⚡",
  coder: "⌨️",
  research: "🔎",
  ops: "📋",
  review: "🧐",
  writer: "✍️",
  translator: "🌐",
  analyst: "📊",
  product: "🧭",
  tester: "🧪",
  designer: "🎨",
  tutor: "📚",
  life: "🏡",
  custom: "🐾",
};

function Emoji({ bot, size }: { bot: BotProfile; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.7) }}
    >
      {EMOJI_FALLBACK[bot.avatar] || "🐾"}
    </span>
  );
}

function Thumb({ src, alt, size }: { src: string; alt: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(true)}
      className="shrink-0 select-none object-contain"
      style={{ width: size, height: size }}
    />
  );
}

export function BotAvatar({ bot, size = 28 }: { bot: BotProfile; size?: number }) {
  const info = bot.petAvatar ? describeAvatar(bot.petAvatar) : null;
  if (info?.thumb) return <Thumb src={info.thumb} alt={bot.name} size={size} />;
  return <Emoji bot={bot} size={size} />;
}

export function BotPortrait({ bot, size = 96 }: { bot: BotProfile; size?: number }) {
  const info = bot.petAvatar ? describeAvatar(bot.petAvatar) : null;
  if (info?.thumb) return <Thumb src={info.thumb} alt={bot.name} size={size} />;
  if (bot.petAvatar === "toon_pikachu") return <PikachuSprite state="idle" size={size} skin={bot.petSkin} />;
  return <Emoji bot={bot} size={size} />;
}
