param(
    [switch]$Check,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = $PSScriptRoot
$Runtime = Join-Path $Root 'runtime'
$RuntimeBin = Join-Path $Runtime 'node_modules\.bin\dsh.CMD'
$DshHome = Join-Path $Root '.dsh'
$Profile = Join-Path $DshHome 'profiles\clinical'
$Cache = Join-Path $Root '.cache'
$PythonHome = Join-Path $Root '.venv'
$PythonBin = Join-Path $PythonHome 'Scripts\python.exe'

function Assert-Version([string]$Actual, [version]$Minimum, [string]$Label) {
    if (-not $Actual) { throw "Unable to detect $Label version." }
    try {
        if ([version]$Actual -lt $Minimum) {
            throw "$Label version is too old: minimum $Minimum+, found $Actual."
        }
    } catch [System.Management.Automation.RuntimeException] {
        throw "Invalid $Label version: $Actual."
    }
}

function Get-Sha256([string]$Path) {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '')
    } finally {
        $hasher.Dispose()
    }
}
function Get-SystemPythonCommand {
    if ($env:EMERALD_PYTHON) {
        if (Test-Path $env:EMERALD_PYTHON) {
            return @{ Command = $env:EMERALD_PYTHON; Arguments = @() }
        }
    }

    foreach ($name in @('python', 'python3')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        $candidate = if ($command) { $command.Source } else { $null }
        if ($candidate -and $candidate -notmatch 'WindowsApps') {
            return @{ Command = $candidate; Arguments = @() }
        }
    }

    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $launcherVersion = & $launcher.Source -3 -c 'import platform; print(platform.python_version())' 2>$null
            if ($LASTEXITCODE -eq 0 -and $launcherVersion) {
                return @{ Command = $launcher.Source; Arguments = @('-3') }
            }
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
    }
    return $null
}

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw 'Node.js 24+ and npm are required. Install Node.js from https://nodejs.org, then rerun this script.'
}
$nodeCommand = $node.Source
$npmCommand = $npm.Source

$pythonSource = Get-SystemPythonCommand
if (-not $pythonSource) {
    throw 'Python 3.10+ is required. Install Python from https://www.python.org/downloads/, then rerun this script.'
}
$pythonCommand = $pythonSource.Command
$pythonArguments = $pythonSource.Arguments

$nodeVersion = (& $nodeCommand --version).ToString() -replace '^v', ''
$pythonVersion = (& $pythonCommand @pythonArguments -c 'import platform; print(platform.python_version())').ToString()
Assert-Version $nodeVersion ([version]'24.0.0') 'Node.js'
Assert-Version $pythonVersion ([version]'3.10.0') 'Python'

New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$env:DSH_HOME = $DshHome
$env:NPM_CONFIG_CACHE = Join-Path $Cache 'npm'
$env:PIP_CACHE_DIR = Join-Path $Cache 'pip'
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
# ST-P2-4: 强制 DISABLED，不允许外部预设覆盖（临床数据守卫不上报遥测）
$env:DSH_TELEMETRY_MODE = 'DISABLED'
$env:PYTHONDONTWRITEBYTECODE = '1'

# Runtime dependencies are locked by package-lock.json; rebuild only when the lock changes.
$runtimeLock = Join-Path $Runtime 'package-lock.json'
$runtimeStamp = Join-Path $Cache 'runtime-install.sha256'
$runtimeManifest = Join-Path $Runtime 'package.json'
$runtimeHash = @(
    (Get-Sha256 $runtimeLock)
    (Get-Sha256 $runtimeManifest)
) -join ':'
if (-not (Test-Path $RuntimeBin) -or -not (Test-Path $runtimeStamp) -or (Get-Content $runtimeStamp -Raw).Trim() -ne $runtimeHash) {
    & $npmCommand ci --prefix $Runtime --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "DSH runtime install failed (exit $LASTEXITCODE)." }
    Set-Content -LiteralPath $runtimeStamp -Value $runtimeHash -NoNewline
}

# Python packages stay project-local, while the interpreter itself comes from the system.
if (-not (Test-Path $PythonBin)) {
    & $pythonCommand @pythonArguments -m venv $PythonHome
    if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed (exit $LASTEXITCODE)." }
}
$requirements = Join-Path $Root 'requirements.txt'
$pythonStamp = Join-Path $Cache 'python-requirements.sha256'
$requirementsHash = (Get-Sha256 $requirements)
if (-not (Test-Path $pythonStamp) -or (Get-Content $pythonStamp -Raw).Trim() -ne $requirementsHash) {
    & $PythonBin -m pip install --disable-pip-version-check --no-input -r $requirements
    if ($LASTEXITCODE -ne 0) { throw "Python dependency install failed (exit $LASTEXITCODE)." }
    Set-Content -LiteralPath $pythonStamp -Value $requirementsHash -NoNewline
}
$env:PYTHON = $PythonBin

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$pnpmCommand = if ($pnpm) { $pnpm.Source } else { $null }
if (-not $pnpmCommand) {
    Write-Host 'pnpm not found; installing pnpm 11.19.0 with system npm...'
    & $npmCommand install --global pnpm@11.19.0
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm installation failed (exit $LASTEXITCODE). Install it manually with: npm install --global pnpm@11.19.0"
    }
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    $pnpmCommand = if ($pnpm) { $pnpm.Source } else { $null }
    if (-not $pnpmCommand) {
        $globalPrefix = (& $npmCommand prefix -g).ToString().Trim()
        $candidate = Join-Path $globalPrefix 'pnpm.cmd'
        if (Test-Path $candidate) { $pnpmCommand = $candidate }
    }
    if (-not $pnpmCommand) {
        throw 'pnpm was installed but its command could not be found. Open a new terminal and rerun this script.'
    }
}

# Profile manifests and lockfiles are committed; pnpm reuses installed packages when current.
if (-not (Test-Path (Join-Path $Profile 'pnpm-lock.yaml'))) {
    throw "Missing clinical profile lockfile: $Profile\pnpm-lock.yaml"
}
Push-Location $Profile
try {
    & $pnpmCommand install --frozen-lockfile --prefer-offline --config.confirmModulesPurge=false --store-dir (Join-Path $Root '.pnpm-store')
    if ($LASTEXITCODE -ne 0) { throw "Clinical profile install failed (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}

if ($Check) {
    $config = & $RuntimeBin --profile clinical --dump-config
    if ($LASTEXITCODE -ne 0) { throw "Clinical profile config check failed (exit $LASTEXITCODE)." }
    if (-not ($config -match 'clinical-data-guard')) {
        throw 'Clinical profile did not load emerald-clinical-data-guard.'
    }
    Write-Host 'PROJECT_DSH_CHECK=PASS'
    exit 0
}

$url = 'http://127.0.0.1:3080'
$portOwners = & netstat -ano -p TCP |
    Select-String '^\s*TCP\s+\S+:3080\s+\S+\s+LISTENING\s+(\d+)\s*$' |
    ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
    Select-Object -Unique

if ($portOwners) {
    try {
        $existingResponse = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
        if ($existingResponse.StatusCode -ge 200) {
            Write-Host "Emerald Clinical DSH is already running: $url"
            if (-not $NoOpen) { Start-Process $url }
            exit 0
        }
    } catch {
    }

    foreach ($processId in $portOwners) {
        try {
            Write-Host "Cleaning up stale process on port 3080, PID $processId"
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        } catch {
            throw "Port 3080 is occupied by PID $processId and could not be released. Run stop.bat as administrator, then retry."
        }
    }
}

$opener = $null
if (-not $NoOpen) {
    $waitAndOpen = @"
for (`$i = 0; `$i -lt 120; `$i++) {
    try {
        `$response = Invoke-WebRequest -UseBasicParsing -Uri '$url' -TimeoutSec 1
        if (`$response.StatusCode -ge 200) { Start-Process '$url'; exit 0 }
    } catch {
        Start-Sleep -Seconds 1
    }
}
exit 1
"@
    $opener = Start-Process -FilePath powershell -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $waitAndOpen
    ) -WindowStyle Hidden -PassThru
}

try {
    Write-Host "Emerald Clinical DSH: $url"
    & $RuntimeBin --profile clinical
    $exitCode = $LASTEXITCODE
} finally {
    if ($opener -and -not $opener.HasExited) {
        Stop-Process -Id $opener.Id -Force
    }
}

exit $exitCode