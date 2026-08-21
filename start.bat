@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "exitCode=%errorlevel%"
if not "%exitCode%"=="0" (
    echo.
    echo Startup failed. See the error above.
    pause
)
exit /b %exitCode%