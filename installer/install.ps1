<#
  Geekatplay Photoshop Bridge - Windows installer
  by Geekatplay Studio - Vladimir Chopine
  https://www.geekatplay.com

  Started by install.bat. Copies the ComfyUI nodes into your ComfyUI folder and
  installs the Photoshop panel through Adobe Creative Cloud.

    -ComfyUI <folder>   ComfyUI folder to install the nodes into (skips the questions)
    -SkipPhotoshop      only install the ComfyUI nodes
    -NoPause            do not wait for a key at the end
#>
param([string]$ComfyUI = "", [switch]$SkipPhotoshop, [switch]$NoPause)

$ErrorActionPreference = "Stop"
$Pack = Split-Path -Parent $PSScriptRoot
$PackName = "ComfyUI-Geekatplay-Photoshop"
$Ccx = Join-Path $Pack "build\GeekatplayComfyUIBridge.ccx"

function Step($n, $text) { Write-Host ""; Write-Host "  [$n/3] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "        OK  $text" -ForegroundColor Green }
function Say($text) { Write-Host "            $text" }
function Warn($text) { Write-Host "        !!  $text" -ForegroundColor Yellow }

# Accepts the ComfyUI folder, the portable package folder, or custom_nodes itself.
function Get-CustomNodes($path) {
    foreach ($candidate in @($path, (Join-Path $path "ComfyUI"))) {
        if ((Split-Path -Leaf $candidate) -eq "custom_nodes" -and (Test-Path $candidate)) { return $candidate }
        $nodes = Join-Path $candidate "custom_nodes"
        if (Test-Path $nodes) { return $nodes }
    }
    return $null
}

function Find-ComfyUI {
    foreach ($guess in @(
            "$env:USERPROFILE\Documents\ComfyUI",
            "$env:USERPROFILE\ComfyUI",
            "$env:USERPROFILE\Desktop\ComfyUI_windows_portable",
            "$env:USERPROFILE\Downloads\ComfyUI_windows_portable",
            "C:\ComfyUI_windows_portable",
            "C:\ComfyUI")) {
        $nodes = Get-CustomNodes $guess
        if ($nodes) { return $nodes }
    }
    return $null
}

function Select-Folder {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select your ComfyUI folder (the one that contains custom_nodes)"
    if ($dialog.ShowDialog($owner) -eq "OK") { return $dialog.SelectedPath }
    return $null
}

function Install-Nodes {
    Step 1 "ComfyUI nodes"
    $parent = Split-Path -Parent $Pack
    if ((Split-Path -Leaf $parent) -eq "custom_nodes") {
        Ok "Already in ComfyUI: $Pack"
        return
    }
    $nodes = $null
    if ($ComfyUI) {
        $nodes = Get-CustomNodes $ComfyUI
        if (-not $nodes) { throw "No custom_nodes folder found in $ComfyUI." }
    } else {
        $found = Find-ComfyUI
        if ($found) {
            $answer = Read-Host "            Found ComfyUI at $(Split-Path -Parent $found). Install there? [Y/n]"
            if ($answer -notmatch "^[nN]") { $nodes = $found }
        }
        if (-not $nodes) {
            Say "Pick your ComfyUI folder in the window that opens."
            Say "Press Cancel if ComfyUI runs on another computer."
            $picked = Select-Folder
            if ($picked) {
                $nodes = Get-CustomNodes $picked
                if (-not $nodes) { Warn "There is no custom_nodes folder in $picked." }
            }
        }
    }
    if (-not $nodes) {
        Warn "Skipped. On the ComfyUI computer, put this folder in ComfyUI\custom_nodes"
        Say "(or install it with ComfyUI-Manager or git clone)."
        return
    }
    $target = Join-Path $nodes $PackName
    robocopy $Pack $target /E /XD .git __pycache__ build /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying to $target failed (robocopy code $LASTEXITCODE)." }
    Ok "Copied to $target"
    Say "Restart ComfyUI to load the nodes."
}

function Build-Plugin {
    Step 2 "Photoshop panel package"
    New-Item -ItemType Directory -Force (Split-Path $Ccx) | Out-Null
    if (Test-Path $Ccx) { Remove-Item $Ccx }
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $source = Join-Path $Pack "photoshop"
    $zip = [IO.Compression.ZipFile]::Open($Ccx, "Create")
    try {
        foreach ($file in Get-ChildItem $source -Recurse -File) {
            $entry = $file.FullName.Substring($source.Length + 1).Replace("\", "/")
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry) | Out-Null
        }
    } finally {
        $zip.Dispose()
    }
    Ok "Built $Ccx"
}

function Show-ManualSteps {
    Say "Install the panel by hand:"
    Say "  1. Open the Adobe Creative Cloud app and sign in."
    Say "  2. Double-click $Ccx and confirm Install."
    Say "  3. Restart Photoshop and open Plugins > Geekatplay ComfyUI Bridge."
    Say "No Creative Cloud app? Use the Adobe UXP Developer Tool: Add Plugin,"
    Say "pick photoshop\manifest.json in this folder, then Load."
    Start-Process explorer.exe "/select,`"$Ccx`""
}

function Install-Plugin {
    Step 3 "Install the panel in Photoshop"
    $agent = $null
    foreach ($common in @($env:CommonProgramW6432, $env:CommonProgramFiles)) {
        $path = Join-Path "$common" "Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
        if ($common -and (Test-Path $path)) { $agent = $path; break }
    }
    if (-not $agent) {
        Warn "Adobe Creative Cloud's plugin installer was not found."
        Show-ManualSteps
        return
    }
    # An earlier version stays registered next to the new one unless it is removed first.
    & $agent /remove "Geekatplay ComfyUI Bridge" 2>&1 | Out-Null
    $output = & $agent /install $Ccx 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Ok "Installed the ComfyUI Bridge panel."
        Say "Open Plugins > Geekatplay ComfyUI Bridge in Photoshop (restart Photoshop if it is not there yet)."
    } else {
        Warn "Creative Cloud could not install the panel:"
        Say $output.Trim()
        Show-ManualSteps
    }
}

Write-Host ""
Write-Host "  Geekatplay Photoshop Bridge - installer" -ForegroundColor White
Write-Host "  Geekatplay Studio - www.geekatplay.com"
try {
    Install-Nodes
    if ($SkipPhotoshop) {
        Write-Host ""
        Say "Photoshop panel skipped (-SkipPhotoshop)."
    } else {
        Build-Plugin
        Install-Plugin
    }
    Write-Host ""
    Write-Host "  Done. Next:" -ForegroundColor White
    Say "1. Start or restart ComfyUI."
    Say "2. In Photoshop open Plugins > Geekatplay ComfyUI Bridge > ComfyUI Bridge."
    Say "3. ComfyUI on another computer? Enter its address in the panel's Settings tab."
} catch {
    Write-Host ""
    Warn "Installation stopped: $($_.Exception.Message)"
}
if (-not $NoPause) {
    Write-Host ""
    Read-Host "  Press Enter to close" | Out-Null
}
