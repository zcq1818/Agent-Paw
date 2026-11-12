//! 电脑控制：命令行、文件、窗口、鼠标键盘、界面元素（UI Automation）。
//!
//! 这里只负责“能做”，要不要做由前端的审批策略决定（src/agent/computer.ts）。
//! 坐标统一用物理像素：Tauri 进程是 Per-Monitor DPI Aware，
//! SetCursorPos / GetWindowRect / UI Automation 的包围盒都在同一坐标系里，多显示器负坐标也能用。

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|error| format!("后台任务失败: {error}"))?
    }
}

fn clip(text: String, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text;
    }
    let head: String = text.chars().take(max * 2 / 3).collect();
    let tail: String = text.chars().skip(count - max / 3).collect();
    format!("{head}\n…（中间省略 {} 个字符）…\n{tail}", count - max)
}

/// 展开 ~ 和 %VAR% / $env:VAR，方便模型直接写 “~/Desktop”。
/// 展开 ~ 和 %VAR% 后的路径字符串（给其它模块用）。
pub(crate) fn expand_user_path(input: &str) -> String {
    expand_path(input).to_string_lossy().to_string()
}

fn expand_path(input: &str) -> PathBuf {
    let mut text = input.trim().trim_matches('"').to_string();
    if text == "~" || text.starts_with("~/") || text.starts_with("~\\") {
        if let Ok(home) = std::env::var("USERPROFILE") {
            text = format!("{home}{}", &text[1..]);
        }
    }
    // %VAR%
    while let Some(start) = text.find('%') {
        let Some(len) = text[start + 1..].find('%') else { break };
        let name = &text[start + 1..start + 1 + len];
        let value = std::env::var(name).unwrap_or_default();
        text = format!("{}{}{}", &text[..start], value, &text[start + 2 + len..]);
    }
    PathBuf::from(text)
}

// ------------------------------------------------------------------ 命令行

#[derive(Serialize)]
pub struct ShellResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    duration_ms: u128,
}

fn base64_utf16le(text: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = text.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 在 PowerShell 里执行一段脚本。用 -EncodedCommand 传递，避免引号转义问题；输出强制 UTF-8，
/// Get-Content / Set-Content / Out-File 也默认 UTF-8（PowerShell 5.1 默认按 ANSI 读写，中文会乱码）。
#[tauri::command]
pub async fn run_shell(command: String, cwd: Option<String>, timeout_ms: Option<u64>) -> Result<ShellResult, String> {
    blocking(move || {
        let script = format!(
            "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$PSDefaultParameterValues['*:Encoding']='utf8';\n{command}"
        );
        let mut cmd = crate::hidden_command("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &base64_utf16le(&script)])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = cwd.filter(|dir| !dir.trim().is_empty()) {
            cmd.current_dir(expand_path(&dir));
        } else if let Ok(home) = std::env::var("USERPROFILE") {
            cmd.current_dir(home);
        }
        let started = Instant::now();
        let mut child = cmd.spawn().map_err(|error| format!("无法启动 PowerShell: {error}"))?;
        // 必须并发读管道，否则输出超过管道缓冲区（约 4KB）时子进程会卡住。
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let out_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            buf
        });
        let err_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            buf
        });
        let limit = Duration::from_millis(timeout_ms.unwrap_or(60_000).clamp(1_000, 600_000));
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                break Some(status);
            }
            if started.elapsed() > limit {
                timed_out = true;
                // 连同子进程一起结束
                let _ = crate::hidden_command("taskkill.exe")
                    .args(["/T", "/F", "/PID", &child.id().to_string()])
                    .status();
                let _ = child.kill();
                break child.wait().ok();
            }
            std::thread::sleep(Duration::from_millis(40));
        };
        let stdout = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).trim_end().to_string();
        let stderr = String::from_utf8_lossy(&err_thread.join().unwrap_or_default()).trim_end().to_string();
        Ok(ShellResult {
            code: status.and_then(|status| status.code()),
            stdout: clip(stdout, 12_000),
            stderr: clip(stderr, 4_000),
            timed_out,
            duration_ms: started.elapsed().as_millis(),
        })
    })
    .await
}

// ------------------------------------------------------------------ 文件

#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
pub struct DirListing {
    path: String,
    entries: Vec<FileEntry>,
    truncated: bool,
}

#[tauri::command]
pub async fn fs_list(path: String) -> Result<DirListing, String> {
    blocking(move || {
        let dir = expand_path(&path);
        let read = std::fs::read_dir(&dir).map_err(|error| format!("无法读取目录 {}: {error}", dir.display()))?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in read.flatten() {
            if entries.len() >= 500 {
                truncated = true;
                break;
            }
            let meta = entry.metadata().ok();
            entries.push(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            });
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(DirListing { path: dir.display().to_string(), entries, truncated })
    })
    .await
}

#[derive(Serialize)]
pub struct FileContent {
    path: String,
    content: String,
    size: u64,
    truncated: bool,
}

#[tauri::command]
pub async fn fs_read(path: String, max_chars: Option<usize>) -> Result<FileContent, String> {
    blocking(move || {
        let file = expand_path(&path);
        let meta = std::fs::metadata(&file).map_err(|error| format!("无法读取 {}: {error}", file.display()))?;
        if meta.is_dir() {
            return Err("这是一个目录，请用列目录工具".into());
        }
        let mut handle = std::fs::File::open(&file).map_err(|error| error.to_string())?;
        let mut buf = Vec::new();
        handle.by_ref().take(4 * 1024 * 1024).read_to_end(&mut buf).map_err(|error| error.to_string())?;
        if buf.iter().take(8000).any(|b| *b == 0) {
            return Err("这是二进制文件，不能按文本读取".into());
        }
        let text = String::from_utf8_lossy(&buf).to_string();
        let max = max_chars.unwrap_or(20_000).clamp(500, 200_000);
        let truncated = text.chars().count() > max || meta.len() > buf.len() as u64;
        Ok(FileContent {
            path: file.display().to_string(),
            content: clip(text, max),
            size: meta.len(),
            truncated,
        })
    })
    .await
}

#[tauri::command]
pub async fn fs_write(path: String, content: String, append: Option<bool>) -> Result<String, String> {
    blocking(move || {
        let file = expand_path(&path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录: {error}"))?;
        }
        if append.unwrap_or(false) {
            use std::io::Write;
            let mut handle = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .map_err(|error| error.to_string())?;
            handle.write_all(content.as_bytes()).map_err(|error| error.to_string())?;
        } else {
            std::fs::write(&file, content.as_bytes()).map_err(|error| error.to_string())?;
        }
        Ok(format!("已写入 {}（{} 字节）", file.display(), content.len()))
    })
    .await
}

#[allow(dead_code)]
fn is_inside(path: &Path, base: &Path) -> bool {
    path.starts_with(base)
}

// ------------------------------------------------------------------ 窗口

#[derive(Serialize, Clone)]
pub struct WindowInfo {
    id: i64,
    title: String,
    process: String,
    pid: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    minimized: bool,
    foreground: bool,
}

#[cfg(windows)]
mod win {
    use super::WindowInfo;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, MAX_PATH, RECT};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    pub fn hwnd(id: i64) -> HWND {
        id as isize as *mut c_void
    }

    pub fn process_name(pid: u32) -> String {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return String::new();
            }
            let mut buf = vec![0u16; MAX_PATH as usize];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 {
                return String::new();
            }
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
        }
    }

    pub fn info(h: HWND) -> Option<WindowInfo> {
        unsafe {
            if IsWindowVisible(h) == 0 {
                return None;
            }
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW != 0 {
                return None;
            }
            let len = GetWindowTextLengthW(h);
            if len <= 0 {
                return None;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let read = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
            let title = String::from_utf16_lossy(&buf[..read.max(0) as usize]);
            let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(h, &mut rect);
            let minimized = IsIconic(h) != 0;
            if !minimized && (rect.right - rect.left < 40 || rect.bottom - rect.top < 30) {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            Some(WindowInfo {
                id: h as isize as i64,
                title,
                process: process_name(pid),
                pid,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                minimized,
                foreground: GetForegroundWindow() == h,
            })
        }
    }

    unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> i32 {
        let list = &mut *(lparam as *mut Vec<WindowInfo>);
        if let Some(info) = info(h) {
            list.push(info);
        }
        1
    }

    /// 按 Z 序（从最上层开始）列出可见的顶层窗口，排除桌宠自己的窗口。
    pub fn list() -> Vec<WindowInfo> {
        let mut list: Vec<WindowInfo> = Vec::new();
        unsafe {
            EnumWindows(Some(collect), &mut list as *mut Vec<WindowInfo> as LPARAM);
        }
        let own = std::process::id();
        list.into_iter()
            .filter(|w| w.pid != own && w.process.to_lowercase() != "textinputhost.exe")
            .collect()
    }

    pub fn focus(h: HWND) -> bool {
        unsafe {
            if IsIconic(h) != 0 {
                ShowWindow(h, SW_RESTORE);
            }
            if SetForegroundWindow(h) != 0 && GetForegroundWindow() == h {
                return true;
            }
            // 前台锁：模拟一次 Alt 按键后再切，系统才允许把别的进程窗口放到前台。
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU};
            keybd_event(VK_MENU as u8, 0, 0, 0);
            keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
            SetForegroundWindow(h);
            BringWindowToTop(h);
            GetForegroundWindow() == h
        }
    }

    pub fn action(h: HWND, action: &str) -> Result<(), String> {
        unsafe {
            if IsWindow(h) == 0 {
                return Err("窗口不存在（可能已关闭），请重新列出窗口".into());
            }
            match action {
                "focus" | "activate" => {
                    if !focus(h) {
                        return Err("系统拒绝切换到该窗口".into());
                    }
                }
                "minimize" => {
                    ShowWindow(h, SW_MINIMIZE);
                }
                "maximize" => {
                    ShowWindow(h, SW_MAXIMIZE);
                }
                "restore" => {
                    ShowWindow(h, SW_RESTORE);
                }
                "close" => {
                    PostMessageW(h, WM_CLOSE, 0, 0);
                }
                other => return Err(format!("不支持的窗口操作：{other}")),
            }
        }
        Ok(())
    }

    pub fn set_cursor(x: i32, y: i32) {
        unsafe {
            SetCursorPos(x, y);
        }
    }

    /// 锁屏 / UAC 安全桌面时前台窗口为空，系统会拦截所有模拟输入。
    pub fn desktop_locked() -> bool {
        unsafe {
            let h = GetForegroundWindow();
            if h.is_null() {
                return true;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            let name = process_name(pid).to_lowercase();
            name == "lockapp.exe" || name == "logonui.exe"
        }
    }

    pub fn foreground_title() -> String {
        unsafe {
            let h = GetForegroundWindow();
            if h.is_null() {
                return String::new();
            }
            info(h).map(|w| format!("{}（{}）", w.title, w.process)).unwrap_or_default()
        }
    }
}

/// 按 id 找窗口（为空用最上层的可见窗口），返回句柄和 (id, 标题)。给看图找字用。
#[cfg(windows)]
pub(crate) fn resolve_window(id: Option<i64>) -> Result<(windows_sys::Win32::Foundation::HWND, (i64, String)), String> {
    let info = match id {
        Some(id) if id != 0 => win::info(win::hwnd(id)).ok_or("窗口不存在或不可见，请重新列出窗口")?,
        _ => win::list().into_iter().find(|w| !w.minimized).ok_or("没有找到可读取的窗口")?,
    };
    if info.minimized {
        win::action(win::hwnd(info.id), "restore")?;
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    Ok((win::hwnd(info.id), (info.id, info.title.clone())))
}

/// 把窗口切到最前面（看图找字截图前用）。
#[cfg(windows)]
pub(crate) fn bring_to_front(h: windows_sys::Win32::Foundation::HWND) -> bool {
    win::focus(h)
}

/// 是否处于锁屏 / 安全桌面（给时间线记录器用）。
#[cfg(windows)]
pub(crate) fn desktop_locked() -> bool {
    win::desktop_locked()
}

#[tauri::command]
pub async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    #[cfg(windows)]
    {
        blocking(|| Ok(win::list())).await
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows".into())
    }
}

#[tauri::command]
pub async fn window_action(id: i64, action: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        blocking(move || {
            win::action(win::hwnd(id), action.trim())?;
            std::thread::sleep(Duration::from_millis(250));
            Ok(format!("完成。当前前台窗口：{}", win::foreground_title()))
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (id, action);
        Err("仅支持 Windows".into())
    }
}

// ------------------------------------------------------------------ 界面元素（UI Automation）

#[derive(Serialize, Clone)]
pub struct UiNode {
    id: usize,
    role: String,
    name: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    enabled: bool,
    depth: usize,
}

#[derive(Serialize)]
pub struct UiSnapshot {
    window: Option<WindowInfo>,
    nodes: Vec<UiNode>,
    truncated: bool,
}

/// 最近一次读取到的元素位置（窗口句柄 + 每个元素的矩形），点击时按编号取中心点。
static UI_CACHE: Mutex<(i64, Vec<[i32; 4]>)> = Mutex::new((0, Vec::new()));

#[cfg(windows)]
fn snapshot_window(id: i64, max_nodes: usize) -> Result<UiSnapshot, String> {
    use uiautomation::types::ControlType;
    use uiautomation::{UIAutomation, UIElement, UITreeWalker};

    const INTERACTIVE: &[ControlType] = &[
        ControlType::Button,
        ControlType::Edit,
        ControlType::MenuItem,
        ControlType::ListItem,
        ControlType::TabItem,
        ControlType::Hyperlink,
        ControlType::CheckBox,
        ControlType::RadioButton,
        ControlType::ComboBox,
        ControlType::TreeItem,
        ControlType::SplitButton,
        ControlType::Document,
        ControlType::DataItem,
        ControlType::Slider,
        ControlType::MenuBar,
    ];

    fn walk(walker: &UITreeWalker, element: &UIElement, depth: usize, out: &mut Vec<UiNode>, rects: &mut Vec<[i32; 4]>, max: usize) -> bool {
        if depth > 40 {
            return false;
        }
        let mut child = walker.get_first_child(element);
        while let Ok(current) = child {
            if out.len() >= max {
                return true;
            }
            let offscreen = current.is_offscreen().unwrap_or(false);
            if !offscreen {
                if let Ok(rect) = current.get_bounding_rectangle() {
                    let (x, y) = (rect.get_left(), rect.get_top());
                    let (w, h) = (rect.get_right() - x, rect.get_bottom() - y);
                    let control = current.get_control_type().ok();
                    let name: String = current.get_name().unwrap_or_default().trim().chars().take(80).collect();
                    let interactive = control.map(|c| INTERACTIVE.contains(&c)).unwrap_or(false);
                    let text_like = matches!(control, Some(ControlType::Text)) && !name.is_empty();
                    if w > 2 && h > 2 && (interactive || text_like) {
                        let role = current
                            .get_localized_control_type()
                            .ok()
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| control.map(|c| format!("{c:?}")).unwrap_or_default());
                        rects.push([x, y, w, h]);
                        out.push(UiNode {
                            id: out.len() + 1,
                            role,
                            name,
                            x,
                            y,
                            width: w,
                            height: h,
                            enabled: current.is_enabled().unwrap_or(true),
                            depth,
                        });
                    }
                }
            }
            if walk(walker, &current, depth + 1, out, rects, max) {
                return true;
            }
            child = walker.get_next_sibling(&current);
        }
        false
    }

    let automation = UIAutomation::new().map_err(|error| format!("UI Automation 初始化失败: {error}"))?;
    let hwnd = windows::Win32::Foundation::HWND(id as isize as *mut std::ffi::c_void);
    let root = automation
        .element_from_handle(hwnd.into())
        .map_err(|error| format!("读取窗口失败: {error}"))?;
    let walker = automation.get_control_view_walker().map_err(|error| error.to_string())?;
    let mut nodes = Vec::new();
    let mut rects = Vec::new();
    let truncated = walk(&walker, &root, 0, &mut nodes, &mut rects, max_nodes);
    *UI_CACHE.lock().unwrap() = (id, rects);
    let window = win::info(win::hwnd(id));
    Ok(UiSnapshot { window, nodes, truncated })
}

/// 读取窗口里可操作的界面元素。不传 id 时取最上层的非桌宠窗口。
#[tauri::command]
pub async fn ui_snapshot(id: Option<i64>, max_nodes: Option<usize>) -> Result<UiSnapshot, String> {
    #[cfg(windows)]
    {
        blocking(move || {
            let target = match id {
                Some(id) if id != 0 => id,
                _ => win::list()
                    .into_iter()
                    .find(|w| !w.minimized)
                    .map(|w| w.id)
                    .ok_or("没有找到可读取的窗口")?,
            };
            let limit = max_nodes.unwrap_or(220).clamp(20, 600);
            let first = snapshot_window(target, limit)?;
            // Chromium / Electron（浏览器、Claude、VS Code、飞书……）第一次被 UI Automation
            // 访问时才开启无障碍树，首次只能读到标题栏按钮。稍等一下再读一次。
            if first.nodes.len() <= 5 {
                std::thread::sleep(std::time::Duration::from_millis(900));
                if let Ok(second) = snapshot_window(target, limit) {
                    if second.nodes.len() > first.nodes.len() {
                        return Ok(second);
                    }
                }
            }
            Ok(first)
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (id, max_nodes);
        Err("仅支持 Windows".into())
    }
}

// ------------------------------------------------------------------ 鼠标键盘

/// 模拟输入前检查：锁屏时给出明确提示，而不是“UIPI 拦截”这种看不懂的错误。
fn ensure_input_available() -> Result<(), String> {
    #[cfg(windows)]
    if win::desktop_locked() {
        return Err("电脑处于锁屏或安全桌面（如 UAC 提示），系统不允许模拟鼠标键盘。请解锁后再试。".into());
    }
    Ok(())
}

fn input_error(error: impl std::fmt::Display) -> String {
    let text = error.to_string();
    if text.contains("UIPI") {
        "输入被系统拦截：前台是管理员权限的窗口，或屏幕已锁定。可以先切到普通窗口，或以管理员身份运行 Paw。".into()
    } else {
        text
    }
}

fn enigo() -> Result<enigo::Enigo, String> {
    enigo::Enigo::new(&enigo::Settings::default()).map_err(|error| format!("无法初始化输入模拟: {error}"))
}

fn parse_button(button: Option<&str>) -> enigo::Button {
    match button.unwrap_or("left") {
        "right" => enigo::Button::Right,
        "middle" => enigo::Button::Middle,
        _ => enigo::Button::Left,
    }
}

fn click_at(x: i32, y: i32, button: Option<String>, double: bool) -> Result<(), String> {
    use enigo::{Direction, Mouse};
    ensure_input_available()?;
    #[cfg(windows)]
    win::set_cursor(x, y);
    #[cfg(not(windows))]
    enigo()?.move_mouse(x, y, enigo::Coordinate::Abs).map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(40));
    let mut input = enigo()?;
    let btn = parse_button(button.as_deref());
    input.button(btn, Direction::Click).map_err(input_error)?;
    if double {
        std::thread::sleep(Duration::from_millis(60));
        input.button(btn, Direction::Click).map_err(input_error)?;
    }
    Ok(())
}

fn after_action_status() -> String {
    std::thread::sleep(Duration::from_millis(350));
    #[cfg(windows)]
    {
        format!("当前前台窗口：{}", win::foreground_title())
    }
    #[cfg(not(windows))]
    {
        String::new()
    }
}

/// 点击：传 element（最近一次 ui_snapshot 的编号）或 x/y 物理像素坐标。
#[tauri::command]
pub async fn mouse_click(
    element: Option<usize>,
    x: Option<i32>,
    y: Option<i32>,
    button: Option<String>,
    double: Option<bool>,
) -> Result<String, String> {
    blocking(move || {
        let (px, py, desc) = match element {
            Some(index) if index > 0 => {
                let (window, rects) = UI_CACHE.lock().unwrap().clone();
                let rect = rects.get(index - 1).ok_or("元素编号无效，请先重新读取界面")?;
                #[cfg(windows)]
                if window != 0 {
                    win::focus(win::hwnd(window));
                }
                let _ = window;
                (rect[0] + rect[2] / 2, rect[1] + rect[3] / 2, format!("元素 #{index}"))
            }
            _ => {
                let (Some(x), Some(y)) = (x, y) else { return Err("需要元素编号或 x、y 坐标".into()) };
                (x, y, format!("坐标 ({x}, {y})"))
            }
        };
        click_at(px, py, button, double.unwrap_or(false))?;
        Ok(format!("已点击{desc}。{}", after_action_status()))
    })
    .await
}

#[tauri::command]
pub async fn mouse_scroll(amount: i32, x: Option<i32>, y: Option<i32>, element: Option<usize>) -> Result<String, String> {
    use enigo::{Axis, Mouse};
    blocking(move || {
        if let Some(index) = element.filter(|i| *i > 0) {
            let (_, rects) = UI_CACHE.lock().unwrap().clone();
            if let Some(rect) = rects.get(index - 1) {
                #[cfg(windows)]
                win::set_cursor(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2);
            }
        } else if let (Some(x), Some(y)) = (x, y) {
            #[cfg(windows)]
            win::set_cursor(x, y);
        }
        ensure_input_available()?;
        std::thread::sleep(Duration::from_millis(30));
        enigo()?.scroll(amount.clamp(-50, 50), Axis::Vertical).map_err(input_error)?;
        Ok(format!("已滚动 {amount}。"))
    })
    .await
}

fn parse_key(name: &str) -> Result<enigo::Key, String> {
    use enigo::Key;
    let lower = name.trim().to_lowercase();
    Ok(match lower.as_str() {
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" => Key::Alt,
        "win" | "windows" | "meta" | "super" | "cmd" => Key::Meta,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "pgup" => Key::PageUp,
        "pagedown" | "pgdn" => Key::PageDown,
        "capslock" => Key::CapsLock,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Unicode(c),
                _ => return Err(format!("不认识的按键：{name}")),
            }
        }
    })
}

/// 按组合键，例如 "ctrl+s"、"alt+tab"、"win+d"、"enter"。多组用空格分隔会依次按下。
#[tauri::command]
pub async fn key_press(keys: String) -> Result<String, String> {
    use enigo::{Direction, Keyboard};
    blocking(move || {
        ensure_input_available()?;
        let mut input = enigo()?;
        for combo in keys.split_whitespace() {
            let parts: Vec<enigo::Key> = combo.split('+').filter(|p| !p.is_empty()).map(parse_key).collect::<Result<_, _>>()?;
            let Some((main, modifiers)) = parts.split_last() else { continue };
            for key in modifiers {
                input.key(*key, Direction::Press).map_err(input_error)?;
            }
            input.key(*main, Direction::Click).map_err(input_error)?;
            for key in modifiers.iter().rev() {
                input.key(*key, Direction::Release).map_err(input_error)?;
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        Ok(format!("已按下 {keys}。{}", after_action_status()))
    })
    .await
}

/// 输入文字（支持中文）。可先点击某个元素让它获得焦点。
#[tauri::command]
pub async fn type_text(text: String, element: Option<usize>) -> Result<String, String> {
    use enigo::Keyboard;
    if let Some(index) = element.filter(|i| *i > 0) {
        mouse_click(Some(index), None, None, None, None).await?;
    }
    blocking(move || {
        ensure_input_available()?;
        enigo()?.text(&text).map_err(input_error)?;
        Ok(format!("已输入 {} 个字符。{}", text.chars().count(), after_action_status()))
    })
    .await
}
