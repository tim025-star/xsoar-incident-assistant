@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "CHROME="
set "BROWSER_KIND=chrome"
set "REQUESTED_BROWSER=%XSOAR_ASSISTANT_BROWSER%"
if /I "%REQUESTED_BROWSER%"=="edge" set "REQUESTED_BROWSER=msedge"
if defined REQUESTED_BROWSER if /I not "%REQUESTED_BROWSER%"=="chrome" if /I not "%REQUESTED_BROWSER%"=="msedge" (
  echo XSOAR_ASSISTANT_BROWSER must be chrome or edge when provided.
  call :pause_if_visible
  exit /b 1
)
if /I "%REQUESTED_BROWSER%"=="msedge" goto find_edge
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME for /f "delims=" %%A in ('where chrome.exe 2^>nul') do if not defined CHROME set "CHROME=%%~fA"
if not defined CHROME goto find_edge
goto browser_selected

:find_edge
set "BROWSER_KIND=msedge"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME for /f "delims=" %%A in ('where msedge.exe 2^>nul') do if not defined CHROME set "CHROME=%%~fA"

:browser_selected
set "AHK_SCRIPT=%~dp0xsoar-incident-assistant.ahk"
set "AHK_EXE="
if /I "%BROWSER_KIND%"=="msedge" (
  set "ASSISTANT_PROFILE=%LOCALAPPDATA%\Microsoft\Edge\XSOAR-Incident-Assistant"
) else (
  set "ASSISTANT_PROFILE=%LOCALAPPDATA%\Google\Chrome\XSOAR-Incident-Assistant"
)
set "CDP_PORT=9222"
set "CDP_URL=http://127.0.0.1:%CDP_PORT%/json/version"

if not defined CHROME (
  echo The selected Chrome or Edge browser was not found in the standard install locations or PATH.
  call :pause_if_visible
  exit /b 1
)

if not exist "%AHK_SCRIPT%" (
  echo xsoar-incident-assistant.ahk was not found beside this launcher:
  echo %AHK_SCRIPT%
  echo Keep the launcher files together and put a shortcut to start-xsoar-assistant-hidden.vbs in Startup.
  call :pause_if_visible
  exit /b 1
)

if exist "%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe" set "AHK_EXE=%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe"
if not defined AHK_EXE if exist "%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe" set "AHK_EXE=%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe"

where curl.exe >nul 2>nul
if errorlevel 1 (
  echo Windows curl.exe is required but was not found.
  echo Ask IT to enable the built-in curl.exe command, then try again.
  call :pause_if_visible
  exit /b 1
)

call :port_in_use
if not errorlevel 1 (
  echo Port %CDP_PORT% is already in use.
  echo Close the existing remote-debugging browser, then try again.
  call :pause_if_visible
  exit /b 1
)

if not exist "%ASSISTANT_PROFILE%" mkdir "%ASSISTANT_PROFILE%" 2>nul
if not exist "%ASSISTANT_PROFILE%" (
  echo The dedicated Chrome profile folder could not be created:
  echo %ASSISTANT_PROFILE%
  call :pause_if_visible
  exit /b 1
)
start "" "%CHROME%" --remote-debugging-address=127.0.0.1 --remote-debugging-port=%CDP_PORT% --user-data-dir="%ASSISTANT_PROFILE%"

set /a ATTEMPT=0
:wait_for_cdp
call :capture_cdp_session
if not errorlevel 1 goto cdp_ready
set /a ATTEMPT+=1
if !ATTEMPT! GEQ 20 (
    echo The selected browser started, but the dedicated debugging session was not verified on port %CDP_PORT%.
    echo Check Chrome policy settings or ask IT whether remote debugging is permitted.
    call :pause_if_visible
    exit /b 1
)
ping 127.0.0.1 -n 2 >nul
goto wait_for_cdp

:cdp_ready
echo The dedicated Chromium remote-debugging session is ready on port %CDP_PORT%.
if defined AHK_EXE (
  start "" "!AHK_EXE!" "%AHK_SCRIPT%"
) else (
  start "" "%AHK_SCRIPT%"
)
if errorlevel 1 (
  echo xsoar-incident-assistant.ahk could not be started.
  echo Install AutoHotkey v2 or repair the .ahk file association, then try again.
  call :pause_if_visible
  exit /b 1
)
echo XSOAR Incident Assistant is running. Press the physical Numpad+ key while viewing an incident.
endlocal
exit /b 0

:port_in_use
for /f "tokens=1,2,3,4,5" %%A in ('netstat -ano -p tcp ^| findstr /I /C:"LISTENING"') do (
  if /I "%%B"=="127.0.0.1:%CDP_PORT%" exit /b 0
  if /I "%%B"=="0.0.0.0:%CDP_PORT%" exit /b 0
  if /I "%%B"=="[::1]:%CDP_PORT%" exit /b 0
  if /I "%%B"=="[::]:%CDP_PORT%" exit /b 0
)
exit /b 1

:capture_cdp_session
set "CDP_PRODUCT_FOUND="
set "CDP_SOCKET_FOUND="
for /f "delims=" %%A in ('curl.exe --silent --fail --max-time 2 "%CDP_URL%" 2^>nul ^| findstr /L /C:"Chrome/" /C:"Chromium/" /C:"Edg/"') do set "CDP_PRODUCT_FOUND=1"
if not defined CDP_PRODUCT_FOUND exit /b 1
for /f "delims=" %%A in ('curl.exe --silent --fail --max-time 2 "%CDP_URL%" 2^>nul ^| findstr /L /C:"webSocketDebuggerUrl"') do set "CDP_SOCKET_FOUND=1"
if not defined CDP_SOCKET_FOUND exit /b 1
exit /b 0

:pause_if_visible
if /I "%XSOAR_ASSISTANT_HIDDEN_LAUNCH%"=="1" exit /b 0
pause
exit /b 0
