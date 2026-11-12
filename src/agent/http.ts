import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * 跨域请求第三方服务（模型接口、搜索结果、新闻 RSS）。
 *
 * WebView 里直接 fetch 这些站点会被 CORS 拦截（如讯飞星火、DuckDuckGo 都不返回
 * Access-Control-Allow-Origin），所以在桌面端走 tauri-plugin-http 由 Rust 侧发请求。
 * 模型的 Base URL 由用户填写（可能是任意域名或本地端口），因此
 * src-tauri/capabilities/default.json 的 http:default 放行了全部 http(s) 地址。
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
