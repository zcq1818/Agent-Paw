import { useMemo } from "react";

type PetState = "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking";

interface PikachuSpriteProps {
  state: PetState;
  size?: number;
}

/**
 * 像素风皮卡丘 SVG
 * 用纯 SVG 路径绘制，支持不同状态的动画
 */
export function PikachuSprite({ state, size = 120 }: PikachuSpriteProps) {
  const animationClass = useMemo(() => {
    switch (state) {
      case "idle":
        return "animate-float";
      case "walk":
        return "animate-wiggle";
      case "sit":
        return "";
      case "sleep":
        return "opacity-80";
      case "excited":
        return "animate-bounce";
      case "thinking":
        return "animate-pulse";
      default:
        return "";
    }
  }, [state]);

  const eyesClosed = state === "sleep";
  const mouthOpen = state === "excited" || state === "thinking";

  return (
    <div className={`transition-all duration-300 ${animationClass}`} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 120 120"
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* 身体 */}
        <ellipse cx="60" cy="75" rx="32" ry="28" fill="#F7DC6F" />

        {/* 头 */}
        <circle cx="60" cy="48" r="28" fill="#F7DC6F" />

        {/* 左耳 */}
        <polygon points="35,30 25,5 42,22" fill="#F7DC6F" />
        <polygon points="37,28 30,10 42,22" fill="#2C3E50" />

        {/* 右耳 */}
        <polygon points="85,30 95,5 78,22" fill="#F7DC6F" />
        <polygon points="83,28 90,10 78,22" fill="#2C3E50" />

        {/* 脸颊（红） */}
        <circle cx="38" cy="55" r="7" fill="#E74C3C" opacity="0.8" />
        <circle cx="82" cy="55" r="7" fill="#E74C3C" opacity="0.8" />

        {/* 眼睛 */}
        {eyesClosed ? (
          <>
            <line x1="48" y1="44" x2="56" y2="44" stroke="#2C3E50" strokeWidth="2" strokeLinecap="round" />
            <line x1="64" y1="44" x2="72" y2="44" stroke="#2C3E50" strokeWidth="2" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx="50" cy="43" r="4" fill="#2C3E50" />
            <circle cx="70" cy="43" r="4" fill="#2C3E50" />
            {/* 眼睛高光 */}
            <circle cx="51.5" cy="41.5" r="1.5" fill="white" />
            <circle cx="71.5" cy="41.5" r="1.5" fill="white" />
          </>
        )}

        {/* 鼻子 */}
        <ellipse cx="60" cy="49" rx="2" ry="1.5" fill="#2C3E50" />

        {/* 嘴巴 */}
        {mouthOpen ? (
          <path d="M 54 54 Q 60 60 66 54" fill="none" stroke="#2C3E50" strokeWidth="1.5" strokeLinecap="round" />
        ) : (
          <path d="M 55 54 Q 60 57 65 54" fill="none" stroke="#2C3E50" strokeWidth="1.5" strokeLinecap="round" />
        )}

        {/* 尾巴（闪电形状） */}
        <polygon points="88,65 105,50 95,65 110,55 97,72 90,70" fill="#F1C40F" />
        <polygon points="90,68 100,58 95,67 105,57 97,70" fill="#F7DC6F" />

        {/* 手 */}
        <ellipse cx="32" cy="72" rx="6" ry="4" fill="#F7DC6F" transform="rotate(-20 32 72)" />
        <ellipse cx="88" cy="72" rx="6" ry="4" fill="#F7DC6F" transform="rotate(20 88 72)" />

        {/* 脚 */}
        <ellipse cx="48" cy="98" rx="8" ry="5" fill="#F7DC6F" />
        <ellipse cx="72" cy="98" rx="8" ry="5" fill="#F7DC6F" />

        {/* 背部条纹 */}
        <line x1="50" y1="68" x2="50" y2="78" stroke="#D4AC0D" strokeWidth="2" strokeLinecap="round" />
        <line x1="60" y1="66" x2="60" y2="80" stroke="#D4AC0D" strokeWidth="2" strokeLinecap="round" />
        <line x1="70" y1="68" x2="70" y2="78" stroke="#D4AC0D" strokeWidth="2" strokeLinecap="round" />

        {/* 闪电特效 (excited 状态) */}
        {state === "excited" && (
          <>
            <polygon points="15,35 20,25 18,35 25,28" fill="#F39C12" opacity="0.8">
              <animate attributeName="opacity" values="0.8;0.3;0.8" dur="0.5s" repeatCount="indefinite" />
            </polygon>
            <polygon points="95,25 100,15 98,25 105,18" fill="#F39C12" opacity="0.8">
              <animate attributeName="opacity" values="0.3;0.8;0.3" dur="0.5s" repeatCount="indefinite" />
            </polygon>
          </>
        )}
      </svg>
    </div>
  );
}
