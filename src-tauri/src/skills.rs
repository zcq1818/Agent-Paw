//! 技能文件夹：按 Agent Skills 的格式（一个文件夹里放 SKILL.md，加上脚本、参考资料等文件）
//! 从磁盘加载技能，也负责把桌宠帮你写的技能存成文件夹。
//!
//! 只读写技能文件夹里面的文件；读文件时拒绝跳出技能文件夹的路径（..、绝对路径）。

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_SKILL_MD: u64 = 512 * 1024;
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_FILES_LISTED: usize = 200;

#[derive(Serialize)]
pub struct SkillFolder {
    /// 技能文件夹的绝对路径
    dir: String,
    /// SKILL.md 全文
    content: String,
    /// 文件夹里的其他文件（相对路径，最多 200 个）
    files: Vec<String>,
    modified: i64,
}

/// 桌宠自己的技能文件夹（%APPDATA%/com.paw.desktop/skills），没有就创建。
#[tauri::command]
pub fn skills_root(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建技能文件夹失败：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

fn list_files(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize) {
    if depth > 4 || out.len() >= MAX_FILES_LISTED {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "__pycache__" {
            continue;
        }
        if path.is_dir() {
            list_files(root, &path, out, depth + 1);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel != "SKILL.md" {
                out.push(rel);
            }
        }
        if out.len() >= MAX_FILES_LISTED {
            return;
        }
    }
}

fn read_skill_dir(dir: &Path) -> Option<SkillFolder> {
    let skill_md = dir.join("SKILL.md");
    let meta = std::fs::metadata(&skill_md).ok()?;
    if meta.len() > MAX_SKILL_MD {
        return None;
    }
    let content = std::fs::read_to_string(&skill_md).ok()?;
    let mut files = Vec::new();
    list_files(dir, dir, &mut files, 0);
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(SkillFolder { dir: dir.to_string_lossy().to_string(), content, files, modified })
}

/// 扫描若干个“技能库”文件夹：每个子文件夹里有 SKILL.md 就算一个技能；
/// 传进来的文件夹本身有 SKILL.md 时，它自己就是一个技能。
#[tauri::command]
pub async fn skills_scan(roots: Vec<String>) -> Result<Vec<SkillFolder>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for root in roots {
            let root = PathBuf::from(crate::control::expand_user_path(&root));
            if !root.is_dir() {
                continue;
            }
            if let Some(skill) = read_skill_dir(&root) {
                out.push(skill);
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&root) else { continue };
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            dirs.sort();
            for dir in dirs {
                if let Some(skill) = read_skill_dir(&dir) {
                    out.push(skill);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 相对路径必须留在技能文件夹里面。
fn safe_join(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("只能读取技能文件夹里面的文件".into());
    }
    Ok(dir.join(rel_path))
}

/// 读技能文件夹里的一个文件（参考资料、模板、脚本源码）。
#[tauri::command]
pub fn skill_read_file(dir: String, path: String) -> Result<String, String> {
    let dir = PathBuf::from(&dir);
    if !dir.join("SKILL.md").is_file() {
        return Err("不是技能文件夹".into());
    }
    let file = safe_join(&dir, path.trim().trim_start_matches("./"))?;
    let meta = std::fs::metadata(&file).map_err(|_| format!("技能里没有这个文件：{path}"))?;
    if meta.len() > MAX_FILE {
        return Err(format!("文件太大（{} KB），不直接读取", meta.len() / 1024));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(_) => Err("这是二进制文件，不能当文本读取".into()),
    }
}

fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        format!("skill-{}", chrono::Local::now().format("%Y%m%d%H%M%S"))
    } else {
        cleaned.chars().take(64).collect()
    }
}

/// 在桌宠的技能文件夹里保存（新建或覆盖）一个技能的 SKILL.md，返回技能文件夹路径。
/// existing_dir 不为空时改写那个技能（必须在桌宠技能文件夹里）。
#[tauri::command]
pub fn skill_save(app: AppHandle, name: String, content: String, existing_dir: Option<String>) -> Result<String, String> {
    let root = PathBuf::from(skills_root(app)?);
    let dir = match existing_dir.filter(|d| !d.trim().is_empty()) {
        Some(existing) => {
            let existing = PathBuf::from(existing);
            let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
            let canonical = existing.canonicalize().map_err(|e| e.to_string())?;
            if !canonical.starts_with(&canonical_root) {
                return Err("只能修改桌宠技能文件夹里的技能；其他位置的技能请到原文件夹里改".into());
            }
            existing
        }
        None => {
            let base = folder_name(&name);
            let mut dir = root.join(&base);
            let mut index = 2;
            while dir.exists() {
                dir = root.join(format!("{base}-{index}"));
                index += 1;
            }
            dir
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建技能文件夹失败：{e}"))?;
    std::fs::write(dir.join("SKILL.md"), content).map_err(|e| format!("保存 SKILL.md 失败：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 删除桌宠技能文件夹里的一个技能（其他位置的不删）。
#[tauri::command]
pub fn skill_delete(app: AppHandle, dir: String) -> Result<(), String> {
    let root = PathBuf::from(skills_root(app)?).canonicalize().map_err(|e| e.to_string())?;
    let target = PathBuf::from(&dir).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) || target == root {
        return Err("只能删除桌宠技能文件夹里的技能".into());
    }
    std::fs::remove_dir_all(&target).map_err(|e| format!("删除失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_paths() {
        let dir = Path::new("C:/skills/demo");
        assert!(safe_join(dir, "../other/SKILL.md").is_err());
        assert!(safe_join(dir, "C:/Windows/win.ini").is_err());
        assert!(safe_join(dir, "references/guide.md").is_ok());
    }

    #[test]
    fn folder_names_are_safe() {
        assert_eq!(folder_name("Weekly Report!"), "weekly-report");
        assert_eq!(folder_name("周报助手"), "周报助手");
        assert!(folder_name("///").starts_with("skill-"));
    }

    #[test]
    fn scans_skill_folders() {
        let root = std::env::temp_dir().join(format!("paw-skill-test-{}", std::process::id()));
        let skill = root.join("demo");
        std::fs::create_dir_all(skill.join("references")).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: demo\ndescription: 测试\n---\n正文").unwrap();
        std::fs::write(skill.join("references/a.md"), "参考").unwrap();
        let found = tauri::async_runtime::block_on(skills_scan(vec![root.to_string_lossy().to_string()])).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].files, vec!["references/a.md".to_string()]);
        assert_eq!(skill_read_file(found[0].dir.clone(), "references/a.md".into()).unwrap(), "参考");
        assert!(skill_read_file(found[0].dir.clone(), "../demo/SKILL.md".into()).is_err());
        std::fs::remove_dir_all(root).ok();
    }
}
