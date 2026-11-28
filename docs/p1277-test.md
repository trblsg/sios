# P1277 Rev7 — native CI candidate for S9 starlte

**Not flash-ready until the user's integrated Action succeeds, exact source manifest matches, and review finds no unresolved native errors.** No device or energy qualification yet. Keep the Rev6 installer for recovery. This is the same P12754 audit ABI (6) plus P1277 revision 7.

## Build once

Workflow: https://github.com/trblsg/sios/actions/workflows/s9-installer.yml
Dispatch NEW run (not rerun old SHA).
- Use workflow from branch: fix/s9-p1277-installer
- kernel_ref: s9/p12-4-guarded-thermal-rev7
- packaging_ref: main
- partition: SYSTEM
- metal=true, fps=true, tweaks=true, time_limit=0, userdata_blocks=starlte=13917184
- Preserve CONFIG_MFC=5, CONFIG_MFC_IRQ=1, CONFIG_CAM_S9=7, CONFIG_CAM=5.

Boot args (single line, 258/280 bytes with automatic extras):
```text
hi=2 panel=1 p122=1 p12_gpu_boot_auto=1 mali_gov=1 mali_gov_frame=450 mali_probe=1 p3power=1 max77705_fg_s=10 p1273=1 p1274=1 p1275=1 p12751=1 p12752=1 p12753=1 p12754=1 p127545_qch=1 p127545_disp=1 p127545_ect=1 p1277=1
```
The compact flag grants runtime permissions; all new optimization requests OFF at baseline. Optional p1277_psci=1 (271/280 bytes) invokes one read-only SMC query; excluded from recommended first boot because conduit/resume evidence is unresolved. No CPU_OFF/SUSPEND, MIF/INT SET or LITTLE455. No other Rev7 boot-time optimization flags. The kernel branch must resolve to tools/p1277-kernel.sha. Existing Rev6 lock is unchanged.

Check native kernel/userland/loader build, P1277 preflight, staged header and linked marker checks, installer artifact; extract SOURCE-MANIFEST.json inside encrypted archive and compare both full commits and p12754_revision=6 / p1277_revision=7 against SHA256SUMS.json from matched host kit. The installer formats USERDATA (backup first). Do not flash a failed native build or mismatched package.

## Initial bring-up (only after build/review)

Close PuTTY and every other COM reader. Extract matched kit to a new directory, verify file hashes, run PowerShell with actual port:
```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
[IO.Ports.SerialPort]::GetPortNames()
$port='COM125'
$s='.\s9-p125-timer-serial.ps1'
& $s -Port $port -P12754 -Scenario Rev7Status -Execute
```
Expect revision=7; boot identity unchanged; p1277_auto_stats enabled=0 own_lease=0 fault=0; panel request=0 pending=0; DVS active=0; layer2 state=0. Missing telemetry is unavailable, not pass. Send complete log and rev7-status.json. Normal touch, scroll, screen OFF/ON, audio and camera first without optimization. Keep USB attached for initial qualification. Do not run two serial readers simultaneously. Touch once after boot and cool before every test.

## Runtime pilots — separate, not all enabled at once

Use actual serial console sysctl (not host PowerShell command); close serial reader before launching scripts. Check status before and after each. A successful syscall means request accepted, NOT actual applied/qualified/power proof. Never force an EBUSY/EPERM/EIO; record and stop. Run legacy qualification with all Rev7 runtime requests disabled and own_lease=0.

1. Auto Idle: on cool screen ON, `sysctl kern.hakios.p1277_auto_idle=1`; OFF, connected, wait until status stage=5/state=4 or stop on thermal/fault. Requires real touch seen, UFS safe, quiet, exact table and rail. First wake, verify UI/audio; disable via `sysctl kern.hakios.p1277_auto_idle=0`; wait own_lease=0 and stock restore, fault=0. Driver ABOX stop/resume alone is not audible proof; qualify audio separately.
2. Panel: awake and normal, `sysctl kern.hakios.p1277_panel=1`; exercise 3 OFF/ON cycles, visually check fresh content and no tearing. Expect sleep and latch29 increments, pending=0 after wake, fallback/fault/wake_uncertain=0. Disable only awake via `sysctl kern.hakios.p1277_panel=0`. No DISP pilot while panel request/persistent active.
3. Active CPU: screen ON, `sysctl kern.hakios.p1277_active=1`; compare touch/scroll and temperature against baseline, then =0. GPU IRQ independent `mali_irq` control through existing Foreground542 procedure; do not assume active CPU enables IRQ at runtime.
4. G3D: screen ON after normal verified OFF/wake, `sysctl kern.hakios.p1277_gpu_dvs=1` only if exact table/950mV witness accepted. Watch real frame/IRQ faults, then OFF/ON with high rail/rebase witness, disable =0. Any sticky failure/uncertain rollback: stop, recovery; do not reset fault to force it. Cached VSEL is not live rail power.
5. G2: screen ON and safe layout/hash context, `sysctl kern.hakios.p1277_g2=1`, test normal UI, disable =0. Context mismatch must fall back; no FPS or power claim.
6. Layer2: first qualify selected module with isolated Rev6 procedure below and then enable Auto Idle, wait state=4. Only one of `sysctl kern.hakios.p1277_layer2=1` (MFC), 2 (ISPPRE), 3 (DISP200), 4 (DISP134); one shot ~20s, =0 cancel. Result 1 with restored=1 and samples>=20 is a software witness, not watts. Result 4 or uncertain restoration: stop/recovery. No stacking panel+DISP or optional radios.
7. CPU burst: while Auto Idle enabled, `sysctl kern.hakios.p1277_burst_trace=1`. Wait up to 120s for >=150 total CPU load 250ms, only then 10s post-restore recorder if sustained. Check stats; dump frozen data with `& $s -Port $port -P12754 -Scenario ThermalTraceDump -Execute` after frozen trace state=4; no pretrigger claim. =0 cancels; one trace per boot.
8. Read Rev7Status after each pilot. On thermal/visual/audio/UFS/rail fault, abort and retain logs. If frozen readback disconnects use same-boot Audit53Recover with actual checkpoint; do not rearm/reboot first. For independent A/B/A results use `s9-p1277-report.ps1 -Manifest actual-manifest.json`, manifest version=1 trials each A0/B/A1 actual paths, optional qch_review or disp_review; no additive deltas.

## Legacy isolated qualification (all new requests disabled)
### Same boot prerequisites
Extract kit, close all serial readers, use actual COM port. Keep device cool; touch once with screen on, then turn screen off. In PowerShell in the kit directory:
```powershell
$port='COM125' # replace with actual port
$s='.\s9-p125-timer-serial.ps1'
& $s -Port $port -P12754 -Scenario Guard53 -Execute
& $s -Port $port -P12754 -Scenario Hardware54 -Execute
& $s -Port $port -P12754 -Scenario FunctionalGate -GateModule LITTLE949 -AllowFunctionalGate -Execute
```

Follow each host prompt. Advance only on successful same-boot functional/rail/UFS proof. For each lower floor, use actual preceding floor543-qualified.json path (not floor543-rail.json):
```powershell
& $s -Port $port -P12754 -Scenario FunctionalGate -GateModule LITTLE832 -AllowFunctionalGate -AllowLowerFloor -ConnectedFloorReport 'ACTUAL-949.floor543-qualified.json' -Execute
& $s -Port $port -P12754 -Scenario FunctionalGate -GateModule LITTLE715 -AllowFunctionalGate -AllowLowerFloor -ConnectedFloorReport 'ACTUAL-832.floor543-qualified.json' -Execute
& $s -Port $port -P12754 -Scenario FunctionalGate -GateModule LITTLE598 -AllowFunctionalGate -AllowLowerFloor -ConnectedFloorReport 'ACTUAL-715.floor543-qualified.json' -Execute
& $s -Port $port -P12754 -Scenario FunctionalGate -GateModule ABOX -AllowFunctionalGate -HeadlessAudio -Execute
```

Replace the ACTUAL placeholders before running. Audio review requires actual tone and recorded playback. Y only if heard and correct; otherwise N. No Y for an unobserved result. A failed or missing prerequisite prohibits the dependent module. No repeat on a revoked lease or uncertain restore.

## First battery A/B/A
Each run starts USB connected, screen OFF. Warm precondition 15s; continuous quiet 20s; valid window 60s; extended WAIT up to 150s with LongWait545. At OFFLINE ARMED unplug promptly; if screen wakes turn it OFF once, leave alone, reconnect only at host prompt. Observe thermal and stop conditions. Keep the same profile for A0/B/A1. Do not rearm after failure.
```powershell
$a=@{Port=$port;P12754=$true;Scenario='Audit53';WarmAudit=$true;LongWait545=$true;AllowOfflineTrial=$true;WaitCoolSeconds=60;Execute=$true}
& $s @a -Audit53Module STOCK60
& $s @a -Audit53Module COMPOSITE69 -AllowComposite545
& $s @a -Audit53Module STOCK60
& $s -P12754 -Scenario Audit53Compare -Audit53Reports @('ACTUAL-A0.json','ACTUAL-B.json','ACTUAL-A1.json')
```

Use actual audit report paths printed by host. Composite69 requires BASE + ABOX + LITTLE598 and qualification mask 7202. Optional WIFI/BT/TICKER bits are not required. Compare only verified, restored, same-boot, ordered and matched windows. Do not add independent savings estimates.

## Isolated DISP
Connected pilot at screen OFF, then wake as prompted. Verify fresh scanout and visible operation; Y only if correct. Run 134 MHz pilot only after 200 MHz is qualified in this boot.
```powershell
& $s -Port $port -P12754 -Scenario Disp545Probe -AllowDisp545 -Disp545KHz 200000 -Execute
& $s @a -Audit53Module DISP400 -AllowDisp545
& $s @a -Audit53Module DISP200 -AllowDisp545
& $s @a -Audit53Module DISP400 -AllowDisp545
& $s -Port $port -P12754 -Scenario Disp545Probe -AllowDisp545 -Disp545KHz 200000 -Execute
& $s -P12754 -Scenario Audit53Compare -Audit53Reports @('ACTUAL-A0.json','ACTUAL-B.json','ACTUAL-A1.json') -Disp545Review 'ACTUAL-POST-A1.disp545-probe.json'
```

Use corresponding post-A1 probe file printed by host (confirm exact suffix). For 134 repeat with Disp545KHz 134000 and B DISP134. All A/B/A phases mask trigger; A is DISP400 zero SET. Failed rollback means recovery required; no subsequent experiment.

## Isolated MFC and ISPPRE
MFC keeps configured IRQ mode. Probe with screen OFF, connected; codec must be idle and post-restore six-frame CRC and real IRQ review must pass when IRQ configured. Camera requires real preview before pilot, then close and screen OFF; follow actual wake/preview/close/OFF prompts after rollback.
```powershell
& $s -Port $port -P12754 -Scenario Mfc545Probe -AllowMfc545 -Execute
& $s @a -Audit53Module STOCK60
& $s @a -Audit53Module MFCQCH -AllowMfc545
& $s @a -Audit53Module STOCK60
& $s -Port $port -P12754 -Scenario Mfc545Probe -AllowMfc545 -Execute
& $s -P12754 -Scenario Audit53Compare -Audit53Reports @('ACTUAL-A0.json','ACTUAL-B.json','ACTUAL-A1.json') -Qch545Review 'ACTUAL-POST-A1.mfc545-probe.json'
```

For camera, same sequence replacing Mfc545Probe with Cam545Probe, AllowMfc545 with AllowCam545, MFCQCH with ISPPREQCH, and the post-A1 review with actual cam545-probe.json. Do not combine QCH trials or force clocks if rejected.

## Other qualifications
Optional WIFI/TICKER: run FunctionalGate with GateModule WIFI or TICKER, AllowFunctionalGate and HeadlessNetwork, only with actual external peer proof. BT active owner HCI is not implemented; passive HCI witness is diagnostic only, do not enable BT composite on its basis. Panel trial is a separate connected test:
```powershell
& $s -Port $port -P12754 -Scenario Panel545 -AllowPanel545 -PanelCycles 3 -Execute
```

Follow per-cycle screen prompts, check visible frame and no tear. N on any problem. Panel temporal witness is not exact BO/DSC/TE or watts proof; no panel power saving qualification. INT/MIF read-only: Guard53 records ECT/MINLOCK and conservative bounds; live_verified=0/write_allowed=0, no SET. If ECT missing, do not bypass capture checks.

Send full logs and JSON (including failures, boot nonce, checkpoints, raw thermal/FG, guard, pre/post evidence and compare outputs); no selective pass-only reporting. No native CI failure or unqualified module should be treated as a reason to flash repeatedly. Review actual results before selecting further combined tests.
