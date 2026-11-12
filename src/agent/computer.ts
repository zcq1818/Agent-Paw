import { invoke } from "@tauri-apps/api/core";
import { confirmSystemAction, type Tool } from "./tools";

/**
 * 电脑控制工具：命令行、文件、窗口、鼠标键盘、读取界面元素。
 *
 * 审批策略（设置 → AI 能力 → 电脑控制）：
 * - off：不提供这些工具；
 * - ask：只读操作（看窗口、读界面、读文件、列目录）直接执行，其它每一步都弹确认卡片；
 * - trusted：自动执行，但危险操作（格式化、删系统文件、改注册表、关机……）仍然必须确认。
 * 读屏幕用 Windows UI Automation 拿到文字化的元素列表，纯文本模型也能“看懂”界面。
 */
export type ComputerControlMode = "off" | "ask" | "trusted";

export const COMPUTER_CONTROL_LABELS: Record<ComputerControlMode, string> = {
  off: "关闭",
  ask: "每次确认",
  trusted: "信任模式",
};

const DANGEROUS_COMMAND = [
  // 只匹配格式化磁盘（format C: / Format-Volume），不误伤 Format-Table、-f 格式化字符串
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bformat-volume\b/i,
  /\bdiskpart\b/i,
  /\bclear-disk\b|\binitialize-disk\b/i,
  /\bbcdedit\b/i,
  /\breg(\.exe)?\s+(delete|add|import)\b/i,
  /remove-item[^\n]*hk(lm|cu|cr|u|cc):/i,
  /\b(stop|restart)-computer\b|\bshutdown(\.exe)?\b/i,
  /\bcipher\s+\/w\b/i,
  /\bvssadmin\b|\bwbadmin\b/i,
  /\bset-executionpolicy\b/i,
  /\bnet\s+(user|localgroup)\b/i,
  /\btakeown\b|\bicacls\b/i,
  /\bset-mppreference\b|\bdisable-?windows\s*defender/i,
  /remove-item[^\n]*-recurse/i,
  /\b(rd|rmdir)\s+\/s\b|\bdel\s+[^\n]*\/s\b/i,
  /\brm\s+-(rf|fr)\b/i,
  /[a-z]:\\windows\b|[a-z]:\\program files/i,
  /\binvoke-(webrequest|restmethod)[^\n]*\|\s*(iex|invoke-expression)\b/i,
];

const PROTECTED_PATH = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)|^[a-z]:\\?$/i;

const DANGEROUS_KEYS = /^(win\+l|ctrl\+alt\+(del|delete)|alt\+f4)$/i;

function isDangerousCommand(command: string) {
  return DANGEROUS_COMMAND.some((pattern) => pattern.test(command));
}

/** 取当前模式；用动态 import 避免与 kernel.ts 形成循环依赖。 */
async function currentMode(): Promise<ComputerControlMode> {
  const { loadConfig } = await import("./kernel");
  const mode = loadConfig().computerControl;
  return mode === "off" || mode === "trusted" ? mode : "ask";
}

/** 需要改动电脑的操作：按模式决定是否弹确认卡片。返回 false 表示用户拒绝。 */
async function allow(summary: string, options: { dangerous?: boolean; kind?: "shell" | "file_edit" | "tool" } = {}) {
  const mode = await currentMode();
  if (mode === "off") return false;
  if (mode === "trusted" && !options.dangerous) return true;
  const prefix = options.dangerous ? "⚠️ 高风险操作，请仔细确认\n" : "";
  // 高风险操作每次都要确认，不提供“一直允许”
  return confirmSystemAction(`${prefix}${summary}`, options.kind || "shell", { allowAlways: !options.dangerous });
}

function json(value: unknown) {
  return JSON.stringify(value, null, 1);
}

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : String((error as Error)?.message || error));
  }
}

interface WindowInfo {
  id: number;
  title: string;
  process: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  foreground: boolean;
}

interface UiNode {
  id: number;
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  depth: number;
}

function describeWindow(w: WindowInfo) {
  return `[${w.id}] ${w.title} — ${w.process}${w.minimized ? "（已最小化）" : ""}${w.foreground ? "（前台）" : ""}`;
}

export function getComputerTools(): Tool[] {
  return [
    {
      name: "computer_run_command",
      description:
        "在用户电脑上执行 PowerShell 命令并返回输出。适合查文件、装软件、改配置、批量处理、查进程等一切命令行能完成的事。能用命令完成的优先用命令，比模拟点击可靠。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "PowerShell 脚本，可多行" },
          cwd: { type: "string", description: "工作目录，默认用户目录，支持 ~" },
          timeout_seconds: { type: "number", description: "超时秒数，默认 60，最长 600" },
        },
        required: ["command"],
      },
      execute: async (args) => {
        const command = String(args.command || "").trim();
        if (!command) return "命令为空。";
        const dangerous = isDangerousCommand(command);
        if (!(await allow(`皮卡准备执行命令：\n${command}${args.cwd ? `\n目录：${args.cwd}` : ""}`, { dangerous }))) {
          return "用户拒绝了这条命令，不要重试同样的命令。";
        }
        const result = await call<{ code: number | null; stdout: string; stderr: string; timed_out: boolean; duration_ms: number }>(
          "run_shell",
          {
            command,
            cwd: args.cwd ? String(args.cwd) : undefined,
            timeoutMs: Math.round(Number(args.timeout_seconds || 60) * 1000),
          }
        );
        return [
          `退出码：${result.code ?? "无"}${result.timed_out ? "（超时已终止）" : ""}，用时 ${result.duration_ms}ms`,
          result.stdout ? `输出：\n${result.stdout}` : "（没有输出）",
          result.stderr ? `错误输出：\n${result.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "computer_list_files",
      description: "列出目录内容（只读）。支持 ~、%USERPROFILE% 等写法，如 ~/Desktop。",
      parameters: { type: "object", properties: { path: { type: "string", description: "目录路径" } }, required: ["path"] },
      execute: async (args) => {
        const listing = await call<{ path: string; entries: Array<{ name: string; is_dir: boolean; size: number; modified: number }>; truncated: boolean }>(
          "fs_list",
          { path: String(args.path || "~") }
        );
        const lines = listing.entries.map((entry) =>
          entry.is_dir
            ? `📁 ${entry.name}`
            : `📄 ${entry.name}  ${entry.size >= 1048576 ? `${(entry.size / 1048576).toFixed(1)}MB` : `${Math.ceil(entry.size / 1024)}KB`}  ${new Date(entry.modified * 1000).toLocaleString("zh-CN")}`
        );
        return `${listing.path}（${listing.entries.length} 项${listing.truncated ? "，只显示前 500 项" : ""}）\n${lines.join("\n")}`;
      },
    },
    {
      name: "computer_read_file",
      description: "读取文本文件内容（只读）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          max_chars: { type: "number", description: "最多返回多少字符，默认 20000" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const file = await call<{ path: string; content: string; size: number; truncated: boolean }>("fs_read", {
          path: String(args.path || ""),
          maxChars: args.max_chars ? Number(args.max_chars) : undefined,
        });
        return `${file.path}（${file.size} 字节${file.truncated ? "，内容已截断" : ""}）\n${file.content}`;
      },
    },
    {
      name: "computer_write_file",
      description: "写入文本文件（会覆盖，append=true 时追加），自动创建目录。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "要写入的内容" },
          append: { type: "boolean", description: "是否追加到末尾" },
        },
        required: ["path", "content"],
      },
      execute: async (args) => {
        const path = String(args.path || "");
        const content = String(args.content ?? "");
        const preview = content.length > 300 ? `${content.slice(0, 300)}…（共 ${content.length} 字）` : content;
        const dangerous = PROTECTED_PATH.test(path.replace(/\//g, "\\"));
        if (!(await allow(`皮卡准备${args.append ? "追加写入" : "写入"}文件：${path}\n${preview}`, { dangerous, kind: "file_edit" }))) {
          return "用户拒绝了写文件。";
        }
        return call<string>("fs_write", { path, content, append: Boolean(args.append) });
      },
    },
    {
      name: "computer_list_windows",
      description: "列出当前打开的所有窗口（按从上到下的层级），返回窗口编号、标题和程序名（只读）。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const windows = await call<WindowInfo[]>("list_windows");
        if (!windows.length) return "没有找到打开的窗口。";
        return windows.slice(0, 40).map(describeWindow).join("\n");
      },
    },
    {
      name: "computer_window",
      description: "对窗口执行操作：focus 切到前台、minimize 最小化、maximize 最大化、restore 还原、close 关闭。窗口编号来自 computer_list_windows。",
      parameters: {
        type: "object",
        properties: {
          window_id: { type: "number", description: "窗口编号" },
          action: { type: "string", enum: ["focus", "minimize", "maximize", "restore", "close"] },
        },
        required: ["window_id", "action"],
      },
      execute: async (args) => {
        const action = String(args.action || "focus");
        // 切换 / 最小化之类不改数据，信任模式和确认模式下都只对“关闭”确认。
        if (action === "close" && !(await allow(`皮卡准备关闭窗口 #${args.window_id}（未保存的内容可能丢失）`, { kind: "tool" }))) {
          return "用户拒绝了关闭窗口。";
        }
        return call<string>("window_action", { id: Number(args.window_id), action });
      },
    },
    {
      name: "computer_read_screen",
      description:
        "读取一个窗口里的界面元素（按钮、输入框、菜单、列表项、文字等），每个元素带编号、类型、名称和位置（只读）。不传 window_id 时读取最上层的窗口。操作软件前先调用它，点击和输入时用这里的编号。",
      parameters: {
        type: "object",
        properties: {
          window_id: { type: "number", description: "窗口编号，可省略" },
          max_elements: { type: "number", description: "最多返回多少个元素，默认 220" },
        },
      },
      execute: async (args) => {
        const snap = await call<{ window: WindowInfo | null; nodes: UiNode[]; truncated: boolean }>("ui_snapshot", {
          id: args.window_id ? Number(args.window_id) : undefined,
          maxNodes: args.max_elements ? Number(args.max_elements) : undefined,
        });
        const head = snap.window ? `窗口：${describeWindow(snap.window)}` : "窗口：未知";
        const lines = snap.nodes.map(
          (node) =>
            `#${node.id} ${"  ".repeat(Math.min(node.depth, 6))}${node.role}${node.name ? `「${node.name}」` : ""}${node.enabled ? "" : "（不可用）"} @${node.x + Math.round(node.width / 2)},${node.y + Math.round(node.height / 2)}`
        );
        return `${head}\n共 ${snap.nodes.length} 个元素${snap.truncated ? "（太多已截断，可指定窗口或增大 max_elements）" : ""}\n${lines.join("\n")}`;
      },
    },
    {
      name: "computer_click",
      description: "点击界面：优先传 element（computer_read_screen 返回的编号），也可以传屏幕坐标 x、y。支持右键和双击。",
      parameters: {
        type: "object",
        properties: {
          element: { type: "number", description: "元素编号" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          double: { type: "boolean", description: "是否双击" },
          target_name: { type: "string", description: "要点的东西叫什么，用于确认提示" },
        },
      },
      execute: async (args) => {
        const where = args.element ? `元素 #${args.element}` : `坐标 (${args.x}, ${args.y})`;
        const label = args.target_name ? `「${args.target_name}」` : "";
        if (!(await allow(`皮卡准备${args.double ? "双击" : args.button === "right" ? "右键点击" : "点击"}${label}${where}`, { kind: "tool" }))) {
          return "用户拒绝了点击。";
        }
        return call<string>("mouse_click", {
          element: args.element ? Number(args.element) : undefined,
          x: args.x !== undefined ? Number(args.x) : undefined,
          y: args.y !== undefined ? Number(args.y) : undefined,
          button: args.button ? String(args.button) : undefined,
          double: Boolean(args.double),
        });
      },
    },
    {
      name: "computer_type",
      description: "在当前焦点处输入文字（支持中文）。传 element 会先点击该元素再输入；press_enter=true 时输入后回车。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          element: { type: "number", description: "先点击的元素编号，可省略" },
          press_enter: { type: "boolean" },
        },
        required: ["text"],
      },
      execute: async (args) => {
        const text = String(args.text ?? "");
        const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        if (!(await allow(`皮卡准备输入${args.element ? `到元素 #${args.element}` : ""}：\n${preview}${args.press_enter ? "\n然后按回车" : ""}`, { kind: "tool" }))) {
          return "用户拒绝了输入。";
        }
        let result = await call<string>("type_text", { text, element: args.element ? Number(args.element) : undefined });
        if (args.press_enter) result = await call<string>("key_press", { keys: "enter" });
        return result;
      },
    },
    {
      name: "computer_press_keys",
      description: "按键盘快捷键，如 ctrl+s、ctrl+c、alt+tab、win+d、enter、esc；多组用空格分隔会依次按下。",
      parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
      execute: async (args) => {
        const keys = String(args.keys || "").trim();
        if (!keys) return "没有指定按键。";
        const dangerous = keys.split(/\s+/).some((combo) => DANGEROUS_KEYS.test(combo));
        if (!(await allow(`皮卡准备按键：${keys}`, { dangerous, kind: "tool" }))) return "用户拒绝了按键。";
        return call<string>("key_press", { keys });
      },
    },
    {
      name: "computer_scroll",
      description: "滚动鼠标滚轮。amount 正数向下、负数向上（单位约等于一格滚轮）。可传元素编号或坐标指定滚动位置。",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          element: { type: "number" },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["amount"],
      },
      execute: async (args) => {
        // 滚动不改变任何数据，不弹确认。
        return call<string>("mouse_scroll", {
          amount: Math.round(Number(args.amount || 3)),
          element: args.element ? Number(args.element) : undefined,
          x: args.x !== undefined ? Number(args.x) : undefined,
          y: args.y !== undefined ? Number(args.y) : undefined,
        });
      },
    },
  ];
}

/** 开启电脑控制时追加到系统提示词的操作指南。 */
export function computerControlPrompt(mode: ComputerControlMode) {
  if (mode === "off") return "";
  return `

## 操作电脑
你可以直接操作用户的 Windows 电脑（当前模式：${COMPUTER_CONTROL_LABELS[mode]}）。用户让你做电脑上的事时，直接动手做完，不要只给教程。
- 能用命令完成的（查找/整理文件、装软件、查系统信息、批量改名、下载等）优先用 computer_run_command（PowerShell）。
- 操作图形界面的软件：先 computer_list_windows 找到窗口，computer_window 切到前台，再 computer_read_screen 读出界面元素，用元素编号 computer_click / computer_type；每做一步后重新 computer_read_screen 确认结果，再决定下一步。
- 打开软件可以用 open_app，或 computer_run_command 执行 Start-Process。
- 删除、覆盖、关闭未保存的窗口等不可逆操作，先在回复里说清楚要做什么。被用户拒绝的操作不要重试。
- 完成后简要说明做了什么、结果如何。`;
}
