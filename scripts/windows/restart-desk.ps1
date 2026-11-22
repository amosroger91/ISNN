# Restarts the live desk: stops the "ISNN Desk" task, ends whatever still
# listens on its port, starts the task again and waits until it answers.
# Used by the Emergency fix agent and by hand. Exit code 0 means the desk is up.
param([int]$Port = 4320, [int]$WaitSeconds = 90)
$ErrorActionPreference = "Continue"
$log = Join-Path $PSScriptRoot "..\..\data\logs\desk.log"
# The running desk holds desk.log open, so the note is best effort.
try { "[$(Get-Date -Format s)] restart-desk.ps1: restarting the desk" | Add-Content $log -ErrorAction Stop } catch { }
Stop-ScheduledTask -TaskName "ISNN Desk" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$listener = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess
foreach ($id in @($listener)) { if ($id) { Stop-Process -Id $id -Force -Confirm:$false -ErrorAction SilentlyContinue } }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "ISNN Desk"
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  try {
    $code = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop).StatusCode
  } catch { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -gt 0) {
    $now = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess
    "The desk is back up (process $now, HTTP $code)."
    exit 0
  }
}
"The desk did not answer on port $Port within $WaitSeconds seconds. Check data\logs\desk.log."
exit 1
