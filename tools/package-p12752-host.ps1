#requires -Version 5.1
# Create a host-only ZIP from the exact published kernel commit.
[CmdletBinding()]
param()
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kernel=Join-Path $root '.ioss9-p4-lab'
$commit='7cc59a335c46ec473fc6f166572dec20304efd63'
$gitCmd=Get-Command git.exe -ErrorAction SilentlyContinue
$git=if($gitCmd){$gitCmd.Source}else{'C:\Program Files\Git\cmd\git.exe'}
if(-not (Test-Path -LiteralPath $git)){throw 'Git for Windows not found'}
$files=@('s9-p1274-serial.ps1','s9-p125-timer-serial.ps1','s9-p12-dual-serial.ps1','s9-screen-lifecycle-serial.ps1')
# Scratch stays in workspace under .catdesk, never included in Git or ZIP.
$work=Join-Path $root ('.catdesk\p12752-kit-'+[guid]::NewGuid().ToString('N'))
$stage=Join-Path $work 'kit'
[void](New-Item -ItemType Directory -Path $stage)
$source=Join-Path $work 'pinned.zip'
& $git -C $kernel archive --format=zip "--output=$source" $commit -- @($files|ForEach-Object {"tools/$_"})
if($LASTEXITCODE){throw 'Pinned kernel commit archive failed'}
Expand-Archive -LiteralPath $source -DestinationPath (Join-Path $work 'source')
foreach($f in $files){Copy-Item -LiteralPath (Join-Path $work "source\tools\$f") -Destination $stage}
Copy-Item -LiteralPath (Join-Path $root 'docs\p12752-test.md') -Destination (Join-Path $stage 'README.md')
$names=$files+@('README.md')
$hash=[ordered]@{}
foreach($f in $names){$hash[$f]=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage $f)).Hash}
[ordered]@{kernel_commit=$commit;files=$hash}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'SHA256SUMS.json')
$zip=Join-Path $PSScriptRoot 'p12752-host-7cc59a3.zip'
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
        @{scenario='EnergyTrials';extra=@('-EnergyModules','PSR','-EnergySeconds','30')},
        @{scenario='EnergyTrials';extra=@('-EnergyModules','LITTLE949','-EnergySeconds','30')},
        @{scenario='DriverTrials';extra=@('-DriverModules','WIFI','-DriverSeconds','30')}
    )){
        $extra=$case.extra
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $verify 's9-p125-timer-serial.ps1') -Scenario $case.scenario -P12752Idle @extra
        if($LASTEXITCODE -ne 0){throw "ZIP idle preview failed: $($case.scenario)"}
    }
    if(@(Compare-Object ($names+@('SHA256SUMS.json')) @(Get-ChildItem -Force -Name)).Count){throw 'Preview created files'}
}finally{Pop-Location}
Write-Host "Verified ZIP: $zip"
Write-Host "SHA256 $((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash)"
Write-Host "Scratch verification directory: $work"
