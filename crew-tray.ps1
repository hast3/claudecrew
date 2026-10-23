# Claude Crew tray icon.
# Shows whether Crew is running (green = ready, amber = agents working, grey = not running),
# opens it, restarts it, and pops a Windows notification when an agent replies.
# Crew itself runs in the background (the "Claude Crew" scheduled task, or run-crew.cmd);
# closing the tray icon does not stop Crew.

param([switch]$Open)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'Claude Crew'

# Same overrides as server.js: CREW_CONFIG (config file) and CREW_PORT.
$CfgPath = if (-not $env:CREW_CONFIG) { Join-Path $Here 'crew.config.json' }
           elseif ([IO.Path]::IsPathRooted($env:CREW_CONFIG)) { $env:CREW_CONFIG }
           else { Join-Path $Here $env:CREW_CONFIG }
$cfg = Get-Content $CfgPath -Raw | ConvertFrom-Json
$port = if ($env:CREW_PORT) { [int]$env:CREW_PORT } elseif ($cfg.settings.port) { $cfg.settings.port } else { 7777 }
$LocalUrl = "http://localhost:$port"
# Status checks go straight to IPv4; "localhost" can stall on IPv6 first in Windows PowerShell.
$ApiUrl = "http://127.0.0.1:$port"
$PublicUrl = if ($cfg.cloudflare -and $cfg.cloudflare.enabled) { "https://$($cfg.cloudflare.hostname)" } else { $null }

# One tray icon per user; a second launch just opens Crew.
$isFirst = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ClaudeCrewTray', [ref]$isFirst)
if (-not $isFirst) { if ($Open) { Start-Process $LocalUrl }; return }

# ------------------------------------------------------------------ settings

$SettingsPath = Join-Path $Here 'data\tray.json'
$Settings = @{ notify = $true }
try { $Settings.notify = [bool](Get-Content $SettingsPath -Raw | ConvertFrom-Json).notify } catch {}
function Save-Settings { try { $Settings | ConvertTo-Json | Set-Content $SettingsPath -Encoding UTF8 } catch {} }

# ------------------------------------------------------------------ icons

function New-CrewIcon([string]$dot) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#D97757'))), 0, 0, 31, 31)
    $font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $g.DrawString('C', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(-1, 0, 32, 32)), $fmt)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#1F1E1D'))), 17, 17, 15, 15)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($dot))), 19, 19, 11, 11)
    $g.Dispose()
    [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$Icons = @{
    ready = New-CrewIcon '#6FB581'
    busy  = New-CrewIcon '#E8B04A'
    down  = New-CrewIcon '#8A8986'
}

# ------------------------------------------------------------------ Crew process control

function Test-CrewTask { [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) }

function Start-Crew {
    if (Test-CrewTask) { Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    else { Start-Process -FilePath (Join-Path $Here 'run-crew.cmd') -WorkingDirectory $Here -WindowStyle Hidden }
}

function Get-CrewPid {
    (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
}

function Restart-Crew {
    if (Get-CrewPid) {
        # Crew stops its agents and exits; run-crew.cmd brings it back in ~10 seconds.
        # (The background Crew runs under its own sign-in, so we ask it rather than kill it.)
        try {
            Invoke-RestMethod "$ApiUrl/api/restart" -Method Post -ContentType 'application/json' -Body '{}' `
                -Headers @{ 'X-Crew' = '1' } -TimeoutSec 5 -UseBasicParsing | Out-Null
            $tray.ShowBalloonTip(3000, 'Claude Crew', 'Restarting… back in about 10 seconds.', 'Info')
        } catch {
            $tray.ShowBalloonTip(5000, 'Claude Crew', "Couldn't restart Crew: $($_.Exception.Message)", 'Warning')
        }
    } else {
        Start-Crew
        $tray.ShowBalloonTip(3000, 'Claude Crew', 'Starting Crew…', 'Info')
    }
}

# ------------------------------------------------------------------ tray + menu

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $Icons.down
$tray.Text = 'Claude Crew: starting…'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add('Checking…'); $miStatus.Enabled = $false
[void]$menu.Items.Add('-')
$miOpen = $menu.Items.Add('Open Crew')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.Add_Click({ Start-Process $LocalUrl })
if ($PublicUrl) {
    $miPublic = $menu.Items.Add("Open $($PublicUrl -replace '^https://')")
    $miPublic.Add_Click({ Start-Process $PublicUrl })
}
[void]$menu.Items.Add('-')
$miNotify = New-Object System.Windows.Forms.ToolStripMenuItem('Notify me when agents reply')
$miNotify.Checked = $Settings.notify
$miNotify.Add_Click({ $Settings.notify = -not $Settings.notify; $miNotify.Checked = $Settings.notify; Save-Settings })
[void]$menu.Items.Add($miNotify)
$miLog = $menu.Items.Add('View log')
$miLog.Add_Click({ $log = Join-Path $Here 'data\crew.log'; if (Test-Path $log) { Start-Process notepad.exe $log } })
$miFolder = $menu.Items.Add('Open Crew folder')
$miFolder.Add_Click({ Start-Process explorer.exe $Here })
[void]$menu.Items.Add('-')
$miRestart = $menu.Items.Add('Restart Crew')
$miRestart.Add_Click({
    $busy = $script:lastWorking
    if ($busy -gt 0) {
        $r = [System.Windows.Forms.MessageBox]::Show("$busy agent(s) are working right now and will be stopped. Restart anyway?", 'Claude Crew', 'YesNo', 'Warning')
        if ($r -ne 'Yes') { return }
    }
    Restart-Crew
})
$miExit = $menu.Items.Add('Hide tray icon (Crew keeps running)')
$miExit.Add_Click({ $timer.Stop(); $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$tray.ContextMenuStrip = $menu
$tray.Add_MouseDoubleClick({ Start-Process $LocalUrl })
$tray.Add_BalloonTipClicked({ Start-Process $LocalUrl })

# ------------------------------------------------------------------ status polling

$script:lastId = $null
$script:primed = $false
$script:lastWorking = 0
$script:downSince = $null
$script:startedAt = Get-Date
$script:triedStart = $false
$script:openPending = [bool]$Open

function Set-TrayText([string]$t) { $tray.Text = if ($t.Length -gt 63) { $t.Substring(0, 62) + '…' } else { $t } }

function Update-Status {
    $s = $null
    try { $s = Invoke-RestMethod "$ApiUrl/api/state" -TimeoutSec 2 -UseBasicParsing } catch {}

    if (-not $s) {
        $tray.Icon = $Icons.down
        Set-TrayText 'Claude Crew: not running'
        $miStatus.Text = 'Crew is not running'
        $script:lastWorking = 0
        # If Crew isn't up shortly after the tray starts (e.g. it was never started), start it once.
        if (-not $script:triedStart -and ((Get-Date) - $script:startedAt).TotalSeconds -gt 8 -and -not (Get-CrewPid)) {
            $script:triedStart = $true
            Start-Crew
        }
        return
    }

    $names = @{}
    foreach ($a in $s.agents) { $names[$a.id] = "$($a.emoji) $($a.name)" }
    $working = @($s.agents | Where-Object { $_.status -eq 'working' })
    $script:lastWorking = $working.Count
    if ($working.Count) {
        $tray.Icon = $Icons.busy
        $who = ($working | ForEach-Object { $_.name }) -join ', '
        Set-TrayText "Claude Crew: $who working"
        $miStatus.Text = "Working: $who"
    } else {
        $tray.Icon = $Icons.ready
        Set-TrayText 'Claude Crew: ready'
        $miStatus.Text = 'Crew is running, all agents idle'
    }

    if ($script:openPending) { $script:openPending = $false; Start-Process $LocalUrl }

    # Windows notification for new agent replies.
    $replies = @($s.history | Where-Object { $_.from -ne 'user' -and ($_.kind -eq 'chat' -or $_.kind -eq 'error') })
    if (-not $replies.Count) { $script:primed = $true; return }
    $latest = $replies[-1]
    if (-not $script:primed) { $script:primed = $true; $script:lastId = $latest.id; return }
    if ($latest.id -ne $script:lastId) {
        $script:lastId = $latest.id
        if ($Settings.notify) {
            $title = if ($names[$latest.from]) { $names[$latest.from] } else { $latest.from }
            $body = ($latest.text -replace '\s+', ' ').Trim()
            if ($body.Length -gt 200) { $body = $body.Substring(0, 199) + '…' }
            $tipIcon = if ($latest.kind -eq 'error') { 'Warning' } else { 'Info' }
            $tray.ShowBalloonTip(8000, $title, $body, $tipIcon)
        }
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Status })
$timer.Start()
Update-Status

[System.Windows.Forms.Application]::Run()
$tray.Dispose()
$mutex.ReleaseMutex()
