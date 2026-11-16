//! 快捷启动器：按快捷键呼出搜索框，输入几个字就能打开本机软件。
//!
//! 软件列表来自开始菜单（Get-StartApps，桌面软件和商店应用都在里面），图标从快捷方式指向的 exe
//! 或商店应用的 logo 里取。第一次建索引要十几秒，结果缓存在 launcher_apps.json，之后秒开，后台再刷新。
//! 打开软件统一用 explorer shell:AppsFolder\<AppID>，和从开始菜单点开完全一样。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct LauncherApp {
    name: String,
    id: String,
    #[serde(default)]
    path: String,
    /// PNG 的 base64，没有就是空
    #[serde(default)]
    icon: String,
}

const SCAN_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$shell = New-Object -ComObject WScript.Shell
$dirs = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs", [Environment]::GetFolderPath('Desktop'), "$env:PUBLIC\Desktop")
$lnkByName = @{}
foreach ($d in $dirs) {
  Get-ChildItem -LiteralPath $d -Recurse -Include *.lnk -File | ForEach-Object {
    if (-not $lnkByName.ContainsKey($_.BaseName)) { $lnkByName[$_.BaseName] = $_.FullName }
  }
}
$pkgs = @{}
Get-AppxPackage | ForEach-Object { $pkgs[$_.PackageFamilyName] = $_ }
function Icon-FromExe($p) {
  $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
  if (-not $ic) { return '' }
  $bmp = $ic.ToBitmap(); $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return [Convert]::ToBase64String($ms.ToArray())
}
function Icon-FromPackage($appId) {
  $fam = $appId.Split('!')[0]
  $pkg = $pkgs[$fam]
  if (-not $pkg) { return '' }
  $manifest = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
  $text = Get-Content -LiteralPath $manifest -Raw
  if ($text -notmatch 'Square44x44Logo="([^"]+)"') { if ($text -notmatch '<Logo>([^<]+)</Logo>') { return '' } }
  $logo = Join-Path $pkg.InstallLocation $Matches[1]
  $dir = Split-Path $logo
  $stem = [IO.Path]::GetFileNameWithoutExtension($logo)
  $files = Get-ChildItem -LiteralPath $dir -Filter "$stem*.png" -File
  $pick = ($files | Where-Object { $_.Name -match 'targetsize-32(_altform-unplated)?\.png$' } | Select-Object -First 1)
  if (-not $pick) { $pick = ($files | Where-Object { $_.Name -match 'targetsize-48' } | Select-Object -First 1) }
  if (-not $pick) { $pick = ($files | Where-Object { $_.Name -match 'scale-100' } | Select-Object -First 1) }
  if (-not $pick) { $pick = ($files | Sort-Object Length | Select-Object -First 1) }
  if (-not $pick -or $pick.Length -gt 60000) { return '' }
  return [Convert]::ToBase64String([IO.File]::ReadAllBytes($pick.FullName))
}
$seen = @{}
$out = New-Object System.Collections.ArrayList
foreach ($a in Get-StartApps) {
  $path = ''
  $lnk = $lnkByName[$a.Name]
  if ($lnk) {
    $t = $shell.CreateShortcut($lnk).TargetPath
    if ($t -and (Test-Path -LiteralPath $t)) { $path = $t }
  } elseif ($a.AppID -match '^[A-Za-z]:\\' -and (Test-Path -LiteralPath $a.AppID)) { $path = $a.AppID }
  $key = ($a.Name + '|' + $path).ToLower()
  if ($path -and $seen.ContainsKey($key)) { continue }
  $seen[$key] = 1
  $icon = ''
  if ($path -match '\.exe$') { $icon = Icon-FromExe $path }
  elseif ($a.AppID -match '!') { $icon = Icon-FromPackage $a.AppID }
  [void]$out.Add([pscustomobject]@{ name = $a.Name; id = $a.AppID; path = $path; icon = $icon })
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
"#;

fn cache_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::data_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("launcher_apps.json"))
}

fn scan() -> Result<Vec<LauncherApp>, String> {
    let output = crate::hidden_command("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", SCAN_SCRIPT])
        .output()
        .map_err(|e| format!("读取软件列表失败：{e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let start = text.find('[').ok_or("没有读到软件列表")?;
    serde_json::from_str::<Vec<LauncherApp>>(text[start..].trim()).map_err(|e| format!("解析软件列表失败：{e}"))
}

/// 返回软件列表：有缓存且不要求刷新时直接用缓存。
#[tauri::command]
pub async fn launcher_apps(app: AppHandle, refresh: Option<bool>) -> Result<Vec<LauncherApp>, String> {
    let file = cache_file(&app)?;
    if !refresh.unwrap_or(false) {
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(list) = serde_json::from_str::<Vec<LauncherApp>>(&text) {
                if !list.is_empty() {
                    return Ok(list);
                }
            }
        }
    }
    let list = tauri::async_runtime::spawn_blocking(scan).await.map_err(|e| e.to_string())??;
    if let Ok(json) = serde_json::to_string(&list) {
        let _ = std::fs::write(&file, json);
    }
    Ok(list)
}

/// 缓存文件的修改时间（毫秒），前端用来决定要不要后台刷新。
#[tauri::command]
pub fn launcher_cache_age(app: AppHandle) -> Option<i64> {
    let modified = std::fs::metadata(cache_file(&app).ok()?).ok()?.modified().ok()?;
    let elapsed = std::time::SystemTime::now().duration_since(modified).ok()?;
    Some(elapsed.as_millis() as i64)
}

/// 打开一个软件（和从开始菜单点开一样）。
#[tauri::command]
pub fn launcher_open(id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() || id.chars().any(|c| c.is_control() || c == '"') {
        return Err("无效的软件".into());
    }
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg(format!("shell:AppsFolder\\{id}"));
    crate::ai_apps::spawn_detached(cmd, false).map_err(|e| format!("打开失败：{e}"))
}

/// 呼出 / 收起启动器窗口。呼出时放在鼠标所在屏幕的上三分之一处。
#[tauri::command]
pub fn toggle_launcher(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("launcher").ok_or("启动器窗口不存在")?;
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
        return Ok(());
    }
    if let Ok(cursor) = app.cursor_position() {
        let monitors = window.available_monitors().unwrap_or_default();
        let monitor = monitors.iter().find(|m| {
            let p = m.position();
            let s = m.size();
            cursor.x >= p.x as f64 && cursor.x < (p.x + s.width as i32) as f64 && cursor.y >= p.y as f64 && cursor.y < (p.y + s.height as i32) as f64
        });
        if let (Some(monitor), Ok(size)) = (monitor.or(monitors.first()), window.outer_size()) {
            let area = monitor.work_area();
            let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
            let y = area.position.y + area.size.height as i32 / 5;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("launcher-shown", ());
    Ok(())
}
