import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/** 工作台 / 设置页共用的基础组件。颜色只用语义色（见 tailwind.config.js）。 */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg hover:brightness-110 disabled:opacity-50",
  secondary: "border border-line bg-surface text-fg hover:bg-surface-2 disabled:opacity-50",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40",
  danger: "text-danger hover:bg-danger/10 disabled:opacity-40",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-xs",
  md: "h-9 gap-2 rounded-lg px-4 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center justify-center font-medium transition disabled:cursor-not-allowed ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
    />
  );
}

export function IconButton({
  label,
  className = "",
  active = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:opacity-40 ${
        active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg"
      } ${className}`}
    />
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-line bg-surface shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
            {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="space-y-4 px-5 py-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-fg">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-fg-muted">{hint}</p>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-fg-muted/35"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}

/** 一行：左边标题 + 说明，右边控件。 */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-fg">{title}</div>
        {description && <div className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={`inline-flex rounded-lg border border-line bg-surface-2 p-0.5 ${className}`} role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
            value === option.value ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 可选卡片（主题、形态等）。 */
export function ChoiceCard({
  selected,
  title,
  description,
  onClick,
  leading,
}: {
  selected: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClick: () => void;
  leading?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
        selected ? "border-primary bg-primary/10" : "border-line bg-surface hover:border-fg-muted/50"
      }`}
    >
      {leading}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{title}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">{description}</span>}
      </span>
    </button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "primary" | "accent" | "danger"; children: ReactNode }) {
  const tones = {
    neutral: "bg-surface-2 text-fg-muted",
    primary: "bg-primary/15 text-primary-ink",
    accent: "bg-accent/15 text-accent",
    danger: "bg-danger/10 text-danger",
  };
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "success" | "error" | "warning"; children: ReactNode }) {
  const tones = {
    info: "border-line bg-surface-2 text-fg-muted",
    success: "border-success/30 bg-success/10 text-success",
    error: "border-danger/30 bg-danger/10 text-danger",
    warning: "border-accent/30 bg-accent/10 text-fg",
  };
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tones[tone]}`}>{children}</div>;
}

/** 点击按钮弹出的小菜单；点外部或按 Esc 关闭。 */
export function Popover({
  trigger,
  children,
  align = "right",
  className = "",
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div
          className={`fade-in absolute top-full z-40 mt-1.5 min-w-[200px] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-pop ${
            align === "right" ? "right-0" : "left-0"
          } ${className}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger = false,
  trailing,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
        danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-surface-2"
      }`}
    >
      {icon && <span className="shrink-0 text-fg-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

/** 监听容器宽度，用来在窄窗口下切换布局。 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1024));
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
