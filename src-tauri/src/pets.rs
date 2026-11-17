//! 私人定制的桌宠形象：放在数据文件夹的 pets 里（发布版就是安装目录下的 data\pets），不打进安装包。
//!
//! data\pets\
//!   manifest.json      [{ "id": "xxx", "label": "名字", "description": "一句话介绍" }]（可省略）
//!   xxx.glb            带骨骼和动作的模型
//!   thumbs\xxx.png     头像（可省略）

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{ipc::Response, AppHandle, Runtime};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CustomPet {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn pets_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = crate::paths::data_dir(app)?.join("pets");
    fs::create_dir_all(&dir).map_err(|e| format!("创建形象文件夹失败：{e}"))?;
    Ok(dir)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// manifest 里写了的按 manifest 的顺序和名字；没写进 manifest 的 .glb 也列出来。没有模型文件的条目跳过。
fn list_in(dir: &std::path::Path) -> Vec<CustomPet> {
    let mut list: Vec<CustomPet> = fs::read_to_string(dir.join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str(text.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default();
    if let Ok(entries) = fs::read_dir(dir) {
        let mut extra: Vec<String> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().map(|ext| ext.eq_ignore_ascii_case("glb")).unwrap_or(false))
            .filter_map(|path| path.file_stem().map(|stem| stem.to_string_lossy().to_string()))
            .filter(|id| !list.iter().any(|pet| &pet.id == id))
            .collect();
        extra.sort();
        list.extend(extra.into_iter().map(|id| CustomPet { id, label: None, description: None }));
    }
    let mut seen = std::collections::HashSet::new();
    list.retain(|pet| valid_id(&pet.id) && dir.join(format!("{}.glb", pet.id)).is_file() && seen.insert(pet.id.clone()));
    list
}

#[tauri::command]
pub fn custom_pets_list(app: AppHandle) -> Result<Vec<CustomPet>, String> {
    Ok(list_in(&pets_dir(&app)?))
}

/// 读模型（thumb=false）或头像（thumb=true），原样返回字节，前端转成 blob 地址。
#[tauri::command]
pub fn custom_pet_file(app: AppHandle, id: String, thumb: bool) -> Result<Response, String> {
    if !valid_id(&id) {
        return Err("形象 id 只能包含字母、数字、下划线和短横线".into());
    }
    let dir = pets_dir(&app)?;
    let path = if thumb { dir.join("thumbs").join(format!("{id}.png")) } else { dir.join(format!("{id}.glb")) };
    let bytes = fs::read(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_manifest_entries_and_loose_models() {
        let dir = std::env::temp_dir().join(format!("paw-pets-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            "\u{feff}[{\"id\":\"b\",\"label\":\"B\"},{\"id\":\"missing\"},{\"id\":\"../x\"}]",
        )
        .unwrap();
        fs::write(dir.join("b.glb"), b"glb").unwrap();
        fs::write(dir.join("a.glb"), b"glb").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();

        let list = list_in(&dir);
        let ids: Vec<&str> = list.iter().map(|pet| pet.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
        assert_eq!(list[0].label.as_deref(), Some("B"));
        assert!(!valid_id("../x") && !valid_id("") && valid_id("fu_bao-2"));
        let _ = fs::remove_dir_all(&dir);
    }
}
