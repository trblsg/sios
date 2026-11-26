# P12.7.5 — ICD root-cause / protected Metal trials

Kernel `c993cc0eeb6eab73bfaa1bc6ad5714c067ad9464`. Host kit `tools/p1275-host-c993cc0.zip`.
Use the new ZIP; existing P12741 scripts cannot select new experiments.

## Build
- Workflow s9-installer; branch fix/s9-p124-thermal-installer.
- kernel_ref=s9/p12-4-guarded-thermal; packaging_ref=main; partition=SYSTEM.
- metal=true, fps=true, time_limit=0, tweaks=true, userdata_blocks=starlte=13917184.
- Boot arguments (new exact flag p1275=1, no boot-time mode):

```text
hi=2 panel=1 p122=1 p12_gpu_boot_auto=1 mali_gov=1 mali_gov_frame=450 mali_probe=1 p3power=1 max77705_fg_s=10 p1273=1 p1274=1 p1275=1
```

Do not enable p1272_probe=1, metal_layout=1, p_layout_probe=1, sleep_cores,
syssleep, panel_sleep, mali_dvs, p9_panel_mode, gov_policy=3, fb_psr or
frequency/voltage overrides. Native build must succeed before flash.
Download the GitHub Actions artifact **p1275-panvk-macho**: report JSON,
actual build input dylib, SHA256, UUID, existing manifests and optional
LLVM dumps. This is the input copied by userland/build.sh, not a runtime
measurement or an independently extracted phone binary. Do not infer
binding time merely from export counts. Send report and weak-entrypoints
with the logs.

## First test — EarlyLoad (NOW, no coordination)
Fresh cooled boot, screen OFF, USB connected, close PuTTY. Start early
enough to arm before uptime 225 s. COM125 is an example; use real port.
No touch/swipe during measurement. Existing hard stop BIG76/LITTLE70/GPU72,
720s absolute deadline, guard survives freeze. EarlyLoad enables typed
nil shim and predictive BIG+LITTLE cap, keeps RTLD_NOW, does not flock.
Do not force repeated hot captures. If arm is refused or thermal stop
occurs, cool first; preserve RAM only if safe.

```powershell
powershell -ExecutionPolicy Bypass -File .\s9-p1274-serial.ps1 -Profile LOG2 -Experiment EarlyLoad -AllowIntervention -Port COM125 -RunDir .\logs\P1275-EarlyLoad-A0 -Execute
```

Confirm p1275_revision=1, p1275_selected=4, p1274 active profile=2.
Kernel arm may stop sooner for safety. Log P1275 typed layout shim ABI=1
means installed (not proof used); ABI=0 falls back to original path.
Event6 code100 counts deferred layout requests, 101 later real open.
No alignment value is fabricated. Code105 identifies open selector.

## Priority Dump then Analyze
Only when cool on same boot; do not reboot before Dump.

```powershell
powershell -ExecutionPolicy Bypass -File .\s9-p1274-serial.ps1 -Action Dump -Port COM125 -RunDir .\logs\P1275-EarlyLoad-A0 -MaxPages 160 -Execute
powershell -ExecutionPolicy Bypass -File .\s9-p1274-serial.ps1 -Action Analyze -RunDir .\logs\P1275-EarlyLoad-A0 -Execute
```

Send whole directory after first batch even if dump_complete=false.
Priority p1275-focus.txt, newest stage events and DVFS, peak timeline,
GPU first wake and near-trigger owner bins. CSV metal-stages,
metal-process-usage (process-wide user/system and fault deltas,
not thread CPU), p1275-events, thread-placement (not exact migration),
episode-samples, trace-owners and raw logs. Repeat Dump in same
RunDir only when safe, smaller budget if needed. No need to force full
dump or reproduce 88C. Do not edit capture metadata.

## Subsequent trials after review, same firmware/reboot
All P1275 modes require LOG2 Connected; each fresh boot, unique RunDir.
Observe (1) detailed stage measurement, no added intervention.
Early (2) typed nil only. Load (3) two-cluster load cap only.
EarlyLoad (4) early+load. Coord (5) bounded advisory flock only.
Lazy (9) RTLD_LAZY only. Combined (8) early+load+coord with NOW.
CombinedLazy (16) same plus LAZY. Explicit -AllowIntervention except Observe.
No automatic progression; review first test and audit before lazy/coord.
Compare matched conditions A/B/A, separate boots. Do not test Offline,
B/R profiles until separately reviewed.

If new module fails, collect raw logs; do not disable thermal guard or
raise limits. Actual SDK/Rust/kernel compilation and native behavior
remain unverified locally. Weak dispatch generator/linker changes,
alignment answer and private ImageIO fallback implementation deferred
pending actual binary/API evidence. See kernel docs/s9-p1275-implementation-status.md.
