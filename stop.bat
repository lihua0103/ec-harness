@echo off
setlocal
set "found="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3080" ^| findstr "LISTENING"') do (
    set "found=1"
    echo Stopping Emerald Clinical DSH, PID %%a
    taskkill /PID %%a /F
)
if not defined found echo No Emerald Clinical DSH process found on port 3080.
endlocal
