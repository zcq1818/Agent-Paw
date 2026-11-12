import { Suspense, lazy, useEffect, useRef } from "react";

const MarkdownContent = lazy(() => import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })));

interface PetBubbleProps {
  message: string;
  isVisible: boolean;
  onClose: () => void;
  onOpen?: () => void;
  autoClose?: number;
}

export function PetBubble({ message, isVisible, onClose, onOpen, autoClose = 5000 }: PetBubbleProps) {
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = (duration = autoClose) => {
    clearTimer();
    if (isVisible && duration > 0) {
      timerRef.current = window.setTimeout(onClose, duration);
    }
  };

  useEffect(() => {
    startTimer();

    return () => {
      clearTimer();
    };
  }, [isVisible, onClose, autoClose, message]);

  if (!isVisible) return null;

  return (
    <div
      className="absolute left-1/2 top-8 z-20 w-[260px] -translate-x-1/2 pointer-events-auto"
      onPointerEnter={clearTimer}
      onPointerLeave={() => startTimer(Math.min(autoClose, 2400))}
    >
      <div
        className="speech-window relative rounded-2xl border border-line bg-surface px-4 py-3 text-fg shadow-xl cursor-pointer"
        onClick={onOpen}
        title="点击打开聊天"
      >
        <div className="pet-bubble-markdown max-h-32 overflow-y-auto text-sm text-fg leading-relaxed">
          <Suspense fallback={<div className="whitespace-pre-line">{message}</div>}>
            <MarkdownContent content={message} compact />
          </Suspense>
        </div>
        <div className="absolute -bottom-2 left-1/2 -translate-x-1/2">
          <div className="speech-tail h-4 w-4 rotate-45 border-b border-r border-line bg-surface" />
        </div>
        <button
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface-2 text-xs text-fg-muted transition-colors hover:text-fg"
          aria-label="关闭气泡"
        >
          x
        </button>
      </div>
    </div>
  );
}
