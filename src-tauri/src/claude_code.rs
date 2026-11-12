//! 本机 Claude 模型通道：以官方文档里的非交互模式（`claude -p --output-format stream-json`）
//! 调用用户自己安装、自己登录的 Claude Code。
//!
//! 合规约束（见 Claude Code《法律与合规》）：
//! - 只调用官方安装的、未经修改的 Claude Code 程序，不打包、不改它；
//! - 登录完全由 Claude Code 自己的流程完成，这里不读取、不保存、不转发任何账号凭据；
//! - 只在用户主动发消息 / 接受提议 / 定时任务到点时调用，属于个人日常使用。
//!
//! 桌宠自己的工具通过一个只监听 127.0.0.1、带随机令牌的 MCP（Streamable HTTP）
//! 服务提供给 Claude：Claude 调工具 → 这里发事件给前端 → 前端按原有审批规则执行 → 结果写回。

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct McpServer {
    port: u16,
    token: String,
}

static MCP: OnceLock<McpServer> = OnceLock::new();
static TOOLS: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();
static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<(String, bool)>>>> = OnceLock::new();
static RUNS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<(String, bool)>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tools() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    TOOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn runs() -> &'static Mutex<HashMap<String, u32>> {
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..4u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(i ^ std::process::id() as u64);
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

// ───────────────────────── MCP 服务 ─────────────────────────

fn ensure_mcp(app: &AppHandle) -> Result<&'static McpServer, String> {
    if let Some(server) = MCP.get() {
        return Ok(server);
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("启动本机工具服务失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let server = McpServer { port, token: random_token() };
    let token = server.token.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let token = token.clone();
            let handle = handle.clone();
            std::thread::spawn(move || {
                let _ = serve_connection(stream, &token, &handle);
            });
        }
    });
    let _ = MCP.set(server);
    Ok(MCP.get().unwrap())
}

fn write_response(stream: &mut TcpStream, status: &str, body: Option<&Value>) -> std::io::Result<()> {
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let content_type = if body.is_some() { "Content-Type: application/json\r\n" } else { "" };
    let head = format!(
        "HTTP/1.1 {status}\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n",
        text.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(text.as_bytes())?;
    stream.flush()
}

fn serve_connection(mut stream: TcpStream, token: &str, app: &AppHandle) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    // 路径 /mcp/<令牌>/<本次运行 ID>：令牌只有本机启动的 Claude 进程知道，
    // 运行 ID 用来把工具调用交回发起这次对话的窗口。
    let Some(run_id) = path.strip_prefix(&format!("/mcp/{token}/")).map(str::to_string) else {
        return write_response(&mut stream, "404 Not Found", None);
    };
    if run_id.is_empty() || !tools().lock().map(|t| t.contains_key(&run_id)).unwrap_or(false) {
        return write_response(&mut stream, "404 Not Found", None);
    }
    if method != "POST" {
        // 不提供服务端主动推送的 SSE 通道
        return write_response(&mut stream, "405 Method Not Allowed", None);
    }
    let mut body = vec![0u8; content_length.min(8 * 1024 * 1024)];
    reader.read_exact(&mut body)?;
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return write_response(&mut stream, "400 Bad Request", None);
    };
    match handle_rpc(&message, app, &run_id) {
        Some(reply) => write_response(&mut stream, "200 OK", Some(&reply)),
        None => write_response(&mut stream, "202 Accepted", None),
    }
}

fn handle_rpc(message: &Value, app: &AppHandle, run_id: &str) -> Option<Value> {
    let id = message.get("id").cloned()?; // 没有 id 的是通知，回 202 即可
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => {
            let version = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "paw", "version": env!("CARGO_PKG_VERSION") }
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools().lock().ok().and_then(|t| t.get(run_id).cloned()).unwrap_or_default() }),
        "tools/call" => {
            let name = message.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_string();
            let arguments = message.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            let (text, is_error) = call_frontend_tool(app, run_id, &name, arguments);
            json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
        }
        _ => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("不支持的方法：{method}") }
            }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// 把工具调用交给前端执行（审批卡片、执行、记录都在前端），最多等 15 分钟。
fn call_frontend_tool(app: &AppHandle, run_id: &str, name: &str, arguments: Value) -> (String, bool) {
    let call_id = format!("call_{}", random_token().get(..16).unwrap_or("x"));
    let (tx, rx) = mpsc::channel();
    pending().lock().unwrap().insert(call_id.clone(), tx);
    let _ = app.emit("claude-tool-call", json!({ "requestId": run_id, "callId": call_id, "name": name, "arguments": arguments }));
    let reply = rx.recv_timeout(Duration::from_secs(15 * 60));
    pending().lock().unwrap().remove(&call_id);
    reply.unwrap_or_else(|_| ("工具执行超时或桌宠窗口没有响应".to_string(), true))
}

#[tauri::command]
pub fn claude_tool_result(call_id: String, text: String, is_error: bool) -> Result<(), String> {
    if let Some(tx) = pending().lock().map_err(|e| e.to_string())?.remove(&call_id) {
        let _ = tx.send((text, is_error));
    }
    Ok(())
}

// ───────────────────────── 运行 Claude ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRunRequest {
    request_id: String,
    prompt: String,
    system_prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    /// 允许 Claude Code 自带的只读工具（读文件、搜索文件、联网搜索 / 抓网页）
    read_only_builtins: bool,
    tools: Vec<Value>,
    path: Option<String>,
}

fn work_dir(app: &AppHandle) -> PathBuf {
    // 固定的空工作目录：不会加载某个项目里的 CLAUDE.md、钩子之类
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("claude-work");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
pub fn claude_run(app: AppHandle, request: ClaudeRunRequest) -> Result<(), String> {
    let server = ensure_mcp(&app)?;
    if request.request_id.is_empty() || !request.request_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("无效的请求 ID".into());
    }
    tools().lock().map_err(|e| e.to_string())?.insert(request.request_id.clone(), request.tools.clone());

    let dir = work_dir(&app);
    let system_file = dir.join(format!("system-{}.txt", request.request_id));
    std::fs::write(&system_file, &request.system_prompt).map_err(|e| e.to_string())?;
    let mcp_file = dir.join(format!("mcp-{}.json", request.request_id));
    let mcp_config = json!({
        "mcpServers": {
            "paw": {
                "type": "http",
                "url": format!("http://127.0.0.1:{}/mcp/{}/{}", server.port, server.token, request.request_id)
            }
        }
    });
    std::fs::write(&mcp_file, mcp_config.to_string()).map_err(|e| e.to_string())?;

    let binary = crate::claude_binary(request.path.clone());
    let mut cmd = crate::hidden_command(&binary);
    cmd.current_dir(&dir).args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--system-prompt-file",
    ]);
    cmd.arg(&system_file);
    cmd.arg("--system-prompt-snapshot").arg("off");
    cmd.arg("--mcp-config").arg(&mcp_file).arg("--strict-mcp-config");
    let builtins = if request.read_only_builtins { "Read,Glob,Grep,WebSearch,WebFetch" } else { "" };
    cmd.arg("--tools").arg(builtins);
    let mut allowed = String::from("mcp__paw");
    if request.read_only_builtins {
        allowed.push_str(",Read,Glob,Grep,WebSearch,WebFetch");
    }
    cmd.arg("--allowedTools").arg(allowed);
    cmd.arg("--max-turns").arg("40");
    if let Some(model) = request.model.as_deref().map(str::trim).filter(|m| !m.is_empty() && *m != "default") {
        cmd.arg("--model").arg(model);
    }
    if let Some(session) = request.session_id.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(session);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            tools().lock().unwrap().remove(&request.request_id);
            let _ = std::fs::remove_file(&system_file);
            let _ = std::fs::remove_file(&mcp_file);
            return Err(format!("启动 Claude Code 失败：{e}"));
        }
    };
    // 提示词走标准输入，避免命令行长度和引号转义问题
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = request.prompt.clone();
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    runs().lock().unwrap().insert(request.request_id.clone(), child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let request_id = request.request_id.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        let err_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut err) = stderr {
                let _ = err.read_to_string(&mut text);
            }
            text
        });
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = handle.emit("claude-run", json!({ "requestId": request_id, "line": line }));
            }
        }
        let status = child.wait().ok().and_then(|s| s.code());
        let stderr_text: String = err_reader.join().unwrap_or_default().chars().take(2000).collect();
        runs().lock().unwrap().remove(&request_id);
        tools().lock().unwrap().remove(&request_id);
        let _ = std::fs::remove_file(&system_file);
        let _ = std::fs::remove_file(&mcp_file);
        let _ = handle.emit(
            "claude-run-end",
            json!({ "requestId": request_id, "code": status, "stderr": stderr_text }),
        );
    });
    Ok(())
}

#[tauri::command]
pub fn claude_cancel(request_id: String) -> Result<(), String> {
    let pid = runs().lock().map_err(|e| e.to_string())?.remove(&request_id);
    if let Some(pid) = pid {
        let _ = crate::hidden_command("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).output();
    }
    Ok(())
}
