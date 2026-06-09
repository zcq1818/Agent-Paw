import { usePetStore, SKIN_COLORS, type PetSkin } from "../store/pet";

type PetState = "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking" | "morning" | "night";

interface PikachuSpriteProps {
  state: PetState;
  size?: number;
  skin?: PetSkin;
  facing?: "left" | "right";
}

export function PikachuSprite({ state, size = 120, skin, facing = "right" }: PikachuSpriteProps) {
  const storeSkin = usePetStore((s) => s.skin);
  const actualSkin = skin || storeSkin;
  const colors = SKIN_COLORS[actualSkin];
  const eyesClosed = state === "sleep" || state === "night";
  const mouthOpen = state === "excited" || state === "thinking" || state === "morning";
  const isNight = state === "night";

  return (
    <div className="pet-facing" style={{ width: size, height: size, transform: facing === "left" ? "scaleX(-1)" : undefined }}>
      <div className={`pet-sprite pet-sprite--${state}`} style={{ width: size, height: size }}>
        <svg viewBox="0 0 120 120" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          <ellipse className="pet-shadow" cx="60" cy="108" rx="28" ry="7" fill="rgba(0,0,0,0.18)" />

          {isNight && (
            <g className="pet-stars">
              <circle cx="95" cy="15" r="10" fill="#F9E79F" opacity="0.9" />
              <circle cx="92" cy="13" r="8" fill="#1a1a2e" />
              <polygon points="15,20 16,23 19,23 17,25 18,28 15,26 12,28 13,25 11,23 14,23" fill="#F9E79F" opacity="0.8" />
              <polygon points="25,10 26,12 28,12 26.5,13.5 27,15.5 25,14.5 23,15.5 23.5,13.5 22,12 24,12" fill="#F9E79F" opacity="0.6" />
            </g>
          )}

          <g className="pet-body">
            <g className="pet-tail">
              <polygon points="88,65 105,50 95,65 110,55 97,72 90,70" fill={colors.dark} />
              <polygon points="90,68 100,58 95,67 105,57 97,70" fill={colors.body} />
            </g>

            <ellipse cx="60" cy="75" rx="32" ry="28" fill={colors.body} />
            <circle className="pet-head" cx="60" cy="48" r="28" fill={colors.body} />

            <g className="pet-ear pet-ear-left">
              <polygon points="35,30 25,5 42,22" fill={colors.body} />
              <polygon points="37,28 30,10 42,22" fill="#2C3E50" />
            </g>
            <g className="pet-ear pet-ear-right">
              <polygon points="85,30 95,5 78,22" fill={colors.body} />
              <polygon points="83,28 90,10 78,22" fill="#2C3E50" />
            </g>

            <g className="pet-face">
              <circle className="pet-cheek pet-cheek-left" cx="38" cy="55" r="7" fill={colors.cheek} opacity="0.82" />
              <circle className="pet-cheek pet-cheek-right" cx="82" cy="55" r="7" fill={colors.cheek} opacity="0.82" />

              {eyesClosed ? (
                <g className="pet-eyes-closed">
                  <line x1="48" y1="44" x2="56" y2="44" stroke="#2C3E50" strokeWidth="2" strokeLinecap="round" />
                  <line x1="64" y1="44" x2="72" y2="44" stroke="#2C3E50" strokeWidth="2" strokeLinecap="round" />
                </g>
              ) : (
                <g className="pet-eyes">
                  <circle cx="50" cy="43" r="4" fill="#2C3E50" />
                  <circle cx="70" cy="43" r="4" fill="#2C3E50" />
                  <circle className="pet-eye-shine" cx="51.5" cy="41.5" r="1.5" fill="white" />
                  <circle className="pet-eye-shine" cx="71.5" cy="41.5" r="1.5" fill="white" />
                </g>
              )}

              <ellipse cx="60" cy="49" rx="2" ry="1.5" fill="#2C3E50" />

              {mouthOpen ? (
                state === "morning" ? (
                  <ellipse className="pet-mouth" cx="60" cy="56" rx="6" ry="4" fill="#2C3E50" />
                ) : (
                  <path className="pet-mouth" d="M 54 54 Q 60 60 66 54" fill="none" stroke="#2C3E50" strokeWidth="1.5" strokeLinecap="round" />
                )
              ) : (
                <path className="pet-mouth" d="M 55 54 Q 60 57 65 54" fill="none" stroke="#2C3E50" strokeWidth="1.5" strokeLinecap="round" />
              )}
            </g>

            <g className="pet-arm pet-arm-left">
              <ellipse cx="32" cy="72" rx="6" ry="4" fill={colors.body} transform="rotate(-20 32 72)" />
            </g>
            <g className="pet-arm pet-arm-right">
              <ellipse cx="88" cy="72" rx="6" ry="4" fill={colors.body} transform="rotate(20 88 72)" />
            </g>

            <g className="pet-foot pet-foot-left">
              <ellipse cx="48" cy="98" rx="8" ry="5" fill={colors.body} />
            </g>
            <g className="pet-foot pet-foot-right">
              <ellipse cx="72" cy="98" rx="8" ry="5" fill={colors.body} />
            </g>

            <g className="pet-stripes">
              <line x1="50" y1="68" x2="50" y2="78" stroke="#D4AC0D" strokeWidth="2" strokeLinecap="round" />
              <line x1="60" y1="66" x2="60" y2="80" stroke="#D4AC0D" strokeWidth="2" strokeLinecap="round" />
              <line x1="70" y1="68" x2="70" y2="78" stroke="#D4AC0D" strokeWidth="2" strokeLinecap="round" />
            </g>
          </g>

          {state === "excited" && (
            <g className="pet-sparks">
              <polygon points="15,35 20,25 18,35 25,28" fill="#F39C12" opacity="0.85" />
              <polygon points="95,25 100,15 98,25 105,18" fill="#F39C12" opacity="0.85" />
              <polygon points="24,68 29,58 27,68 35,61" fill="#F7DC6F" opacity="0.7" />
            </g>
          )}

          {state === "morning" && (
            <g className="pet-morning-rays">
              <line x1="20" y1="50" x2="10" y2="45" stroke="#F39C12" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
              <line x1="20" y1="55" x2="8" y2="55" stroke="#F39C12" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
              <line x1="100" y1="47" x2="112" y2="42" stroke="#F39C12" strokeWidth="2" strokeLinecap="round" opacity="0.45" />
            </g>
          )}

          {state === "thinking" && (
            <g className="pet-thought-dots" fill="#FFFFFF" stroke="#D1D5DB" strokeWidth="0.7">
              <circle cx="88" cy="20" r="2.2" />
              <circle cx="96" cy="15" r="3" />
              <circle cx="106" cy="11" r="3.8" />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
