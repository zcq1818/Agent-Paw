//! MCP 服务的 OAuth 登录回调：在 127.0.0.1 上临时开一个端口，等浏览器授权完跳回来，
//! 把 code / state 交给前端去换令牌。只监听本机回环地址，拿到一次回调就关掉。

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

static LISTENERS: OnceLock<Mutex<HashMap<u16, TcpListener>>> = OnceLock::new();

fn listeners() -> &'static Mutex<HashMap<u16, TcpListener>> {
    LISTENERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Default)]
pub struct OAuthCallback {
    code: String,
    state: String,
    error: String,
    error_description: String,
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query(target: &str) -> HashMap<String, String> {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            if k.is_empty() {
                None
            } else {
                Some((percent_decode(k), percent_decode(v)))
            }
        })
        .collect()
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>授权完成</title><body style=\"font-family:system-ui,'Microsoft YaHei';background:#F4F4F4;color:#041E42;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><div style=\"background:#fff;border-radius:16px;padding:32px 40px;box-shadow:0 4px 24px rgba(4,30,66,.08);text-align:center\"><div style=\"font-size:40px;color:#00B2A9\">✓</div><h2 style=\"margin:8px 0\">授权完成</h2><p style=\"color:#8D99AE\">回到桌宠就能用了，这个页面可以关掉。</p></div>";
const PAGE_FAIL: &str = "<!doctype html><meta charset=utf-8><title>授权没有完成</title><body style=\"font-family:system-ui,'Microsoft YaHei';background:#F4F4F4;color:#041E42;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><div style=\"background:#fff;border-radius:16px;padding:32px 40px;box-shadow:0 4px 24px rgba(4,30,66,.08);text-align:center\"><div style=\"font-size:40px;color:#FC7A1E\">!</div><h2 style=\"margin:8px 0\">授权没有完成</h2><p style=\"color:#8D99AE\">回到桌宠看看原因，可以再试一次。</p></div>";

/// 开始监听回调端口（port 为 0 时随机分配），返回实际端口。
#[tauri::command]
pub fn oauth_listen(port: Option<u16>) -> Result<u16, String> {
    let wanted = port.unwrap_or(0);
    if wanted != 0 {
        // 上一次没走完的授权还占着这个端口：先放掉
        if let Ok(mut map) = listeners().lock() {
            map.remove(&wanted);
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", wanted))
        .map_err(|e| format!("回调端口 {wanted} 被占用或无法监听：{e}。可以在设置里换一个端口。"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let actual = listener.local_addr().map_err(|e| e.to_string())?.port();
    listeners().lock().map_err(|_| "回调监听表已损坏")?.insert(actual, listener);
    Ok(actual)
}

/// 等浏览器跳回 /callback，最多等 timeout_secs 秒。
#[tauri::command]
pub async fn oauth_wait(port: u16, timeout_secs: Option<u64>) -> Result<OAuthCallback, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs.unwrap_or(300).clamp(10, 900));
        loop {
            if Instant::now() > deadline {
                listeners().lock().ok().map(|mut m| m.remove(&port));
                return Err("等了太久没有完成授权，已取消。".to_string());
            }
            let accepted = {
                let map = listeners().lock().map_err(|_| "回调监听表已损坏")?;
                let Some(listener) = map.get(&port) else {
                    return Err("授权已取消。".to_string());
                };
                listener.accept()
            };
            let (mut stream, _) = match accepted {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(150));
                    continue;
                }
                Err(e) => return Err(format!("接收授权回调失败：{e}")),
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
            let mut request_line = String::new();
            let _ = reader.read_line(&mut request_line);
            // 读掉请求头
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line == "\r\n" || line == "\n" => break,
                    _ => {}
                }
            }
            let target = request_line.split_whitespace().nth(1).unwrap_or("/");
            if !target.starts_with("/callback") {
                // 浏览器顺带请求的 favicon 之类
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            let query = parse_query(target);
            let result = OAuthCallback {
                code: query.get("code").cloned().unwrap_or_default(),
                state: query.get("state").cloned().unwrap_or_default(),
                error: query.get("error").cloned().unwrap_or_default(),
                error_description: query.get("error_description").cloned().unwrap_or_default(),
            };
            let page = if result.code.is_empty() { PAGE_FAIL } else { PAGE_OK };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                page.len(),
                page
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            listeners().lock().ok().map(|mut m| m.remove(&port));
            return Ok(result);
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn oauth_cancel(port: u16) {
    if let Ok(mut map) = listeners().lock() {
        map.remove(&port);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_callback_query() {
        let q = parse_query("/callback?code=abc%2F123&state=xy+z&error_description=a%20b");
        assert_eq!(q["code"], "abc/123");
        assert_eq!(q["state"], "xy z");
        assert_eq!(q["error_description"], "a b");
    }
}
