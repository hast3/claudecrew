# Registers the "Claude Crew" scheduled task: starts Crew hidden when Windows boots,
# running as the current user so agents use your Claude Code login and project folders.
# Needs to run as Administrator (tasks that run before sign-in require it).
#   Install:    powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#   Uninstall:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall

param([switch]$Uninstall, [string]$User = "$env:USERDOMAIN\$env:USERNAME")

$ErrorActionPreference = 'Stop'
$TaskName = 'Claude Crew'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TrayShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Crew tray.lnk'

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $TrayShortcut -ErrorAction SilentlyContinue
    Write-Host "Removed the '$TaskName' task and tray startup shortcut. Crew will no longer start with Windows."
    return
}

# Tray icon at sign-in (no console window: conhost --headless).
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($TrayShortcut)
$lnk.TargetPath = "$env:WINDIR\System32\conhost.exe"
$lnk.Arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$(Join-Path $Here 'crew-tray.ps1')`""
$lnk.WorkingDirectory = $Here
$lnk.Description = 'Claude Crew tray icon'
$lnk.Save()

$action = New-ScheduledTaskAction -Execute (Join-Path $Here 'run-crew.cmd') -WorkingDirectory $Here
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'   # give the network a moment after boot
# S4U = runs as you without storing your password, whether or not you're signed in.
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description "Claude Crew agent chat ($Here). Starts at boot, runs hidden, logs to data\crew.log." `
    -Force | Out-Null

# Let you start/stop/restart it later without an admin prompt.
$sid = (New-Object System.Security.Principal.NTAccount($User)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
$task = $svc.GetFolder('\').GetTask($TaskName)
$sddl = $task.GetSecurityDescriptor(0xF)
if ($sddl -notmatch [regex]::Escape($sid)) { $task.SetSecurityDescriptor($sddl + "(A;;GRGX;;;$sid)", 0) }

Write-Host "Installed the '$TaskName' task for $User. Crew will start automatically when Windows boots,"
Write-Host "and the Crew tray icon will appear when you sign in."
