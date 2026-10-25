# Claude Crew installer / updater for Windows. One command does everything:
#   installs what is missing (Node.js, Claude Code), downloads the latest Crew into C:\Crew,
#   creates the config, starts Crew, turns on autostart, and (optionally) joins your hub.
# Safe to run again any time: it updates the code and never touches your config, data or workspace.
#
#   First time, paste into PowerShell:
#     irm https://raw.githubusercontent.com/hast3/claudecrew/main/install.ps1 | iex
#   Joining a hub (the hub's Machines panel gives you this exact line):
#     & ([scriptblock]::Create((irm https://raw.githubusercontent.com/hast3/claudecrew/main/install.ps1))) -Hub crew.example.com -Code 3ACA9B73
#
# Options: -Dir C:\Crew   -Hub <address>  -Code <pairing code>   -NoAutostart

param([string]$Dir = 'C:\Crew', [string]$Hub = '', [string]$Code = '', [switch]$NoAutostart)

$ErrorActionPreference = 'Stop'
$Repo = 'hast3/claudecrew'
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   $t" -ForegroundColor Yellow }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:USERPROFILE '.local\bin')
}
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Winget-Install($id) {
    if (-not (Have winget)) { return $false }
    winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
    Refresh-Path
    return $true
}

try {
    Refresh-Path

    Step '1/6  Node.js'
    $nodeOk = $false
    if (Have node) { $nodeOk = ([int]((node --version) -replace '^v(\d+).*', '$1')) -ge 20 }
    if (-not $nodeOk) {
        Write-Host '   Installing Node.js (LTS)...'
        Winget-Install 'OpenJS.NodeJS.LTS' | Out-Null
        if (Have node) { $nodeOk = ([int]((node --version) -replace '^v(\d+).*', '$1')) -ge 20 }
    }
    if (-not $nodeOk) { throw 'Node.js 20+ is needed. Install it from https://nodejs.org (LTS), then run this command again.' }
    Ok "Node $(node --version)"

    Step '2/6  Claude Code'
    if (-not (Have claude)) {
        Write-Host '   Installing Claude Code...'
        Invoke-Expression (Invoke-RestMethod 'https://claude.ai/install.ps1')
        Refresh-Path
    }
    if (-not (Have claude)) { throw 'Claude Code did not install. Install it from https://claude.com/product/claude-code, then run this command again.' }
    Ok 'Claude Code is installed'

    Step "3/6  Crew files in $Dir"
    if (-not (Have git)) { Write-Host '   Installing Git...'; Winget-Install 'Git.Git' | Out-Null }
    if (Test-Path (Join-Path $Dir '.git')) {
        if (-not (Have git)) { throw 'Git is needed to update this folder. Install it from https://git-scm.com and run again.' }
        git -C $Dir pull --ff-only 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn 'Could not fast-forward (you have local edits?). Kept your files as they are.' } else { Ok 'Updated to the latest version' }
    } elseif ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1) -and -not (Test-Path (Join-Path $Dir 'server.js'))) {
        throw "$Dir already has other files in it. Run again with -Dir pointing to a different folder."
    } elseif (Have git) {
        if (Test-Path (Join-Path $Dir 'server.js')) {
            # an existing zip install: switch it to a git clone, keeping its config/data/workspace
            git -C $Dir init -q; git -C $Dir remote add origin "https://github.com/$Repo.git" 2>$null
            git -C $Dir fetch -q origin main; git -C $Dir checkout -q -f -B main origin/main
        } else { git clone -q "https://github.com/$Repo.git" $Dir }
        Ok 'Downloaded the latest version'
    } else {
        $zip = Join-Path $env:TEMP 'claudecrew.zip'; $tmp = Join-Path $env:TEMP 'claudecrew-x'
        Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/main.zip" -OutFile $zip
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive $zip $tmp -Force
        New-Item -ItemType Directory -Force $Dir | Out-Null
        Copy-Item (Join-Path (Get-ChildItem $tmp | Select-Object -First 1).FullName '*') $Dir -Recurse -Force
        Remove-Item $zip, $tmp -Recurse -Force
        Ok 'Downloaded the latest version (zip)'
    }

    Step '4/6  Settings'
    $cfgFile = Join-Path $Dir 'crew.config.json'
    if (-not (Test-Path $cfgFile)) {
        $cfg = [IO.File]::ReadAllText((Join-Path $Dir 'crew.config.example.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $cfg.settings.userName = $env:USERNAME
        $cfg.settings | Add-Member -NotePropertyName machineName -NotePropertyValue $env:COMPUTERNAME -Force
        [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
        Ok "Created crew.config.json (this PC is called $env:COMPUTERNAME)"
    } else { Ok 'Kept your existing crew.config.json' }
    $port = 7777
    try { $port = [int](([IO.File]::ReadAllText($cfgFile, [Text.Encoding]::UTF8) | ConvertFrom-Json).settings.port) } catch { }
    $base = "http://127.0.0.1:$port"
    $hdr = @{ 'x-crew' = '1'; 'Origin' = $base }
    function Crew-Up { try { Invoke-RestMethod "$base/api/machines/link" -TimeoutSec 3 | Out-Null; $true } catch { $false } }

    Step '5/6  Starting Crew'
    if (Crew-Up) {
        try { Invoke-RestMethod "$base/api/restart" -Method Post -Headers $hdr -TimeoutSec 5 | Out-Null } catch { }
        Start-Sleep 4
    } else {
        Start-Process -FilePath (Join-Path $Dir 'run-crew.cmd') -WorkingDirectory $Dir -WindowStyle Hidden
    }
    for ($i = 0; $i -lt 30 -and -not (Crew-Up); $i++) { Start-Sleep 1 }
    if (-not (Crew-Up)) { throw "Crew did not start. Look at $Dir\data\crew.log for the reason." }
    Ok "Crew is running at http://localhost:$port"

    if ($Hub -and $Code) {
        Step "Joining the hub at $Hub"
        try {
            Invoke-RestMethod "$base/api/machines/connect" -Method Post -Headers $hdr -ContentType 'application/json' `
                -Body (@{ url = $Hub; code = $Code } | ConvertTo-Json) | Out-Null
            Ok 'Connected. This PC now shows up in the hub''s Machines panel.'
        } catch {
            $msg = $_.ErrorDetails.Message
            Warn ("Could not join the hub: " + $(if ($msg) { ($msg | ConvertFrom-Json).error } else { $_.Exception.Message }))
            Warn 'Get a fresh code from the hub''s Machines panel and use the "Connect this PC to a hub" box here.'
        }
    }

    Step '6/6  Autostart'
    if ($NoAutostart) { Warn 'Skipped (-NoAutostart).' }
    else {
        $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Dir 'install-autostart.ps1')`" -User `"$env:USERDOMAIN\$env:USERNAME`""
        try {
            $p = Start-Process powershell -ArgumentList $arg -Verb RunAs -Wait -PassThru
            if ($p.ExitCode -eq 0) { Ok 'Crew will now start with Windows.' } else { Warn "Autostart did not finish. Run $Dir\install-autostart.ps1 as Administrator later." }
        } catch { Warn "Autostart skipped (the administrator prompt was declined). Run $Dir\install-autostart.ps1 as Administrator later." }
    }

    Write-Host "`nDone." -ForegroundColor Green
    Write-Host "  Open Crew:   http://localhost:$port"
    Write-Host '  One thing left: sign in to Claude Code once. Type  claude  in a terminal and follow the login.'
    Start-Process "http://localhost:$port"
} catch {
    Write-Host "`nStopped: $($_.Exception.Message)" -ForegroundColor Red
}
