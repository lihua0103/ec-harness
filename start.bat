@echo off
rem 切到 UTF-8 代码页，否则中文提示在默认 GBK 控制台里会变成 ????。
rem >nul 是为了吞掉 chcp 自己的 "Active code page" 回显。
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo [DSH] 正在启动 DeepSeek Harness WebUI...
where node >nul 2>nul
if errorlevel 1 (
  echo [DSH] 未找到 Node.js，请安装 Node 22.19+ 或 24+
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [DSH] 未找到 pnpm，请先安装 pnpm 11
  pause
  exit /b 1
)
node scripts\start.mjs
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo [DSH] 启动失败，退出码 %CODE%
  pause
)
exit /b %CODE%
