# Claude Crew uninstaller for Windows. Removes everything Crew put on this PC.
#
#   Easiest:  double-click UNINSTALL.bat (in the Crew folder).
#   Or from PowerShell:  powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   See what it would do first, changing nothing:  ... -DryRun
#
# Needs no administrator rights. It asks before it deletes anything (type REMOVE), unless you pass -Yes.
# Options: -Dir <folder>  -Yes (no questions)  -DryRun (list only)  -KeepData (keep your config, chat history,
#          workspace and saved logins; remove everything else)  -KeepClaudeHistory (keep Claude Code's saved
#          conversations for the Crew agents)
# ASCII only on purpose: Windows PowerShell 5.1 misreads other characters in a script.

param(
    [string]$Dir = '',
    [switch]$Yes, [switch]$DryRun, [switch]$KeepData, [switch]$KeepClaudeHistory,
    [switch]$FromTemp
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Say($t)  { Write-Host "   $t" }
function Good($t) { Write-Host "   OK: $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   NOTE: $t" -ForegroundColor Yellow }
function Head($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }

# ---- Where is Crew? -------------------------------------------------------------------
if (-not $Dir) {
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'server.js'))) { $Dir = $PSScriptRoot }
    else { $Dir = Join-Path $env:USERPROFILE 'ClaudeCrew' }
}
$Dir = $Dir.TrimEnd('\', '/')
if (-not (Test-Path (Join-Path $Dir 'server.js'))) {
    Write-Host ""
    Write-Host "  I can't find a Claude Crew install at: $Dir" -ForegroundColor Red
    Write-Host "  Run this from inside the Crew folder, or add  -Dir ""C:\path\to\Crew""."
    exit 1
}
$Dir = (Resolve-Path $Dir).Path.TrimEnd('\')
$DirLike = $Dir.Replace('[', '`[').Replace(']', '`]') + '\*'

# ---- Run from a temp copy, so the Crew folder itself can be deleted --------------------
if (-not $FromTemp -and $PSScriptRoot -and $Dir -and ($PSScriptRoot.TrimEnd('\') -like ($Dir.Replace('[', '`[').Replace(']', '`]') + '*'))) {
    $copy = Join-Path $env:TEMP ('crew-uninstall-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
    Copy-Item $PSCommandPath $copy -Force
    $pass = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $copy, '-Dir', $Dir, '-FromTemp')
    if ($Yes) { $pass += '-Yes' }
    if ($DryRun) { $pass += '-DryRun' }
    if ($KeepData) { $pass += '-KeepData' }
    if ($KeepClaudeHistory) { $pass += '-KeepClaudeHistory' }
    & powershell.exe @pass
    $code = $LASTEXITCODE
    Remove-Item $copy -Force -ErrorAction SilentlyContinue
    exit $code
}

# ---- What exists -----------------------------------------------------------------------
$port = 7777
$cfgPath = Join-Path $Dir 'crew.config.json'
$ports = @()
try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.settings.port) { $port = [int]$cfg.settings.port }
    $ports += $port
    if ($cfg.cloudflare.port) { $ports += [int]$cfg.cloudflare.port }
} catch { $ports = @($port, 7778) }

$taskNames = @('Claude Crew', 'CrewScreen')
# Only tasks that belong to THIS folder (another Crew install, or a test copy, must never lose its task).
$tasks = @(); foreach ($n in $taskNames) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if ($t) { $txt = (($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' ').ToLower(); if ($txt.Contains($Dir.ToLower())) { $tasks += $n } }
}

function Find-Shortcuts {
    $out = @()
    $sh = New-Object -ComObject WScript.Shell
    $places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs')) | Where-Object { $_ }
    foreach ($p in $places) {
        foreach ($f in (Get-ChildItem $p -Filter 'Claude Crew*.lnk' -ErrorAction SilentlyContinue)) {
            try {
                $l = $sh.CreateShortcut($f.FullName)
                if (("$($l.TargetPath) $($l.Arguments) $($l.WorkingDirectory)").ToLower().Contains($Dir.ToLower())) { $out += $f.FullName }
            } catch { }
        }
    }
    return $out
}
$shortcuts = @(Find-Shortcuts)

$projRoot = Join-Path $env:USERPROFILE '.claude\projects'
$mangled = ($Dir -replace '[^A-Za-z0-9]', '-')
$history = @()
if (-not $KeepClaudeHistory -and (Test-Path $projRoot)) {
    $history = @(Get-ChildItem $projRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $mangled -or $_.Name.StartsWith($mangled + '-') } | ForEach-Object { $_.FullName })
}

$reviewBase = if ($env:CREW_REVIEW_DIR) { $env:CREW_REVIEW_DIR } else { Join-Path $env:USERPROFILE 'td_review' }
$reviewTmp = Join-Path $reviewBase 'crew-tmp'
if (-not (Test-Path $reviewTmp)) { $reviewTmp = $null }

$keepNames = @('crew.config.json', 'data', 'workspace', 'secrets')
$topItems = @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue)
if ($KeepData) { $topItems = @($topItems | Where-Object { $keepNames -notcontains $_.Name }) }

Write-Host ""
Write-Host "  Claude Crew uninstaller" -ForegroundColor Cyan
Write-Host ""
Write-Host "  This will remove Claude Crew from this PC:"
Write-Host "    - stop Crew, its tray icon, the screen helper and any app previews it started (port(s) $($ports -join ', '))"
foreach ($n in $tasks) { Write-Host "    - the scheduled task '$n'" }
foreach ($s in $shortcuts) { Write-Host "    - the shortcut $s" }
if ($KeepData) { Write-Host "    - the Crew program files in $Dir (KEEPING crew.config.json, data, workspace and secrets)" }
else { Write-Host "    - the whole folder $Dir, including your config, chat history, workspace notes, saved logins and uploads" }
foreach ($h in $history) { Write-Host "    - Claude Code's saved conversations: $h" }
if ($reviewTmp) { Write-Host "    - temporary screen pictures: $reviewTmp" }
Write-Host ""
Write-Host "  Not removed (other programs may use them): Node.js, Git, Claude Code and your Claude sign-in."
Write-Host "  Your own project folders outside the Crew folder are never touched."
Write-Host ""

if ($DryRun) { Write-Host "  Dry run: nothing was changed." -ForegroundColor Yellow; exit 0 }

if (-not $Yes) {
    if ($KeepData) { $ans = Read-Host "   Type REMOVE and press Enter to uninstall (anything else cancels)" }
    else { $ans = Read-Host "   This deletes EVERYTHING above, including chat history. Type REMOVE and press Enter (anything else cancels)" }
    if ($ans.Trim() -cne 'REMOVE') { Write-Host "  Cancelled. Nothing was changed."; exit 0 }
}

$problems = @()

# ---- 1. Stop everything ----------------------------------------------------------------
Head 'Stopping Crew'
# The supervisor loop first (run-crew.cmd restarts Crew if it dies), so nothing comes back.
$self = $PID
$parents = @(); $p = $self
for ($i = 0; $i -lt 6 -and $p; $i++) { $parents += $p; $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; $p = if ($pr) { $pr.ParentProcessId } else { 0 } }
function Kill-Tree($procId) { if ($procId -and ($parents -notcontains [int]$procId)) { & taskkill /PID $procId /T /F 2>&1 | Out-Null } }

foreach ($n in $tasks) { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
foreach ($pr in $all) {
    $cl = [string]$pr.CommandLine
    if (-not $cl) { continue }
    $inDir = $cl.ToLower().Contains($Dir.ToLower())
    $isLoop = $inDir -and ($cl -match 'run-crew\.cmd')
    $isHelper = $inDir -and ($cl -match 'crew-tray\.ps1|screen-helper\.ps1|control-watchdog\.ps1|Start Crew\.bat|run-crew\.cmd')
    if (($isLoop -or $isHelper) -and ($parents -notcontains [int]$pr.ProcessId)) { Kill-Tree $pr.ProcessId }
}
# Whatever still listens on Crew's ports is Crew's server (and the apps it started via previews).
foreach ($pt in ($ports | Select-Object -Unique)) {
    foreach ($c in @(Get-NetTCPConnection -LocalPort $pt -State Listen -ErrorAction SilentlyContinue)) {
        $own = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($own -and $own.ProcessName -match '^node$') { Kill-Tree $c.OwningProcess }
    }
}
try {
    $pv = Get-Content (Join-Path $Dir 'data\previews.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    foreach ($x in @($pv)) { if ($x.pid) { Kill-Tree $x.pid } }
} catch { }
# Anything still running out of the Crew folder (private Node copy, Claude Code started by Crew).
Start-Sleep -Milliseconds 800
foreach ($pr in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $exe = [string]$pr.ExecutablePath
    if ($exe -and $exe.ToLower().StartsWith($Dir.ToLower() + '\') -and ($parents -notcontains [int]$pr.ProcessId)) { Kill-Tree $pr.ProcessId }
}
Good 'Crew is stopped'

# ---- 2. Windows entries -----------------------------------------------------------------
Head 'Removing Windows entries'
foreach ($n in $tasks) {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { $problems += "Could not remove the scheduled task '$n' (try again as Administrator)." } else { Good "Removed scheduled task '$n'" }
}
if (-not $tasks.Count) { Say 'No scheduled tasks to remove.' }
foreach ($s in $shortcuts) {
    Remove-Item $s -Force -ErrorAction SilentlyContinue
    if (Test-Path $s) { $problems += "Could not remove $s" } else { Good "Removed $s" }
}
if (-not $shortcuts.Count) { Say 'No shortcuts to remove.' }

# ---- 3. Claude Code history and temp pictures -------------------------------------------
Head 'Removing Claude Code conversations and temp files made by Crew'
foreach ($h in $history) {
    Remove-Item $h -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $h) { $problems += "Could not remove $h" } else { Good "Removed $h" }
}
if (-not $history.Count) { Say 'Nothing to remove there.' }
if ($reviewTmp) {
    Remove-Item $reviewTmp -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $reviewTmp) { $problems += "Could not remove $reviewTmp" } else { Good "Removed $reviewTmp" }
    try { if (-not (Get-ChildItem $reviewBase -Force -ErrorAction SilentlyContinue)) { Remove-Item $reviewBase -Force -ErrorAction SilentlyContinue } } catch { }
}

# ---- 4. The Crew folder -----------------------------------------------------------------
Head 'Removing Crew files'
Set-Location $env:TEMP
foreach ($attempt in 1..3) {
    foreach ($it in @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue)) {
        if ($KeepData -and $keepNames -contains $it.Name) { continue }
        # Long paths and read-only files (git, node_modules): clear attributes, then delete.
        try { if ($it.PSIsContainer) { & cmd.exe /c "attrib -r -s -h `"$($it.FullName)\*`" /s /d" 2>&1 | Out-Null } else { $it.Attributes = 'Normal' } } catch { }
        Remove-Item -LiteralPath $it.FullName -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $it.FullName) { & cmd.exe /c "rd /s /q `"$($it.FullName)`"" 2>&1 | Out-Null }
    }
    $left = @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue | Where-Object { -not ($KeepData -and $keepNames -contains $_.Name) })
    if (-not $left.Count) { break }
    Start-Sleep 2
}
if (-not $KeepData) { try { if (-not (Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue)) { Remove-Item $Dir -Force -ErrorAction SilentlyContinue } } catch { } }
if ($KeepData) {
    $left = @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue | Where-Object { $keepNames -notcontains $_.Name })
} else { $left = if (Test-Path $Dir) { @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue) } else { @() } }
if ($left.Count) { $problems += "Could not remove: $(($left | ForEach-Object { $_.Name }) -join ', ') in $Dir (something still has it open; close it and run this again)." }
else { Good $(if ($KeepData) { "Removed the Crew program files (kept your data in $Dir)" } else { "Removed $Dir" }) }

# ---- Done -------------------------------------------------------------------------------
Write-Host ""
if ($problems.Count) {
    Write-Host "  Mostly done, but:" -ForegroundColor Yellow
    foreach ($x in $problems) { Write-Host "    - $x" -ForegroundColor Yellow }
} else {
    Write-Host "  Claude Crew is uninstalled." -ForegroundColor Green
}
Write-Host ""
Write-Host "  Things this script cannot reach:"
Write-Host "    - Node.js, Git and Claude Code stay installed. Remove them in Settings > Apps if you want."
Write-Host "    - On a phone: delete the Crew icon from the home screen and turn off its notifications."
Write-Host "    - If this PC was joined to a hub, remove it from the hub's Machines panel."
Write-Host "    - If you set up a Cloudflare tunnel, delete it in your Cloudflare dashboard."
exit $(if ($problems.Count) { 1 } else { 0 })
