# Runs while Computer Control is OFF. Kills agent-launched game/driver processes.
$procs = Get-CimInstance Win32_Process
$byId = @{}; foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
foreach ($p in $procs) {
  $kill = $false
  if ($p.Name -eq 'Game.exe') {
    $par = $byId[[int]$p.ParentProcessId]
    if ($par -and $par.Name -match '^(powershell|pwsh|cmd|node|claude|python|wscript)') { $kill = $true }
  }
  elseif ($p.Name -match '^(powershell|pwsh|python|node)' -and $p.CommandLine -match 'ui-drive|run-lan-login|SendKeys|SetCursorPos|mouse_event|SendInput' -and $p.ProcessId -ne $PID) { $kill = $true }
  if ($kill) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
