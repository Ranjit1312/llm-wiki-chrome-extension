# ─────────────────────────────────────────────────────────────────────────────
# LLM Wiki — Windows installer (PowerShell)
# Usage:  Right-click → "Run with PowerShell"
#         OR in PowerShell: .\install.ps1
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"

$RepoDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDir  = Join-Path $RepoDir "dist"

function Write-Step  { param($msg) Write-Host "▸ $msg" -ForegroundColor Cyan }
function Write-OK    { param($msg) Write-Host "✔ $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
Write-Host "  ⬡  LLM Wiki — Local GraphRAG Extension"    -ForegroundColor White
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
Write-Host ""

# ── 1. Check / install Node.js ───────────────────────────────────────────────
Write-Step "Checking Node.js..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCmd) {
    Write-Warn "Node.js not found. Attempting install via winget..."

    # Try winget (Windows 10 1709+ / Windows 11)
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH in current session
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        Write-Warn "winget not available. Opening nodejs.org for manual install..."
        Start-Process "https://nodejs.org/en/download/"
        Write-Fail "Install Node.js LTS, restart PowerShell, then re-run this script."
    }
}

$nodeVer = node -v
$npmVer  = npm -v
Write-OK "Node $nodeVer / npm $npmVer"

# ── 2. Install dependencies ──────────────────────────────────────────────────
Write-Step "Installing npm dependencies..."
Set-Location $RepoDir

$ciResult = npm ci --prefer-offline 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warn "npm ci failed, falling back to npm install..."
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed. Check your network connection." }
}
Write-OK "Dependencies installed"

# ── 3. Build ─────────────────────────────────────────────────────────────────
Write-Step "Building extension (webpack)..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Fail "Build failed. Check the output above for errors." }
Write-OK "Build complete → dist\"

# ── 4. Verify ────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $DistDir "manifest.json"))) {
    Write-Fail "dist\manifest.json not found — build may have failed."
}
Write-OK "dist\ folder ready"

# ── 5. Open Chrome ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Chrome will open at chrome://extensions" -ForegroundColor Gray
Write-Host "  2. Enable Developer mode (top-right toggle)" -ForegroundColor Gray
Write-Host "  3. Click 'Load unpacked'" -ForegroundColor Gray
Write-Host "  4. Select: $DistDir" -ForegroundColor Cyan
Write-Host ""

$chromePaths = @(
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe",
    "$env:PROGRAMFILES(X86)\Google\Chrome\Application\chrome.exe"
)

$chromeFound = $false
foreach ($path in $chromePaths) {
    if (Test-Path $path) {
        Write-Step "Opening Chrome extensions page..."
        Start-Process $path "chrome://extensions"
        $chromeFound = $true
        break
    }
}
if (-not $chromeFound) {
    Write-Warn "Chrome not found in standard locations. Open it manually and go to chrome://extensions"
}

# Copy dist path to clipboard for easy pasting into Load unpacked dialog
$DistDir | Set-Clipboard
Write-OK "dist\ path copied to clipboard — paste it in the 'Load unpacked' dialog"

Write-Host ""
Write-Host "✔ Installation complete!" -ForegroundColor Green
Write-Host "  See SETUP.md for model download instructions." -ForegroundColor Gray
Write-Host ""
