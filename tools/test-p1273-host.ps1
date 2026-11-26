#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$KitPath)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$kit=(Resolve-Path -LiteralPath $KitPath).Path
$entry=Join-Path $kit 's9-p1273-test.ps1'
$m=Get-Content -LiteralPath (Join-Path $kit 'SHA256SUMS.json') -Raw|ConvertFrom-Json
if($m.kernel_commit -ne 'ee597e843386a45293f90b9800889593983bf812'){throw 'Wrong commit'}
foreach($p in $m.files.PSObject.Properties){
    if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $kit $p.Name)).Hash -ne $p.Value){throw "Wrong hash $($p.Name)"}
}
foreach($file in Get-ChildItem -LiteralPath $kit -Filter '*.ps1'){
    $tokens=$null;$errors=$null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw "Parse error $($file.Name): $errors"}
}
$count=0
function Preview([hashtable]$ArgsMap,[string[]]$Expected){
    $out=(& $entry @ArgsMap 6>&1|Out-String -Width 4096)
    foreach($e in @('PREVIEW ONLY')+$Expected){if(-not $out.Contains($e)){throw "Missing $e in $out"}}
    $script:count++
}
function Reject([hashtable]$ArgsMap,[string]$Expected){
    $caught=$false
    try{& $entry @ArgsMap 6>&1|Out-Null}catch{if($_.Exception.Message -notlike "*$Expected*"){throw};$caught=$true}
    if(-not $caught){throw "Expected refusal $Expected"}
    $script:count++
}
$names=@('GpuCacheCheck','ThermalTrace','ThermalGpuDump','ThermalTraceDump','P1273Diagnostics','BusTrace')
for($i=1;$i -le 6;$i++){Preview @{Test=$i;Port='COM123'} @("-Scenario $($names[$i-1])",'-Port COM123')}
Preview @{Test=7} @('-Scenario EnergyTrials','-EnergyModules PSR','-EnergySeconds 30','-P1273Telemetry')
Preview @{Test=8;Module='USB';AllowFunctionalGate=$true} @('-Scenario FunctionalGate','-GateModule USB','-AllowFunctionalGate')
Preview @{Test=8;Module='COMBINED5';AllowFunctionalGate=$true;AllowCombined=$true} @('-GateModule COMBINED5','-AllowCombined')
Preview @{Test=9;AllowOffCap=$true} @('-Scenario OffBurstCapABA','-AllowOffCap')
Preview @{Test=9;AllowOffCap=$true;AllowStrongerCap=$true} @('-AllowStrongerCap')
Preview @{Test=10;Module='ABOX';AllowOfflineTrial=$true;ReconnectPort='COM126'} @('-Scenario OfflineABA','-OfflineModule ABOX','-AllowOfflineTrial','-ReconnectPort COM126')
Preview @{Test=10;Module='COMBINED6';AllowOfflineTrial=$true;AllowCombined=$true} @('-OfflineModule COMBINED6','-AllowCombined')
Preview @{Test=11;Module='COMBINED5';AllowCombined=$true} @('-Scenario CombinedConnected','-CombinedProfile COMBINED5','-EnergySeconds 30')
Preview @{Test=12;Module='LITTLE949'} @('-Scenario EnergyTrials','-EnergyModules LITTLE949','-P1273Telemetry')
Reject @{Test=8;Module='USB'} 'requires -AllowFunctionalGate'
Reject @{Test=8;Module='COMBINED5';AllowFunctionalGate=$true} 'requires -AllowCombined'
Reject @{Test=9} 'requires -AllowOffCap'
Reject @{Test=10;Module='USB';AllowOfflineTrial=$true} 'explicit offline'
Reject @{Test=10;Module='ABOX'} 'requires -AllowOfflineTrial'
Reject @{Test=10;Module='COMBINED6';AllowOfflineTrial=$true} 'requires -AllowCombined'
Reject @{Test=11;Module='COMBINED5'} 'requires -AllowCombined'
Reject @{Test=12} 'requires one individual'
Reject @{Test=12;Module='PSR'} 'requires one individual'
Reject @{Test=1;AllowCombined=$true} 'requires a combined'
Reject @{Test=1;Module='USB'} 'does not accept -Module'
Reject @{Test=1;AllowOffCap=$true} 'only for Test 9'
if(Test-Path -LiteralPath (Join-Path $kit 'logs')){throw 'Preview unexpectedly wrote logs'}
Write-Host "P1273 host kit: ZIP manifest, all script parse checks and $count preview/refusal cases PASS (no serial/device)"
