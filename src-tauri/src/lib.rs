use std::process::Command;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use serde::Serialize;

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
            .inner_size(480.0, 640.0)
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

#[tauri::command]
fn launch_app(target: String) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("目标不能为空".into());
    }

    let target_lower = target.to_lowercase();
    let (program, args): (&str, Vec<&str>) = match target_lower.as_str() {
        "notepad" | "记事本" => ("notepad.exe", vec![]),
        "calculator" | "calc" | "计算器" => ("calc.exe", vec![]),
        "explorer" | "file explorer" | "资源管理器" => ("explorer.exe", vec![]),
        "task manager" | "taskmgr" | "任务管理器" => ("taskmgr.exe", vec![]),
        "paint" | "mspaint" | "画图" => ("mspaint.exe", vec![]),
        "terminal" | "cmd" | "命令行" => ("cmd.exe", vec!["/K"]),
        "settings" | "设置" | "系统设置" => ("cmd.exe", vec!["/C", "start", "", "ms-settings:"]),
        _ => {
            if target.starts_with("http://") || target.starts_with("https://") || target.starts_with("mailto:") {
                ("cmd.exe", vec!["/C", "start", "", target])
            } else if target.contains(':') || target.contains('\\') || target.ends_with(".exe") {
                ("cmd.exe", vec!["/C", "start", "", target])
            } else {
                ("cmd.exe", vec!["/C", "start", "", target])
            }
        }
    };

    Command::new(program)
        .args(args)
        .spawn()
        .map_err(|error| format!("启动失败: {error}"))?;

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
            if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
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
    // 先看 PATH。
    if std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map(|result| result.status.success())
        .unwrap_or(false)
    {
        return "claude".to_string();
    }
    // Claude Code 桌面版会把 CLI 放在版本目录里，通常不在 PATH。
    if let Ok(profile) = std::env::var("USERPROFILE") {
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

/// 检测本机 Claude Code CLI。前端可传入显式路径（CLI 常常不在 PATH 里）。
#[tauri::command]
fn check_local_claude(path: Option<String>) -> Result<LocalClaudeStatus, String> {
    let binary = claude_binary(path);
    match std::process::Command::new(&binary).arg("--version").output() {
        Ok(result) if result.status.success() => Ok(LocalClaudeStatus {
            available: true,
            version: String::from_utf8_lossy(&result.stdout).trim().to_string(),
            path: binary,
            detail: "本机 Claude Code CLI 可用（复用已登录凭据）".into(),
        }),
        Ok(result) => Ok(LocalClaudeStatus {
            available: false,
            version: String::new(),
            path: binary,
            detail: String::from_utf8_lossy(&result.stderr).trim().to_string(),
        }),
        Err(error) => Ok(LocalClaudeStatus {
            available: false,
            version: String::new(),
            path: binary,
            detail: format!("未找到可执行文件：{}", error),
        }),
    }
}

/// 无头调用本机 Claude Code。刻意不加 --bare：这样会复用本机登录态、
/// MCP 配置与 CLAUDE.md，而不是要求另配 ANTHROPIC_API_KEY。
#[tauri::command]
fn run_local_claude(
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
    let allowed = allow_tools.unwrap_or_else(|| "Read".to_string());

    let mut child = std::process::Command::new(&binary)
        .args(["-p", trimmed, "--output-format", "text", "--allowedTools", &allowed])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 Claude Code 失败：{}", error))?;

    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(180);
    loop {
        if child.try_wait().map_err(|error| error.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            return Err("本机 Claude 调用超时（180 秒）".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stdout.is_empty() {
        stderr.clone()
    } else if stderr.is_empty() {
        stdout.clone()
    } else {
        format!("{}\n{}", stdout, stderr)
    };

    if !output.status.success() || detail.contains("Failed to authenticate") {
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            tray::create_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_main_window,
            pet_drag_start,
            launch_app,
            system_action,
            get_active_window_info,
            check_local_claude,
            run_local_claude
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
