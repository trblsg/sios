# User-operated publish helper. Preview is read-only; no force, no reset.
# Native validation is performed by GitHub Actions, not this Windows host.
[CmdletBinding()]
param([switch]$Publish,[switch]$AcceptNativeVerificationGap)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kernel=Join-Path $root '.ioss9-p4-lab'
$gitCmd=Get-Command git.exe -ErrorAction SilentlyContinue
$git=if($gitCmd){$gitCmd.Source}else{'C:\Program Files\Git\cmd\git.exe'}
if(-not (Test-Path -LiteralPath $git)){throw 'Git for Windows not found'}
$kernelBranch='s9/p12-4-guarded-thermal'
$installerBranch='fix/s9-p124-thermal-installer'
$kernelFiles=@(
    '.github/workflows/s9-p12-dual-tests.yml'
    'drivers/audio/abox/hakios.exynos_abox.c'
    'drivers/bluetooth/bcm4361/hakios.bcm4361_bt.c'
    'drivers/display/dpu/hakios.exynos_dpu.c'
    'drivers/gpu/mali/hakios.mali.c'
    'drivers/map'
    'drivers/power/exynos/hakios.exynos_cpufreq.c'
    'drivers/power/exynos/hakios.p125_sysctl.h'
    'drivers/power/exynos/hakios.p1273_gate.h'
    'drivers/wifi/lx/hakios.lx.c'
    'tools/s9-p12-dual-serial.ps1'
    'tools/s9-p125-timer-serial.ps1'
    'tools/tests/test-p127-contract.js'
    'tools/tests/test-p1272-gpu-cache.js'
    'tools/tests/test-p1273-contract.js'
    'tools/tests/test-s9-p1273-telemetry.ps1'
    'tools/tests/test-s9-p1273-gate.ps1'
    'tools/tests/test_s9_p1273_gate.c'
    'userland/rc.jobs'
    'userland/src/cputop.c'
    'userland/src/metal_test.m'
    'userland/src/metalvk/NativeBridgeMetalFrontend.mm'
    'userland/src/metalvk/s9_texture_layout.h'
    'userland/src/metalvk/s9_texture_layout.inc'
    'userland/tests/test_s9_texture_layout.c'
    'wifi/lx/brcmfmac/lx_cfg.c'
    'wifi/lx/brcmfmac/lx_pci.c'
    'wifi/lx/src/lx_base.c'
    'xnu/files/hakios_p125.h'
    'xnu/files/hakios_p125_impl.h'
    'xnu/p125-timer-observer.py'
    'docs/s9-p1273-implementation-status.md'
)
$installerFiles=@(
    '.github/workflows/s9-installer.yml'
    '.github/workflows/s9-p12-installer-guard-tests.yml'
    'tools/test-p1273-build-guard.mjs'
    'tools/publish-p1273.ps1'
    'docs/p1273-build.md'
)
function G([string]$Repo,[string[]]$ArgList){
    & $git -C $Repo @ArgList
    if($LASTEXITCODE -ne 0){throw "git failed ($LASTEXITCODE): $($ArgList -join ' ')"}
}
function Check-Repo([string]$Repo,[string]$Branch,[string]$Remote,[string[]]$Files){
    if((G $Repo @('branch','--show-current')) -ne $Branch){throw "Wrong branch in $Repo"}
    if((G $Repo @('remote','get-url','origin')) -ne $Remote){throw "Unexpected origin in $Repo"}
    $existing=@(G $Repo @('diff','--cached','--name-only'))
    if(@($existing | Where-Object {$_ -notin $Files}).Count){throw "Unrelated staged files in $Repo; review manually"}
    $unexpected=@(G $Repo @('diff','--name-only') | Where-Object {$_ -notin $Files})
    if($unexpected.Count){throw "Unexpected tracked modifications in $Repo : $($unexpected -join ', ')"}
    foreach($file in $Files){if(-not (Test-Path -LiteralPath (Join-Path $Repo $file) -PathType Leaf)){throw "Missing $file in $Repo"}}
    G $Repo @('diff','--check')
    Write-Host "READY FOR REVIEW $Branch; HEAD $(G $Repo @('rev-parse','--short','HEAD')); scoped files $($Files.Count)"
}
function Publish-Repo([string]$Repo,[string]$Branch,[string[]]$Files,[string]$Message){
    # Update tracked paths even when an ancestor has an ignore rule.
    $tracked=@(G $Repo @('ls-files','--') | Where-Object {$_ -in $Files})
    if($tracked.Count){G $Repo (@('add','-u','--')+$tracked)}
    $new=@($Files | Where-Object {$_ -notin $tracked})
    if($new.Count){G $Repo (@('add','--')+$new)}
    $staged=@(G $Repo @('diff','--cached','--name-only'))
    if(@($staged | Where-Object {$_ -notin $Files}).Count){throw 'Unexpected staged files; stop'}
    G $Repo @('diff','--cached','--check')
    if($staged.Count){G $Repo @('commit','-m',$Message)}
    G $Repo @('push','origin',$Branch)
    Write-Host "PUBLISHED $Branch at $(G $Repo @('rev-parse','HEAD'))"
}
Check-Repo $kernel $kernelBranch 'https://github.com/trblsg/s-kernel.git' $kernelFiles
Check-Repo $root $installerBranch 'https://github.com/trblsg/sios.git' $installerFiles
if(-not $Publish){
    Write-Host 'PREVIEW ONLY: no staging, commit, push or build. Native build/hardware validation outstanding.'
    return
}
if(-not $AcceptNativeVerificationGap){throw 'Publishing requires explicit -AcceptNativeVerificationGap (native CI not yet run).'}
# Re-run the targeted local checks before touching Git.
Push-Location $root
try {
    $env:BASH_PATH=Join-Path (Split-Path (Split-Path $git -Parent) -Parent) 'bin\bash.exe'
    node tools/test-p1273-build-guard.mjs
    if($LASTEXITCODE){throw 'Installer guard tests failed'}
} finally {Pop-Location}
Push-Location $kernel
try {
    foreach($test in @('test-p125-pinned-anchors.js','test-p1273-contract.js')){
        node "tools/tests/$test"
        if($LASTEXITCODE){throw "Failed $test"}
    }
    foreach($test in @('test-s9-p1273-gate.ps1','test-s9-p1273-telemetry.ps1')){
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools/tests/$test"
        if($LASTEXITCODE){throw "Failed $test"}
    }
} finally {Pop-Location}
Publish-Repo $kernel $kernelBranch $kernelFiles 's9: integrate P12.7.3 thermal recorder and qualified energy lab'
Publish-Repo $root $installerBranch $installerFiles 's9-installer: require paired P12.7.3 lab and clean boot baseline'
Write-Host 'Source published; check Actions native CI before flashing. No firmware built or flashed by this script.'
