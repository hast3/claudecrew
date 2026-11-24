# Keeps exactly one Game.exe alive. Kills any newer copy within seconds.
# Two-instance test: create C:\Claude Code\ClaudeCrew\tools\ALLOW_TWO_GAMES (max 2), delete after.
$log = "C:\Claude Code\ClaudeCrew\data\game-one-guard.log"
$flag = "C:\Claude Code\ClaudeCrew\tools\ALLOW_TWO_GAMES"
while ($true) {
  $g = @(Get-Process Game -ErrorAction SilentlyContinue | Sort-Object StartTime)
  $max = if (Test-Path $flag) { 2 } else { 1 }
  if ($g.Count -gt $max) {
    $g | Select-Object -Skip $max | ForEach-Object {
      "$(Get-Date -f 's') killed extra Game.exe PID $($_.Id)" | Add-Content $log
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2
}
