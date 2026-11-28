# S9 P1278 Rev8 — connected recovery and active thermal candidate

Build only the exact paired Rev8 kernel/installer commits from SOURCE-MANIFEST.json and SHA256SUMS.json; P12754 ABI=6, P1277=7, P1278=8. Native CI must succeed before a flash. Rev7 remains a separate recovery option. Panel permission is disabled until runtime.

Workflow: s9-installer.yml on fix/s9-p1278-installer. kernel_ref=s9/p12-4-guarded-thermal-rev8; packaging_ref=main; partition=SYSTEM; metal/fps/tweaks=true; time_limit=0; userdata_blocks=starlte=13917184.

boot_args (266/280 bytes including workflow extras):
```
hi=2 panel=1 p122=1 p12_gpu_boot_auto=1 mali_gov=1 mali_gov_frame=450 mali_probe=1 p3power=1 max77705_fg_s=10 p1273=1 p1274=1 p1275=1 p12751=1 p12752=1 p12753=1 p12754=1 p127545_qch=1 p127545_disp=1 p127545_ect=1 p1277=1 p1278=1
```
No PSCI opt-in, direct panel_sleep, mali_irq, g2_bind or mali_dvs boot overrides.

After verified build/flash, allow cool device, keep USB attached, extract matched host kit in clean folder, close PuTTY. Windows PowerShell:
```powershell
.\s9-p125-timer-serial.ps1 -Port COM125 -P12754 -Scenario Rev8Suite -Execute
```
Default: AutoIdle automatic qualification; DCS28-only physical review then deep panel restoration review; short Baseline/IRQ/G2/CPU/Combined windows. No manual sysctl. Follow screen prompts; Y only if clean (no gray flash or fixed black region, normal gentle motion); N abort. No repeated pilot after failure. Before each wake the script waits OFF with Auto Idle enabled for thermal headroom. Never override temperature limits or force disarm asleep/uncertain panel. If hot/abnormal, stop and use normal recovery. USB power observations are not isolated watts. DVS 850mV qualification deferred; no 800mV pilot.

No-I/O preview: omit -Execute. Read-only status: -Scenario Rev8Status -Execute. Optional -Rev8Modules AutoIdle,Panel or -Rev8Modules Active for a subset; both use Auto Idle automatically. Resume same boot only:
```powershell
.\s9-p125-timer-serial.ps1 -Port COM125 -P12754 -Scenario Rev8Suite -Rev8Checkpoint '<actual .rev8-checkpoint.json>' -Execute
```
A new boot must requalify; checkpoint is not cross-boot permission. Default cleanup restores owned controls. Optional -KeepAutoIdle retains automatic policy only on success; later manually disable it through the existing guarded control before starting a clean suite. Never transfer an existing uncertain owner. Logs: raw .log, .rev8-suite.json, .rev8-checkpoint.json, readback journal and events. Driver review is not hardware or power certification. Send logs only, do not repeat hot-device tests.
