#requires -Version 5.1
# Build host-only kit from exact committed revisions, never from dirty files.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$KernelCommit,
 [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$InstallerCommit
)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kernel=Join-Path $root '.ioss9-p4-lab'
$gc=Get-Command git.exe -ErrorAction SilentlyContinue
$git=if($gc){$gc.Source}else{'C:\Program Files\Git\cmd\git.exe'}
$rev=& $git -C $kernel show "$($KernelCommit):drivers/power/exynos/hakios.p12753.h"
if($LASTEXITCODE -or -not ($rev -match 'p12754_revision=6')){throw 'Requires exact revision 6 kernel commit'}
$wf=& $git -C $root show "$($InstallerCommit):.github/workflows/s9-installer.yml"
if($LASTEXITCODE -or -not ($wf -match 'P1278 linked kernel missing')){throw 'Requires paired Rev8 installer commit'}
$rev7=& $git -C $kernel show "$($KernelCommit):drivers/power/exynos/hakios.p1277_idle.h"
if($LASTEXITCODE -or -not ($rev7 -match 'p1278_revision')){throw 'Requires exact Rev8 kernel commit'}
$lock=& $git -C $root show "$($InstallerCommit):tools/p1278-kernel.sha"
if($LASTEXITCODE -or ($lock -join '').Trim() -cne $KernelCommit){throw 'Installer source lock does not match exact kernel commit'}
$files=@('s9-p1274-serial.ps1','s9-p125-timer-serial.ps1','s9-p12-dual-serial.ps1','s9-screen-lifecycle-serial.ps1','s9-p127541-background.ps1','p127545-ect.py','s9-p1277-report.ps1','s9-p1277-suite-lib.ps1','s9-p1278-suite-lib.ps1')
$work=Join-Path $root ('.catdesk\p1278-kit-'+[guid]::NewGuid().ToString('N'))
$stage=Join-Path $work 'kit'
[void](New-Item -ItemType Directory -Path $stage)
$src=Join-Path $work 'kernel.zip'
$ins=Join-Path $work 'installer.zip'
& $git -C $kernel archive --format=zip "--output=$src" $KernelCommit -- @($files|ForEach-Object {"tools/$_"})
if($LASTEXITCODE){throw 'Pinned kernel archive failed'}
& $git -C $root archive --format=zip "--output=$ins" $InstallerCommit -- docs/p1278-test.md
if($LASTEXITCODE){throw 'Pinned installer guide archive failed'}
Expand-Archive -LiteralPath $src -DestinationPath (Join-Path $work 'kernel')
Expand-Archive -LiteralPath $ins -DestinationPath (Join-Path $work 'installer')
foreach($f in $files){Copy-Item -LiteralPath (Join-Path $work "kernel\tools\$f") -Destination $stage}
Copy-Item -LiteralPath (Join-Path $work 'installer\docs\p1278-test.md') -Destination (Join-Path $stage 'README.md')
$names=$files+@('README.md')
$hash=[ordered]@{}
foreach($f in $names){$hash[$f]=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage $f)).Hash}
[ordered]@{revision=8;p12754_revision=6;p1277_revision=7;p1278_revision=8;kernel_commit=$KernelCommit;installer_commit=$InstallerCommit;files=$hash}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'SHA256SUMS.json')
$candidate=Join-Path $work 'candidate.zip'
Compress-Archive -LiteralPath @(($names+@('SHA256SUMS.json'))|ForEach-Object {Join-Path $stage $_}) -DestinationPath $candidate
$verify=Join-Path $work 'verify'
Expand-Archive -LiteralPath $candidate -DestinationPath $verify
if(@(Compare-Object ($names+@('SHA256SUMS.json')) @(Get-ChildItem -LiteralPath $verify -Force -Name)).Count){throw 'ZIP contents mismatch'}
foreach($f in $names){if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $verify $f)).Hash -ne $hash[$f]){throw "ZIP verification failed: $f"}}
Push-Location $verify
try{
    $cases=@(
        @{s='Rev8Status';a=@()}
        @{s='Rev8Suite';a=@()}
        @{s='Rev7Status';a=@()}
        @{s='Guard53';a=@()}
        @{s='FunctionalGate';a=@('-GateModule','LITTLE949','-AllowFunctionalGate')}
        @{s='FunctionalGate';a=@('-GateModule','LITTLE598','-AllowFunctionalGate','-AllowLowerFloor','-ConnectedFloorReport','prior.floor543-qualified.json')}
        @{s='FunctionalGate';a=@('-GateModule','ABOX','-AllowFunctionalGate','-HeadlessAudio')}
        @{s='Audit53';a=@('-Audit53Module','STOCK60','-WarmAudit','-LongWait545','-AllowOfflineTrial')}
        @{s='Audit53';a=@('-Audit53Module','COMPOSITE69','-WarmAudit','-LongWait545','-AllowOfflineTrial','-AllowComposite545')}
        @{s='Mfc545Probe';a=@('-AllowMfc545')}
        @{s='Cam545Probe';a=@('-AllowCam545')}
        @{s='Disp545Probe';a=@('-AllowDisp545','-Disp545KHz','200000')}
        @{s='Panel545';a=@('-AllowPanel545','-PanelCycles','3')}
        @{s='Audit53';a=@('-Audit53Module','MFCQCH','-WarmAudit','-AllowOfflineTrial','-AllowMfc545')}
        @{s='Audit53';a=@('-Audit53Module','ISPPREQCH','-WarmAudit','-AllowOfflineTrial','-AllowCam545')}
        @{s='Audit53';a=@('-Audit53Module','DISP400','-WarmAudit','-AllowOfflineTrial','-AllowDisp545')}
        @{s='Audit53';a=@('-Audit53Module','DISP200','-WarmAudit','-AllowOfflineTrial','-AllowDisp545')}
        @{s='Audit53';a=@('-Audit53Module','DISP134','-WarmAudit','-AllowOfflineTrial','-AllowDisp545')}
    )
    foreach($case in $cases){
        $extra=$case.a
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $verify 's9-p125-timer-serial.ps1') -P12754 -Scenario $case.s @extra
        if($LASTEXITCODE){throw "ZIP preview failed: $($case.s) $extra"}
    }
    if(@(Compare-Object ($names+@('SHA256SUMS.json')) @(Get-ChildItem -Force -Name)).Count){throw 'Preview created files'}
}finally{Pop-Location}
$zip=Join-Path $PSScriptRoot ('p1278-host-'+$KernelCommit.Substring(0,7)+'-'+$InstallerCommit.Substring(0,7)+'.zip')
if(Test-Path -LiteralPath $zip){throw 'Refuse overwrite; verify existing kit or remove it explicitly'}
Copy-Item -LiteralPath $candidate -Destination $zip
if((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash){throw 'Final copy hash mismatch'}
Write-Host "Verified host-only ZIP: $zip"
Write-Host "Bytes $((Get-Item -LiteralPath $zip).Length)"
Write-Host "SHA256 $((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash)"
Write-Host 'Packaging is not native CI success, remote publication or device qualification. Check exact build manifest before flash.'
