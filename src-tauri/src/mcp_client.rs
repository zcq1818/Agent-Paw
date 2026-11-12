//! 外部 MCP 服务（本机命令 / stdio 方式）。
//!
//! 用户在设置里添加的 MCP 服务如果是一条本机命令（如 `npx -y @modelcontextprotocol/server-filesystem D:/docs`），
//! 这里负责启动进程、完成 initialize 握手、按行收发 JSON-RPC。网址方式（Streamable HTTP）在前端用
//! tauri-plugin-http 直接请求，不经过这里。
//!
//! 进程由 Rust 统一持有，桌宠窗口和主窗口共用同一个连接；退出应用时全部结束。

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

const PROTOCOL_VERSION: &str = "2025-06-18";
const INIT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StdioConfig {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    cwd: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;

struct Conn {
    config: StdioConfig,
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
    init_result: Mutex<Value>,
}

static CONNS: OnceLock<Mutex<HashMap<String, Arc<Conn>>>> = OnceLock::new();

fn conns() -> &'static Mutex<HashMap<String, Arc<Conn>>> {
    CONNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Windows 下 `npx`、`uvx` 这类命令实际是 PATH 里的 .cmd / .exe，标准库不会按 PATHEXT 去找，这里补上。
fn resolve_program(command: &str) -> PathBuf {
    let expanded = crate::control::expand_user_path(command);
    let path = Path::new(&expanded);
    if path.is_file() {
        return path.to_path_buf();
    }
    if path.components().count() > 1 {
        return path.to_path_buf();
    }
    let has_ext = path.extension().is_some();
    let exts: &[&str] = if has_ext { &[""] } else { &[".exe", ".cmd", ".bat", ".com", ""] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        dirs.push(PathBuf::from(&home).join(".local").join("bin"));
        dirs.push(PathBuf::from(&home).join(".cargo").join("bin"));
    }
    dirs.push(PathBuf::from("C:/Program Files/nodejs"));
    for dir in dirs {
        for ext in exts {
            let candidate = dir.join(format!("{expanded}{ext}"));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    path.to_path_buf()
}

fn write_line(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut guard = stdin.lock().map_err(|_| "MCP 连接已损坏".to_string())?;
    guard.write_all(line.as_bytes()).map_err(|e| format!("写入 MCP 服务失败：{e}"))?;
    guard.flush().map_err(|e| format!("写入 MCP 服务失败：{e}"))
}

/// 服务端发来的请求（ping、roots/list 等）要回复，否则有的服务会一直等。
fn answer_server_request(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let reply = match method {
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "roots/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
        _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "桌宠不支持这个请求" } }),
    };
    let _ = write_line(stdin, &reply);
}

fn stderr_summary(conn: &Conn) -> String {
    let tail = conn.stderr_tail.lock().map(|t| t.join("\n")).unwrap_or_default();
    if tail.trim().is_empty() {
        String::new()
    } else {
        format!("\n服务输出：\n{}", tail.chars().rev().take(800).collect::<String>().chars().rev().collect::<String>())
    }
}

fn spawn(config: &StdioConfig) -> Result<Arc<Conn>, String> {
    if config.command.trim().is_empty() {
        return Err("没有填写启动命令".into());
    }
    let program = resolve_program(config.command.trim());
    let mut command = crate::hidden_command(&program.to_string_lossy());
    command
        .args(&config.args)
        .envs(&config.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = config.cwd.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        command.current_dir(crate::control::expand_user_path(cwd));
    }
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("找不到命令 {}。请确认已经安装，并且在终端里能直接运行。", config.command)
        } else {
            format!("启动 {} 失败：{e}", config.command)
        }
    })?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("拿不到 MCP 服务的输入")?));
    let stdout = child.stdout.take().ok_or("拿不到 MCP 服务的输出")?;
    let stderr = child.stderr.take();

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let stderr_tail = Arc::new(Mutex::new(Vec::new()));

    {
        let pending = pending.clone();
        let alive = alive.clone();
        let stdin = stdin.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.split(b'\n') {
                let Ok(bytes) = line else { break };
                let text = String::from_utf8_lossy(&bytes);
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(text) else { continue };
                let has_method = message.get("method").is_some();
                match (message.get("id").and_then(Value::as_u64), has_method) {
                    (Some(id), false) => {
                        if let Some(sender) = pending.lock().ok().and_then(|mut p| p.remove(&id)) {
                            let _ = sender.send(message);
                        }
                    }
                    (_, true) if message.get("id").is_some() => answer_server_request(&stdin, &message),
                    _ => {}
                }
            }
            alive.store(false, Ordering::SeqCst);
            // 进程退出：让还在等的请求立刻失败，而不是等到超时。
            if let Ok(mut p) = pending.lock() {
                p.clear();
            }
        });
    }
    if let Some(stderr) = stderr {
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut t) = tail.lock() {
                    t.push(line);
                    if t.len() > 30 {
                        t.remove(0);
                    }
                }
            }
        });
    }

    let conn = Arc::new(Conn {
        config: config.clone(),
        child: Mutex::new(child),
        stdin,
        pending,
        next_id: AtomicU64::new(1),
        alive,
        stderr_tail,
        init_result: Mutex::new(Value::Null),
    });

    let init = request(
        &conn,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "paw-desktop-pet", "version": env!("CARGO_PKG_VERSION") }
        }),
        INIT_TIMEOUT,
    );
    let init = match init {
        Ok(value) => value,
        Err(error) => {
            kill(&conn);
            return Err(error);
        }
    };
    write_line(&conn.stdin, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
    if let Ok(mut slot) = conn.init_result.lock() {
        *slot = init;
    }
    Ok(conn)
}

fn request(conn: &Conn, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    if !conn.alive.load(Ordering::SeqCst) {
        return Err(format!("MCP 服务已经退出{}", stderr_summary(conn)));
    }
    let id = conn.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    conn.pending.lock().map_err(|_| "MCP 连接已损坏")?.insert(id, tx);
    let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    if let Err(error) = write_line(&conn.stdin, &message) {
        conn.pending.lock().ok().map(|mut p| p.remove(&id));
        return Err(error);
    }
    let response = match rx.recv_timeout(timeout) {
        Ok(response) => response,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            conn.pending.lock().ok().map(|mut p| p.remove(&id));
            let _ = write_line(
                &conn.stdin,
                &json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": id, "reason": "timeout" } }),
            );
            return Err(format!("MCP 服务 {} 秒没有响应{}", timeout.as_secs(), stderr_summary(conn)));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(format!("MCP 服务已经退出{}", stderr_summary(conn)));
        }
    };
    if let Some(error) = response.get("error") {
        let message = error.get("message").and_then(Value::as_str).unwrap_or("未知错误");
        return Err(format!("MCP 服务返回错误：{message}"));
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

fn kill(conn: &Conn) {
    conn.alive.store(false, Ordering::SeqCst);
    if let Ok(mut child) = conn.child.lock() {
        // npx / cmd 会再起子进程，按进程树结束
        #[cfg(target_os = "windows")]
        {
            let _ = crate::hidden_command("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn connection(server_id: &str, config: &StdioConfig) -> Result<Arc<Conn>, String> {
    let existing = conns().lock().map_err(|_| "MCP 连接表已损坏")?.get(server_id).cloned();
    if let Some(conn) = existing {
        if conn.alive.load(Ordering::SeqCst) && conn.config == *config {
            return Ok(conn);
        }
        kill(&conn);
        conns().lock().ok().map(|mut c| c.remove(server_id));
    }
    let conn = spawn(config)?;
    conns().lock().map_err(|_| "MCP 连接表已损坏")?.insert(server_id.to_string(), conn.clone());
    Ok(conn)
}

/// 发一个 MCP 请求。method 为 "initialize" 时只确保连上并返回握手结果（握手在启动时已经做过）。
#[tauri::command]
pub async fn mcp_stdio_request(
    server_id: String,
    config: StdioConfig,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = connection(&server_id, &config)?;
        if method == "initialize" {
            return Ok(conn.init_result.lock().map(|v| v.clone()).unwrap_or(Value::Null));
        }
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000));
        request(&conn, &method, params.unwrap_or_else(|| json!({})), timeout)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mcp_stdio_stop(server_id: String) {
    let conn = conns().lock().ok().and_then(|mut c| c.remove(&server_id));
    if let Some(conn) = conn {
        std::thread::spawn(move || kill(&conn));
    }
}

/// 已连上的本机 MCP 服务 id。
#[tauri::command]
pub fn mcp_stdio_running() -> Vec<String> {
    conns()
        .lock()
        .map(|c| c.iter().filter(|(_, conn)| conn.alive.load(Ordering::SeqCst)).map(|(id, _)| id.clone()).collect())
        .unwrap_or_default()
}

pub fn stop_all() {
    let all: Vec<Arc<Conn>> = conns().lock().map(|mut c| c.drain().map(|(_, v)| v).collect()).unwrap_or_default();
    for conn in all {
        kill(&conn);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用一段 PowerShell 假扮 MCP 服务：回应 initialize 和 tools/list。
    #[test]
    #[cfg(target_os = "windows")]
    fn stdio_handshake_and_request() {
        let script = r#"
$ErrorActionPreference = 'Stop'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $msg = $line | ConvertFrom-Json
  if ($null -eq $msg.id) { continue }
  if ($msg.method -eq 'initialize') {
    $res = @{ jsonrpc='2.0'; id=$msg.id; result=@{ protocolVersion='2025-06-18'; serverInfo=@{ name='fake'; version='1' }; capabilities=@{ tools=@{} } } }
  } else {
    $res = @{ jsonrpc='2.0'; id=$msg.id; result=@{ tools=@(@{ name='echo'; description='回声'; inputSchema=@{ type='object' } }) } }
  }
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Depth 10 -Compress))
  [Console]::Out.Flush()
}
"#;
        let config = StdioConfig {
            command: "powershell".into(),
            args: vec!["-NoProfile".into(), "-Command".into(), script.into()],
            env: HashMap::new(),
            cwd: None,
        };
        let conn = connection("test", &config).expect("connect");
        let init = conn.init_result.lock().unwrap().clone();
        assert_eq!(init["serverInfo"]["name"], "fake");
        let tools = request(&conn, "tools/list", json!({}), Duration::from_secs(20)).expect("tools");
        assert_eq!(tools["tools"][0]["name"], "echo");
        // 同样的配置复用同一个连接
        let again = connection("test", &config).unwrap();
        assert!(Arc::ptr_eq(&conn, &again));
        stop_all();
        assert!(!conn.alive.load(Ordering::SeqCst));
    }
}
