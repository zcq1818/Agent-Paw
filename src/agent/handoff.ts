import { invoke } from "@tauri-apps/api/core";
import { confirmSystemAction, type Tool } from "./tools";

/**
 * 交接给本机其它 AI 软件（Trae、WorkBuddy）。
 *
 * 这两款软件没有给第三方的后台对话接口，所以只用它们官方提供的方式：
 * - Trae：安装目录里的官方命令行启动器，打开文件夹 / 文件 / 跳到某一行；
 * - WorkBuddy：启动桌面程序，把任务描述放进剪贴板，用户粘贴即可。
 * 之后在那个软件里由用户继续（需要时桌宠也能用电脑控制去点、去输入）。
 */

interface AiApp {
  kind: "trae" | "workbuddy";
  name: string;
  launcher: string;
}

async function listApps(): Promise<AiApp[]> {
  try {
    return await invoke<AiApp[]>("ai_apps");
  } catch {
    return [];
  }
}

export function getHandoffTools(): Tool[] {
  return [
    {
      name: "list_ai_apps",
      description: "列出本机装了哪些可以交接任务的 AI 软件（Trae、WorkBuddy）。只读。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const apps = await listApps();
        if (!apps.length) return "没有找到已安装的 Trae 或 WorkBuddy。";
        return apps.map((app) => `- ${app.name}（${app.kind === "trae" ? "可打开文件夹 / 文件 / 跳到行" : "可打开并带上任务"}）`).join("\n");
      },
    },
    {
      name: "open_in_trae",
      description:
        "用 Trae（字节跳动的 AI 编程工具）打开文件夹或文件，可以跳到指定行。用户说“用 Trae 打开这个项目”“在 Trae 里看看这个文件第 30 行”时使用。路径支持 ~ 开头。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件夹或文件的路径" },
          line: { type: "number", description: "可选，打开文件时跳到第几行" },
          edition: { type: "string", description: "可选，装了多个 Trae 时指定名字里包含的关键词，如 CN、SOLO" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const path = String(args.path || "").trim();
        if (!path) return "需要提供路径。";
        const line = Number(args.line) > 0 ? Math.floor(Number(args.line)) : undefined;
        if (!(await confirmSystemAction(`用 Trae 打开：${path}${line ? `（第 ${line} 行）` : ""}`, "tool"))) {
          return "用户取消了打开。";
        }
        try {
          return await invoke<string>("open_in_trae", { path, line: line ?? null, name: args.edition ? String(args.edition) : null });
        } catch (error) {
          return `打开失败：${error}`;
        }
      },
    },
    {
      name: "open_workbuddy",
      description:
        "打开 WorkBuddy（腾讯的 AI 办公助手），可以把要交给它的任务描述先复制到剪贴板，用户在 WorkBuddy 里粘贴即可。用户说“交给 WorkBuddy 做”时使用。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "可选，要交给 WorkBuddy 的任务描述，会放进剪贴板" },
        },
      },
      execute: async (args) => {
        const task = String(args.task || "").trim();
        const summary = task ? `打开 WorkBuddy，并把任务复制到剪贴板：${task.slice(0, 120)}` : "打开 WorkBuddy";
        if (!(await confirmSystemAction(summary, "tool"))) return "用户取消了打开。";
        let copied = false;
        if (task) {
          try {
            await navigator.clipboard.writeText(task);
            copied = true;
          } catch {}
        }
        try {
          const result = await invoke<string>("open_workbuddy");
          return copied ? `${result}。任务已复制到剪贴板，在 WorkBuddy 的输入框里粘贴（Ctrl+V）即可。` : result;
        } catch (error) {
          return `打开失败：${error}`;
        }
      },
    },
  ];
}
