#requires -Version 5.1
# Create a host-only ZIP from the exact published kernel commit.
[CmdletBinding()]
param()
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$kernel=Join-Path $root '.ioss9-p4-lab'
$commit='ee597e843386a45293f90b9800889593983bf812'
$gitCmd=Get-Command git.exe -ErrorAction SilentlyContinue
$git=if($gitCmd){$gitCmd.Source}else{'C:\Program Files\Git\cmd\git.exe'}
if(-not (Test-Path -LiteralPath $git)){throw 'Git for Windows not found'}
$files=@('s9-p125-timer-serial.ps1','s9-p12-dual-serial.ps1','s9-screen-lifecycle-serial.ps1')
# Scratch stays in workspace under .catdesk, never included in Git or ZIP.
$work=Join-Path $root ('.catdesk\p1273-kit-'+[guid]::NewGuid().ToString('N'))
$stage=Join-Path $work 'kit'
[void](New-Item -ItemType Directory -Path $stage)
$source=Join-Path $work 'pinned.zip'
& $git -C $kernel archive --format=zip "--output=$source" $commit -- @($files|ForEach-Object {"tools/$_"})
if($LASTEXITCODE){throw 'Pinned kernel commit archive failed'}
Expand-Archive -LiteralPath $source -DestinationPath (Join-Path $work 'source')
foreach($f in $files){Copy-Item -LiteralPath (Join-Path $work "source\tools\$f") -Destination $stage}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 's9-p1273-test.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $root 'docs\p1273-test.md') -Destination (Join-Path $stage 'README.md')
$names=$files+@('s9-p1273-test.ps1','README.md')
$hash=[ordered]@{}
foreach($f in $names){$hash[$f]=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage $f)).Hash}
[ordered]@{kernel_commit=$commit;files=$hash}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'SHA256SUMS.json')
$zip=Join-Path $PSScriptRoot 'p1273-host-ee597e8.zip'
Compress-Archive -LiteralPath @(($names+@('SHA256SUMS.json'))|ForEach-Object {Join-Path $stage $_}) -DestinationPath $zip -Force
$verify=Join-Path $work 'verify'
Expand-Archive -LiteralPath $zip -DestinationPath $verify
$actual=@(Get-ChildItem -LiteralPath $verify -File|Select-Object -ExpandProperty Name)
if(@(Compare-Object ($names+@('SHA256SUMS.json')) $actual).Count){throw 'ZIP contents mismatch'}
foreach($f in $names){if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $verify $f)).Hash -ne $hash[$f]){throw "ZIP verification failed: $f"}}
Write-Host "Verified ZIP: $zip"
Write-Host "SHA256 $((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash)"
Write-Host "Scratch verification directory: $work"
