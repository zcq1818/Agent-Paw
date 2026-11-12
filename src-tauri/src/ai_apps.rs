//! 交接给本机其它 AI 软件：用它们官方提供的启动方式打开，不调用任何内部接口。
//! - Trae：安装目录 bin\ 下的官方命令行启动器（trae-cn.cmd 等），支持打开文件夹、--goto 文件:行；
//! - WorkBuddy：直接启动桌面程序。
//! 安装位置从 Windows「已安装的应用」注册表里读取。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct AiApp {
    kind: String,
    name: String,
    launcher: String,
}

/// 读取「已安装的应用」里的 Trae / WorkBuddy。脚本是固定的，不拼接任何外部输入。
fn installed() -> Vec<(String, String, String)> {
    let script = r#"
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$keys='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
Get-ItemProperty $keys | Where-Object { $_.DisplayName -match 'TRAE|WorkBuddy' } | ForEach-Object { "$($_.DisplayName)`t$($_.InstallLocation)`t$($_.DisplayIcon)" }
"#;
    let output = crate::hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output();
    let Ok(output) = output else { return Vec::new() };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            Some((parts.next()?.trim().to_string(), parts.next()?.trim().to_string(), parts.next().unwrap_or("").trim().to_string()))
        })
        .collect()
}

fn icon_exe(icon: &str) -> Option<PathBuf> {
    let path = icon.trim_matches('"').split(',').next()?.trim().trim_matches('"').to_string();
    let path = PathBuf::from(path);
    path.is_file().then_some(path)
}

fn trae_launcher(location: &str, icon: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if !location.is_empty() {
        dirs.push(PathBuf::from(location));
    }
    if let Some(exe) = icon_exe(icon) {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    for dir in dirs {
        let bin = dir.join("bin");
        if let Ok(entries) = std::fs::read_dir(&bin) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("cmd")).unwrap_or(false) {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// 启动其它软件时脱离桌宠的进程树：桌宠重启 / 退出时不会把 Trae、WorkBuddy 一起带走。
/// 所在的作业对象不允许脱离时，退回普通启动。
fn spawn_detached(mut cmd: std::process::Command, hidden: bool) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        let base = if hidden { CREATE_NO_WINDOW } else { 0 } | CREATE_NEW_PROCESS_GROUP;
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(base);
    }
    cmd.spawn().map(|_| ())
}

fn list_apps() -> Vec<AiApp> {
    let mut apps = Vec::new();
    for (name, location, icon) in installed() {
        if name.to_lowercase().contains("trae") {
            if let Some(launcher) = trae_launcher(&location, &icon) {
                apps.push(AiApp { kind: "trae".into(), name, launcher: launcher.to_string_lossy().to_string() });
            }
        } else if name.to_lowercase().contains("workbuddy") {
            let exe = icon_exe(&icon).or_else(|| {
                let candidate = Path::new(&location).join("WorkBuddy.exe");
                candidate.is_file().then_some(candidate)
            });
            if let Some(exe) = exe {
                apps.push(AiApp { kind: "workbuddy".into(), name, launcher: exe.to_string_lossy().to_string() });
            }
        }
    }
    apps
}

#[tauri::command]
pub async fn ai_apps() -> Result<Vec<AiApp>, String> {
    tauri::async_runtime::spawn_blocking(list_apps).await.map_err(|e| e.to_string())
}

/// 用 Trae 打开文件夹或文件；给了行号就跳到那一行。
#[tauri::command]
pub async fn open_in_trae(path: String, line: Option<u32>, name: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = crate::control::expand_user_path(&path);
        if !Path::new(&target).exists() {
            return Err(format!("路径不存在：{target}"));
        }
        let apps: Vec<AiApp> = list_apps().into_iter().filter(|a| a.kind == "trae").collect();
        let app = match name.as_deref().filter(|n| !n.trim().is_empty()) {
            Some(wanted) => apps.iter().find(|a| a.name.to_lowercase().contains(&wanted.to_lowercase())).or(apps.first()),
            None => apps.first(),
        }
        .cloned()
        .ok_or("没有找到已安装的 Trae")?;
        let mut cmd = std::process::Command::new(&app.launcher);
        cmd.arg("-r");
        match line {
            Some(line) if Path::new(&target).is_file() => {
                cmd.arg("--goto").arg(format!("{target}:{line}"));
            }
            _ => {
                cmd.arg(&target);
            }
        }
        spawn_detached(cmd, true).map_err(|e| format!("启动 {} 失败：{e}", app.name))?;
        Ok(format!("已用 {} 打开 {target}", app.name))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_workbuddy() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let app = list_apps().into_iter().find(|a| a.kind == "workbuddy").ok_or("没有找到已安装的 WorkBuddy")?;
        spawn_detached(std::process::Command::new(&app.launcher), false)
            .map_err(|e| format!("启动 WorkBuddy 失败：{e}"))?;
        Ok(format!("已打开 {}", app.name))
    })
    .await
    .map_err(|e| e.to_string())?
}
