# Keeps this PC from idle sleep, then lets it sleep again. It does not change
# any power setting: it asks Windows for "system required" the way a media
# player does, and the request ends when this script exits.
#
#   -Until 11:30    Hold until that clock time (the "ISNN Overnight" task,
#                   which wakes the PC at 23:45).
#   -WhilePid 1234  Hold while that process runs (the desk server starts this
#                   itself when SPORTS_KEEP_AWAKE=true).
param([string]$Until = "11:30", [int]$WhilePid = 0)

Add-Type -Namespace Isnn -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"

$log = Join-Path $PSScriptRoot "..\..\data\logs\keep-awake.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
if ($WhilePid) {
  $holding = { [bool](Get-Process -Id $WhilePid -ErrorAction SilentlyContinue) }
  "[$(Get-Date -Format s)] holding the PC awake while the desk server (process $WhilePid) runs" | Add-Content $log
} else {
  $end = [datetime]::Today.Add([timespan]::Parse($Until))
  if ($end -le (Get-Date)) { $end = $end.AddDays(1) }
  $holding = { (Get-Date) -lt $end }
  "[$(Get-Date -Format s)] holding the PC awake until $($end.ToString('s'))" | Add-Content $log
}

try {
  while (& $holding) {
    [void][Isnn.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    # Check the server often so the hold ends soon after it stops.
    for ($i = 0; $i -lt 6 -and (& $holding); $i++) { Start-Sleep -Seconds 10 }
  }
} finally {
  [void][Isnn.Power]::SetThreadExecutionState($ES_CONTINUOUS)
  "[$(Get-Date -Format s)] released" | Add-Content $log
}
