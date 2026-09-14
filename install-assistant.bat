@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js 20 or newer is required. & exit /b 1)
where npm >nul 2>&1 || (echo npm is required. & exit /b 1)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (echo Node.js 20 or newer is required. & exit /b 1)
call npm ci
if errorlevel 1 exit /b 1
cscript //nologo install-startup-shortcut.vbs
if errorlevel 1 exit /b 1
echo Installation complete. Use the XSOAR Incident Assistant shortcut in the Start menu.
pause
