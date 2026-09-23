@echo off
setlocal
cd /d "%~dp0"
set "LAYA_MAPPER_ROOT=%~dp0laya-mapper"
set "LAYA_MAPPER_EXECUTABLE=%~dp0laya-mapper\runtime-v2\laya-mapper.exe"
set "LAYA_MODEL_PATH=%~dp0laya-mapper\models\__PILOT_MODEL_ID__"
set "HF_HUB_OFFLINE=1"
set "TRANSFORMERS_OFFLINE=1"
set "HF_DATASETS_OFFLINE=1"
title XSOAR Incident Assistant - Experimental Laya Pilot
echo EXPERIMENTAL DIAGNOSTICS ONLY - human review is required.
echo Keep this window open while testing. Press Ctrl+C to stop.
echo.
"%~dp0runtime\node.exe" "%~dp0scripts\serve-laya-pilot.mjs"
if errorlevel 1 (
  echo.
  echo The experimental diagnostics build stopped with an error.
  pause
)
endlocal
