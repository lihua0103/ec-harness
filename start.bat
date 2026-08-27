@echo off
setlocal
cd /d "%~dp0"

echo [DSH] Starting DeepSeek Harness WebUI...
where node >nul 2>nul
if errorlevel 1 (
  echo [DSH] Node.js was not found. Install Node 22.19+ or 24+.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [DSH] pnpm was not found. Install pnpm 11 first.
  pause
  exit /b 1
)

node scripts\start.mjs
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo [DSH] Startup failed with exit code %CODE%.
  pause
)
exit /b %CODE%
