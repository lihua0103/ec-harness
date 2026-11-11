# Configuration inspection only. This script never declares dynamic isolation tests passed.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Profile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$config = Get-Content -LiteralPath $Profile -Raw | ConvertFrom-Json
if ($config.deploymentId -isnot [string] -or $config.deploymentId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') { throw 'DEPLOYMENT_PROFILE_INVALID' }
if ($config.schemaVersion -ne 1 -or $config.productionDataEnabled -ne $false -or
    $config.modelFeedback -ne 'WITHHELD_REQUIRES_BROKER_REVIEW' -or
    $config.aiVmName -eq $config.executionVmName) { throw 'DEPLOYMENT_PROFILE_INVALID' }
foreach ($name in @($config.aiVmName, $config.executionVmName)) {
    if ($name -isnot [string] -or $name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'VM_NAME_INVALID' }
}
$result = [ordered]@{
    schemaVersion = 1
    reportKind = 'HYPERV_CONFIGURATION_OBSERVATIONS_ONLY'
    checkedAt = [DateTime]::UtcNow.ToString('o')
    deploymentId = $config.deploymentId
    vms = @()
    blockers = @()
    dynamicIsolation = 'NOT_RUN'
    productionDataEnabled = $false
}
if ($null -eq (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    $result.blockers += 'HYPERV_MANAGEMENT_UNAVAILABLE'
} else {
    try {
        $hostState = Get-VMHost
        if ($hostState.EnableEnhancedSessionMode -ne $false) { $result.blockers += 'ENHANCED_SESSION_NOT_DISABLED' }
    } catch { $result.blockers += 'HOST_CONFIGURATION_UNVERIFIABLE' }
    foreach ($role in @('ai','execution')) {
        $name = if ($role -eq 'ai') { $config.aiVmName } else { $config.executionVmName }
        try {
            $vm = Get-VM -Name $name
            $adapters = @(Get-VMNetworkAdapter -VM $vm)
            $enabledIntegration = @(Get-VMIntegrationService -VM $vm | Where-Object { $_.Enabled } | ForEach-Object { $_.Name })
            $result.vms += [ordered]@{ role=$role; name=$name; state=[string]$vm.State; vmId=[string]$vm.Id; networkAdapterCount=$adapters.Count; enabledIntegrationServices=$enabledIntegration }
            # Conservative target: execution VM has no virtual NIC. Broker transport is not yet provisioned.
            if ($role -eq 'execution' -and $adapters.Count -ne 0) { $result.blockers += 'EXECUTION_NETWORK_ADAPTER_PRESENT' }
        } catch { $result.blockers += ('VM_CONFIGURATION_UNVERIFIABLE_' + $role.ToUpperInvariant()) }
    }
}
$result.blockers += @('GUEST_FILE_AND_NETWORK_TESTS_NOT_RUN','CLIPBOARD_DRIVE_REDIRECTION_TESTS_NOT_RUN','PROCESS_TREE_AND_CRASH_TESTS_NOT_RUN','MODEL_REQUEST_CANARY_TESTS_NOT_RUN','BROKER_TRANSPORT_NOT_PROVISIONED')
$result | ConvertTo-Json -Depth 8
