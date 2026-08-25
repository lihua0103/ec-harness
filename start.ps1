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

# E-5 (2026-08-22 e2e audit): the clinical profile loads the plugin via pnpm link,
# so the workspace IS the runtime. Code saved after the server started is invisible
# to the running process (drift failures look like random ImportErrors). The stamp
# records the newest plugin source mtime at server start; the "already running"
# path compares it with the current disk state and warns on drift.
function Get-PluginCodeStamp {
    $pluginRoot = Join-Path $Root 'dsh-clinical-data-guard'
    $newest = $null
    foreach ($dir in @('security', 'src')) {
        $files = @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot $dir) -File -Filter '*.*' -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in '.py', '.js' })
        foreach ($file in $files) {
            if (-not $newest -or $file.LastWriteTime -gt $newest.LastWriteTime) { $newest = $file }
        }
    }
    if ($newest) { return "$($newest.LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss'))|$($newest.Name)" }
    return $null
}

$PluginStampFile = Join-Path $Cache 'server-plugin.stamp'
function Get-SystemPythonCommand {
    if ($env:EMERALD_PYTHON) {
        if (Test-Path $env:EMERALD_PYTHON) {
            return @{ Command = $env:EMERALD_PYTHON; Arguments = @() }
        }
    }

    # 2026-08-24：系统只统一一套 Python 环境。宿主运行时（TRAE/codex）会把
    # 自己缓存目录里的 python 前置到 PATH（如 .cache\codex-runtimes），它既是
    # 易失缓存又缺项目依赖，绝不允许作为 venv 基解释器；仅在没有其他选择时
    # 才接受。
    $pathCandidates = @()
    foreach ($name in @('python', 'python3')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        $candidate = if ($command) { $command.Source } else { $null }
        if ($candidate -and $candidate -notmatch 'WindowsApps') {
            $pathCandidates += $candidate
        }
    }
    $stable = @($pathCandidates | Where-Object { $_ -notmatch '\.cache[\\/]codex-runtimes' })
    if ($stable) {
        return @{ Command = $stable[0]; Arguments = @() }
    }
    if ($pathCandidates) {
        return @{ Command = $pathCandidates[0]; Arguments = @() }
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
# The clinical runtime must write its audit trail inside the project runtime.
# A stale lock under the user's profile can retain a restrictive Windows ACL
# after a previous elevated run, causing the real web workflow to fail before
# any Listing tool is reached. Keep an explicit operator override for managed
# deployments and tests, but make the local project path the default.
if (-not $env:EMERALD_AUDIT_ROOT) {
    $env:EMERALD_AUDIT_ROOT = Join-Path $DshHome 'var\egress_audit'
}
# 2026-08-24: listing 交付物属于项目数据，必须落在用户为会话选择的项目目录内
# （<项目>/.clinical-listing/output/<scenario>，由 listing_workflow 回退路径实现）。
# 系统产物（审计日志）才跟随系统 .dsh 运行时目录。不再默认设置
# EMERALD_OUTPUT_PLANE_ROOT；托管部署仍可显式指定独立产物域。
$env:NPM_CONFIG_CACHE = Join-Path $Cache 'npm'
$env:PIP_CACHE_DIR = Join-Path $Cache 'pip'
# 2026-08-24：系统不往 C 盘写任何数据。宿主的 TEMP/TMP 默认指向
# C:\Users\...\AppData\Local\Temp，dsh-spill（工具大结果落盘）、node 与
# python 的临时文件都会落到 C 盘。统一把临时区重定向到系统目录 .cache\tmp。
$TmpHome = Join-Path $Cache 'tmp'
New-Item -ItemType Directory -Force -Path $TmpHome | Out-Null
$env:TMPDIR = $TmpHome
$env:TEMP = $TmpHome
$env:TMP = $TmpHome
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
# 2026-08-24：venv 的基解释器必须与本次选定的解释器一致。venv 记录的是创建时
# 的解释器（pyvenv.cfg home）；宿主环境变化（例如从 TRAE/codex 缓存 python 切到
# 系统 python）后，旧 venv 仍指向易失/错误的基解释器——沙盒与本地因此跑在两套
# 环境上。发现不一致即重建 venv 并使依赖戳失效。
$venvCfg = Join-Path $PythonHome 'pyvenv.cfg'
if ((Test-Path $PythonBin) -and (Test-Path $venvCfg)) {
    $selectedHome = (& $pythonCommand @pythonArguments -c 'import sys; print(sys.base_prefix)').ToString().Trim()
    $recordedHome = ((Select-String -Path $venvCfg -Pattern '^home\s*=\s*(.+)$' | Select-Object -First 1).Matches.Groups[1].Value).Trim()
    if ($recordedHome -and $selectedHome -and ($recordedHome -ne $selectedHome)) {
        Write-Host "Python base interpreter changed ($recordedHome -> $selectedHome); rebuilding virtual environment..."
        Remove-Item -LiteralPath $PythonHome -Recurse -Force
        Remove-Item -LiteralPath (Join-Path $Cache 'python-requirements.sha256') -Force -ErrorAction SilentlyContinue
    }
}
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
# 2026-08-24：PLUGIN_PYTHON 是插件运行时（index.js / tool-result-guard.js）
# 优先消费的解释器钉点，主路径也必须导出——此前只在 -Check 分支设置，
# 生产代码从未读到，worker/extractor 退化到 PATH 上的任意 python。
$env:PLUGIN_PYTHON = $PythonBin

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

# Interrupted pnpm atomic writes can leave _tmp_* files in the profile root.
# DSH watches this directory, and Windows can reject watchers for those files.
foreach ($temporaryProfileFile in @(Get-ChildItem -LiteralPath $Profile -File -Force -Filter '_tmp_*')) {
    Remove-Item -LiteralPath $temporaryProfileFile.FullName -Force
}

if ($Check) {
    $pluginRoot = Join-Path $Root 'dsh-clinical-data-guard'
    $previousPythonPath = $env:PYTHONPATH
    $env:PYTHONPATH = if ($previousPythonPath) { "$pluginRoot;$previousPythonPath" } else { $pluginRoot }
    # D-1 (2026-08-22): the legacy generator module was removed (F-11); check the
    # current three-stage listing stack instead so -Check cannot pass on dead refs.
    & $PythonBin -c 'import security.listing_workflow'
    if ($LASTEXITCODE -ne 0) { throw 'Clinical listing workflow import check failed.' }
    $config = & $RuntimeBin --profile clinical --dump-config
    if ($LASTEXITCODE -ne 0) { throw "Clinical profile config check failed (exit $LASTEXITCODE)." }
    if (-not ($config -match 'clinical-data-guard')) {
        throw 'Clinical profile did not load emerald-clinical-data-guard.'
    }
    $env:PLUGIN_PYTHON = $PythonBin
    $env:LOCAL_DATA_ACCESS = 'uat-local'
    $env:LOCAL_DATA_ROOT = $Root
    $toolContract = & $nodeCommand (Join-Path $pluginRoot 'tests\integration\plugin_driver.js') 'listing-tool-contract'
    if ($LASTEXITCODE -ne 0) { throw 'Clinical tool registration check failed.' }
    $toolNames = @($toolContract | ConvertFrom-Json | ForEach-Object { $_.name })
    foreach ($requiredTool in @('clinical_listing_inspect', 'clinical_listing_run_code', 'clinical_listing_publish', 'local_data_metadata')) {
        if ($requiredTool -notin $toolNames) {
            throw "Clinical profile tool is not registered: $requiredTool"
        }
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
            # E-5: drift self-check - warn when plugin code on disk is newer than
            # the code the running server started with (pnpm link workspace runtime).
            if (Test-Path $PluginStampFile) {
                $startedStamp = (Get-Content $PluginStampFile -Raw).Trim()
                $currentStamp = Get-PluginCodeStamp
                if ($startedStamp -and $currentStamp -and $currentStamp -ne $startedStamp) {
                    Write-Warning "Plugin code changed since the running server started (server started with: $startedStamp; disk now: $currentStamp)."
                    Write-Warning 'The workspace is the runtime (pnpm link). Run stop.bat and then start.ps1 to load the new code.'
                }
            }
            if (-not $NoOpen) {
                Start-Process $url
                # One-click UX: launched via double-click (start.bat), this console
                # would flash and close before the message above is readable.
                # Hold it briefly; -NoOpen (scripted runs) skips the delay.
                for ($i = 10; $i -gt 0; $i--) {
                    Write-Host "`rThis window closes in $i second(s)...   " -NoNewline
                    Start-Sleep -Seconds 1
                }
                Write-Host ''
            }
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
    # E-5: record the plugin code stamp the server is starting with, so a later
    # start.ps1 run can detect and warn about code drift on the running server.
    $pluginStamp = Get-PluginCodeStamp
    if ($pluginStamp) { Set-Content -LiteralPath $PluginStampFile -Value $pluginStamp -NoNewline }
    & $RuntimeBin --profile clinical
    $exitCode = $LASTEXITCODE
} finally {
    if ($opener -and -not $opener.HasExited) {
        Stop-Process -Id $opener.Id -Force
    }
}

exit $exitCode
