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
            get_active_window_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
