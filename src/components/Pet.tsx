import { useState, useEffect, useCallback, useRef } from "react";
import { PikachuSprite } from "./PikachuSprite";
import { usePetStore } from "../store/pet";

type PetState = "idle" | "walk" | "sit" | "sleep" | "excited" | "thinking";

interface PetProps {
  onOpenChat: () => void;
}

export function Pet({ onOpenChat }: PetProps) {
  const [petState, setPetState] = useState<PetState>("idle");
  const [showMenu, setShowMenu] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<HTMLDivElement>(null);
  const emotion = usePetStore((s) => s.emotion);

  // 情绪驱动状态变化
  useEffect(() => {
    if (emotion === "thinking") setPetState("thinking");
    else if (emotion === "excited") setPetState("excited");
    else setPetState("idle");
  }, [emotion]);

  // 随机动作
  useEffect(() => {
    const interval = setInterval(() => {
      const rand = Math.random();
      if (petState === "idle") {
        if (rand < 0.15) setPetState("walk");
        else if (rand < 0.25) setPetState("sit");
        else if (rand < 0.3) setPetState("sleep");
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [petState]);

  // 动作持续后回到 idle
  useEffect(() => {
    if (petState === "walk" || petState === "sit") {
      const timeout = setTimeout(() => setPetState("idle"), 3000);
      return () => clearTimeout(timeout);
    }
    if (petState === "sleep") {
      const timeout = setTimeout(() => setPetState("idle"), 8000);
      return () => clearTimeout(timeout);
    }
  }, [petState]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu((v) => !v);
  }, []);

  const handleClick = useCallback(() => {
    setShowMenu(false);
    setPetState("excited");
    setTimeout(() => setPetState("idle"), 1500);
  }, []);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX - position.x;
      const startY = e.clientY - position.y;

      const onMove = (ev: MouseEvent) => {
        setPosition({ x: ev.clientX - startX, y: ev.clientY - startY });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // 如果几乎没有移动，视为点击
        if (Math.abs(position.x) < 3 && Math.abs(position.y) < 3) {
          handleClick();
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [position, handleClick]
  );

  return (
    <div className="pet-window w-screen h-screen relative" onContextMenu={handleContextMenu}>
      {/* 皮卡丘 */}
      <div
        ref={dragRef}
        className="absolute cursor-grab active:cursor-grabbing"
        style={{
          transform: `translate(${position.x}px, ${position.y}px)`,
          left: "50%",
          top: "50%",
          marginLeft: "-60px",
          marginTop: "-60px",
        }}
        onMouseDown={handleDragStart}
      >
        <PikachuSprite state={petState} />

        {/* 状态气泡 */}
        {petState === "thinking" && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-white rounded-full px-2 py-1 text-xs shadow animate-bounce">
            💭
          </div>
        )}
        {petState === "excited" && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-lg animate-bounce">
            ⚡
          </div>
        )}
        {petState === "sleep" && (
          <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-sm animate-float">
            💤
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {showMenu && (
        <div
          className="absolute bg-gray-900/95 backdrop-blur rounded-xl shadow-2xl border border-gray-700 py-1 min-w-[140px] z-50"
          style={{ left: position.x + 100, top: position.y + 60 }}
        >
          <MenuItem
            icon="💬"
            label="聊天"
            onClick={() => {
              setShowMenu(false);
              onOpenChat();
            }}
          />
          <MenuItem
            icon="⚡"
            label="摸摸头"
            onClick={() => {
              setShowMenu(false);
              setPetState("excited");
            }}
          />
          <MenuItem
            icon="🎵"
            label="唱歌"
            onClick={() => {
              setShowMenu(false);
              setPetState("excited");
            }}
          />
          <div className="border-t border-gray-700 my-1" />
          <MenuItem
            icon="⚙️"
            label="设置"
            onClick={() => {
              setShowMenu(false);
              onOpenChat();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/50 transition-colors"
      onClick={onClick}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
