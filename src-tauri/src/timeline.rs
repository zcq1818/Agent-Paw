//! 本地活动时间线（“记录所有”）。
//!
//! 后台线程每 2 秒采样一次：前台窗口（软件 + 标题）、离开 / 锁屏、剪贴板；
//! 每 10 秒扫描一次系统“最近使用的文件”。事件按天追加到
//! `app_data/timeline/YYYY-MM-DD.jsonl`，只存在本机，不会上传。
//!
//! 隐私约束：
//! - 默认关闭，由前端在用户打开“本地活动观察”后调用 `timeline_configure` 启用；
//! - 排除列表里的软件 / 标题完全不记录；无痕 / InPrivate 窗口只记软件不记标题；
//! - 密码管理器标记为“不进剪贴板历史”的内容、疑似密码 / 密钥的文本不记录；
//! - 超过保留天数的文件每天自动删除。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const TICK: Duration = Duration::from_secs(2);
const AWAY_AFTER_MS: i64 = 5 * 60_000;
const MIN_WINDOW_MS: i64 = 3_000;
const CLIP_STORE_CHARS: usize = 2_000;
const CLIP_EMIT_CHARS: usize = 6_000;

fn yes() -> bool {
    true
}
fn default_retention() -> u32 {
    30
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub files: bool,
    #[serde(default)]
    pub clipboard: bool,
    #[serde(default = "default_retention")]
    pub retention_days: u32,
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl Default for TimelineConfig {
    fn default() -> Self {
        Self { enabled: false, files: true, clipboard: false, retention_days: 30, exclude: Vec::new() }
    }
}

/// 一条时间线事件。kind：app（前台窗口）| file（打开文件）| clip（复制）| away（离开 / 锁屏）。
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Event {
    pub ts: i64,
    pub kind: String,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub dur: i64,
}

#[derive(Clone, Serialize)]
struct ClipPayload {
    text: String,
    app: String,
}

struct Recorder {
    config: TimelineConfig,
    dir: Option<PathBuf>,
    current: Option<Event>,
    away_since: Option<(i64, bool)>,
    clip_seq: u32,
    recent_seen: HashMap<String, SystemTime>,
    /// 当天已从窗口标题里记过的文件名（同一文件一天只记一次）
    title_files: (String, HashSet<String>),
    recent_ready: bool,
    last_recent_scan: i64,
    last_purge_day: String,
}

static STATE: OnceLock<Mutex<Recorder>> = OnceLock::new();

fn state() -> &'static Mutex<Recorder> {
    STATE.get_or_init(|| {
        Mutex::new(Recorder {
            config: TimelineConfig::default(),
            dir: None,
            current: None,
            away_since: None,
            clip_seq: 0,
            recent_seen: HashMap::new(),
            title_files: (String::new(), HashSet::new()),
            recent_ready: false,
            last_recent_scan: 0,
            last_purge_day: String::new(),
        })
    })
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn day_of(ts: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn append(dir: &Path, event: &Event) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(format!("{}.jsonl", day_of(event.ts)));
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(event) {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn matches_exclude(config: &TimelineConfig, haystacks: &[&str]) -> bool {
    config.exclude.iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).any(|needle| {
        haystacks.iter().any(|h| h.to_lowercase().contains(&needle))
    })
}

/// 无痕 / 隐私窗口：只记软件不记标题。
fn is_private_title(title: &str) -> bool {
    let lower = title.to_lowercase();
    ["inprivate", "incognito", "private browsing", "无痕", "隐身", "隐私浏览"].iter().any(|k| lower.contains(k))
}

/// 默认就排除的软件：密码管理器、远程验证器之类。
const BUILTIN_EXCLUDE: &[&str] = &["keepass", "1password", "bitwarden", "lastpass", "dashlane", "enpass", "credentialuibroker"];

fn builtin_excluded(app: &str) -> bool {
    let lower = app.to_lowercase();
    BUILTIN_EXCLUDE.iter().any(|k| lower.contains(k))
}

/// 疑似密码 / 密钥：不记录剪贴板内容。
pub(crate) fn looks_secret(text: &str) -> bool {
    let t = text.trim();
    if t.contains("-----BEGIN") && t.contains("KEY") {
        return true;
    }
    if t.is_empty() || t.chars().any(char::is_whitespace) {
        return false;
    }
    let lower = t.to_lowercase();
    const PREFIXES: &[&str] = &["sk-", "sk_", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "akia", "eyj", "aiza", "glpat-"];
    if t.len() >= 16 && PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    let email_like = t
        .split_once('@')
        .map(|(user, domain)| !user.is_empty() && domain.contains('.') && domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .unwrap_or(false);
    if lower.starts_with("http") || lower.starts_with("www.") || t.contains('\\') || email_like {
        return false;
    }
    let len = t.chars().count();
    if !(8..=128).contains(&len) {
        return false;
    }
    let lower_c = t.chars().any(|c| c.is_ascii_lowercase());
    let upper_c = t.chars().any(|c| c.is_ascii_uppercase());
    let digit_c = t.chars().any(|c| c.is_ascii_digit());
    let symbol_c = t.chars().any(|c| c.is_ascii_punctuation() && c != '.' && c != '-' && c != '_' && c != '/');
    let classes = [lower_c, upper_c, digit_c, symbol_c].iter().filter(|b| **b).count();
    // 长随机串（API Key 一类）或混合了多种字符的短串（密码一类）
    (len >= 24 && classes >= 3 && t.chars().all(|c| c.is_ascii())) || (len <= 32 && classes >= 4)
}

// ───────────────────────── Windows 采样 ─────────────────────────

#[cfg(windows)]
mod sys {
    use std::path::Path;
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP};
    use windows_sys::Win32::System::DataExchange::*;
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_BITMAP: u32 = 2;
    const CF_DIB: u32 = 8;
    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;

    pub fn idle_ms() -> i64 {
        unsafe {
            let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
            if GetLastInputInfo(&mut info) == 0 {
                return 0;
            }
            GetTickCount().wrapping_sub(info.dwTime) as i64
        }
    }

    pub fn clipboard_seq() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    pub enum Clip {
        Text(String),
        Files(Vec<String>),
        Image,
        Private,
        Nothing,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read_clipboard() -> Clip {
        unsafe {
            let mut opened = false;
            for _ in 0..5 {
                if OpenClipboard(std::ptr::null_mut()) != 0 {
                    opened = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            if !opened {
                return Clip::Nothing;
            }
            let result = (|| {
                // 密码管理器会给内容打上这两个标记，表示“不要被剪贴板监控 / 历史记录”。
                let exclude = RegisterClipboardFormatW(wide("ExcludeClipboardContentFromMonitorProcessing").as_ptr());
                if exclude != 0 && IsClipboardFormatAvailable(exclude) != 0 {
                    return Clip::Private;
                }
                let history = RegisterClipboardFormatW(wide("CanIncludeInClipboardHistory").as_ptr());
                if history != 0 && IsClipboardFormatAvailable(history) != 0 {
                    let h = GetClipboardData(history);
                    if !h.is_null() {
                        let p = GlobalLock(h as _) as *const u32;
                        let allowed = p.is_null() || *p != 0;
                        GlobalUnlock(h as _);
                        if !allowed {
                            return Clip::Private;
                        }
                    }
                }
                if IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
                    let h = GetClipboardData(CF_UNICODETEXT);
                    if h.is_null() {
                        return Clip::Nothing;
                    }
                    let p = GlobalLock(h as _) as *const u16;
                    if p.is_null() {
                        return Clip::Nothing;
                    }
                    let mut len = 0usize;
                    while len < 200_000 && *p.add(len) != 0 {
                        len += 1;
                    }
                    let text = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
                    GlobalUnlock(h as _);
                    return Clip::Text(text);
                }
                if IsClipboardFormatAvailable(CF_HDROP) != 0 {
                    let h = GetClipboardData(CF_HDROP) as HDROP;
                    if h.is_null() {
                        return Clip::Nothing;
                    }
                    let count = DragQueryFileW(h, u32::MAX, std::ptr::null_mut(), 0);
                    let mut files = Vec::new();
                    for i in 0..count.min(50) {
                        let len = DragQueryFileW(h, i, std::ptr::null_mut(), 0);
                        let mut buf = vec![0u16; len as usize + 1];
                        let read = DragQueryFileW(h, i, buf.as_mut_ptr(), buf.len() as u32);
                        files.push(String::from_utf16_lossy(&buf[..read as usize]));
                    }
                    return Clip::Files(files);
                }
                if IsClipboardFormatAvailable(CF_BITMAP) != 0 || IsClipboardFormatAvailable(CF_DIB) != 0 {
                    return Clip::Image;
                }
                Clip::Nothing
            })();
            CloseClipboard();
            result
        }
    }

    fn ansi_to_string(bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }
        unsafe {
            let n = MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
            if n <= 0 {
                return String::from_utf8_lossy(bytes).into_owned();
            }
            let mut buf = vec![0u16; n as usize];
            MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, buf.as_mut_ptr(), n);
            String::from_utf16_lossy(&buf)
        }
    }

    fn u32_at(b: &[u8], off: usize) -> Option<u32> {
        b.get(off..off + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u16_at(b: &[u8], off: usize) -> Option<u16> {
        b.get(off..off + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }
    fn cstr(b: &[u8], off: usize) -> Option<&[u8]> {
        let rest = b.get(off..)?;
        let end = rest.iter().position(|c| *c == 0)?;
        Some(&rest[..end])
    }
    fn wstr(b: &[u8], off: usize) -> Option<String> {
        let mut units = Vec::new();
        let mut i = off;
        loop {
            let u = u16_at(b, i)?;
            if u == 0 {
                break;
            }
            units.push(u);
            i += 2;
        }
        Some(String::from_utf16_lossy(&units))
    }

    /// 解析 .lnk（Shell Link）里的本地目标路径：LinkInfo → LocalBasePath(+CommonPathSuffix)。
    pub fn lnk_target(path: &Path) -> Option<String> {
        let b = std::fs::read(path).ok()?;
        if u32_at(&b, 0)? != 0x4C {
            return None;
        }
        let flags = u32_at(&b, 0x14)?;
        let mut off = 0x4C;
        if flags & 0x1 != 0 {
            off += 2 + u16_at(&b, off)? as usize;
        }
        if flags & 0x2 == 0 {
            return None;
        }
        let li = off;
        let header = u32_at(&b, li + 4)?;
        let li_flags = u32_at(&b, li + 8)?;
        if li_flags & 0x1 == 0 {
            return None;
        }
        let suffix_off = u32_at(&b, li + 0x18)? as usize;
        if header >= 0x24 {
            let base_u = u32_at(&b, li + 0x1C)? as usize;
            let suffix_u = u32_at(&b, li + 0x20)? as usize;
            if base_u > 0 {
                let base = wstr(&b, li + base_u)?;
                let suffix = if suffix_u > 0 { wstr(&b, li + suffix_u).unwrap_or_default() } else { String::new() };
                return Some(base + &suffix);
            }
        }
        let base_off = u32_at(&b, li + 0x10)? as usize;
        let base = ansi_to_string(cstr(&b, li + base_off)?);
        let suffix = cstr(&b, li + suffix_off).map(ansi_to_string).unwrap_or_default();
        Some(base + &suffix)
    }
}

const FILE_EXTS: &[&str] = &[
    "doc", "docx", "xls", "xlsx", "xlsm", "csv", "ppt", "pptx", "pdf", "txt", "md", "rtf", "wps", "et", "dps", "ofd",
    "json", "ts", "tsx", "js", "jsx", "py", "rs", "java", "go", "c", "cpp", "h", "cs", "html", "css", "sql", "yaml", "yml",
    "toml", "xml", "vue", "sh", "ps1", "ipynb", "log", "ini", "png", "jpg", "jpeg", "gif", "svg", "psd", "ai", "fig",
    "sketch", "blend", "mp4", "mov", "mp3", "zip", "rar", "7z", "drawio", "xmind", "vsdx", "mpp",
];

/// 从窗口标题里找文件名：“Q3报表.xlsx - Excel”“● main.rs - paw - Visual Studio Code”。
/// 很多电脑关掉了系统“最近使用的文件”，靠标题也能知道你在看哪个文件。
/// 浏览器标题常带“Node.js”“Vue.js”之类，只认文档类扩展名（本地打开的 PDF 等）。
const BROWSER_DOC_EXTS: &[&str] = &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "ofd"];

fn is_browser(process: &str) -> bool {
    let p = process.to_lowercase();
    ["chrome", "msedge", "firefox", "brave", "opera", "360se", "360chrome", "qqbrowser", "sogouexplorer", "vivaldi"]
        .iter()
        .any(|b| p.starts_with(b))
}

pub(crate) fn file_in_title(title: &str, browser: bool) -> Option<String> {
    let normalized = title.replace(" \u{2014} ", " - ").replace(" | ", " - ");
    for segment in normalized.split(" - ") {
        let mut name = segment.trim().trim_start_matches(['●', '*', '•']).trim();
        for suffix in ["[只读]", "[兼容模式]", "(只读)", "[Read-Only]", "[Compatibility Mode]", "[受保护的视图]"] {
            name = name.trim_end_matches(suffix).trim();
        }
        name = name.trim_end_matches(['*', '●']).trim();
        let Some((stem, ext)) = name.rsplit_once('.') else { continue };
        if stem.is_empty() || name.chars().count() > 150 || ext.chars().any(|c| !c.is_ascii_alphanumeric()) {
            continue;
        }
        let ext = ext.to_ascii_lowercase();
        let allowed = if browser { BROWSER_DOC_EXTS } else { FILE_EXTS };
        if allowed.contains(&ext.as_str()) {
            // 去掉网页标题常见的“xxx.com”类误判：stem 不能以 www 开头
            if stem.to_lowercase().starts_with("www") {
                continue;
            }
            return Some(name.rsplit(['\\', '/']).next().unwrap_or(name).to_string());
        }
    }
    None
}

#[cfg(windows)]
fn record_title_file(app: &AppHandle, rec: &mut Recorder, process: &str, title: &str, now: i64) {
    let Some(name) = file_in_title(title, is_browser(process)) else { return };
    if matches_exclude(&rec.config, &[&name]) {
        return;
    }
    let today = day_of(now);
    if rec.title_files.0 != today {
        rec.title_files = (today, HashSet::new());
    }
    if !rec.title_files.1.insert(name.to_lowercase()) {
        return;
    }
    let event = Event { ts: now, kind: "file".into(), app: process.to_string(), title: name, detail: String::new(), dur: 0 };
    record(rec, &event);
    let _ = app.emit("timeline-event", &event);
}

fn recent_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("Microsoft\\Windows\\Recent"))
}

fn finish_current(rec: &mut Recorder, end: i64) {
    if let Some(mut cur) = rec.current.take() {
        cur.dur = (end - cur.ts).max(0);
        if cur.dur >= MIN_WINDOW_MS {
            if let Some(dir) = rec.dir.clone() {
                append(&dir, &cur);
            }
        }
    }
}

fn record(rec: &Recorder, event: &Event) {
    if let Some(dir) = rec.dir.as_ref() {
        append(dir, event);
    }
}

#[cfg(windows)]
fn sample(app: &AppHandle, rec: &mut Recorder) {
    let now = now_ms();

    // 离开 / 锁屏
    let locked = crate::control::desktop_locked();
    let idle = sys::idle_ms();
    if locked || idle >= AWAY_AFTER_MS {
        if rec.away_since.is_none() {
            let start = if locked { now } else { now - idle };
            finish_current(rec, start);
            rec.away_since = Some((start, locked));
        }
        return;
    }
    if let Some((start, was_locked)) = rec.away_since.take() {
        let event = Event {
            ts: start,
            kind: "away".into(),
            app: String::new(),
            title: if was_locked { "锁屏".into() } else { "离开电脑".into() },
            detail: String::new(),
            dur: now - start,
        };
        record(rec, &event);
        let _ = app.emit("timeline-event", &event);
    }

    // 前台窗口
    let mut fg_app = String::new();
    if let Ok(info) = crate::get_active_window_info() {
        fg_app = info.process_name.clone();
        let excluded = builtin_excluded(&info.process_name)
            || matches_exclude(&rec.config, &[&info.process_name, &info.title]);
        if excluded || (info.title.is_empty() && info.process_name.is_empty()) {
            finish_current(rec, now);
        } else {
            let title = if is_private_title(&info.title) { "（隐私窗口，未记录标题）".to_string() } else { info.title.clone() };
            let same = rec.current.as_ref().map(|c| c.app == info.process_name && c.title == title).unwrap_or(false);
            if !same {
                finish_current(rec, now);
                let event = Event {
                    ts: now,
                    kind: "app".into(),
                    app: info.process_name.clone(),
                    title,
                    detail: info.process_path.clone(),
                    dur: 0,
                };
                let _ = app.emit("timeline-event", &event);
                rec.current = Some(event);
                if rec.config.files {
                    record_title_file(app, rec, &info.process_name, &info.title, now);
                }
            }
        }
    }

    // 剪贴板
    if rec.config.clipboard {
        let seq = sys::clipboard_seq();
        if rec.clip_seq == 0 {
            rec.clip_seq = seq;
        } else if seq != rec.clip_seq {
            rec.clip_seq = seq;
            let excluded = builtin_excluded(&fg_app) || matches_exclude(&rec.config, &[&fg_app]);
            if !excluded {
                let (title, detail, emit_text) = match sys::read_clipboard() {
                    sys::Clip::Text(text) if !text.trim().is_empty() => {
                        if looks_secret(&text) {
                            ("复制了疑似密码 / 密钥（未记录内容）".to_string(), String::new(), None)
                        } else {
                            let first = text.trim().lines().next().unwrap_or("").to_string();
                            (truncate_chars(&first, 60), truncate_chars(text.trim(), CLIP_STORE_CHARS), Some(truncate_chars(text.trim(), CLIP_EMIT_CHARS)))
                        }
                    }
                    sys::Clip::Files(files) if !files.is_empty() => {
                        let names: Vec<String> = files
                            .iter()
                            .map(|f| f.rsplit(['\\', '/']).next().unwrap_or(f).to_string())
                            .collect();
                        (format!("复制了 {} 个文件：{}", files.len(), truncate_chars(&names.join("、"), 60)), files.join("\n"), None)
                    }
                    sys::Clip::Image => ("复制了一张图片".to_string(), String::new(), None),
                    _ => (String::new(), String::new(), None),
                };
                if !title.is_empty() {
                    let event = Event { ts: now, kind: "clip".into(), app: fg_app.clone(), title, detail, dur: 0 };
                    record(rec, &event);
                    if let Some(text) = emit_text {
                        let _ = app.emit("timeline-clip", ClipPayload { text, app: fg_app.clone() });
                    }
                }
            }
        }
    } else {
        rec.clip_seq = 0;
    }

    // 最近使用的文件
    if rec.config.files && now - rec.last_recent_scan >= 10_000 {
        rec.last_recent_scan = now;
        scan_recent(app, rec, &fg_app);
    } else if !rec.config.files {
        rec.recent_ready = false;
        rec.recent_seen.clear();
    }
}

#[cfg(windows)]
fn scan_recent(app: &AppHandle, rec: &mut Recorder, fg_app: &str) {
    let Some(dir) = recent_dir() else { return };
    let Ok(entries) = fs::read_dir(&dir) else { return };
    let mut fresh: Vec<(SystemTime, PathBuf, String)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(|e| !e.eq_ignore_ascii_case("lnk")).unwrap_or(true) {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let changed = rec.recent_seen.get(&name).map(|old| *old < modified).unwrap_or(true);
        if changed {
            rec.recent_seen.insert(name.clone(), modified);
            if rec.recent_ready {
                fresh.push((modified, path, name));
            }
        }
    }
    rec.recent_ready = true;
    fresh.sort_by_key(|(t, _, _)| *t);
    for (modified, path, name) in fresh.into_iter().take(20) {
        let target = sys::lnk_target(&path).unwrap_or_default();
        if builtin_excluded(&target) || matches_exclude(&rec.config, &[&name, &target]) {
            continue;
        }
        let is_dir = !target.is_empty() && Path::new(&target).is_dir();
        // 之后从窗口标题里看到同一个文件就不再重复记
        let today = day_of(now_ms());
        if rec.title_files.0 != today {
            rec.title_files = (today, HashSet::new());
        }
        rec.title_files.1.insert(name.to_lowercase());
        let ts = modified.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_else(|_| now_ms());
        let event = Event {
            ts,
            kind: "file".into(),
            app: fg_app.to_string(),
            title: if is_dir { format!("{name}（文件夹）") } else { name },
            detail: target,
            dur: 0,
        };
        record(rec, &event);
        let _ = app.emit("timeline-event", &event);
    }
}

fn purge_old(rec: &mut Recorder) {
    let today = day_of(now_ms());
    if rec.last_purge_day == today {
        return;
    }
    rec.last_purge_day = today;
    let Some(dir) = rec.dir.clone() else { return };
    let keep = rec.config.retention_days.max(1) as i64;
    let cutoff = day_of(now_ms() - keep * 86_400_000);
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(day) = name.strip_suffix(".jsonl") {
                if day.len() == 10 && day < cutoff.as_str() {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// 启动后台采样线程（应用启动时调用一次）。
pub fn start(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        state().lock().unwrap().dir = Some(dir.join("timeline"));
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let Ok(mut rec) = state().lock() else { continue };
        if !rec.config.enabled {
            let now = now_ms();
            finish_current(&mut rec, now);
            rec.away_since = None;
            rec.clip_seq = 0;
            rec.recent_ready = false;
            rec.recent_seen.clear();
            continue;
        }
        purge_old(&mut rec);
        #[cfg(windows)]
        sample(&handle, &mut rec);
        #[cfg(not(windows))]
        let _ = &handle;
    });
}

// ───────────────────────── 命令 ─────────────────────────

#[tauri::command]
pub fn timeline_configure(config: TimelineConfig) -> Result<(), String> {
    let mut rec = state().lock().map_err(|e| e.to_string())?;
    let retention_changed = rec.config.retention_days != config.retention_days;
    rec.config = config;
    if retention_changed {
        rec.last_purge_day.clear();
    }
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimelineQuery {
    from: Option<i64>,
    to: Option<i64>,
    kinds: Option<Vec<String>>,
    keyword: Option<String>,
    limit: Option<usize>,
}

fn read_day(dir: &Path, day: &str, out: &mut Vec<Event>) {
    let Ok(file) = fs::File::open(dir.join(format!("{day}.jsonl"))) else { return };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Ok(event) = serde_json::from_str::<Event>(&line) {
            out.push(event);
        }
    }
}

#[tauri::command]
pub async fn timeline_query(query: TimelineQuery) -> Result<Vec<Event>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_ms();
        let (dir, live) = {
            let rec = state().lock().map_err(|e| e.to_string())?;
            let mut live = Vec::new();
            if let Some(cur) = rec.current.clone() {
                live.push(Event { dur: now - cur.ts, ..cur });
            }
            if let Some((start, locked)) = rec.away_since {
                live.push(Event {
                    ts: start,
                    kind: "away".into(),
                    app: String::new(),
                    title: if locked { "锁屏".into() } else { "离开电脑".into() },
                    detail: String::new(),
                    dur: now - start,
                });
            }
            (rec.dir.clone(), live)
        };
        let Some(dir) = dir else { return Ok(Vec::new()) };
        let to = query.to.unwrap_or(now);
        let from = query.from.unwrap_or(to - 86_400_000).max(to - 92 * 86_400_000);
        let mut events = Vec::new();
        let mut day_ts = from;
        let mut last_day = String::new();
        while day_ts <= to + 86_400_000 {
            let day = day_of(day_ts);
            if day != last_day {
                read_day(&dir, &day, &mut events);
                last_day = day;
            }
            day_ts += 6 * 3_600_000; // 6 小时步进，跨夏令时也不会漏天
        }
        events.extend(live);
        let kinds = query.kinds.unwrap_or_default();
        let keyword = query.keyword.unwrap_or_default().trim().to_lowercase();
        let mut filtered: Vec<Event> = events
            .into_iter()
            .filter(|e| e.ts + e.dur >= from && e.ts <= to)
            .filter(|e| kinds.is_empty() || kinds.iter().any(|k| k == &e.kind))
            .filter(|e| {
                keyword.is_empty()
                    || e.app.to_lowercase().contains(&keyword)
                    || e.title.to_lowercase().contains(&keyword)
                    || e.detail.to_lowercase().contains(&keyword)
            })
            .collect();
        filtered.sort_by_key(|e| e.ts);
        let limit = query.limit.unwrap_or(400).clamp(1, 5000);
        if filtered.len() > limit {
            filtered = filtered.split_off(filtered.len() - limit);
        }
        Ok(filtered)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineStatus {
    enabled: bool,
    days: usize,
    bytes: u64,
    oldest_day: String,
    dir: String,
}

#[tauri::command]
pub fn timeline_status() -> Result<TimelineStatus, String> {
    let (enabled, dir) = {
        let rec = state().lock().map_err(|e| e.to_string())?;
        (rec.config.enabled, rec.dir.clone())
    };
    let mut days = 0;
    let mut bytes = 0;
    let mut oldest = String::new();
    if let Some(dir) = dir.as_ref() {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(day) = name.strip_suffix(".jsonl") {
                    days += 1;
                    bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                    if oldest.is_empty() || day < oldest.as_str() {
                        oldest = day.to_string();
                    }
                }
            }
        }
    }
    Ok(TimelineStatus {
        enabled,
        days,
        bytes,
        oldest_day: oldest,
        dir: dir.map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
    })
}

/// 清空时间线；before 给定时只删该时间之前的整天文件。
#[tauri::command]
pub fn timeline_clear(before: Option<i64>) -> Result<usize, String> {
    let mut rec = state().lock().map_err(|e| e.to_string())?;
    let Some(dir) = rec.dir.clone() else { return Ok(0) };
    let cutoff = before.map(day_of);
    let mut removed = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(day) = name.strip_suffix(".jsonl") {
                if cutoff.as_deref().map(|c| day < c).unwrap_or(true) && fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    if before.is_none() {
        rec.current = None;
        rec.away_since = None;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_detection() {
        assert!(looks_secret("sk-ant-api03-AbCdEf1234567890abcdef"));
        assert!(looks_secret("ghp_1234567890abcdefABCDEF1234567890abcd"));
        assert!(looks_secret("P@ssw0rd!2024"));
        assert!(looks_secret("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"));
        assert!(!looks_secret("hello world"));
        assert!(!looks_secret("https://github.com/a/b?x=1&Y=2"));
        assert!(!looks_secret(r"C:\Users\me\Report2024.xlsx"));
        assert!(!looks_secret("会议纪要"));
        assert!(!looks_secret("12345678"));
        assert!(!looks_secret("someone@example.com"));
        assert!(!looks_secret("README.md"));
    }

    #[test]
    fn files_from_titles() {
        assert_eq!(file_in_title("Q3报表.xlsx - Excel", false).as_deref(), Some("Q3报表.xlsx"));
        assert_eq!(file_in_title("● main.rs - paw - Visual Studio Code", false).as_deref(), Some("main.rs"));
        assert_eq!(file_in_title("合同 v2.docx [兼容模式] - Word", false).as_deref(), Some("合同 v2.docx"));
        assert_eq!(file_in_title("*新建文本文档.txt - 记事本", false).as_deref(), Some("新建文本文档.txt"));
        assert_eq!(file_in_title("报价单.pdf - Adobe Acrobat Reader (64-bit)", false).as_deref(), Some("报价单.pdf"));
        assert_eq!(file_in_title("GitHub - Google Chrome", true), None);
        assert_eq!(file_in_title("www.example.com - 个人 - Microsoft Edge", true), None);
        assert_eq!(file_in_title("微信", false), None);
        assert_eq!(file_in_title("Node.js - Google Chrome", true), None);
        assert_eq!(file_in_title("报价单.pdf - 个人 - Microsoft Edge", true).as_deref(), Some("报价单.pdf"));
    }

    #[cfg(windows)]
    #[test]
    fn parse_recent_links() {
        let dir = recent_dir().unwrap();
        let mut parsed = 0;
        let mut total = 0;
        for entry in fs::read_dir(dir).unwrap().flatten().take(40) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("lnk") {
                continue;
            }
            total += 1;
            if let Some(target) = sys::lnk_target(&path) {
                parsed += 1;
                println!("{} -> {}", path.file_name().unwrap().to_string_lossy(), target);
            }
        }
        println!("parsed {parsed}/{total}");
        assert!(total == 0 || parsed * 2 >= total);
    }

    /// 会改写系统剪贴板（结束后恢复原文本），所以默认忽略：cargo test -- --ignored
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn read_clipboard_text() {
        let ps = |cmd: &str| {
            let out = std::process::Command::new("powershell").args(["-NoProfile", "-Command", cmd]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let original = ps("[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw");
        let before = sys::clipboard_seq();
        ps("Set-Clipboard -Value '剪贴板测试 hello 123'");
        assert_ne!(before, sys::clipboard_seq());
        let read = sys::read_clipboard();
        if original.is_empty() {
            ps("Set-Clipboard -Value $null");
        } else {
            ps(&format!("Set-Clipboard -Value '{}'", original.replace('\'', "''")));
        }
        match read {
            sys::Clip::Text(text) => assert_eq!(text.trim(), "剪贴板测试 hello 123"),
            _ => panic!("没有读到文本"),
        }
    }

    /// 用 WScript.Shell 现做一个指向中文文件名的快捷方式，再解析回来。
    #[cfg(windows)]
    #[test]
    fn parse_generated_link() {
        let dir = std::env::temp_dir().join("paw_lnk_test");
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("季度报表 2026.txt");
        fs::write(&target, "x").unwrap();
        let link = dir.join("季度报表 2026.txt.lnk");
        let script = format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Save()",
            link.display(),
            target.display()
        );
        let status = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).status().unwrap();
        assert!(status.success());
        let parsed = sys::lnk_target(&link);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(parsed.as_deref(), Some(target.to_string_lossy().as_ref()));
    }
}
