//! 数据放哪：
//! - 正式版（安装包）：放在程序旁边的 `data` 文件夹，比如装在 D:\Paw 就是 D:\Paw\data，
//!   聊天、记忆、设置（网页存储）和技能、时间线都在里面，整个文件夹一起走；
//! - 开发版，或者安装目录写不进去（比如装进了 Program Files）：仍然用系统默认的 AppData。
//!
//! 第一次以“放在安装目录”的方式启动时，会把 AppData 里的旧数据复制过来（只复制，不删旧的）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, Runtime};

static PORTABLE_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

const MIGRATED_MARKER: &str = ".migrated-from-appdata";

/// 网页缓存类的文件夹，搬家时跳过（会自动重建，又大又没用）
const SKIP_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "GrShaderCache",
    "ShaderCache",
    "CacheStorage",
    "ScriptCache",
    "Crashpad",
    "component_crx_cache",
    "extensions_crx_cache",
];

fn detect_portable_root() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("data");
    fs::create_dir_all(&dir).ok()?;
    // 确认真的能写
    let probe = dir.join(".write-test");
    fs::write(&probe, b"ok").ok()?;
    let _ = fs::remove_file(&probe);
    Some(dir)
}

/// 安装目录下的 data 文件夹；开发版或写不进去时为 None
pub fn portable_root() -> Option<&'static PathBuf> {
    PORTABLE_ROOT.get_or_init(detect_portable_root).as_ref()
}

/// 程序自己的数据文件夹（技能、时间线、启动器缓存……）
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    match portable_root() {
        Some(root) => Ok(root.clone()),
        None => app.path().app_data_dir().map_err(|e| e.to_string()),
    }
}

/// 网页存储（localStorage 等）放哪；None 表示用 Tauri 默认位置。所有窗口必须用同一个。
pub fn webview_dir() -> Option<PathBuf> {
    portable_root().map(|root| root.join("webview"))
}

/// 第一次用安装目录存数据时，把 AppData 里的旧数据复制过来
pub fn migrate_from_appdata<R: Runtime>(app: &AppHandle<R>) {
    let Some(root) = portable_root() else { return };
    let marker = root.join(MIGRATED_MARKER);
    if marker.exists() {
        return;
    }

    let mut copied = 0usize;
    // 技能、时间线、启动器缓存等（%APPDATA%\<id>）
    if let Ok(old) = app.path().app_data_dir() {
        if old.is_dir() && old != *root {
            copied += copy_tree(&old, root);
        }
    }
    // 网页存储：聊天、记忆、设置都在这里（%LOCALAPPDATA%\<id>\EBWebView）
    if let (Ok(old_local), Some(webview)) = (app.path().app_local_data_dir(), webview_dir()) {
        let old_profile = old_local.join("EBWebView");
        let new_profile = webview.join("EBWebView");
        if old_profile.is_dir() && !new_profile.exists() {
            copied += copy_tree(&old_profile, &new_profile);
        }
    }

    let note = format!(
        "从 AppData 复制了 {copied} 个文件。旧数据没有删除，确认这边一切正常后可以手动删掉：\r\n{}\r\n{}\r\n",
        app.path().app_data_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        app.path().app_local_data_dir().map(|p| p.display().to_string()).unwrap_or_default(),
    );
    let _ = fs::write(&marker, note);
}

/// 递归复制，已存在的文件不覆盖；单个文件失败就跳过。返回复制的文件数。
fn copy_tree(from: &Path, to: &Path) -> usize {
    let Ok(entries) = fs::read_dir(from) else { return 0 };
    if fs::create_dir_all(to).is_err() {
        return 0;
    }
    let mut count = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let src = entry.path();
        let dst = to.join(&name);
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if SKIP_DIRS.iter().any(|skip| name.to_string_lossy().eq_ignore_ascii_case(skip)) {
                continue;
            }
            count += copy_tree(&src, &dst);
        } else if kind.is_file() && !dst.exists() && fs::copy(&src, &dst).is_ok() {
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_tree_skips_caches_and_keeps_existing() {
        let base = std::env::temp_dir().join(format!("paw-paths-test-{}", std::process::id()));
        let from = base.join("from");
        let to = base.join("to");
        fs::create_dir_all(from.join("Default/Local Storage")).unwrap();
        fs::create_dir_all(from.join("Default/Cache")).unwrap();
        fs::write(from.join("Default/Local Storage/a.log"), b"new").unwrap();
        fs::write(from.join("Default/Cache/big"), b"x").unwrap();
        fs::write(from.join("keep.json"), b"new").unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(to.join("keep.json"), b"old").unwrap();

        let n = copy_tree(&from, &to);
        assert_eq!(n, 1);
        assert!(to.join("Default/Local Storage/a.log").is_file());
        assert!(!to.join("Default/Cache").exists());
        assert_eq!(fs::read(to.join("keep.json")).unwrap(), b"old");
        let _ = fs::remove_dir_all(&base);
    }
}
