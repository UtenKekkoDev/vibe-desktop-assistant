@echo off
setlocal
if not exist "%~dp0vibe-desktop-assistant.exe" (
  echo The native desktop assistant has not been built.
  pause
  exit /b 1
)
start "" /d "%~dp0" "%~dp0vibe-desktop-assistant.exe"
