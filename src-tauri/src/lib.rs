use std::process::Command;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use serde::Serialize;

mod ai_apps;
mod claude_code;
mod control;
mod mcp_client;
mod ocr;
mod timeline;
mod tray;

#[derive(Serialize)]
struct ActiveWindowInfo {
    title: String,
    process_path: String,
    process_name: String,
}

#[tauri::command]
fn toggle_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        let _ = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .title("Paw - 工作台")
            .inner_size(1040.0, 720.0)
            .min_inner_size(420.0, 520.0)
            .resizable(true)
            .build();
    }
}

#[tauri::command]
fn pet_drag_start(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.start_dragging();
    }
}

/// Windows 下以 GUI 子系统运行时，启动控制台程序会闪一下黑窗；加上 CREATE_NO_WINDOW 隐藏。
pub(crate) fn hidden_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn is_web_url(target: &str) -> bool {
    let lower = target.to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

/// 经 `cmd /C start` 启动时 cmd 会解释这些元字符（Rust 不会替 cmd.exe 转义），
/// 不拦截的话 `a & calc` 之类的输入就能注入额外命令。
fn has_cmd_metachar(target: &str) -> bool {
    target
        .chars()
        .any(|c| matches!(c, '&' | '|' | '<' | '>' | '^' | '"' | '%' | '!') || c.is_control())
}

/// 用系统默认程序打开 URL，不经过 cmd，`?a=1&b=2` 这类查询串不会被截断或注入。
fn open_url_with_default_handler(url: &str) -> Result<(), String> {
    if url.chars().any(|c| c.is_whitespace() || c == '"' || c.is_control()) {
        return Err("URL 不能包含空白、引号或控制字符".into());
    }
    hidden_command("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动失败: {error}"))
}

#[tauri::command]
fn launch_app(target: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("目标不能为空".into());
    }

    if is_web_url(target) {
        open_url_with_default_handler(target)?;
        return Ok(format!("已打开 {target}"));
    }

    let target_lower = target.to_lowercase();
    let spawned = match target_lower.as_str() {
        "notepad" | "记事本" => Command::new("notepad.exe").spawn(),
        "calculator" | "calc" | "计算器" => Command::new("calc.exe").spawn(),
        "explorer" | "file explorer" | "资源管理器" => Command::new("explorer.exe").spawn(),
        "task manager" | "taskmgr" | "任务管理器" => Command::new("taskmgr.exe").spawn(),
        "paint" | "mspaint" | "画图" => Command::new("mspaint.exe").spawn(),
        // 终端需要可见窗口：用 start 新开一个控制台。
        "terminal" | "cmd" | "命令行" => hidden_command("cmd.exe")
            .args(["/C", "start", "", "cmd.exe", "/K"])
            .spawn(),
        "settings" | "设置" | "系统设置" => hidden_command("cmd.exe")
            .args(["/C", "start", "", "ms-settings:"])
            .spawn(),
        _ => {
            if has_cmd_metachar(target) {
                return Err("目标包含不允许的特殊字符（& | < > ^ \" % !）".into());
            }
            hidden_command("cmd.exe").args(["/C", "start", "", target]).spawn()
        }
    };

    spawned.map_err(|error| format!("启动失败: {error}"))?;
    Ok(format!("已打开 {target}"))
}

#[tauri::command]
fn system_action(action: String, target: Option<String>) -> Result<String, String> {
    let action = action.trim().to_lowercase();
    match action.as_str() {
        "open_app" => launch_app(target.unwrap_or_default()),
        "open_settings" => launch_app("settings".into()),
        "open_explorer" => launch_app("explorer".into()),
        "open_notepad" => launch_app("notepad".into()),
        "open_calc" => launch_app("calculator".into()),
        "open_task_manager" => launch_app("task manager".into()),
        "open_terminal" => launch_app("terminal".into()),
        "open_url" => {
            let url = target.unwrap_or_default();
            if is_web_url(url.trim()) {
                launch_app(url)
            } else {
                Err("URL 必须以 http://、https:// 或 mailto: 开头".into())
            }
        }
        _ => Err(format!("暂不支持的系统动作：{action}")),
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_active_window_info() -> Result<ActiveWindowInfo, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == null_mut() {
            return Err("未找到活动窗口".into());
        }

        let len = GetWindowTextLengthW(hwnd);
        let mut title_buf = vec![0u16; (len + 1).max(1) as usize];
        let read = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
        let title = String::from_utf16_lossy(&title_buf[..read.max(0) as usize]);

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return Ok(ActiveWindowInfo { title, process_path: String::new(), process_name: String::new() });
        }

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == null_mut() {
            return Ok(ActiveWindowInfo { title, process_path: String::new(), process_name: String::new() });
        }

        let mut path_buf = vec![0u16; MAX_PATH as usize * 4];
        let mut size = path_buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, path_buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);

        let process_path = if ok != 0 {
            String::from_utf16_lossy(&path_buf[..size as usize])
        } else {
            String::new()
        };
        let process_name = process_path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .to_string();

        Ok(ActiveWindowInfo { title, process_path, process_name })
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn get_active_window_info() -> Result<ActiveWindowInfo, String> {
    Err("当前平台暂不支持活动窗口检测".into())
}

#[derive(serde::Serialize)]
struct LocalClaudeStatus {
    available: bool,
    version: String,
    path: String,
    detail: String,
}

fn claude_binary(explicit: Option<String>) -> String {
    if let Some(value) = explicit {
        if !value.trim().is_empty() {
            return value.trim().to_string();
        }
    }
    // 先看 PATH（Command 只会补 .exe；npm 全局安装得到的是 claude.cmd，单独再试一次）。
    for candidate in ["claude", "claude.cmd"] {
        let ok = hidden_command(candidate)
            .arg("--version")
            .output()
            .map(|result| result.status.success())
            .unwrap_or(false);
        if ok {
            return candidate.to_string();
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        // 原生安装器的默认位置。
        let native = std::path::Path::new(&profile)
            .join(".local")
            .join("bin")
            .join("claude.exe");
        if native.exists() {
            return native.to_string_lossy().to_string();
        }
        // Claude Code 桌面版会把 CLI 放在版本目录里，通常不在 PATH。
        let roots = [
            format!("{}/AppData/Roaming/Claude/claude-code", profile),
            format!("{}/AppData/Local/Claude-3p/claude-code", profile),
        ];
        for root in roots {
            let mut versions: Vec<std::path::PathBuf> = match std::fs::read_dir(&root) {
                Ok(entries) => entries
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir())
                    .collect(),
                Err(_) => continue,
            };
            versions.sort();
            versions.reverse();
            for version in versions {
                if let Ok(inner) = std::fs::read_dir(&version) {
                    for entry in inner.filter_map(|entry| entry.ok()) {
                        let exe = entry.path().join("claude.exe");
                        if exe.exists() {
                            return exe.to_string_lossy().to_string();
                        }
                    }
                }
                let direct = version.join("claude.exe");
                if direct.exists() {
                    return direct.to_string_lossy().to_string();
                }
            }
        }
    }
    "claude".to_string()
}

fn check_local_claude_blocking(path: Option<String>) -> LocalClaudeStatus {
    let binary = claude_binary(path);
    match hidden_command(&binary).arg("--version").output() {
        Ok(result) if result.status.success() => LocalClaudeStatus {
            available: true,
            version: String::from_utf8_lossy(&result.stdout).trim().to_string(),
            path: binary,
            detail: "本机 Claude Code CLI 可用（复用已登录凭据）".into(),
        },
        Ok(result) => LocalClaudeStatus {
            available: false,
            version: String::new(),
            path: binary,
            detail: String::from_utf8_lossy(&result.stderr).trim().to_string(),
        },
        Err(error) => LocalClaudeStatus {
            available: false,
            version: String::new(),
            path: binary,
            detail: format!("未找到可执行文件：{}", error),
        },
    }
}

/// 检测本机 Claude Code CLI。前端可传入显式路径（CLI 常常不在 PATH 里）。
/// 用 async + spawn_blocking：同步命令跑在主线程上，探测期间所有窗口都会卡住。
#[tauri::command]
async fn check_local_claude(path: Option<String>) -> Result<LocalClaudeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check_local_claude_blocking(path))
        .await
        .map_err(|error| error.to_string())
}

fn spawn_pipe_reader<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    })
}

/// 无头调用本机 Claude Code。刻意不加 --bare：这样会复用本机登录态、
/// MCP 配置与 CLAUDE.md，而不是要求另配 ANTHROPIC_API_KEY。
/// 放到阻塞线程池里跑，避免最长 180 秒的调用冻结主线程（宠物、聊天、托盘）。
#[tauri::command]
async fn run_local_claude(
    prompt: String,
    path: Option<String>,
    allow_tools: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_local_claude_blocking(prompt, path, allow_tools))
        .await
        .map_err(|error| error.to_string())?
}

fn run_local_claude_blocking(
    prompt: String,
    path: Option<String>,
    allow_tools: Option<String>,
) -> Result<String, String> {
    let binary = claude_binary(path);
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err("任务不能为空".into());
    }
    // 默认只放行只读工具；要写文件或跑命令必须用户显式配置。
    let allowed = allow_tools
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Read".to_string());

    let mut child = hidden_command(&binary)
        .args(["-p", trimmed, "--output-format", "text", "--allowedTools", &allowed])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 Claude Code 失败：{}", error))?;

    // 必须边运行边读管道：管道缓冲区只有几 KB，输出一长子进程就会卡在写入上，
    // 永远不会退出，最后只能等到超时。
    let stdout_reader = spawn_pipe_reader(child.stdout.take());
    let stderr_reader = spawn_pipe_reader(child.stderr.take());

    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(180);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本机 Claude 调用超时（180 秒）".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };

    let stdout_bytes = stdout_reader.join().unwrap_or_default();
    let stderr_bytes = stderr_reader.join().unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout_bytes).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
    let detail = if stdout.is_empty() {
        stderr.clone()
    } else if stderr.is_empty() {
        stdout.clone()
    } else {
        format!("{}\n{}", stdout, stderr)
    };

    if !status.success() || detail.contains("Failed to authenticate") {
        if detail.contains("Failed to authenticate") || detail.contains("OAuth session expired") {
            return Err(
                "本机 Claude 登录态已过期：请先在 Claude Code 里重新登录，或配置 ANTHROPIC_API_KEY"
                    .into(),
            );
        }
        let short: String = detail.chars().take(300).collect();
        return Err(format!("Claude Code 调用失败：{}", short));
    }
    if stdout.is_empty() {
        return Err("Claude Code 调用失败：无输出".into());
    }
    Ok(stdout)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            tray::create_tray(app)?;
            timeline::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_main_window,
            pet_drag_start,
            launch_app,
            system_action,
            get_active_window_info,
            check_local_claude,
            run_local_claude,
            control::run_shell,
            control::fs_list,
            control::fs_read,
            control::fs_write,
            control::list_windows,
            control::window_action,
            control::ui_snapshot,
            control::mouse_click,
            control::mouse_scroll,
            control::key_press,
            control::type_text,
            timeline::timeline_configure,
            timeline::timeline_query,
            timeline::timeline_status,
            timeline::timeline_clear,
            timeline::clipboard_read,
            claude_code::claude_run,
            claude_code::claude_cancel,
            claude_code::claude_tool_result,
            claude_code::check_codebuddy,
            ai_apps::ai_apps,
            ai_apps::open_in_trae,
            ai_apps::open_workbuddy,
            ocr::ocr_window,
            mcp_client::mcp_stdio_request,
            mcp_client::mcp_stdio_stop,
            mcp_client::mcp_stdio_running
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // 退出时结束外部 MCP 服务进程，免得留下没人管的 node / python 进程
            if let tauri::RunEvent::Exit = event {
                mcp_client::stop_all();
            }
        });
}
