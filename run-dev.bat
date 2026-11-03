@echo off
chcp 936 >nul 2>nul
setlocal EnableExtensions
title WalkingJourney - 开发模式
cd /d "%~dp0"

echo ==================================================
echo   WalkingJourney 行迹  -  开发模式启动
echo ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18+ 并加入 PATH。
  echo        下载地址: https://nodejs.org/
  goto :fail
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [提示] 首次运行，正在安装依赖（约 100MB，请耐心等待）...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  set "ELECTRON_CUSTOM_DIR={{ version }}"
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。若卡在下载 Electron，请检查网络后重试。
    goto :fail
  )
  echo.
)

rem 某些开发工具会设置 ELECTRON_RUN_AS_NODE，会让 Electron 退化成纯 Node 运行
set "ELECTRON_RUN_AS_NODE="

echo [启动] electron .   ^(关闭应用窗口即退出^)
echo.
"node_modules\electron\dist\electron.exe" .
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo [错误] 应用退出，错误码 %EXITCODE%
  goto :fail
)
endlocal
exit /b 0

:fail
echo.
pause
endlocal
exit /b 1
