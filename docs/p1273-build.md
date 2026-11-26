# P12.7.3 one-build diagnostic firmware
This is a laboratory build, not a validated production firmware. Local source/host checks passed; native compilation and hardware validation remain outstanding.

## Publish from the Windows workspace
Preview only: `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish-p1273.ps1`
After accepting that native verification is pending, manually run the same command with `-Publish -AcceptNativeVerificationGap`. The helper stages only its explicit P12.7.3 file lists, runs targeted tests, commits/pushes kernel first and installer second, never force-pushes, preserves unrelated untracked files. If Git rejects a push, stop and review; do not force. Check both remote commits and the kernel CI.

## GitHub Actions: trblsg/sios, s9-installer
- Workflow branch: fix/s9-p124-thermal-installer
- kernel_ref: s9/p12-4-guarded-thermal (exact branch, older nested preflights match branch names)
- packaging_ref: main
- partition: SYSTEM
- metal: true
- fps: true
- time_limit: 0
- tweaks: true
- userdata_blocks: starlte=13917184 (Galaxy S9 Exynos only)
- boot_args (one line):
```
hi=2 panel=1 p122=1 p12_gpu_boot_auto=1 mali_gov=1 mali_gov_frame=450 mali_probe=1 p3power=1 max77705_fg_s=10 p1272_probe=1 p1273=1
```
131 bytes typed; installer adds shub=6 bt=7 camtl=0 metal=2 fps_log=1: 169/280 bytes. Device config already provides gov_policy=2, fb_psr=300, tmu=3, cpufreq_gov=1, all eight cores. Keep CPU_OFF, panel DCS sleep, voltage changes and unqualified Metal layout disabled. Do not add a static CPU ceiling or lower floor: compare runtime trials against the same baseline. time_limit=0 disables timed restart, not thermal protection.

Repository Actions secret INSTALLER_PASSPHRASE must already exist. Keep passphrase private. The installer formats USERDATA; back up data, retain a working recovery, and verify artifact checksum before flashing. Confirm preflight marker `S9 P12.7.3 paired source preflight PASS (not hardware qualification)` plus actual compiled kernel/userland/system success. Use BOOT and SYSTEM from the same run. Keep the matching host scripts and symbol map. Never flash a failed build.

## First boot
Do not run combined or cap experiments immediately. First capture boot and normal thermals; close other serial clients before using the matching host script. Run the once-per-boot GpuCacheCheck promptly (worker expires after 900 s); then the thermal flight recorder and read-only dumps, then individual functional gates. No automatic qualification of combined masks. Review raw logs before moving to stronger trials. See kernel docs/s9-p1273-implementation-status.md.
