'use strict';
// Freeze / thaw whole process trees on Windows (the "Pause all" button).
// A frozen agent keeps its place: claude, its tools, a running Game.exe or script all
// stop mid-step and carry on from the same spot when thawed.
const { execFile } = require('child_process');

const SCRIPT = (pids, fn) => [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -Namespace CrewFreeze -Name N -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr h); [DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr h);'",
  '$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
  '$set = New-Object System.Collections.Generic.HashSet[int]',
  `foreach ($r in @(${pids.join(',')})) { [void]$set.Add([int]$r) }`,
  'do { $added = $false; foreach ($p in $all) { if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) { [void]$set.Add([int]$p.ProcessId); $added = $true } } } while ($added)',
  `$n = 0; foreach ($id in $set) { try { $pr = [Diagnostics.Process]::GetProcessById($id); [void][CrewFreeze.N]::${fn}($pr.Handle); $n++ } catch {} }`,
  '$n',
].join('\r\n');

// pids: root process ids. Every descendant is included. Resolves to how many were touched.
function run(pids, fn) {
  const list = [...new Set(pids.map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  if (!list.length || process.platform !== 'win32') return Promise.resolve(0);
  const enc = Buffer.from(SCRIPT(list, fn), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, timeout: 30000 }, (err, out) => {
      resolve(err ? 0 : Number(String(out).trim().split(/\s+/).pop()) || 0);
    });
  });
}

module.exports = {
  freeze: (pids) => run(pids, 'NtSuspendProcess'),
  thaw: (pids) => run(pids, 'NtResumeProcess'),
};
