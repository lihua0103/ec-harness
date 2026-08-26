@echo off
setlocal
cd /d "%~dp0"
echo [DSH] ???? DeepSeek Harness WebUI...
where node >nul 2>nul
if errorlevel 1 (
  echo [DSH] ???? Node.js 22.19 ??????
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [DSH] ???? pnpm????? pnpm 11?
  exit /b 1
)
node scripts\start.mjs
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo [DSH] ???????? %CODE%?
  pause
)
exit /b %CODE%