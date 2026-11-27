#requires -Version 5.1
# Create a host-only ZIP from the exact published kernel commit.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$KernelCommit)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kernel=Join-Path $root '.ioss9-p4-lab'
$commit=$KernelCommit
$gitCmd=Get-Command git.exe -ErrorAction SilentlyContinue
$git=if($gitCmd){$gitCmd.Source}else{'C:\Program Files\Git\cmd\git.exe'}
if(-not (Test-Path -LiteralPath $git)){throw 'Git for Windows not found'}
$files=@('s9-p1274-serial.ps1','s9-p125-timer-serial.ps1','s9-p12-dual-serial.ps1','s9-screen-lifecycle-serial.ps1','s9-p127541-background.ps1')
# Scratch stays in workspace under .catdesk, never included in Git or ZIP.
$work=Join-Path $root ('.catdesk\p12754-kit-'+[guid]::NewGuid().ToString('N'))
$stage=Join-Path $work 'kit'
[void](New-Item -ItemType Directory -Path $stage)
$source=Join-Path $work 'pinned.zip'
& $git -C $kernel archive --format=zip "--output=$source" $commit -- @($files|ForEach-Object {"tools/$_"})
if($LASTEXITCODE){throw 'Pinned kernel commit archive failed'}
& $git -C $kernel show "$($commit):tools/tests/test-p12754-contract.js" | Out-Null
if($LASTEXITCODE){throw 'Pinned kernel commit does not contain P12754 source contract'}
$rev=& $git -C $kernel show "$($commit):drivers/power/exynos/hakios.p12753.h"
if($LASTEXITCODE -or -not ($rev -match 'p12754_revision=2')){throw 'P127541 kit requires exact revision 2 kernel commit'}
Expand-Archive -LiteralPath $source -DestinationPath (Join-Path $work 'source')
foreach($f in $files){Copy-Item -LiteralPath (Join-Path $work "source\tools\$f") -Destination $stage}
Copy-Item -LiteralPath (Join-Path $root 'docs\p12754-test.md') -Destination (Join-Path $stage 'README.md')
$names=$files+@('README.md')
$hash=[ordered]@{}
foreach($f in $names){$hash[$f]=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage $f)).Hash}
[ordered]@{kernel_commit=$commit;files=$hash}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'SHA256SUMS.json')
$zip=Join-Path $PSScriptRoot ('p12754-host-'+$commit.Substring(0,7)+'.zip')
Compress-Archive -LiteralPath @(($names+@('SHA256SUMS.json'))|ForEach-Object {Join-Path $stage $_}) -DestinationPath $zip -Force
$verify=Join-Path $work 'verify'
Expand-Archive -LiteralPath $zip -DestinationPath $verify
$actual=@(Get-ChildItem -LiteralPath $verify -File|Select-Object -ExpandProperty Name)
if(@(Compare-Object ($names+@('SHA256SUMS.json')) $actual).Count){throw 'ZIP contents mismatch'}
foreach($f in $names){if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $verify $f)).Hash -ne $hash[$f]){throw "ZIP verification failed: $f"}}
$preview=Join-Path $work 'preview-no-io'
foreach($profile in @('LOG2','R2','R1','R0')){
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $verify 's9-p1274-serial.ps1') -P12752 -Profile $profile -Experiment EarlyLoad -BootVariant OptEarly -AllowIntervention -RunDir $preview
    if($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $preview)){throw "ZIP burst preview failed: $profile"}
}
Push-Location $verify
try{
    foreach($case in @(
        @{scenario='Idle52';extra=@('-EnergySeconds','60')},
        @{scenario='BusTrace';extra=@()},
        @{scenario='Idle52Offline';extra=@('-EnergySeconds','60','-AllowOfflineTrial')},
        @{scenario='Idle52Recover';extra=@('-ExpectedStart','14178910718')},
        @{scenario='EnergyTrials';extra=@('-EnergyModules','PSR','-EnergySeconds','30')},
        @{scenario='EnergyTrials';extra=@('-EnergyModules','LITTLE949','-EnergySeconds','30')},
        @{scenario='DriverTrials';extra=@('-DriverModules','WIFI','-DriverSeconds','30')}
    )){
        $extra=$case.extra
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $verify 's9-p125-timer-serial.ps1') -Scenario $case.scenario -P12752Idle @extra
        if($LASTEXITCODE -ne 0){throw "ZIP idle preview failed: $($case.scenario)"}
    }
    foreach($case in @(
        @{scenario='Guard53';extra=@('-P12754')},
        @{scenario='Hardware54';extra=@('-P12754')},
        @{scenario='Audit53';extra=@('-P12754','-Audit53Module','STOCK60','-AllowOfflineTrial')},
        @{scenario='FunctionalGate';extra=@('-P12754','-GateModule','LITTLE949','-AllowFunctionalGate')},
        @{scenario='Audit53';extra=@('-P12754','-Audit53Module','STOCK120','-AllowOfflineTrial')},
        @{scenario='Audit53';extra=@('-P12754','-Audit53Module','BASE15','-AllowOfflineTrial')},
        @{scenario='Audit53Recover';extra=@('-P12754','-Audit53Checkpoint','example.audit53-checkpoint.clixml')}
    )){
        $extra=$case.extra
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $verify 's9-p125-timer-serial.ps1') -Scenario $case.scenario @extra
        if($LASTEXITCODE -ne 0){throw "ZIP audit preview failed: $($case.scenario)"}
    }
    if(@(Compare-Object ($names+@('SHA256SUMS.json')) @(Get-ChildItem -Force -Name)).Count){throw 'Preview created files'}
}finally{Pop-Location}
Write-Host "Verified ZIP: $zip"
Write-Host "SHA256 $((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash)"
Write-Host "Scratch verification directory: $work"
