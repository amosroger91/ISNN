@echo off
rem Starts the desk in production mode and appends its output to data\logs\desk.log.
rem Run by the "ISNN Desk" scheduled task (see scripts\windows\install-tasks.ps1).
cd /d "%~dp0..\.."
if not exist data\logs mkdir data\logs
echo [%date% %time%] starting desk>> data\logs\desk.log
node server\index.mjs >> data\logs\desk.log 2>&1
echo [%date% %time%] desk exited with code %errorlevel%>> data\logs\desk.log
exit /b %errorlevel%
