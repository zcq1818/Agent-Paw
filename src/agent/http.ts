import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * 跨域抓取第三方网页（搜索结果、新闻 RSS）。
 *
 * WebView 里直接 fetch 这些站点会被 CORS 拦截（它们不返回 Access-Control-Allow-Origin），
 * 所以在桌面端走 tauri-plugin-http 由 Rust 侧发请求。允许的域名在
 * src-tauri/capabilities/default.json 的 http:default 里白名单配置，新增来源要同步加上。
 * 浏览器 dev 预览没有 Tauri 运行时，退回普通 fetch（多半仍会被 CORS 拦，但不至于崩）。
 */
export async function fetchExternal(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

/** 部分站点会对非浏览器 UA 返回 403。 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
