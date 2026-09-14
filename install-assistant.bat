@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js 20.19 or 22.12 and newer is required. & exit /b 1)
where npm >nul 2>&1 || (echo npm is required. & exit /b 1)
node scripts\check-node-version.mjs
if errorlevel 1 (echo Node.js 20.19 or 22.12 and newer is required. & exit /b 1)
call npm ci
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1
cscript //nologo install-start-menu-shortcut.vbs
if errorlevel 1 exit /b 1
echo Installation complete. Use the XSOAR Incident Assistant shortcut in the Start menu.
pause
