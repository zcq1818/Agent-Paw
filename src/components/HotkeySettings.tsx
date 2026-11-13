import { useState, type KeyboardEvent } from "react";
import { RotateCcw, X } from "lucide-react";
import { Button, Card } from "./ui";
import {
  HOTKEY_ACTIONS,
  displayHotkey,
  pauseHotkeys,
  useHotkeyStatusSync,
  useShortcutStore,
  type HotkeyAction,
} from "../store/shortcut";

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/** KeyboardEvent → 快捷键字符串（CommandOrControl+Shift+P）。只按了修饰键时返回 null。 */
function comboFromEvent(event: KeyboardEvent): { combo: string | null; error?: string } {
  if (MODIFIER_CODES.has(event.code)) return { combo: null };
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("CommandOrControl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Super");

  let key = event.code;
  const letter = /^Key([A-Z])$/.exec(key);
  const digit = /^Digit(\d)$/.exec(key);
  if (letter) key = letter[1];
  else if (digit) key = digit[1];
  if (!key || key === "Unidentified") return { combo: null, error: "这个键识别不了，换一个" };

  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(key);
  if (mods.length === 0 && !isFunctionKey) return { combo: null, error: "要带上 Ctrl、Alt 或 Shift，单个键会影响正常打字" };
  if (mods.length === 1 && mods[0] === "Shift" && !isFunctionKey) {
    return { combo: null, error: "只配 Shift 会影响正常打字，再加上 Ctrl 或 Alt" };
  }
  return { combo: [...mods, key].join("+") };
}

function Recorder({
  action,
  value,
  onChange,
}: {
  action: HotkeyAction;
  value: string;
  onChange: (combo: string) => string | null;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");

  const stop = () => {
    setRecording(false);
    pauseHotkeys(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-hotkey={action}
        className={`min-w-[150px] rounded-lg border px-3 py-1.5 text-center font-mono text-xs transition ${
          recording ? "border-primary bg-primary/10 text-fg" : "border-line bg-surface-2 text-fg hover:border-primary"
        }`}
        onFocus={() => {
          setRecording(true);
          setHint("");
          // 录制期间先注销全部热键，免得按到旧组合时触发动作
          pauseHotkeys(true);
        }}
        onBlur={stop}
        onKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            (event.currentTarget as HTMLButtonElement).blur();
            return;
          }
          if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            onChange("");
            (event.currentTarget as HTMLButtonElement).blur();
            return;
          }
          const { combo, error } = comboFromEvent(event);
          if (error) setHint(error);
          if (!combo) return;
          const problem = onChange(combo);
          if (problem) {
            setHint(problem);
            return;
          }
          (event.currentTarget as HTMLButtonElement).blur();
        }}
        title="点一下，然后按下想要的组合键；Esc 取消，Backspace 清除"
      >
        {recording ? "请按下组合键…" : value ? displayHotkey(value) : "未设置"}
      </button>
      {hint && <span className="text-[11px] text-danger">{hint}</span>}
    </div>
  );
}

/** 设置 → 快捷键 */
export function HotkeySettingsCard() {
  useHotkeyStatusSync();
  const hotkeys = useShortcutStore((state) => state.hotkeys);
  const status = useShortcutStore((state) => state.status);
  const setHotkey = useShortcutStore((state) => state.setHotkey);
  const resetHotkeys = useShortcutStore((state) => state.resetHotkeys);

  const change = (action: HotkeyAction, combo: string): string | null => {
    if (combo) {
      const clash = HOTKEY_ACTIONS.find((item) => item.id !== action && hotkeys[item.id] === combo);
      if (clash) return `和「${clash.label}」重复了`;
    }
    setHotkey(action, combo);
    return null;
  };

  return (
    <Card
      title="全局快捷键"
      description="在任何软件里按下就能叫桌宠干活。点右边的框，再按下想要的组合键；Esc 取消，Backspace 清除。改完立即生效。"
      actions={
        <Button size="sm" variant="ghost" onClick={resetHotkeys} title="恢复默认快捷键">
          <RotateCcw size={14} />
          恢复默认
        </Button>
      }
    >
      <ul className="divide-y divide-line rounded-lg border border-line">
        {HOTKEY_ACTIONS.map((item) => {
          const value = hotkeys[item.id] || "";
          const state = status[item.id];
          return (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-fg">{item.label}</div>
                <div className="text-xs text-fg-muted">{item.description}</div>
                <div className="mt-0.5 text-[11px]">
                  {!value ? (
                    <span className="text-fg-muted">未启用 · 建议 {displayHotkey(item.suggestion)}</span>
                  ) : state === "ok" ? (
                    <span className="text-success">✓ 已生效</span>
                  ) : state ? (
                    <span className="text-danger">✕ {state}</span>
                  ) : (
                    <span className="text-fg-muted">正在生效…</span>
                  )}
                </div>
              </div>
              <Recorder action={item.id} value={value} onChange={(combo) => change(item.id, combo)} />
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-danger disabled:opacity-30"
                disabled={!value}
                onClick={() => setHotkey(item.id, "")}
                aria-label={`清除「${item.label}」的快捷键`}
                title="清除"
              >
                <X size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">
        快捷键由桌宠窗口负责，桌宠退出后不生效。“处理刚复制的内容”不会读取密码管理器标记为私密的内容。
      </p>
    </Card>
  );
}
