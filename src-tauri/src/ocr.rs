//! 看图找字：截取某个窗口的画面，用 Windows 自带的 OCR（Windows.Media.Ocr，离线、不上传）
//! 识别文字和位置。用于读不出界面结构的软件（VS Code 系的 Trae、游戏、自绘界面）。
//!
//! 截图在 Paw 进程里做（和点击用同一套物理像素坐标），OCR 交给 PowerShell 调 WinRT，
//! 脚本是固定的，图片路径通过环境变量传入，不拼接任何外部输入。

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct OcrWord {
    pub t: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Serialize, Clone)]
pub struct OcrLine {
    pub text: String,
    pub words: Vec<OcrWord>,
    /// 整行的屏幕坐标范围
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Serialize)]
pub struct OcrResult {
    pub window_id: i64,
    pub title: String,
    pub lines: Vec<OcrLine>,
}

#[derive(Deserialize)]
struct RawLine {
    words: Vec<OcrWord>,
}

const OCR_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:PAW_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
$lines = @(foreach ($line in $result.Lines) {
  @{ words = @(foreach ($w in $line.Words) { @{ t = $w.Text; x = [int]$w.BoundingRect.X; y = [int]$w.BoundingRect.Y; w = [int]$w.BoundingRect.Width; h = [int]$w.BoundingRect.Height } }) }
})
ConvertTo-Json -InputObject $lines -Depth 5 -Compress
"#;

#[cfg(windows)]
mod capture {
    use std::path::Path;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    /// 截取窗口画面存成 PNG，返回窗口在屏幕上的左上角。
    pub fn window_png(h: HWND, path: &Path) -> Result<(i32, i32), String> {
        unsafe {
            let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(h, &mut r) == 0 {
                return Err("拿不到窗口位置".into());
            }
            let (w, hh) = (r.right - r.left, r.bottom - r.top);
            if w <= 0 || hh <= 0 {
                return Err("窗口大小为 0（可能最小化了）".into());
            }
            let screen = GetDC(std::ptr::null_mut());
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, hh);
            let old = SelectObject(mem, bmp as _);
            // 窗口已经被切到最前面：直接从屏幕拷像素，GPU 渲染的内容（Chromium / Electron）也能截到。
            // 拷贝失败时再退回 PrintWindow（PW_RENDERFULLCONTENT = 2）。
            if BitBlt(mem, 0, 0, w, hh, screen, r.left, r.top, SRCCOPY) == 0 {
                PrintWindow(h, mem, 2);
            }
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = -hh; // 自上而下
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            let mut buf = vec![0u8; (w as usize) * (hh as usize) * 4];
            GetDIBits(mem, bmp, 0, hh as u32, buf.as_mut_ptr() as _, &mut info, DIB_RGB_COLORS);
            SelectObject(mem, old);
            DeleteObject(bmp as _);
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            for px in buf.chunks_mut(4) {
                px[3] = 255;
            }
            // 直接写不压缩的 BMP（GetDIBits 给的就是 BGRA）：比编码 PNG 快得多
            let mut file = Vec::with_capacity(buf.len() + 54);
            let size = (buf.len() + 54) as u32;
            file.extend_from_slice(b"BM");
            file.extend_from_slice(&size.to_le_bytes());
            file.extend_from_slice(&0u32.to_le_bytes());
            file.extend_from_slice(&54u32.to_le_bytes());
            file.extend_from_slice(&40u32.to_le_bytes());
            file.extend_from_slice(&w.to_le_bytes());
            file.extend_from_slice(&(-hh).to_le_bytes());
            file.extend_from_slice(&1u16.to_le_bytes());
            file.extend_from_slice(&32u16.to_le_bytes());
            file.extend_from_slice(&0u32.to_le_bytes());
            file.extend_from_slice(&(buf.len() as u32).to_le_bytes());
            file.extend_from_slice(&[0u8; 16]);
            file.extend_from_slice(&buf);
            std::fs::write(path, file).map_err(|e| format!("保存截图失败：{e}"))?;
            Ok((r.left, r.top))
        }
    }
}

#[cfg(windows)]
fn run_ocr(image: &std::path::Path) -> Result<Vec<RawLine>, String> {
    let output = crate::hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", OCR_SCRIPT])
        .env("PAW_OCR_IMAGE", image)
        .output()
        .map_err(|e| format!("启动文字识别失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = stdout.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        let err: String = String::from_utf8_lossy(&output.stderr).chars().take(300).collect();
        return Err(format!("文字识别没有结果：{err}"));
    }
    // 只有一行时 ConvertTo-Json 也会输出数组（-InputObject @()），空结果是 []
    serde_json::from_str::<Vec<RawLine>>(text).map_err(|e| format!("解析识别结果失败：{e}"))
}

/// 识别窗口里的文字。id 为空时用当前前台窗口。
#[tauri::command]
pub async fn ocr_window(id: Option<i64>, save_to: Option<String>) -> Result<OcrResult, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let (hwnd, info) = crate::control::resolve_window(id)?;
            // 从屏幕截图要求窗口在最前面且没被挡住
            crate::control::bring_to_front(hwnd);
            std::thread::sleep(std::time::Duration::from_millis(350));
            let path = std::env::temp_dir().join(format!("paw-ocr-{}.bmp", std::process::id()));
            let started = std::time::Instant::now();
            let (left, top) = capture::window_png(hwnd, &path)?;
            let captured = started.elapsed().as_millis();
            let raw = run_ocr(&path);
            eprintln!("[ocr] capture {captured}ms, total {}ms", started.elapsed().as_millis());
            // 调试用：把截图另存一份（只在调用方明确给了路径时）
            if let Some(target) = save_to.filter(|p| !p.trim().is_empty()) {
                let _ = std::fs::copy(&path, target);
            }
            let _ = std::fs::remove_file(&path);
            let lines = raw?
                .into_iter()
                .filter(|l| !l.words.is_empty())
                .map(|l| {
                    let words: Vec<OcrWord> = l
                        .words
                        .into_iter()
                        .map(|w| OcrWord { x: w.x + left, y: w.y + top, ..w })
                        .collect();
                    let x = words.iter().map(|w| w.x).min().unwrap_or(0);
                    let y = words.iter().map(|w| w.y).min().unwrap_or(0);
                    let right = words.iter().map(|w| w.x + w.w).max().unwrap_or(0);
                    let bottom = words.iter().map(|w| w.y + w.h).max().unwrap_or(0);
                    // 中文按字切分，英文按词切分：中文之间不加空格
                    let mut text = String::new();
                    for (i, w) in words.iter().enumerate() {
                        let ascii_pair = i > 0
                            && words[i - 1].t.chars().last().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false)
                            && w.t.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                        if ascii_pair {
                            text.push(' ');
                        }
                        text.push_str(&w.t);
                    }
                    OcrLine { text, words, x, y, w: right - x, h: bottom - y }
                })
                .collect();
            Ok(OcrResult { window_id: info.0, title: info.1, lines })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        Err("仅支持 Windows".into())
    }
}
