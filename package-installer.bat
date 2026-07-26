@echo off
setlocal
cd /d "%~dp0"

call npm run dist
if errorlevel 1 (
  echo.
  echo Installer build failed.
  pause
  exit /b 1
)

echo.
echo Installer created in dist-installer.
pause
