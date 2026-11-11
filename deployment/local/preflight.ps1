# Read-only host preflight. Emits JSON to stdout, never installs/enables features or changes policies.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = [ordered]@{
    schemaVersion = 1
    reportKind = 'LOCAL_HOST_PREFLIGHT'
    checkedAt = [DateTime]::UtcNow.ToString('o')
    os = 'Windows'
    memoryBytes = $null
    logicalProcessors = $null
    hypervisorPresent = $null
    virtualizationFirmwareReported = $null
    slatReported = $null
    hyperVCommandAvailable = $false
    vmmsStatus = 'NOT_OBSERVED'
    windowsEdition = 'UNKNOWN'
    collectionErrors = @()
    isolationVerification = 'NOT_RUN'
    productionDataEnabled = $false
    conclusion = 'BLOCKED_PENDING_DEPLOYMENT_AND_DYNAMIC_TESTS'
}
try {
    $system = Get-CimInstance Win32_ComputerSystem
    $result.memoryBytes = $system.TotalPhysicalMemory
    $result.hypervisorPresent = $system.HypervisorPresent
} catch { $result.collectionErrors += 'COMPUTER_SYSTEM_QUERY_FAILED' }
try {
    $cpu = @(Get-CimInstance Win32_Processor)
    $result.logicalProcessors = ($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    $result.virtualizationFirmwareReported = @($cpu | ForEach-Object { $_.VirtualizationFirmwareEnabled })
    $result.slatReported = @($cpu | ForEach-Object { $_.SecondLevelAddressTranslationExtensions })
} catch { $result.collectionErrors += 'PROCESSOR_QUERY_FAILED' }
try { $result.windowsEdition = (Get-CimInstance Win32_OperatingSystem).Caption }
catch { $result.collectionErrors += 'OS_QUERY_FAILED' }
$result.hyperVCommandAvailable = $null -ne (Get-Command Get-VM -ErrorAction SilentlyContinue)
$service = Get-Service -Name vmms -ErrorAction SilentlyContinue
if ($null -ne $service) { $result.vmmsStatus = [string]$service.Status }
# CPU firmware fields can be misleading under an already active hypervisor; never infer isolation from them.
$result | ConvertTo-Json -Depth 6
