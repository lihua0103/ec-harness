# fix-claude-vm.ps1
# Fixes: "Failed to start Claude's workspace - EPERM ... claude-code-vm\.sdk-version"
# Usage:
#   1) Fully quit the Claude desktop app (including tray icon)
#   2) Right-click this file -> Run with PowerShell (as Administrator)
#   3) Reopen Claude. The app recreates the version file and boots the VM.

$dir = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude-code-vm'
$f   = Join-Path $dir '.sdk-version'

# Stop leftover Claude processes that may still hold a lock on the file
Get-Process | Where-Object { $_.ProcessName -match 'claude' } | ForEach-Object {
    Write-Host "Stopping leftover process: $($_.ProcessName) (PID $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

if (Test-Path $f) {
    attrib -r $f                          # clear read-only attribute if set
    takeown /f $f 2>$null | Out-Null      # take ownership if ACL is broken
    icacls $f /reset 2>$null | Out-Null   # reset ACL to inherited defaults
    Remove-Item $f -Force
}

if (Test-Path $f) {
    Write-Host 'FAILED: file is still locked. Reboot the PC and run this again,'
    Write-Host 'or use the "Reinstall workspace" option in Claude settings.'
} else {
    Write-Host 'OK: stale .sdk-version removed.'
    Write-Host 'Now start Claude again - it will recreate the file and boot the workspace VM.'
}
