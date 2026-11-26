#requires -Version 5.1
# P12.7.3 host-only test launcher. No hardware access unless -Execute.
[CmdletBinding()]
param(
    [ValidateRange(1,12)][int]$Test=1,
    [ValidatePattern('^COM[0-9]+$')][string]$Port='COM125',
    [ValidatePattern('^COM[0-9]+$|^$')][string]$ReconnectPort='',
    [ValidateSet('USB','ABOX','BT','WIFI','TICKER','PSR','LITTLE949','COMBINED5','COMBINED6')][string]$Module='',
    [string]$SymbolMap='',
    [string]$OutputRoot='',
    [switch]$AllowFunctionalGate,
    [switch]$AllowOffCap,
    [switch]$AllowStrongerCap,
    [switch]$AllowOfflineTrial,
    [switch]$AllowCombined,
    [switch]$Execute
)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
if(-not $OutputRoot){$OutputRoot=Join-Path $PSScriptRoot 'logs'}
$kernel='ee597e843386a45293f90b9800889593983bf812'
$scenarios=@('GpuCacheCheck','ThermalTrace','ThermalGpuDump','ThermalTraceDump','P1273Diagnostics','BusTrace','EnergyTrials','FunctionalGate','OffBurstCapABA','OfflineABA','CombinedConnected','EnergyTrials')
$scenario=$scenarios[$Test-1]
$extra=@()
switch($Test){
    7 {
        if($Module -and $Module -ne 'PSR'){throw 'Test 7 is PSR only'}
        $extra=@('-EnergyModules','PSR','-EnergySeconds','30','-RequireGpuCache','-P1273Telemetry')
    }
    8 {
        if($Module -notin @('USB','ABOX','BT','WIFI','TICKER','LITTLE949','COMBINED5','COMBINED6')){throw 'Test 8 requires an explicit valid -Module'}
        if(-not $AllowFunctionalGate){throw 'Test 8 requires -AllowFunctionalGate and real foreground verification'}
        $extra=@('-GateModule',$Module,'-AllowFunctionalGate','-RequireGpuCache')
        if($Module -in @('COMBINED5','COMBINED6')){
            if(-not $AllowCombined){throw 'Combined gate also requires -AllowCombined'}
            $extra+= '-AllowCombined'
        }
    }
    9 {
        if(-not $AllowOffCap){throw 'Test 9 requires -AllowOffCap after frozen trace review'}
        $extra=@('-AllowOffCap')
        if($AllowStrongerCap){$extra+='-AllowStrongerCap'}
    }
    10 {
        if($Module -notin @('ABOX','BT','WIFI','TICKER','LITTLE949','COMBINED5','COMBINED6')){throw 'Test 10 requires an explicit offline -Module'}
        if(-not $AllowOfflineTrial){throw 'Test 10 requires -AllowOfflineTrial after functional review'}
        $extra=@('-OfflineModule',$Module,'-AllowOfflineTrial','-RequireGpuCache')
        if($Module -in @('COMBINED5','COMBINED6')){
            if(-not $AllowCombined){throw 'Combined offline also requires -AllowCombined'}
            $extra+='-AllowCombined'
        }
    }
    11 {
        if($Module -notin @('COMBINED5','COMBINED6')){throw 'Test 11 requires explicit COMBINED5 or COMBINED6'}
        if(-not $AllowCombined){throw 'Test 11 requires -AllowCombined and same-boot qualifications'}
        $extra=@('-CombinedProfile',$Module,'-EnergySeconds','30','-AllowCombined','-RequireGpuCache')
    }
    12 {
        if($Module -notin @('USB','ABOX','BT','WIFI','TICKER','LITTLE949')){throw 'Test 12 requires one individual -Module'}
        $extra=@('-EnergyModules',$Module,'-EnergySeconds','30','-RequireGpuCache','-P1273Telemetry')
    }
}
if($Test -notin @(7,8,10,11,12) -and $Module){throw 'This test does not accept -Module'}
if($AllowStrongerCap -and $Test -ne 9){throw '-AllowStrongerCap is only for Test 9'}
if($AllowOffCap -and $Test -ne 9){throw '-AllowOffCap is only for Test 9'}
if($AllowFunctionalGate -and $Test -ne 8){throw '-AllowFunctionalGate is only for Test 8'}
if($AllowOfflineTrial -and $Test -ne 10){throw '-AllowOfflineTrial is only for Test 10'}
if($AllowCombined -and ($Test -notin @(8,10,11) -or $Module -notin @('COMBINED5','COMBINED6'))){throw '-AllowCombined requires a combined gate or trial'}
$entry=Join-Path $PSScriptRoot 's9-p125-timer-serial.ps1'
$files=@('s9-p125-timer-serial.ps1','s9-p12-dual-serial.ps1','s9-screen-lifecycle-serial.ps1')
$child=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$entry,'-Port',$Port,'-Scenario',$scenario)+$extra
if($ReconnectPort){$child+=@('-ReconnectPort',$ReconnectPort)}
if($SymbolMap){$child+=@('-SymbolMap',(Resolve-Path -LiteralPath $SymbolMap).Path)}
Write-Host "P12.7.3 kernel source $kernel"
Write-Host "Test $Test : $scenario $Module"
Write-Host "powershell.exe $($child -join ' ') -Execute"
if(-not $Execute){
    Write-Host 'PREVIEW ONLY. No serial connection or hardware policy change.'
    return
}
if($env:OS -ne 'Windows_NT'){throw 'Windows serial runner only'}
foreach($file in $files){if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)){throw "Missing matched companion $file; extract full ZIP"}}
$manifest=Join-Path $PSScriptRoot 'SHA256SUMS.json'
if(-not (Test-Path -LiteralPath $manifest)){throw 'Missing SHA256SUMS.json; extract full ZIP'}
$m=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if($m.kernel_commit -ne $kernel){throw 'Host kit source identity mismatch'}
foreach($file in $files+@('s9-p1273-test.ps1','README.md')){
    $expected=$m.files.PSObject.Properties[$file]
    if($null -eq $expected -or (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot $file)).Hash -ne $expected.Value){throw "Host kit checksum mismatch: $file"}
}
$dir=Join-Path $OutputRoot ('Test{0:D2}-{1}-{2}' -f $Test,$scenario,(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
[void](New-Item -ItemType Directory -Path $dir)
$dir=(Resolve-Path -LiteralPath $dir).Path
@("kernel_source=$kernel","test=$Test","scenario=$scenario","module=$Module","port=$Port","reconnect_port=$ReconnectPort","command=powershell.exe $($child -join ' ') -Execute") | Set-Content -LiteralPath (Join-Path $dir 'test-info.txt') -Encoding UTF8
Write-Host "LOG DIRECTORY: $dir"
Push-Location -LiteralPath $dir
try{
    # Child console stays interactive for real Y/N gate confirmation and USB prompts.
    & powershell.exe @child -Execute
    $code=$LASTEXITCODE
    Add-Content -LiteralPath (Join-Path $dir 'test-info.txt') -Value "exit_code=$code"
    if($code -ne 0){throw "Test $Test failed/incomplete (exit $code). Keep all files; do not proceed to dependent tests."}
    Write-Host "Test $Test exited normally. Inspect report for actual PASS/INCONCLUSIVE; exit 0 alone is not qualification."
}finally{Pop-Location}
