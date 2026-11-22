# Registers the two scheduled tasks that run the daily show on this PC, for the
# current user (no administrator rights needed). Re-run it to update them.
#
#   ISNN Desk       Starts the desk at logon and again at 23:45 if it is not
#                   running; restarts it if it crashes. The server ticks itself
#                   (SPORTS_SELF_CRON=true in .env): midnight research, overnight
#                   build, 8 a.m. episode upload, then its Shorts.
#   ISNN Overnight  Wakes the PC at 23:45 and keeps it from idle sleep until 11:30.
#
# Remove with: Unregister-ScheduledTask "ISNN Desk","ISNN Overnight" -Confirm:$false
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$user = "$env:USERDOMAIN\$env:USERNAME"
$hidden = "$env:WINDIR\System32\conhost.exe"

$deskAction = New-ScheduledTaskAction -Execute $hidden -Argument "--headless `"$root\scripts\windows\run-desk.cmd`"" -WorkingDirectory $root
$deskTriggers = @(
  New-ScheduledTaskTrigger -AtLogOn -User $user
  New-ScheduledTaskTrigger -Daily -At "23:45"
)
$deskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 5) -StartWhenAvailable -WakeToRun `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ISNN Desk" -Force -Action $deskAction -Trigger $deskTriggers -Settings $deskSettings `
  -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) `
  -Description "Wellspring Media Sports desk: midnight research, overnight build, 8 a.m. YouTube upload." | Out-Null

$awakeAction = New-ScheduledTaskAction -Execute $hidden `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$root\scripts\windows\keep-awake.ps1`" -Until 11:30" -WorkingDirectory $root
$awakeSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
  -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ISNN Overnight" -Force -Action $awakeAction -Trigger (New-ScheduledTaskTrigger -Daily -At "23:45") `
  -Settings $awakeSettings -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) `
  -Description "Keeps the PC awake from 23:45 to 11:30 for the ISNN overnight show." | Out-Null

Get-ScheduledTask "ISNN Desk","ISNN Overnight" | ForEach-Object {
  "{0,-15} {1,-8} next run {2}" -f $_.TaskName, $_.State, (Get-ScheduledTaskInfo $_).NextRunTime
}
