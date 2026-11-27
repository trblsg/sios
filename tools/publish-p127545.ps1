#requires -Version 5.1
# USER-OPERATED publication from the two explicit baseline commits.
# Default is a read-only preview. No workflow_dispatch or device I/O.
[CmdletBinding()]
param([switch]$Publish,[switch]$AcceptNativeVerificationGap)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kernel=Join-Path $root '.ioss9-p4-lab'
$gc=Get-Command git.exe -ErrorAction SilentlyContinue
$git=if($gc){$gc.Source}else{'C:\Program Files\Git\cmd\git.exe'}
if(-not (Test-Path -LiteralPath $git)){throw 'Git for Windows not found'}
$env:PATH=(Split-Path $git -Parent)+';'+$env:PATH
$env:BASH_PATH=Join-Path (Split-Path (Split-Path $git -Parent) -Parent) 'bin\bash.exe'
$kb='s9/p12-4-guarded-thermal'
$ib='fix/s9-p124-thermal-installer'
$kbase='47faf7d0f76352fd2d5eefc400a163c49037d881'
$ibase='b26320799a46100822871191966591e37b2774d4'
$kernelFiles=@(
    '.github/workflows/check.yml'
    '.gitignore'
    'configs/boot-args.lst'
    'configs/symbols.tsv'
    'docs/boot-args.md'
    'drivers/bluetooth/bcm4361/hakios.bcm4361_bt.c'
    'drivers/camera/exynos/hakios.exynos_camera.c'
    'drivers/core/hakios.stubs.c'
    'drivers/display/dpu/hakios.exynos_dpu.c'
    'drivers/display/panel/hakios.s6e3ha8.c'
    'drivers/gpu/mali/hakios.mali.c'
    'drivers/map'
    'drivers/media/mfc/hakios.exynos_mfc.c'
    'drivers/power/exynos/hakios.p125_sysctl.h'
    'drivers/power/exynos/hakios.p12753.h'
    'drivers/soc/exynos/hakios.exynos_acpm.c'
    'tools/drivers-check.py'
    'tools/s9-p12-dual-serial.ps1'
    'tools/s9-p125-timer-serial.ps1'
    'tools/tests/test-p127-contract.js'
    'tools/tests/test-p12753-contract.js'
    'tools/tests/test-p12754-contract.js'
    'tools/tests/test-s9-p12753-serial.ps1'
    'tools/tests/test-s9-p12754-serial.ps1'
    'wifi/lx/brcmfmac/lx_pci.c'
    'xnu/files/GenericARMPE.cpp'
    'xnuloader/loader.c'
    'xnuloader/platform.h'
    'xnuloader/platforms/star2lte.c'
    'xnuloader/platforms/starlte.c'
    'docs/s9-p127545-implementation-status.md'
    'drivers/bluetooth/bcm4361/hakios.p127545_hci.h'
    'drivers/display/hakios.p127545_disp_access.h'
    'drivers/soc/exynos/hakios.p127545_cmu.h'
    'drivers/soc/exynos/hakios.p127545_disp.h'
    'drivers/soc/exynos/hakios.p127545_ect.h'
    'drivers/soc/exynos/hakios.p127545_ect_abi.h'
    'drivers/soc/exynos/hakios.p127545_int_bounds.h'
    'tools/p127545-ect.py'
    'tools/tests/test-p127545-contract.js'
    'tools/tests/test_p127545_ect.py'
    'tools/tests/test_s9_p127545_witness.c'
    'xnuloader/p127545_ect.h'
)
$installerFiles=@(
    '.github/workflows/s9-installer.yml'
    'tools/test-p1273-build-guard.mjs'
    'tools/package-p127545-host.ps1'
    'tools/publish-p127545.ps1'
    'docs/p127545-test.md'
)
$lockPath='tools/p127545-kernel.sha'
function G([string]$Repo,[string[]]$ArgList){
    & $git -C $Repo @ArgList
    if($LASTEXITCODE){throw "Git failed ($LASTEXITCODE): $Repo / $($ArgList -join ' ')"}
}
function RemoteHead([string]$Repo,[string]$Branch){
    $rows=@(G $Repo @('ls-remote','--heads','origin',"refs/heads/$Branch"))
    if($rows.Count -eq 0){return ''}
    if($rows.Count -ne 1 -or $rows[0] -notmatch '^([0-9a-f]{40})\s+refs/heads/'){throw "Unexpected remote response for $Branch"}
    return $Matches[1]
}
function Preflight([string]$Repo,[string]$Branch,[string]$Base,[string]$Remote,[string[]]$Files){
    $top=G $Repo @('rev-parse','--show-toplevel')
    if((Resolve-Path $top).Path -ne (Resolve-Path $Repo).Path){throw "Not repository root: $Repo"}
    if((G $Repo @('branch','--show-current')) -ne $Branch){throw "Wrong branch: $Repo"}
    if((G $Repo @('remote','get-url','origin')) -ne $Remote){throw "Wrong origin: $Repo"}
    if((G $Repo @('rev-parse','HEAD')) -ne $Base -or (RemoteHead $Repo $Branch) -ne $Base){throw "Baseline changed; stop and reconcile $Branch"}
    if(@(G $Repo @('diff','--cached','--name-only')).Count){throw "Pre-existing staged files: $Repo"}
    $changed=@(G $Repo @('diff','--name-only'))
    if(@($changed|Where-Object {$_ -notin $Files}).Count){throw "Unrelated tracked edits: $Repo"}
    $untracked=@(G $Repo @('ls-files','--others','--exclude-standard','--') | Where-Object {$_ -in $Files})
    $delta=@($changed+$untracked)
    if(@(Compare-Object $Files $delta).Count){throw "Planned source set differs from actual edits: $Repo"}
    foreach($f in $Files){if(-not (Test-Path -LiteralPath (Join-Path $Repo $f) -PathType Leaf)){throw "Missing $f"}}
    G $Repo @('log','--oneline','-n','5') | Write-Host
    Write-Host "Scoped $Branch : $($Files.Count) files; exact base $Base, remote matched"
}
function Check-Stage([string]$Repo,[string[]]$Files){
    $staged=@(G $Repo @('diff','--cached','--name-only'))
    if(@(Compare-Object $Files $staged).Count){throw "Stage mismatch: $Repo"}
    G $Repo @('diff','--cached','--check','--','.',':!configs/symbols.tsv')
    if($Repo -eq $kernel){G $Repo @('-c','core.whitespace=-blank-at-eol','diff','--cached','--check','--','configs/symbols.tsv')}
}
Preflight $kernel $kb $kbase 'https://github.com/trblsg/s-kernel.git' $kernelFiles
Preflight $root $ib $ibase 'https://github.com/trblsg/sios.git' $installerFiles
if(Test-Path -LiteralPath (Join-Path $root $lockPath)){throw 'Existing lock; stop and reconcile previous publication'}
if(-not $Publish){
    Write-Host 'PREVIEW ONLY: no staging, commits, push, ZIP or Action.'
    Write-Host 'Use -Publish -AcceptNativeVerificationGap to publish the source candidate, then run the Action manually.'
    return
}
if(-not $AcceptNativeVerificationGap){throw 'Explicit -AcceptNativeVerificationGap required: full XNU and device are not verified'}
$py=(Resolve-Path (Join-Path $kernel '.p545-tools\python\python.exe')).Path
$zig=(Resolve-Path (Join-Path $kernel '.p545-tools\zig-x86_64-windows-0.14.1\zig.exe')).Path
$scratch=Join-Path $root ('.catdesk\p127545-publish-'+[guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $scratch)
Push-Location $root
try{
    node tools/test-p1273-build-guard.mjs
    if($LASTEXITCODE){throw 'Installer guard failed'}
}finally{Pop-Location}
Push-Location $kernel
try{
    foreach($test in @('test-p127-contract.js','test-p1273-contract.js','test-p12753-contract.js','test-p12754-contract.js','test-p127545-contract.js')){
        node "tools/tests/$test"
        if($LASTEXITCODE){throw "Failed $test"}
    }
    foreach($test in @('test-s9-p12753-serial.ps1','test-s9-p12754-serial.ps1','test-s9-p12-dual-serial.ps1','test-s9-p9-power-fix.ps1')){
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools/tests/$test"
        if($LASTEXITCODE){throw "Failed $test"}
    }
    & $py tools/tests/test_p127545_ect.py
    if($LASTEXITCODE){throw 'ECT fixtures failed'}
    & $py tools/drivers-check.py
    if($LASTEXITCODE){throw 'Driver map failed'}
    $witness=Join-Path $scratch 'witness.exe'
    & $zig cc -std=c11 -Wall -Wextra -Werror tools/tests/test_s9_p127545_witness.c -o $witness
    if($LASTEXITCODE){throw 'Witness compilation failed'}
    & $witness
    if($LASTEXITCODE){throw 'Witness failed'}
}finally{Pop-Location}
# Recheck all scopes and remote bases after tests, before actual writes.
Preflight $kernel $kb $kbase 'https://github.com/trblsg/s-kernel.git' $kernelFiles
Preflight $root $ib $ibase 'https://github.com/trblsg/sios.git' $installerFiles
G $kernel (@('add','--')+$kernelFiles)
G $kernel @('update-index','--chmod=+x','tools/p127545-ect.py')
Check-Stage $kernel $kernelFiles
Push-Location $kernel
try{
    & $py tools/boot-args.py --check
    if($LASTEXITCODE){throw 'Generated boot args stale'}
    & $py tools/provenance-check.py
    if($LASTEXITCODE){throw 'Provenance check failed'}
}finally{Pop-Location}
G $kernel @('commit','-m','P127545: integrate guarded display, QCH and idle revision 6')
$kc=G $kernel @('rev-parse','HEAD')
if($kc -notmatch '^[0-9a-f]{40}$'){throw 'Missing kernel commit'}
Write-Host "LOCAL KERNEL $kc"
[IO.File]::WriteAllText((Join-Path $root $lockPath),"$kc`n",[Text.Encoding]::ASCII)
$installerFiles+=@($lockPath)
G $root (@('add','--')+$installerFiles)
Check-Stage $root $installerFiles
G $root @('commit','-m','P127545: pair revision 6 installer and exact source lock')
$ic=G $root @('rev-parse','HEAD')
if($ic -notmatch '^[0-9a-f]{40}$'){throw 'Missing installer commit'}
Write-Host "LOCAL INSTALLER $ic"
& (Join-Path $PSScriptRoot 'package-p127545-host.ps1') -KernelCommit $kc -InstallerCommit $ic
$zipName='p127545-host-'+$kc.Substring(0,7)+'-'+$ic.Substring(0,7)+'.zip'
$zip=Join-Path $PSScriptRoot $zipName
if(-not (Test-Path -LiteralPath $zip)){throw 'Verified ZIP missing'}
$zipHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
$zipBytes=(Get-Item -LiteralPath $zip).Length
# Separate publication branch so adding the ZIP does not change the exact
# installer commit embedded in it. Worktree is isolated from the dirty logs.
$kitBranch='p127545-host-'+$kc.Substring(0,7)+'-'+$ic.Substring(0,7)
if(RemoteHead $root $kitBranch){throw 'Host publication branch already exists; no overwrite'}
$kitTree=Join-Path $scratch 'kit-worktree'
G $root @('worktree','add','--detach',$kitTree,$ic)
$kitRel="tools/$zipName"
Copy-Item -LiteralPath $zip -Destination (Join-Path $kitTree $kitRel)
G $kitTree @('add','--',$kitRel)
Check-Stage $kitTree @($kitRel)
G $kitTree @('commit','-m','P127545: publish exact paired revision 6 host kit')
$zc=G $kitTree @('rev-parse','HEAD')
if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $kitTree $kitRel)).Hash -ne $zipHash){throw 'Kit worktree hash mismatch'}
# All three commits and the kit are ready locally. Non-force pushes only.
G $kernel @('push','origin',$kb)
if((RemoteHead $kernel $kb) -ne $kc){throw 'Kernel remote mismatch'}
G $root @('push','origin',$ib)
if((RemoteHead $root $ib) -ne $ic){throw 'Installer remote mismatch'}
G $kitTree @('push','origin',"HEAD:refs/heads/$kitBranch")
if((RemoteHead $root $kitBranch) -ne $zc){throw 'Host publication remote mismatch'}
$hostUrl="https://raw.githubusercontent.com/trblsg/sios/$zc/$kitRel"
$guideUrl="https://github.com/trblsg/sios/blob/$ic/docs/p127545-test.md"
# Download published bytes and compare the actual SHA, not just a local file.
$download=Join-Path $scratch 'published.zip'
Invoke-WebRequest -UseBasicParsing -Uri $hostUrl -OutFile $download
if((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash -ne $zipHash){throw 'Published ZIP hash mismatch'}
$receipt=[ordered]@{revision=6;status='SOURCE_PUBLISHED_NATIVE_ACTION_PENDING';kernel_branch=$kb;kernel_commit=$kc;installer_branch=$ib;installer_commit=$ic;host_branch=$kitBranch;host_commit=$zc;zip=$zipName;bytes=$zipBytes;sha256=$zipHash;url=$hostUrl;guide=$guideUrl}
$receipt|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 -LiteralPath (Join-Path $root '.catdesk\p127545-publication.json')
$receipt|ConvertTo-Json -Depth 4|Write-Host
Write-Host 'SOURCE PUBLISHED; native XNU/installer and hardware pending. You may now run s9-installer manually. Do not flash before successful paired build.'
Write-Host "Scratch worktree retained at $kitTree"
