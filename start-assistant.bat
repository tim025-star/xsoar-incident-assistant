@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\playwright-core" (
  echo Dependencies are not installed. Run install-assistant.bat first.
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause
