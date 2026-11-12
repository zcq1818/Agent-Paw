import { invoke } from "@tauri-apps/api/core";

/**
 * 本机 Claude Code 通道：通过 Tauri Rust 侧 spawn `claude -p`。
 * 不加 --bare，因此复用本机已登录凭据、MCP 配置与 CLAUDE.md，无需另配 API Key。
 */

export interface LocalClaudeStatus {
  available: boolean;
  version: string;
  path: string;
  detail: string;
}

export async function checkLocalClaude(path?: string): Promise<LocalClaudeStatus> {
  try {
    return await invoke<LocalClaudeStatus>("check_local_claude", {
      path: path?.trim() || null,
    });
  } catch (error) {
    return {
      available: false,
      version: "",
      path: path?.trim() || "claude",
      detail: `当前没有 Tauri 运行时（浏览器预览无法调用本机 CLI）：${String(error)}`,
    };
  }
}

export async function callLocalClaude(
  prompt: string,
  path?: string,
  allowedTools = "Read"
): Promise<string> {
  try {
    return await invoke<string>("run_local_claude", {
      prompt,
      path: path?.trim() || null,
      // Tauri v2 把 Rust 的 snake_case 参数映射为 camelCase；写成 allow_tools 会被静默忽略。
      allowTools: allowedTools,
    });
  } catch (error) {
    const detail = String(error);
    if (detail.includes("登录态已过期")) throw new Error(detail);
    throw new Error(
      `本机 Claude 通道不可用：${detail}。浏览器预览没有 Tauri 运行时，请在桌面端使用。`
    );
  }
}
