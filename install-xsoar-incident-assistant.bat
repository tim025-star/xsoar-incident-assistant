@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "INSTALL_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "STARTUP_SCRIPT=%INSTALL_DIR%start-xsoar-assistant-hidden.vbs"
set "SHORTCUT_SCRIPT=%INSTALL_DIR%install-startup-shortcut.vbs"
set "SHORTCUT_PATH=%STARTUP_DIR%\XSOAR Incident Assistant.lnk"
set "CONFIG_TEMPLATE=%INSTALL_DIR%config.example.json"
set "CONFIG_PATH=%INSTALL_DIR%config.json"
set "MISSING=0"

if not exist "%INSTALL_DIR%package.json" (
  echo Run this script from the XSOAR Incident Assistant folder containing package.json.
  call :pause_if_visible
  exit /b 1
)
if not exist "%STARTUP_SCRIPT%" (
  echo start-xsoar-assistant-hidden.vbs was not found beside this installer.
  call :pause_if_visible
  exit /b 1
)
if not exist "%CONFIG_TEMPLATE%" (
  echo config.example.json was not found beside this installer.
  call :pause_if_visible
  exit /b 1
)
if not exist "%CONFIG_PATH%" (
  copy /y "%CONFIG_TEMPLATE%" "%CONFIG_PATH%" >nul
  if errorlevel 1 (
    echo config.json could not be created from config.example.json.
    call :pause_if_visible
    exit /b 1
  )
)
if not exist "%SHORTCUT_SCRIPT%" (
  echo install-startup-shortcut.vbs was not found beside this installer.
  call :pause_if_visible
  exit /b 1
)

call :ensure_node
call :ensure_ahk
call :ensure_browser
call :ensure_notepad
if "%MISSING%"=="1" (
  echo One or more prerequisites could not be installed without administrator access.
  echo Re-run this script after installing the named prerequisite, then try again.
  call :pause_if_visible
  exit /b 1
)

where npm.exe >nul 2>nul
if errorlevel 1 (
  echo npm.exe was not found after installing Node.js.
  echo Open a new Command Prompt so the per-user Node.js PATH update is loaded, then rerun this script.
  call :pause_if_visible
  exit /b 1
)
echo Installing locked Node.js dependencies...
call npm ci
if errorlevel 1 (
  echo npm ci failed. Review the output above and rerun after fixing the reported issue.
  call :pause_if_visible
  exit /b 1
)

if not exist "%STARTUP_DIR%" mkdir "%STARTUP_DIR%" 2>nul
if not exist "%STARTUP_DIR%" (
  echo The per-user Startup folder could not be created:
  echo %STARTUP_DIR%
  call :pause_if_visible
  exit /b 1
)
cscript.exe //nologo "%SHORTCUT_SCRIPT%" "%STARTUP_SCRIPT%" "%SHORTCUT_PATH%"
if errorlevel 1 (
  echo The XSOAR Incident Assistant Startup shortcut could not be created.
  call :pause_if_visible
  exit /b 1
)
echo XSOAR Incident Assistant is installed for this Windows user.
echo Startup shortcut: %SHORTCUT_PATH%
echo Edit config.json and replace https://xsoar.example.com with your trusted XSOAR origin.
echo Set XSOAR_ASSISTANT_BROWSER=edge before running start-chrome-debug.bat if Edge is preferred.
endlocal
exit /b 0

:ensure_node
where node.exe >nul 2>nul
if not errorlevel 1 (
  call :node_is_supported
  if not errorlevel 1 exit /b 0
  echo Node.js 20 or newer is required. Attempting a per-user Node.js LTS install...
  call :winget_install OpenJS.NodeJS.LTS "Node.js LTS"
  set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
  call :node_is_supported
  if not errorlevel 1 exit /b 0
  echo Node.js 20 or newer was not found.
  set "MISSING=1"
  exit /b 0
)
echo Node.js was not found. Attempting a per-user Node.js LTS install...
call :winget_install OpenJS.NodeJS.LTS "Node.js LTS"
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
call :node_is_supported
if errorlevel 1 (
  echo Node.js was not installed or is not on PATH.
  set "MISSING=1"
)
exit /b 0

:node_is_supported
for /f "tokens=1 delims=." %%V in ('node.exe -p "process.versions.node.split('.')[0]" 2^>nul') do if %%V GEQ 20 exit /b 0
exit /b 1

:ensure_ahk
if exist "%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe" exit /b 0
if exist "%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe" exit /b 0
echo AutoHotkey v2 was not found. Attempting a per-user AutoHotkey install...
call :winget_install AutoHotkey.AutoHotkey "AutoHotkey v2"
if exist "%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe" exit /b 0
if exist "%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe" exit /b 0
echo AutoHotkey v2 was not installed in a supported per-user location.
set "MISSING=1"
exit /b 0

:ensure_browser
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" exit /b 0
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" exit /b 0
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" exit /b 0
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" exit /b 0
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" exit /b 0
if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" exit /b 0
where chrome.exe >nul 2>nul
if not errorlevel 1 exit /b 0
where msedge.exe >nul 2>nul
if not errorlevel 1 exit /b 0
echo Chromium-based Chrome or Edge was not found. Attempting a per-user Chrome install...
call :winget_install Google.Chrome "Google Chrome"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" exit /b 0
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" exit /b 0
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" exit /b 0
where chrome.exe >nul 2>nul
if not errorlevel 1 exit /b 0
echo Chrome or Edge was not installed in a supported location.
set "MISSING=1"
exit /b 0

:ensure_notepad
call :find_notepad
if not errorlevel 1 exit /b 0
echo Notepad++ was not found. Attempting a per-user Notepad++ install...
call :winget_install Notepad++.Notepad++ "Notepad++"
call :find_notepad
if not errorlevel 1 exit /b 0
echo Notepad++ was not installed in a supported location.
echo Portable Notepad++ is supported: place notepad++.exe under this folder's notepad++ subfolder,
echo or edit config.json and set notepadPlusPlusPath to your portable executable.
set "MISSING=1"
exit /b 0

:find_notepad
set "FOUND_NOTEPAD="
for %%P in (
  "%INSTALL_DIR%notepad++\notepad++.exe"
  "%INSTALL_DIR%notepad-plus-plus\notepad++.exe"
  "%LOCALAPPDATA%\Notepad++\notepad++.exe"
  "%LOCALAPPDATA%\Programs\Notepad++\notepad++.exe"
  "%ProgramFiles%\Notepad++\notepad++.exe"
  "%ProgramFiles(x86)%\Notepad++\notepad++.exe"
) do if not defined FOUND_NOTEPAD if exist "%%~P" set "FOUND_NOTEPAD=%%~fP"
if not defined FOUND_NOTEPAD for /f "delims=" %%P in ('where notepad++.exe 2^>nul') do if not defined FOUND_NOTEPAD set "FOUND_NOTEPAD=%%~fP"
if not defined FOUND_NOTEPAD exit /b 1
set "ASSISTANT_CONFIG_PATH=%CONFIG_PATH%"
set "ASSISTANT_NOTEPAD_PATH=!FOUND_NOTEPAD!"
node.exe -e "const fs=require('fs');const p=process.env.ASSISTANT_CONFIG_PATH;const c=JSON.parse(fs.readFileSync(p,'utf8'));c.notepadPlusPlusPath=process.env.ASSISTANT_NOTEPAD_PATH;fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');"
if errorlevel 1 (
  echo Notepad++ was found but config.json could not be updated.
  exit /b 1
)
echo Using Notepad++: !FOUND_NOTEPAD!
exit /b 0

:winget_install
where winget.exe >nul 2>nul
if errorlevel 1 (
  echo winget.exe is unavailable; install %~2 manually.
  exit /b 0
)
echo Installing %~2 for the current Windows user...
winget.exe install --id %~1 --scope user --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo winget could not install %~2 without elevation.
)
exit /b 0

:pause_if_visible
if /I "%XSOAR_ASSISTANT_HIDDEN_LAUNCH%"=="1" exit /b 0
pause
exit /b 0
