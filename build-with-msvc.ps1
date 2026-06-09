# Build script that sets MSVC environment and runs Tauri build

$msvcBase = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"
$linkPath = "$msvcBase\bin\Hostx64\x64"
$sdkBase = "C:\Program Files (x86)\Windows Kits\10"

# Find latest Windows SDK
$sdkBin = Get-ChildItem "$sdkBase\bin\10*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdkBin) {
    # Try alternate path
    $sdkBin = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
}

$sdkBinPath = ""
if ($sdkBin) {
    $sdkBinPath = Join-Path $sdkBin.FullName "x64"
}

# Find Windows SDK lib and include
$sdkLib = ""
$sdkInclude = ""
$sdkDir = Get-ChildItem "$sdkBase\Include\10*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($sdkDir) {
    $sdkInclude = $sdkDir.FullName
    $sdkVersion = $sdkDir.Name
    $sdkLib = "$sdkBase\Lib\$sdkVersion"
}

Write-Host "MSVC Base: $msvcBase"
Write-Host "Link path: $linkPath"
Write-Host "SDK Bin: $sdkBinPath"
Write-Host "SDK Include: $sdkInclude"
Write-Host "SDK Lib: $sdkLib"

# Verify link.exe exists
if (-not (Test-Path "$linkPath\link.exe")) {
    Write-Error "link.exe not found at $linkPath"
    exit 1
}

# Set PATH
$currentPath = $env:PATH
$env:PATH = "$linkPath;$sdkBinPath;$currentPath"

# Set INCLUDE and LIB for MSVC
$env:INCLUDE = "$msvcBase\include;$sdkInclude\um;$sdkInclude\ucrt;$sdkInclude\shared"
$env:LIB = "$msvcBase\lib\x64;$sdkLib\um\x64;$sdkLib\ucrt\x64"

# Remove CI env vars
Remove-Item Env:CI -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_CI -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Environment configured. Starting Tauri build..."
Write-Host ""

Set-Location "e:\cn\zhuomiancc\chongwu"
node build-tauri.js
