//! 读文档：拖给桌宠的文件、聊天里提到的本地文件，统一在这里转成纯文本。
//!
//! - 文本类（txt / md / csv / json / 代码 / 日志）：直接读；
//! - Word / PowerPoint / Excel：它们本身是 zip 包，用 PowerShell 自带的 .NET 解压读 XML；
//! - PDF 和图片：用 Windows 自带的离线 OCR（Windows.Data.Pdf 渲染页面 + Windows.Media.Ocr 识别），
//!   不装新依赖、不上传任何内容。
//!
//! 脚本是固定的，文件路径通过环境变量传进去，不拼接到命令里。

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct DocText {
    pub path: String,
    pub name: String,
    /// text / word / slides / sheet / pdf / image
    pub kind: String,
    pub text: String,
    pub truncated: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct DroppedFile {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub is_dir: bool,
}

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "html", "htm", "log", "ini", "cfg",
    "conf", "sql", "py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "rb", "sh",
    "ps1", "bat", "cmd", "css", "scss", "vue", "svelte", "swift", "dart", "lua", "r", "m", "srt", "vtt", "tex", "rst",
];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff", "webp"];

fn ext_of(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kind_of(ext: &str) -> Option<&'static str> {
    match ext {
        "docx" => Some("word"),
        "pptx" => Some("slides"),
        "xlsx" => Some("sheet"),
        "pdf" => Some("pdf"),
        e if IMAGE_EXTS.contains(&e) => Some("image"),
        e if TEXT_EXTS.contains(&e) => Some("text"),
        _ => None,
    }
}

fn clip(text: String, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text, false);
    }
    (text.chars().take(max).collect(), true)
}

/// 中文 OCR 结果里字和字之间常带空格（“合 同 编 号”），去掉中文之间的空格。
fn tidy_ocr(text: &str) -> String {
    let is_cjk = |c: char| ('\u{4e00}'..='\u{9fff}').contains(&c) || ('\u{3000}'..='\u{303f}').contains(&c) || ('\u{ff00}'..='\u{ffef}').contains(&c);
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, c) in chars.iter().enumerate() {
        if *c == ' ' {
            let prev = if i > 0 { chars[i - 1] } else { ' ' };
            let next = chars.get(i + 1).copied().unwrap_or(' ');
            if is_cjk(prev) && is_cjk(next) {
                continue;
            }
        }
        out.push(*c);
    }
    out
}

const OFFICE_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Plain([string]$xml, [string]$para) {
  $t = $xml -replace $para, "`n" -replace '<w:tab/>', "`t" -replace '<[^>]+>', ''
  [System.Net.WebUtility]::HtmlDecode($t)
}
function ReadEntry($zip, $name) {
  $e = $zip.GetEntry($name); if (-not $e) { return $null }
  $r = New-Object System.IO.StreamReader($e.Open(), [Text.Encoding]::UTF8); $s = $r.ReadToEnd(); $r.Close(); $s
}
$zip = [System.IO.Compression.ZipFile]::OpenRead($env:PAW_DOC_PATH)
try {
  switch ($env:PAW_DOC_KIND) {
    'word' {
      Plain (ReadEntry $zip 'word/document.xml') '</w:p>'
    }
    'slides' {
      $slides = $zip.Entries | Where-Object { $_.FullName -match '^ppt/slides/slide(\d+)\.xml$' } | Sort-Object { [int]($_.FullName -replace '\D', '') }
      $i = 0
      foreach ($s in $slides) { $i++; "--- 第 $i 页 ---"; Plain (ReadEntry $zip $s.FullName) '</a:p>' }
    }
    'sheet' {
      $shared = @()
      $ss = ReadEntry $zip 'xl/sharedStrings.xml'
      if ($ss) { $shared = @(([xml]$ss).sst.si | ForEach-Object { $_.InnerText }) }
      $sheets = $zip.Entries | Where-Object { $_.FullName -match '^xl/worksheets/sheet(\d+)\.xml$' } | Sort-Object { [int]($_.FullName -replace '\D', '') }
      $n = 0
      foreach ($sh in $sheets) {
        $n++; "--- 工作表 $n ---"
        $doc = [xml](ReadEntry $zip $sh.FullName)
        $rows = 0
        foreach ($row in $doc.worksheet.sheetData.row) {
          $rows++; if ($rows -gt 300) { '……（后面的行省略）'; break }
          $cells = foreach ($c in $row.c) {
            if ($c.t -eq 's') { $shared[[int]$c.v] } elseif ($c.t -eq 'inlineStr') { $c.is.InnerText } else { $c.v }
          }
          ($cells -join "`t")
        }
      }
    }
  }
} finally { $zip.Dispose() }
"#;

const OCR_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTask = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asAction = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
function AwaitAction($op) { $task = $asAction.Invoke($null, @($op)); $task.Wait(-1) | Out-Null }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw '这台电脑没有可用的 OCR 语言包' }
function Recognize($stream) {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  foreach ($line in $result.Lines) { $line.Text }
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:PAW_DOC_PATH)) ([Windows.Storage.StorageFile])
if ($env:PAW_DOC_KIND -eq 'pdf') {
  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $pages = [Math]::Min([int]$pdf.PageCount, [int]$env:PAW_DOC_PAGES)
  "（共 $($pdf.PageCount) 页，识别了前 $pages 页）"
  for ($i = 0; $i -lt $pages; $i++) {
    "--- 第 $($i + 1) 页 ---"
    $page = $pdf.GetPage($i)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = 1700
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    Recognize $stream
    $stream.Dispose(); $page.Dispose()
  }
} else {
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  Recognize $stream
  $stream.Dispose()
}
"#;

fn run_script(script: &str, path: &Path, kind: &str) -> Result<String, String> {
    let output = crate::hidden_command("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("PAW_DOC_PATH", path)
        .env("PAW_DOC_KIND", kind)
        .env("PAW_DOC_PAGES", "12")
        .output()
        .map_err(|e| format!("读取失败：{e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let first = err.lines().find(|line| !line.trim().is_empty()).unwrap_or("未知错误");
        return Err(format!("读不出来：{}", first.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n"))
}

fn read_text_file(path: &Path) -> Result<String, String> {
    let mut handle = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    handle.by_ref().take(4 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.iter().take(8000).any(|b| *b == 0) {
        return Err("这是二进制文件，不能按文本读取".into());
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn expand(path: &str) -> PathBuf {
    // Windows 的 StorageFile（PDF / 图片识别用）只认反斜杠，统一换掉
    let normalized = if cfg!(windows) { path.replace('/', "\\") } else { path.to_string() };
    let trimmed = normalized.trim().trim_matches('"');
    if let Some(rest) = trimmed.strip_prefix("~") {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(home).join(rest.trim_start_matches(['/', '\\']));
        }
    }
    PathBuf::from(trimmed)
}

/// 把一个本地文件转成纯文本。只读，不改动文件。
#[tauri::command]
pub async fn read_document(path: String, max_chars: Option<usize>) -> Result<DocText, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand(&path);
        let meta = std::fs::metadata(&file).map_err(|e| format!("找不到文件 {}：{e}", file.display()))?;
        if meta.is_dir() {
            return Err("这是一个文件夹".into());
        }
        let ext = ext_of(&file);
        let kind = kind_of(&ext).ok_or_else(|| format!("暂时读不了 .{ext} 文件，能读：文本/代码、Word、PPT、Excel、PDF、图片"))?;
        let raw = match kind {
            "text" => read_text_file(&file)?,
            "word" | "slides" | "sheet" => run_script(OFFICE_SCRIPT, &file, kind)?,
            _ => tidy_ocr(&run_script(OCR_SCRIPT, &file, kind)?),
        };
        let text = raw.lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
        let text = text.trim().to_string();
        let (text, truncated) = clip(text, max_chars.unwrap_or(30_000).clamp(1_000, 200_000));
        Ok(DocText {
            name: file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            path: file.display().to_string(),
            kind: kind.into(),
            text,
            truncated,
            size: meta.len(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 拖进来的路径：名字、类型、大小，给桌宠决定弹哪些选项。
#[tauri::command]
pub fn describe_paths(paths: Vec<String>) -> Vec<DroppedFile> {
    paths
        .into_iter()
        .take(20)
        .map(|raw| {
            let path = expand(&raw);
            let meta = std::fs::metadata(&path).ok();
            DroppedFile {
                name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| raw.clone()),
                ext: ext_of(&path),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                is_dir: meta.map(|m| m.is_dir()).unwrap_or(false),
                path: raw,
            }
        })
        .collect()
}

/// 读图片给看图模型用（data URL）。只接受图片、最多 8MB。
#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    let file = expand(&path);
    let ext = ext_of(&file);
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return Err("只支持 png / jpg / gif / webp / bmp 图片".into()),
    };
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("图片太大（超过 8MB）".into());
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidy_removes_spaces_between_chinese() {
        assert_eq!(tidy_ocr("合 同 编 号 A 12 ok"), "合同编号 A 12 ok");
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_of("pdf"), Some("pdf"));
        assert_eq!(kind_of("docx"), Some("word"));
        assert_eq!(kind_of("png"), Some("image"));
        assert_eq!(kind_of("exe"), None);
    }
}
