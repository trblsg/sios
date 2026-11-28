# Host only. Fake clock/transport, never touches a real COM.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'p1277-host-auto-v2/s9-p125-timer-serial.ps1') -LibraryOnly -P12754 -Scenario Rev7Suite -Execute
function Assert($ok,[string]$msg){if(-not $ok){throw $msg}}
function Refuse([scriptblock]$Action,[string]$Pattern){$ok=$false;try{& $Action}catch{if($_.Exception.Message -match $Pattern){$ok=$true}else{throw}};Assert $ok "expected refusal: $Pattern"}
Assert (P12-ReplyShape 'p1277_active' '1' $true) 'binary readback'
Assert (-not (P12-ReplyShape 'p1277_active' '2' $true)) 'binary shape rejects 2'
Refuse {P12-Query 'p1277_active' '2'} 'only permits'
Refuse {P12-Query 'p1277_layer2' '5'} 'only permits'
Refuse {P12-Query 'p1277_psci_stats' '1'} 'only permits'
Refuse {P12-Query 'p1277_active' '1' -Cleanup} 'Cleanup bypass'
$script:P1277SuiteAllowed=$false
Refuse {P12-Query 'p1277_active' '1'} 'disallowed'
$script:P1277SuiteAllowed=$true
$script:now=[datetime]::UtcNow
function Life-Now{$script:now=$script:now.AddMilliseconds(50);return $script:now}
function Life-Say($x){}
function Life-Pump{$script:now=$script:now.AddMilliseconds(100)}
function Life-CheckSafety($x){}
function P12-EarlyThermalGuard{}
function P127542-ReadKey{return $null}
function P12754-Require{}
function P1273-GateStatus{return @{phase='0'}}
$script:LifeState='ON'
$script:boot='version=1 nonce=0123456789abcdef'
$script:temp=59000;$script:lit=58000;$script:gpu=59000;$script:bat=36;$script:age=100
$script:writes=[Collections.Generic.List[string]]::new()
$script:controls=@{p1277_auto_idle='0';p1277_panel='0';p1277_active='0';p1277_gpu_dvs='0';p1277_g2='0';mali_irq='0';p127542_g2='0'}
$script:sl=0;$script:lat=0;$script:high=0;$script:rebase=0;$script:rejectReview=$false;$script:uncertain=$false
$script:l2=0;$script:l2Result=1;$script:burst=0;$script:trace=0;$script:traceDumps=0;$script:legacy=[Collections.Generic.List[string]]::new()
function P77-Display([string]$State,[int]$Seconds=20){
    if($script:LifeState -eq $State){return}
    $script:LifeState=$State
    if($script:controls.p1277_panel -eq '1'){if($State -eq 'OFF'){$script:sl++}else{$script:lat++}}
    if($script:controls.p1277_gpu_dvs -eq '1'){if($State -eq 'OFF'){$script:high++}else{$script:high++;$script:rebase++}}
}
function P77-Review([string]$Message,[int]$Seconds=15){Assert ($script:LifeState -eq 'ON') 'review OFF';if($script:rejectReview -and $Message -like '*touch/scroll*'){throw 'simulated operator rejected'}}
function P77-Wait([int]$Seconds,[string]$State){Assert ($script:LifeState -eq $State) 'wait state';[void](P77-Guard);$script:now=$script:now.AddSeconds($Seconds)}
function P1273-TraceDump($Stem){$script:traceDumps++}
function P127545-MfcProbe($Stem){Assert $script:P127545MfcProbeAllowed 'MFC permission';Assert $script:P12753ArmAllowed 'MFC arm';$script:legacy.Add('MFC')}
function P127545-CamProbe($Stem){Assert $script:P127545CamProbeAllowed 'Camera permission';$script:legacy.Add('Camera')}
function P127545-DispProbe($Stem){Assert $script:P127545DispProbeAllowed 'DISP permission';$script:legacy.Add("DISP$Disp545KHz")}
function P1273-FunctionalGate($Stem){Assert ($GateModule -eq 'ABOX' -and $HeadlessAudio -and $AllowFunctionalGate) 'ABOX options';$script:legacy.Add('Audio')}
function P12-Query([string]$Name,[string]$Value='',[switch]$Cleanup){
    if($Value -ne ''){
        if($Name -eq 'p1277_layer2'){Assert ($script:controls.p1277_auto_idle -eq '1') 'layer2 requires parent';$script:l2=[int]$Value;return $Value}
        if($Name -eq 'p1277_burst_trace'){Assert ($script:controls.p1277_auto_idle -eq '1') 'burst requires parent';$script:burst=[int]$Value;$script:trace=4;return $Value}
        if($Name -eq 'p1277_auto_idle' -and $Value -eq '1'){Assert ($script:LifeState -eq 'OFF') 'Auto Idle must arm after display OFF'}
        Assert ($script:controls.ContainsKey($Name)) "unexpected write $Name"
        $script:writes.Add("$Name=$Value");$script:controls[$Name]=$Value
        return $Value
    }
    if($script:controls.ContainsKey($Name)){return $script:controls[$Name]}
    $on=$script:LifeState -eq 'ON';$enabled=$script:controls.p1277_auto_idle -eq '1'
    $active=$enabled -and -not $on
    $panel=$script:controls.p1277_panel -eq '1'
    $dvs=$script:controls.p1277_gpu_dvs -eq '1'
    $mode=if($active){69}else{0};$lease=if($active){123456}else{0};$floor=if($active){598000}else{1053000}
    switch($Name){
        p1273_boot_identity{return $script:boot}
        p1277_revision{return '7'}
        p12754_revision{return '6'}
        p12753_guard{return "version=1 enabled=1 at=1 mask=0 big=$script:temp lit=$script:lit gpu=$script:gpu bat=$script:bat age=$script:age slope=0 bcap=0 lcap=0 peak_big=59000 peak_lit=58000 changes=0"}
        p1277_auto_stats{return "version=1 permission=1 enabled=$([int]$enabled) state=$(if($active){4}else{3}) stage=5 samples=2 retries=0 abox_driver_ok=1 fault=0 last_uv=637500 last_mhz=598 last_reason=0 own_lease=$lease live_mode=$mode ufs_safe=1 interactive_qualification=0"}
        p127_status{return "mode=$mode ufs_safe=1 little_cur=$floor"}
        p126_status{return 'mode=0'}
        p12753_status{return 'state=0'}
        p1277_panel_stats{return "version=1 permission=1 request=$([int]$panel) persistent=$([int]$panel) failed=0 asleep=$([int]($panel -and -not $on)) pending=0 sleep=$script:sl latch29=$script:lat fallback=0 fault=0 sleep_verified=$([int]($panel -and -not $on)) wake_uncertain=$([int]$script:uncertain)"}
        p1277_gpu_dvs_stats{return "version=1 permission=1 active=$([int]$dvs) failed=0 high=$script:high rebase=$script:rebase last_configured_vsel=88 fault=0"}
        p1277_layer2_stats{return "state=0 request=0 module=$script:l2 result=$script:l2Result restored=1 samples=20"}
        p1277_burst_stats{return "request=0 owned=$script:burst trace_state=$script:trace observed_trigger=$(if($script:trace){123}else{0})"}
        p1277_psci_stats{return 'done=0'}
        p12754_rate{return 'fresh=1 cur=1053000'}
        g3d_lab_stats{return 'domain=0 pll=0 fault=0'}
        default{throw "unexpected read $Name"}
    }
}
$root=Join-Path $PSScriptRoot ('p1277-host-auto-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$Rev7Modules=@('AutoIdle','Panel','Active','IRQ','DVS','G2')
P1277-RunSuite (Join-Path $root 'full')
$r=Get-Content -Raw (Join-Path $root 'full.rev7-suite.json')|ConvertFrom-Json
Assert ($r.result -eq 'complete' -and $r.cleanup -eq 'verified' -and -not $r.power_verified) 'suite result'
Assert ($script:writes.Count -eq 12) 'six exact enable/disable pairs'
Assert ($script:controls.Values -notcontains '1') 'no leaked controls'
Assert ($script:sl -eq 3 -and $script:lat -eq 3) 'three actual mock panel transitions'
Assert ($script:rebase -eq 3) 'three actual mock DVS wakes'
$Rev7Modules=@('Audio','MFC','DISP200','DISP134','Camera','Layer2MFC','Layer2Cam','Layer2Disp200','Layer2Disp134','Burst')
P1277-RunSuite (Join-Path $root 'extended')
$r=Get-Content -Raw (Join-Path $root 'extended.rev7-suite.json')|ConvertFrom-Json
Assert ($r.result -eq 'complete' -and $r.cleanup -eq 'verified') 'extended suite result'
Assert (($script:legacy -join ',') -eq 'Audio,MFC,DISP200000,DISP134000,Camera') 'legacy order'
Assert ($script:traceDumps -eq 1) 'frozen trace dump'
Assert ($script:controls.Values -notcontains '1') 'no leaked extended parent'
$script:l2Result=3;$Rev7Modules=@('Layer2MFC');$script:writes.Clear()
Refuse {P1277-RunSuite (Join-Path $root 'layer2-refuse')} 'Layer2 refused'
Assert ($script:controls.p1277_auto_idle -eq '0') 'layer2 refusal cancels parent'
$script:l2Result=1
$Rev7Modules=@('AutoIdle');$script:rejectReview=$true;$script:writes.Clear()
Refuse {P1277-RunSuite (Join-Path $root 'abort')} 'simulated operator rejected'
Assert ($script:controls.p1277_auto_idle -eq '0' -and $script:writes.Count -eq 2) 'abort rolls back'
$script:rejectReview=$false;$script:writes.Clear();$script:temp=68000
Refuse {P1277-RunSuite (Join-Path $root 'hot')} 'thermal stop'
Assert ($script:writes.Count -eq 0) 'hot refuses all writes'
# Reproduce the user-visible admission bug: all three warm thresholds
# exceeded but the actual Rev7 ceilings are not reached. No old cold gate.
$script:temp=64000;$script:lit=63000;$script:gpu=65000
$script:writes.Clear();$Rev7Modules=@('AutoIdle','Panel','Active')
P1277-RunSuite (Join-Path $root 'warm-connected')
$r=Get-Content -Raw (Join-Path $root 'warm-connected.rev7-suite.json')|ConvertFrom-Json
Assert ($r.result -eq 'complete' -and $r.host_revision -eq 'auto2' -and $script:writes.Count -eq 6) 'warm connected suite permitted and restored'
Assert ($script:controls.Values -notcontains '1') 'warm suite no leaked controls'
$script:writes.Clear()
Refuse {P77-Guard -Cold} 'cold pilot requires'
Assert ($script:writes.Count -eq 0) 'cold pilot safety unchanged'
# Exact kernel stop boundaries, independent sensors, fresh evidence.
$Rev7Modules=@('AutoIdle')
foreach($case in @(@{b=67000;l=63000;g=65000;bat=36;age=100},@{b=64000;l=66000;g=65000;bat=36;age=100},@{b=64000;l=63000;g=68000;bat=36;age=100},@{b=64000;l=63000;g=65000;bat=45;age=100},@{b=64000;l=63000;g=65000;bat=36;age=2001})){
    $script:temp=$case.b;$script:lit=$case.l;$script:gpu=$case.g;$script:bat=$case.bat;$script:age=$case.age
    $id="boundary-$($case.b)-$($case.l)-$($case.g)-$($case.bat)-$($case.age)"
    Refuse {P1277-RunSuite (Join-Path $root $id)} 'observed BIG='
    Assert ($script:writes.Count -eq 0) "no writes at $id"
    $report=Get-Content -Raw (Join-Path $root "$id.rev7-suite.json")|ConvertFrom-Json
    Assert (@($report.events|Where-Object step -eq 'thermal_stop').Count -eq 1) 'actual guard recorded'
}
$script:temp=59000;$script:lit=58000;$script:gpu=59000;$script:bat=36;$script:age=100
$script:P77Dirty='p1277_active';$script:P77Boot='version=1 nonce=1111111111111111'
Refuse {P77-Disable} 'identity changed'
Assert ($script:writes.Count -eq 0) 'wrong boot no cleanup write'
$script:P77Boot=$script:boot;$script:P77Dirty='p1277_panel';$script:LifeState='OFF';$script:controls.p1277_panel='1'
Refuse {P77-Disable} 'asleep/uncertain'
Assert ($script:writes.Count -eq 0) 'asleep panel no disarm'
Write-Output "Rev7 host suite mocked core/extended/warm connected suite, exact thermal boundaries, cold pilot refusal, layer2 refusal, burst dump, rollback, boot mismatch, asleep panel PASS; fixture outputs $root"
