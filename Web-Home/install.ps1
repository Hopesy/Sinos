# Sinos CLI - Windows Installer / Updater
# Usage:   irm https://raw.githubusercontent.com/Hopesy/Sinos/main/install/install.ps1 | iex
# License: AGPL-3.0-or-later (https://github.com/Hopesy/Sinos/blob/main/LICENSE)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Sinos CLI Installer" -ForegroundColor Cyan
Write-Host "  --------------------" -ForegroundColor DarkGray

# Resolve the latest published release and Windows installer from GitHub.
# The version is accepted only when the matching setup asset exists, so a
# tag whose CI build is still running does not advertise an unavailable update.
Write-Host "  Fetching latest version..." -ForegroundColor Gray
$latestVer = $null
$downloadUrl = $null
try {
    $release = Invoke-RestMethod "https://api.github.com/repos/Hopesy/Sinos/releases/latest" `
        -Headers @{ "User-Agent" = "SinosCLI-Install" } -TimeoutSec 15
    $winAsset = $release.assets | Where-Object { $_.name -like "*Windows_x64-setup.exe" -or $_.name -like "*x64-setup.exe" } | Select-Object -First 1
    if ($winAsset) {
        $latestVer = $release.tag_name -replace '^v',''
        $downloadUrl = $winAsset.browser_download_url
    }
} catch {}

# Detect currently installed version from Windows registry
$installedVer = $null
$regPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach ($path in $regPaths) {
    $entry = Get-ItemProperty $path -ErrorAction SilentlyContinue |
             Where-Object { $_.DisplayName -like "Sinos CLI*" -or $_.DisplayName -like "Coffee CLI*" } |
             Select-Object -First 1
    if ($entry) {
        $installedVer = $entry.DisplayVersion
        break
    }
}

# Empty `version` = the Windows build isn't out yet (CI probably still
# running for a just-tagged release). Show an explicit "come back later"
# message and pause so the window doesn't auto-close on the user before
# they read it (some launch flows spawn a fresh PowerShell that closes
# the moment the script returns).
if (-not $latestVer) {
    Write-Host ""
    Write-Host "  A new version of Sinos CLI was just released." -ForegroundColor Yellow
    Write-Host "  The server is currently redeploying." -ForegroundColor Yellow
    Write-Host "  Please try again in about 10 minutes." -ForegroundColor Yellow
    Write-Host ""
    if ($installedVer) {
        Write-Host "  Your current v$installedVer stays installed." -ForegroundColor Gray
        Write-Host ""
    }
    Write-Host "  Press any key to close..." -ForegroundColor DarkGray
    # ReadKey reads from the console keyboard buffer directly, so it works
    # even when stdin is consumed by `irm | iex`. The try/catch swallows
    # the case where there is no interactive console (CI / redirected).
    try { [void][System.Console]::ReadKey($true) } catch {}
    exit 0
}

Write-Host "  Latest : v$latestVer" -ForegroundColor Green

if ($installedVer) {
    Write-Host "  Installed: v$installedVer" -ForegroundColor Gray
    if ($installedVer -eq $latestVer) {
        Write-Host ""
        Write-Host "  Sinos CLI is already up to date (v$installedVer)." -ForegroundColor Green
        Write-Host ""
        exit 0
    }
    Write-Host "  Upgrading v$installedVer -> v$latestVer ..." -ForegroundColor Yellow
} else {
    Write-Host "  Not installed - performing fresh install..." -ForegroundColor Gray
}

$url = $downloadUrl
$out = "$env:TEMP\sinos-cli-setup.exe"

Write-Host "  Downloading..." -ForegroundColor Gray
# Wrap in try/catch so a transient GitHub/API or asset-upload failure surfaces
# as a friendly message instead of a raw WebException stack.
try {
    Invoke-WebRequest $url -OutFile $out -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "  Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  The Windows installer may still be uploading to GitHub." -ForegroundColor DarkYellow
    Write-Host "  Please wait ~5 minutes and run this command again." -ForegroundColor DarkYellow
    Write-Host ""
    exit 1
}

Write-Host "  Installing..." -ForegroundColor Gray
Start-Process $out -Wait

Write-Host ""
Write-Host "  Done! Sinos CLI v$latestVer installed." -ForegroundColor Green
Write-Host "  Launch it from the Start Menu." -ForegroundColor Gray
Write-Host ""
