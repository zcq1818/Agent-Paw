// Tauri API 类型声明
declare global {
  interface Window {
    __TAURI__?: {
      window?: {
        label: string;
      };
      invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

export {};
