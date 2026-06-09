import { SKIN_COLORS, usePetStore, type PetAvatar } from "../store/pet";

type PetState = "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking" | "morning" | "night" | "dance" | "stretch" | "look" | "wave";

interface PixelPetSpriteProps {
  avatar: PetAvatar;
  state: PetState;
  size?: number;
  facing?: "left" | "right";
}

type RectSpec = [number, number, number, number, string];

const PALETTES = {
  cat: {
    body: "#f2c38f",
    shade: "#d9965f",
    dark: "#3a2b23",
    cheek: "#f47f88",
    light: "#fff1d5",
  },
  dog: {
    body: "#c9884a",
    shade: "#8b572d",
    dark: "#2d221b",
    cheek: "#ef8a72",
    light: "#ffe2b8",
  },
};

function block([x, y, w, h, color]: RectSpec, index: number) {
  return <rect key={`${x}-${y}-${index}`} x={x} y={y} width={w} height={h} fill={color} />;
}

function commonFace(dark: string, cheek: string, state: PetState): RectSpec[] {
  if (state === "sleep" || state === "night") {
    return [
      [10, 14, 3, 1, dark],
      [20, 14, 3, 1, dark],
      [16, 16, 1, 1, dark],
      [15, 18, 3, 1, dark],
      [7, 17, 3, 2, cheek],
      [23, 17, 3, 2, cheek],
    ];
  }

  return [
    [10, 13, 3, 3, dark],
    [20, 13, 3, 3, dark],
    [11, 13, 1, 1, "#ffffff"],
    [21, 13, 1, 1, "#ffffff"],
    [16, 16, 1, 1, dark],
    [15, state === "excited" ? 19 : 18, 3, 1, dark],
    [7, 17, 3, 2, cheek],
    [23, 17, 3, 2, cheek],
  ];
}

function pikachuRects(state: PetState): RectSpec[] {
  const skin = usePetStore.getState().skin;
  const colors = SKIN_COLORS[skin];
  const body = colors.body;
  const shade = colors.dark;
  const dark = "#2a241c";
  const cheek = colors.cheek;
  const sitOffset = state === "sit" || state === "sleep" || state === "night" ? 2 : 0;

  return [
    [6, 4, 3, 8, body],
    [5, 3, 2, 4, dark],
    [23, 4, 3, 8, body],
    [25, 3, 2, 4, dark],
    [9, 8, 14, 13, body],
    [8, 10, 16, 8, body],
    [10, 20 + sitOffset, 12, 8 - sitOffset, body],
    [8, 22 + sitOffset, 4, 4, body],
    [20, 22 + sitOffset, 4, 4, body],
    [5, 15, 4, 4, shade],
    [23, 15, 4, 4, shade],
    [22, 20, 3, 2, shade],
    [6, 23, 6, 3, dark],
    [20, 23, 6, 3, dark],
    [4, 18, 4, 4, body],
    [24, 18, 4, 4, body],
    [25, 14, 2, 2, dark],
    [27, 12, 3, 2, shade],
    [29, 10, 2, 2, shade],
    ...commonFace(dark, cheek, state),
  ];
}

function catRects(state: PetState): RectSpec[] {
  const { body, shade, dark, cheek, light } = PALETTES.cat;
  const sitOffset = state === "sit" || state === "sleep" || state === "night" ? 2 : 0;

  return [
    [8, 5, 5, 6, body],
    [9, 5, 2, 3, dark],
    [20, 5, 5, 6, body],
    [22, 5, 2, 3, dark],
    [8, 9, 17, 13, body],
    [10, 20 + sitOffset, 12, 8 - sitOffset, body],
    [13, 21 + sitOffset, 6, 5 - sitOffset, light],
    [6, 23, 6, 3, shade],
    [20, 23, 6, 3, shade],
    [4, 15, 5, 3, shade],
    [24, 15, 5, 3, shade],
    [25, 20, 4, 2, shade],
    [28, 18, 2, 2, shade],
    [31, 16, 1, 3, shade],
    [6, 18, 4, 1, dark],
    [23, 18, 4, 1, dark],
    ...commonFace(dark, cheek, state),
  ];
}

function dogRects(state: PetState): RectSpec[] {
  const { body, shade, dark, cheek, light } = PALETTES.dog;
  const sitOffset = state === "sit" || state === "sleep" || state === "night" ? 2 : 0;

  return [
    [6, 8, 5, 9, shade],
    [22, 8, 5, 9, shade],
    [8, 8, 17, 13, body],
    [10, 20 + sitOffset, 12, 8 - sitOffset, body],
    [12, 21 + sitOffset, 8, 5 - sitOffset, light],
    [7, 23, 5, 3, shade],
    [20, 23, 5, 3, shade],
    [5, 17, 5, 3, body],
    [23, 17, 5, 3, body],
    [24, 20, 5, 2, shade],
    [28, 18, 2, 2, shade],
    [13, 16, 7, 4, light],
    [15, 16, 3, 2, dark],
    ...commonFace(dark, cheek, state),
  ];
}

function getRects(avatar: PetAvatar, state: PetState): RectSpec[] {
  if (avatar === "pixel_cat") return catRects(state);
  if (avatar === "pixel_dog") return dogRects(state);
  return pikachuRects(state);
}

export function PixelPetSprite({ avatar, state, size = 128, facing = "right" }: PixelPetSpriteProps) {
  const rects = getRects(avatar, state);
  const sleeping = state === "sleep" || state === "night";
  const thinking = state === "thinking";
  const excited = state === "excited" || state === "morning" || state === "dance" || state === "wave";

  return (
    <div
      className={`pixel-pet pixel-pet--${state}`}
      style={{
        width: size,
        height: size,
        transform: facing === "left" ? "scaleX(-1)" : undefined,
      }}
    >
      <svg viewBox="0 0 32 32" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
        <rect x="7" y="27" width="18" height="2" fill="rgba(0,0,0,0.18)" />
        {rects.map(block)}
        {excited && (
          <g className="pixel-pet-sparks">
            <rect x="3" y="8" width="1" height="4" fill="#ffd84d" />
            <rect x="2" y="10" width="3" height="1" fill="#ffd84d" />
            <rect x="28" y="6" width="1" height="4" fill="#ffd84d" />
            <rect x="27" y="8" width="3" height="1" fill="#ffd84d" />
          </g>
        )}
        {(state === "wave" || state === "look") && (
          <g fill="#fff3a6">
            <rect x="2" y="11" width="3" height="1" />
            <rect x="1" y="13" width="2" height="1" />
          </g>
        )}
        {thinking && (
          <g className="pixel-pet-dots" fill="#ffffff">
            <rect x="23" y="4" width="2" height="2" />
            <rect x="27" y="2" width="3" height="3" />
          </g>
        )}
        {sleeping && (
          <g className="pixel-pet-z" fill="#ffffff">
            <rect x="24" y="4" width="5" height="1" />
            <rect x="28" y="5" width="1" height="1" />
            <rect x="27" y="6" width="1" height="1" />
            <rect x="24" y="7" width="5" height="1" />
          </g>
        )}
      </svg>
    </div>
  );
}
