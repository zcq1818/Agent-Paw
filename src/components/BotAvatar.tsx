import { PixelPetSprite } from "./PixelPetSprite";
import { PikachuSprite } from "./PikachuSprite";
import type { BotProfile } from "../store/bots";

/**
 * Bot 头像：直接复用桌宠的真实形象，而不是另画一套 emoji。
 * - BotAvatar：通讯录 / 房间消息 / 审批卡片用的小图标
 * - BotPortrait：资料卡的大幅人物预览（复活此前零引用的 PikachuSprite）
 */

const EMOJI_FALLBACK: Record<string, string> = {
  pikachu: "⚡",
  coder: "⌨️",
  research: "🔎",
  ops: "📋",
  review: "🧐",
  custom: "🐾",
};

export function BotAvatar({ bot, size = 28 }: { bot: BotProfile; size?: number }) {
  if (bot.petAvatar) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center overflow-hidden"
        style={{ width: size, height: size }}
      >
        <PixelPetSprite avatar={bot.petAvatar} state="idle" size={size} skin={bot.petSkin} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.7) }}
    >
      {EMOJI_FALLBACK[bot.avatar] || "🐾"}
    </span>
  );
}

export function BotPortrait({ bot, size = 96 }: { bot: BotProfile; size?: number }) {
  if (bot.petAvatar === "pixel_cat" || bot.petAvatar === "pixel_dog") {
    return <PixelPetSprite avatar={bot.petAvatar} state="idle" size={size} skin={bot.petSkin} />;
  }
  return <PikachuSprite state="idle" size={size} skin={bot.petSkin} />;
}
