# DeepSeek Harness - runtime assembly script (ASCII only for Windows PowerShell 5.1).
# Assembles build/runtime from a verified @deepseek-ai/dsh install + portable Node,
# then prunes non-win32-x64 native prebuilds to shrink the payload.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-runtime.ps1
#
# Options:
#   -DshSource  path to an installed @deepseek-ai/dsh directory (auto-detected from global npm)
#   -NodeSource path to node.exe or a Node.js install dir (auto-detected from PATH)
#   -OutDir     output dir (default: build\runtime)
param(
  [string]$DshSource = "",
  [string]$NodeSource = "",
  [string]$OutDir = "build\runtime"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ---- 1. Locate DSH source ----
if (-not $DshSource) {
  $g = npm root -g
  $candidate = Join-Path $g "@deepseek-ai\dsh"
  if (Test-Path $candidate) { $DshSource = $candidate }
}
if (-not $DshSource -or -not (Test-Path (Join-Path $DshSource "lib\bin.js"))) {
  throw "dsh not found. Install with: npm install -g @deepseek-ai/dsh   (or pass -DshSource)"
}

# ---- 2. Locate node.exe ----
$nodeExe = ""
if ($NodeSource) {
  if (Test-Path $NodeSource -PathType Leaf) { $nodeExe = $NodeSource }
  elseif (Test-Path (Join-Path $NodeSource "node.exe")) { $nodeExe = Join-Path $NodeSource "node.exe" }
}
else {
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $nodeExe -or -not (Test-Path $nodeExe)) {
  throw "node.exe not found. Install Node v24.x or pass -NodeSource"
}

# ---- 3. Copy ----
$dshDest = Join-Path $OutDir "dsh"
$nodeDest = Join-Path $OutDir "node"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "Copy DSH runtime: $DshSource -> $dshDest"
robocopy $DshSource $dshDest /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

Write-Host "Copy portable Node: $nodeExe -> $nodeDest"
New-Item -ItemType Directory -Force -Path $nodeDest | Out-Null
Copy-Item $nodeExe (Join-Path $nodeDest "node.exe") -Force

# ---- 4. Prune non-win32-x64 native artifacts ----
Write-Host "Prune non-win32-x64 native artifacts..."

# 4.1 remove .bin shim dirs
Get-ChildItem -Path $dshDest -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq ".bin" } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 4.2 remove darwin/linux prebuild dirs
Get-ChildItem -Path $dshDest -Directory -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match "^(darwin|linux)" } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 4.3 node-pty: keep only win32-x64
$arm = Join-Path $dshDest "node_modules\node-pty\prebuilds\win32-arm64"
if (Test-Path $arm) { Remove-Item $arm -Recurse -Force }
$tp = Join-Path $dshDest "node_modules\node-pty\third_party"
if (Test-Path $tp) { Remove-Item $tp -Recurse -Force }

# ---- 5. Verify ----
if (-not (Test-Path (Join-Path $dshDest "lib\bin.js"))) { throw "assembly failed: missing dsh/lib/bin.js" }
if (-not (Test-Path (Join-Path $nodeDest "node.exe"))) { throw "assembly failed: missing node.exe" }

$ver = & (Join-Path $nodeDest "node.exe") -v
Write-Host ""
Write-Host "Runtime assembly complete:"
Write-Host "  portable Node : $ver"
Write-Host "  DSH dir       : $dshDest"
