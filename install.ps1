# Claude Crew installer for Windows. It asks a few plain questions, then does everything else.
#
#   Easiest:  double-click INSTALL.bat (in the Crew folder).
#   Or paste this into PowerShell:
#     irm https://raw.githubusercontent.com/hast3/claudecrew/main/install.ps1 | iex
#   Joining a hub (the hub's Machines panel gives you this exact line):
#     & ([scriptblock]::Create((irm https://raw.githubusercontent.com/hast3/claudecrew/main/install.ps1))) -Hub crew.example.com -Code 3ACA9B73
#
# Needs no administrator rights. Safe to run again: it never touches your config, chat history or workspace.
# Options: -Dir <folder>  -Name <your name>  -Yes (accept every default, ask nothing)  -NoAutostart  -Hub <address> -Code <code>
# ASCII only on purpose: Windows PowerShell 5.1 misreads other characters in a script.

param(
    [string]$Dir = '', [string]$Name = '', [int]$Port = 7777,
    [string]$Hub = '', [string]$Code = '',
    [switch]$Yes, [switch]$NoAutostart, [switch]$SkipClaudeTest, [switch]$ConsoleSetup
)

$ErrorActionPreference = 'Stop'
$Repo = 'hast3/claudecrew'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
# Work networks often use a proxy that needs your Windows login. This lets downloads use it.
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }
$ProgressPreference = 'SilentlyContinue'   # much faster downloads in Windows PowerShell 5.1

function Say($t)   { Write-Host "   $t" }
function Good($t)  { Write-Host "   OK: $t" -ForegroundColor Green }
function Warn($t)  { Write-Host "   NOTE: $t" -ForegroundColor Yellow }
function Head($n, $t) { Write-Host ""; Write-Host "== Step $n of 6: $t" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:USERPROFILE '.local\bin')
    if ($script:Dir) { $rt = Join-Path $script:Dir 'runtime\node'; if (Test-Path (Join-Path $rt 'node.exe')) { $env:Path = "$rt;$env:Path" } }
}
function Ask($question, $default) {
    if ($Yes) { return $default }
    $shown = if ($default) { " [$default]" } else { '' }
    $a = Read-Host "   $question$shown"
    if ([string]::IsNullOrWhiteSpace($a)) { return $default }
    return $a.Trim()
}
function Ask-YesNo($question, $defaultYes) {
    if ($Yes) { return $defaultYes }
    $hint = if ($defaultYes) { 'Y/n' } else { 'y/N' }
    while ($true) {
        $a = (Read-Host "   $question ($hint)").Trim().ToLower()
        if ($a -eq '') { return $defaultYes }
        if ($a -in @('y', 'yes')) { return $true }
        if ($a -in @('n', 'no')) { return $false }
        Say 'Please type y or n, then press Enter.'
    }
}
function Wait-Enter($msg) { if (-not $Yes) { Read-Host "   $msg" | Out-Null } }
function Winget-Install($id) {
    if (-not (Have winget)) { return $false }
    try { winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null } catch { }
    Refresh-Path
    return $true
}
function Node-Ok { if (-not (Have node)) { return $false }; try { return ([int]((node --version) -replace '^v(\d+).*', '$1')) -ge 20 } catch { return $false } }
function Run-Capture($exe, $argList, $timeoutSec) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $exe; $psi.Arguments = $argList
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($timeoutSec * 1000)) { try { $p.Kill() } catch { }; return @{ ok = $false; text = 'timed out' } }
    return @{ ok = ($p.ExitCode -eq 0); text = (($out.Result + ' ' + $err.Result).Trim()) }
}
function Make-AgentId($name, $taken) {
    $id = ($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
    if ($id -notmatch '^[a-z]') { $id = "project-$id".Trim('-') }
    if ($id -eq 'all') { $id = 'all-projects' }
    $base = $id; $n = 2
    while ($taken -contains $id) { $id = "$base-$n"; $n++ }
    return $id
}

$LogFile = $null
try {
    # ---- Where are we? -----------------------------------------------------------------
    $here = $PSScriptRoot
    if ($here -and (Test-Path (Join-Path $here 'server.js'))) { $Dir = $here }          # run from the Crew folder: install right here
    elseif (-not $Dir) { $Dir = Join-Path $env:USERPROFILE 'ClaudeCrew' }               # run from the web: make a folder in your user folder
    $script:Dir = $Dir
    if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Force $Dir | Out-Null }
    $LogFile = Join-Path $Dir 'install-log.txt'
    try { Start-Transcript -Path $LogFile -Force | Out-Null } catch { $LogFile = $null }

    Write-Host ""
    Write-Host "  Claude Crew installer" -ForegroundColor Cyan
    Write-Host "  I will ask a few quick questions, then set everything up for you."
    Write-Host "  Press Enter to accept the answer shown in [brackets]."
    Write-Host "  Nothing here needs administrator rights, and nothing can break your computer."
    Write-Host ""
    Write-Host "  What will happen, so there are no surprises:"
    Write-Host "    1. I ask 3 or 4 easy questions (about 1 minute)."
    Write-Host "    2. I install a few free programs by myself (about 5 to 10 minutes). Just wait."
    Write-Host "    3. A web page may open so you can sign in to your Claude account."
    Write-Host "    4. Crew opens in your browser. Done."
    Write-Host ""
    Write-Host "  If this window looks stuck, it is not. Give it a few minutes. Do not close it."
    Wait-Enter 'Press Enter to begin'
    Refresh-Path

    $cfgFile = Join-Path $Dir 'crew.config.json'
    $isUpdate = Test-Path $cfgFile

    # ---- Questions (all up front, so the rest runs without you) -------------------------
    $answers = @{ name = $Name; lan = $false; autostart = (-not $NoAutostart); agents = @() }
    if ($isUpdate) {
        Write-Host ""
        Write-Host "  Found an existing Crew here, so I will keep your settings and just make sure everything works." -ForegroundColor Yellow
    } elseif (-not $ConsoleSetup -and -not $Yes) {
        # Default: the questions are asked on a point-and-click page once Crew is running (/setup).
        if (-not $answers.name) { $answers.name = $env:USERNAME }
        Write-Host ""
        Write-Host "  Your name, phone use and helpers are chosen on a web page at the end. Nothing to type here." -ForegroundColor Yellow
    } else {
        Write-Host ""; Write-Host "== Your answers" -ForegroundColor Cyan
        Write-Host ""
        Say 'QUESTION 1 of 3: your name'
        Say 'Type your first name and press Enter. Crew will use it to say hello to you.'
        if (-not $answers.name) { $answers.name = Ask 'Your first name' $env:USERNAME }
        Write-Host ""
        Say 'QUESTION 2 of 3: phone'
        Say 'Do you want to open Crew on your phone too (only while the phone is on your home or office Wi-Fi)?'
        Say 'Not sure? Just press Enter. You can change this later.'
        $answers.lan = Ask-YesNo 'Use Crew from your phone' $false
        if (-not $NoAutostart) {
            Write-Host ""
            Say 'QUESTION 3 of 3: start with Windows'
            Say 'Should Crew start by itself each time you turn on and sign in to this computer?'
            Say 'Not sure? Just press Enter (yes is the easy choice).'
            $answers.autostart = Ask-YesNo 'Start Crew automatically' $true
        }
        Write-Host ""
        Say 'OPTIONAL: helpers for your own folders'
        Say 'Crew always comes with an "Assistant" helper. If you also want a helper that works inside one of'
        Say 'your folders (a project, notes, documents), you can add it now. Most people just press Enter to skip.'
        Say 'To get a folder path: open the folder in File Explorer, click the address bar at the top,'
        Say 'press Ctrl+C to copy it, then right-click in this window to paste it, and press Enter.'
        $taken = @('assistant')
        while ($answers.agents.Count -lt 5) {
            $folder = Ask 'Folder for a helper to work in (paste the path, or press Enter to skip)' ''
            if (-not $folder) { break }
            $folder = $folder.Trim('"').Trim("'")
            if (-not (Test-Path $folder -PathType Container)) { Say 'I cannot find that folder. Check the path and try again, or press Enter to skip.'; continue }
            $folder = (Resolve-Path $folder).Path
            $nm = Ask 'What should this helper be called?' (Split-Path $folder -Leaf)
            $id = Make-AgentId $nm $taken
            $taken += $id
            $answers.agents += @{ id = $id; name = $nm; cwd = ($folder -replace '\\', '/') }
            Good "Added $nm (you will talk to it with @$id)"
            if (-not (Ask-YesNo 'Add another helper?' $false)) { break }
        }
    }

    # ---- 1. Node.js --------------------------------------------------------------------
    Head 1 'Node.js (the engine Crew runs on)'
    if (-not (Node-Ok)) {
        Say 'Installing Node.js...'
        Winget-Install 'OpenJS.NodeJS.LTS' | Out-Null
    }
    if (-not (Node-Ok)) {
        Say 'Downloading a private copy of Node.js into the Crew folder (no administrator needed)...'
        try {
            $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
            $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
            $rel = $idx | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
            $zip = Join-Path $env:TEMP 'crew-node.zip'; $tmp = Join-Path $env:TEMP 'crew-node-x'
            Invoke-WebRequest "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-win-$arch.zip" -OutFile $zip -UseBasicParsing
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Expand-Archive $zip $tmp -Force
            $rt = Join-Path $Dir 'runtime'; New-Item -ItemType Directory -Force $rt | Out-Null
            if (Test-Path (Join-Path $rt 'node')) { Remove-Item (Join-Path $rt 'node') -Recurse -Force }
            Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName (Join-Path $rt 'node')
            Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
            Refresh-Path
        } catch { Warn "Could not download Node.js automatically: $($_.Exception.Message)" }
    }
    if (-not (Node-Ok)) {
        Warn 'I could not install Node.js myself (a work computer may block it).'
        Say 'Please do this by hand: a web page will open. Click the big green "LTS" download, run it,'
        Say 'accept every default, then come back here.'
        Start-Process 'https://nodejs.org'
        Wait-Enter 'When Node.js has finished installing, press Enter here'
        Refresh-Path
    }
    if (-not (Node-Ok)) { throw 'Node.js 20 or newer is still missing. Install it from https://nodejs.org (the LTS button), then double-click INSTALL.bat again.' }
    Good "Node $(node --version)"

    # ---- 2. Git ------------------------------------------------------------------------
    Head 2 'Git (Claude Code on Windows needs it)'
    if (-not (Have git)) { Say 'Installing Git...'; Winget-Install 'Git.Git' | Out-Null }
    if (-not (Have git)) {
        Warn 'I could not install Git myself.'
        Say 'Please do this by hand: a web page will open. Download "Git for Windows", run it, accept every default.'
        Start-Process 'https://git-scm.com/download/win'
        Wait-Enter 'When Git has finished installing, press Enter here'
        Refresh-Path
    }
    if (Have git) { Good 'Git is installed' } else { Warn 'Git is still missing. I will carry on, but Claude Code may ask for it later (https://git-scm.com/download/win).' }

    # ---- 3. Crew files -----------------------------------------------------------------
    Head 3 "Crew files in $Dir"
    if (Test-Path (Join-Path $Dir 'server.js')) {
        if ((Test-Path (Join-Path $Dir '.git')) -and (Have git)) {
            git -C $Dir pull --ff-only 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Good 'Updated to the latest version' } else { Good 'Crew files are in place (kept your local edits)' }
        } else { Good 'Crew files are in place' }
    } else {
        Say 'Downloading Crew...'
        $zip = Join-Path $env:TEMP 'claudecrew.zip'; $tmp = Join-Path $env:TEMP 'claudecrew-x'
        Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive $zip $tmp -Force
        Copy-Item (Join-Path (Get-ChildItem $tmp | Select-Object -First 1).FullName '*') $Dir -Recurse -Force
        Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Good 'Downloaded Crew'
    }
    # Files from a downloaded zip are marked "from the internet"; clear that so Windows does not block them.
    Get-ChildItem $Dir -Recurse -File -Include *.ps1, *.cmd, *.bat -ErrorAction SilentlyContinue | ForEach-Object { try { Unblock-File $_.FullName } catch { } }

    # ---- 4. Claude Code ----------------------------------------------------------------
    Head 4 'Claude Code (the AI that does the work) and your login'
    if (-not (Have claude)) {
        Say 'Installing Claude Code...'
        try { Invoke-Expression (Invoke-RestMethod 'https://claude.ai/install.ps1') } catch { Warn "Automatic install failed: $($_.Exception.Message)" }
        Refresh-Path
    }
    if (-not (Have claude)) {
        Warn 'Claude Code did not install by itself (a work computer may block it).'
        Say 'Please do this by hand: a web page will open. Follow its Windows install step, then come back here.'
        Start-Process 'https://docs.claude.com/en/docs/claude-code/setup'
        Wait-Enter 'When Claude Code has finished installing, press Enter here'
        Refresh-Path
    }
    $claudeExe = $null
    if (Have claude) { $claudeExe = (Get-Command claude | Select-Object -First 1).Source }
    if (-not $claudeExe) { throw 'Claude Code is still missing. See https://docs.claude.com/en/docs/claude-code/setup, then double-click INSTALL.bat again.' }
    Good "Claude Code found: $claudeExe"
    if ($SkipClaudeTest) { Say 'Skipping the login check.' }
    else {
        Say 'Checking that you are signed in (this takes a few seconds)...'
        $t = Run-Capture $claudeExe '-p "Reply with exactly: Claude Code is working"' 90
        if (-not $t.ok) {
            Say 'You are not signed in yet. This is normal the first time.'
            Say 'A web page will open. Sign in with your Claude email, then click the "Authorize" button.'
            Say 'When the page says you are done, come back to this window and wait a moment.'
            Say '(Claude Code needs a paid Claude plan, such as Pro or Max.)'
            Wait-Enter 'Press Enter to open the sign-in page'
            try { & $claudeExe auth login } catch { Warn "Sign-in did not finish: $($_.Exception.Message)" }
            $t = Run-Capture $claudeExe '-p "Reply with exactly: Claude Code is working"' 90
        }
        if ($t.ok) { Good 'Signed in and working' }
        else {
            Warn 'Claude Code is not answering yet. Crew will still start.'
            Say "It said: $($t.text)"
            Say 'To finish later: open PowerShell, type  claude  and press Enter, then follow the sign-in.'
        }
    }

    # ---- 5. Settings -------------------------------------------------------------------
    Head 5 'Your settings'
    $enc = New-Object Text.UTF8Encoding $false
    if (-not $isUpdate) {
        $cfg = [IO.File]::ReadAllText((Join-Path $Dir 'crew.config.example.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        $tpl = ($cfg.agents | Where-Object { $_.id -eq 'webapp' } | Select-Object -First 1) | ConvertTo-Json -Depth 10
        $assistant = $cfg.agents | Where-Object { $_.id -eq 'assistant' } | Select-Object -First 1
        $list = @($assistant)
        foreach ($a in $answers.agents) {
            $o = $tpl | ConvertFrom-Json
            $o.id = $a.id; $o.name = $a.name; $o.cwd = $a.cwd
            $o.description = "Works on the $($a.name) folder: answers questions, makes changes and reports back."
            $o.instructions = 'Tell the owner plainly what you changed. Ask before deleting anything.'.Replace('the owner', $answers.name)
            $list += $o
        }
        $cfg.agents = $list
        $cfg.settings.userName = $answers.name
        $cfg.settings.port = $Port
        $cfg.settings.allowLan = [bool]$answers.lan
        $cfg.settings | Add-Member -NotePropertyName machineName -NotePropertyValue $env:COMPUTERNAME -Force
        if (-not $ConsoleSetup -and -not $Yes) { $cfg.settings | Add-Member -NotePropertyName needsSetup -NotePropertyValue $true -Force }
        $cfg.settings.claudePath = ($claudeExe -replace '\\', '/')
        [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 10), $enc)
        Good "Saved your settings (name: $($answers.name), $(1 + $answers.agents.Count) helper(s))"
    } else { Good 'Kept your existing settings' }
    try { $Port = [int](([IO.File]::ReadAllText($cfgFile, [Text.Encoding]::UTF8) | ConvertFrom-Json).settings.port) } catch { }
    $base = "http://127.0.0.1:$Port"
    $hdr = @{ 'x-crew' = '1'; 'Origin' = $base }
    function Crew-Up { try { Invoke-RestMethod "$base/api/machines/link" -TimeoutSec 3 | Out-Null; $true } catch { $false } }

    # ---- 6. Start ----------------------------------------------------------------------
    Head 6 'Starting Crew'
    if (Crew-Up) {
        try { Invoke-RestMethod "$base/api/restart" -Method Post -Headers $hdr -TimeoutSec 5 | Out-Null } catch { }
        Start-Sleep 4
    } else {
        Start-Process -FilePath (Join-Path $Dir 'run-crew.cmd') -WorkingDirectory $Dir -WindowStyle Hidden
    }
    for ($i = 0; $i -lt 40 -and -not (Crew-Up); $i++) { Start-Sleep 1 }
    if (-not (Crew-Up)) { throw "Crew did not start. Open $Dir\data\crew.log to see why (or send me $Dir\install-log.txt)." }
    Good "Crew is running at http://localhost:$Port"

    if ($Hub -and $Code) {
        Say "Joining the hub at $Hub ..."
        try {
            Invoke-RestMethod "$base/api/machines/connect" -Method Post -Headers $hdr -ContentType 'application/json' -Body (@{ url = $Hub; code = $Code } | ConvertTo-Json) | Out-Null
            Good 'Connected. This PC now shows up in the hub''s Machines panel.'
        } catch {
            $msg = $_.ErrorDetails.Message
            Warn ('Could not join the hub: ' + $(if ($msg) { try { ($msg | ConvertFrom-Json).error } catch { $msg } } else { $_.Exception.Message }))
            Say 'Get a fresh code from the hub''s Machines panel and use the "Connect this PC to a hub" box in Crew.'
        }
    }

    # Shortcuts: a Desktop icon always; the tray icon at sign-in if you said yes. Neither needs administrator rights.
    try {
        $sh = New-Object -ComObject WScript.Shell
        $deskPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Crew.lnk'
        if (-not (Test-Path $deskPath) -and -not $env:CREW_TEST) {
            $desk = $sh.CreateShortcut($deskPath)
            $desk.TargetPath = (Join-Path $Dir 'Start Crew.bat'); $desk.WorkingDirectory = $Dir; $desk.Description = 'Open Claude Crew'; $desk.Save()
        }
        Good 'Put a "Claude Crew" shortcut on your Desktop'
        if ($answers.autostart -and -not $isUpdate) {
            $lnk = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Crew tray.lnk'))
            $lnk.TargetPath = "$env:WINDIR\System32\conhost.exe"
            $lnk.Arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$(Join-Path $Dir 'crew-tray.ps1')`""
            $lnk.WorkingDirectory = $Dir; $lnk.Description = 'Claude Crew tray icon'; $lnk.Save()
            Good 'Crew will start by itself when you sign in to Windows'
        }
    } catch { Warn "Could not make the shortcuts: $($_.Exception.Message)" }

    Write-Host ""
    Write-Host "  ALL DONE." -ForegroundColor Green
    Write-Host "  Crew is open in your browser at  http://localhost:$Port"
    Write-Host "  Next time, double-click the Claude Crew icon on your Desktop."
    Write-Host "  Type  hello  in the chat to say hi to your Assistant. The first reply can take a minute."
    Start-Process "http://localhost:$Port"   # a brand-new install lands on the setup page by itself
    $exit = 0
} catch {
    Write-Host ""
    Write-Host "  STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Nothing is broken. Fix what it says, then run this again (it picks up where it left off)."
    if ($LogFile) { Write-Host "  If you are stuck, send the file  $LogFile  to whoever is helping you." }
    $exit = 1
}
try { Stop-Transcript | Out-Null } catch { }
if ($PSCommandPath) { exit $exit }
