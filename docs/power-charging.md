# Heat, battery and charging

Status: 10 November 2026. The three new power switches (`max77705_wdt`, `panel_sleep`, `sleep_cores`) are **off by
default** in the kernel, and as of their commits they were **built, not yet run on a phone**. `gov_policy=3` was booted
on phone 2, but it is **not a heat fix** and is no longer the recommended screen-on test: it overrides
`cpufreq_gov_big_max`, disables parking once the big zone is cooling, and allows two M3s at 2314 MHz when it does
park. [heat.md](heat.md) has the control law and the measurements. The S9's defaults (`tmu=3`, `fb_psr=300`,
`gov_policy=2`, `gov_wake=1`, `cam_s9=7`) are already on. Keep TWRP in RECOVERY and a backup before testing any switch.

This page now also covers the "hot, and the charging current fell from 0.88 A to 0.47 A" report of 10 November 2026.
There is no log from that phone yet; the sections below say what the two numbers can and cannot mean, and how to
capture the log that decides it. The heat side — where the watts go, why `gov_policy=3` is not the lever, and the
screen-on tests — is [heat.md](heat.md).

## The commits

| Commit | Date | What it changes | State |
|---|---|---|---|
| `c400c2a185`, merge `5f439453db` | 5 Nov | The front camera (`cam_s9=7`) starts its stream at the first reader of `/dev/hakios-camera` and stops at the last close or 2 s without one. Before this it streamed at 30 frames a second from boot to power off with nobody using it (`cam_s9_always=1` keeps the old behaviour) | Checked with Camera.app on phone 2; a default |
| `8f2d90f9b8` | 7 Nov | `max77705_wdt=1`: feeds the MAX77705 charger's watchdog (`CNFG_06` WDTCLR) every 30 s while `CNFG_00` says WDTEN. Without it the charger stopped within five minutes of every boot on USB (about 1 A at boot, then "on a charger, not charging") | Built, not yet run on a phone; off by default |
| `ff81cf3f5d`, merge `1e6ef42f00` | 7 Nov | `max77705_diag=1`: read-only dump of `CHG_INT_OK`, `DETAILS_00-03` and `CNFG_00-14`. `max77705_fg_s=S`: a gauge line every S seconds (AvgCurrent and QH besides Current) | Built, not yet run on a phone; off by default |
| `de9b699a37`, `2e04990f13`, `42abb03101` | 7 Nov | `panel_sleep=1`: Samsung's display-off/sleep-in sequence when iOS turns the screen off, display-on on wake. `sleep_cores=1`: the four M3s go through PSCI CPU_OFF `sleep_cores_after=` seconds (10) after screen off, and start again on wake. `sleep_cores=2` also takes the A55s; never the boot processor or the loader's core | Built, not yet run on a phone; off by default |
| `5cc13f8010`, merge `8697cb7d97` | 5 Nov | `gov_policy=3`: the scion governor parks two M3s when the load asks and the big zone is under 70 C, brings them back at 78 C. `gov_policy=2` is the same law without parking | Booted on phone 2; not a heat fix (parking is off when `c->thermal != 0`, and two M3s may run at 2314 MHz); see [heat.md](heat.md) |
| `1cf0f53183` | 5 Nov | `fb_psr=<ms>`: the panel keeps its own frame after `<ms>` without a frame instead of the DECON refreshing it at every TE | Off upstream; **on in the S9's config** as `fb_psr=300` |
| `3e07833aa4` | 5 Nov | `gov_wake=1`: a finger coming down asks for the GPU's frame floor before the first frame needs it | Off upstream; **on in the S9's config** |
| `f0fe052149` | 8 Nov | `docs/screen-off-power.md`: the S9's idle states. **There is still no system sleep** (`gSleepDisabledFlag=1`); the cores only WFI, and CPU_SUSPEND/C2 is the next step | Documentation only |

The 9 November commit `fa52e654` / `e32eae0c19` builds the S9's boot arguments into the `ios-27` kernel. It does
not add any of the three power switches.

## What the S9's defaults already have

`configs/starlte.config` sets `tmu=3`, `fb_psr=300`, `gov_policy=2`, `gov_wake=1`, `cam_s9=7 cam=5` and
`cpufreq_gov=1`. So the thermal stop and the governor's temperature ceilings are already active, the panel
self-refresh and the GPU wake are already on, and the camera no longer streams at boot. The missing pieces for a
cooler phone are the opt-in screen-on CPU/GPU caps (`cpufreq_gov_big_max`, `mali_gov_frame`), panel sleep and the
M3 power-off while the screen is off; the charger watchdog feed only keeps the charger running. The parking policy
is not one of them: [heat.md](heat.md) says why it can run hotter.

## Why the last test did not make the phone cooler

The reported run used

```
max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 panel_sleep=1 sleep_cores=1
```

with the screen on. None of those five is a screen-on heat lever:

- `max77705_wdt=1` keeps the charger's watchdog fed. It stops the charger from going quiet after five minutes; it
  does not lower a current, a voltage or a clock.
- `max77705_diag=1` and `max77705_fg_s=30` only read the charger and the gauge. The extra 30-second gauge reads are
  two I2C reads and cannot be measured as heat.
- `panel_sleep=1` sends the display-off/sleep-in sequence only when iOS turns the display off. With the screen on it
  does nothing.
- `sleep_cores=1` takes the M3s off only after the display has been off for 10 seconds. With the screen on it does
  nothing.
- `gov_policy=3`, the one switch in the list that changes the screen-on CPU law, was **not** in that run. It is
  also not a cooling switch: it parks two M3s only under 70 C, hands all four back as soon as a thermal ceiling is
  active, and when it does park them the ceiling is 2314 MHz. `gov_policy=2`, the S9's default, is the one to keep;
  its lever is `cpufreq_gov_big_max=`.

So the only screen-on changes in that run were the defaults: `cpufreq_gov=1` (its 83/96 C ceilings are already in
`gov_policy=2` too), `fb_psr=300`, `gov_wake=1` and the lazy camera. If the image predates 5 November, the front
camera also streamed at 30 frames a second from boot; look for `exynos_camera: 5: STREAM ON` before Camera.app has
been opened, or build a new image from `kernel_ref=main`.

For screen-on heat the order is:

1. a 5 November or later kernel (lazy camera stream), `gov_policy=2 cpufreq_gov_big_max=1469000`, then `1261000`;
2. `mali_gov_frame=455`, then `0`, with `fps_log=1` (the GPU floor is 572 MHz while any frame arrived in the last
   100 ms, even on a nearly static screen; the cap is applied only after the floor);
3. Wi-Fi and Bluetooth off, brightness at the level actually wanted (the panel is dimmed by the AOR, not switched
   off, so a dark screen still scans and composites);
4. the load: SpringBoard's poster/imagers, a game, the camera, or a loop in an app; `cpufreq_gov` and `fps:` lines
   say which cluster/GPU and how much;
5. only then the charging current (the charger adds heat on top of the SoC; it is not the SoC's heat).

[heat.md](heat.md) explains the thermal chain, the 83/76/96 C ceilings, the GPU caps and the screen-off gap
(no system sleep, no `CPU_SUSPEND`, the panel scans without `panel_sleep=1`).

`panel_sleep=1` and `sleep_cores=1` are for a different measurement: leave the screen off for 10-30 minutes and
compare the drain and the battery temperature with and without them.

## 0.88 A to 0.47 A: what the two numbers can mean

0.88 A is about 900 mA and 0.47 A is about 500 mA. The report's numbers were measured at the powered hub's port,
so they are **input** current at about 5 V; the battery gauge is a different number, and can be lower (or negative)
while the port still shows 0.47 A. The same two values also appear on the charger's and the phone's own scales:

- a plain USB 2.0 cable/port: the S9's device tree sets `input_current = 475 mA` and `charging_current = 550 mA`
  (`battery_data_starlte_common.dtsi`, `cable-info/current_group_12`, cable type 4 `USB`);
- the `CNFG_09` input-limit code `0x13` is 500 mA; the code for 900 mA is `0x23`.

The MAX77705 charger does not decide the battery current by itself. It has two limits:

| Register | Field | Step | Decode |
|---|---|---|---|
| `CNFG_09` (`0xC0`) | input current limit, bits 6:0 | 25 mA | code 0-3 = 100 mA, 4-126 = (code + 1) x 25 mA, 0x7F = 3200 mA |
| `CNFG_02` (`0xB9`) | fast-charge current, bits 5:0 | 50 mA | code 0-2 = 100 mA, 3-63 = code x 50 mA |

The S9's device tree asks for 1800 mA input / 2100 mA fast charge by default; USB wants 475/550; a USB CDP port
1500/1500; a 9 V charger 1650/2150. Android's `sec_battery` writes these on every cable attach. HakiOS does **not**:
its only write to the charger is the watchdog's `CNFG_06`, and only with `max77705_wdt=1`. Whatever `CNFG_09` and
`CNFG_02` hold at boot is what S-Boot or the charger left there, and a hotplug under HakiOS does not re-apply a
charger-type limit.

Four cases explain a fall from 0.88 A to 0.47 A; the log tells them apart:

1. **Constant `CNFG_09` at `0x13` (500 mA).** Not the battery's CV taper and not a driver fault: the limit was
   already 500 mA. A 500 mA input at 5 V is 2.5 W; the phone with its screen on can use most of that, so the
   battery gets little and can even fall when the load rises. `CHG_DTLS` stays 0-2 (charging) and the battery
   current is positive but small.
2. **`CNFG_09` falls in 100 mA steps.** Samsung's AICL work reduces the register by `REDUCE_CURRENT_STEP` (100 mA)
   when VBUS sags; the register's own step is 25 mA. HakiOS never writes `CNFG_09`, so a fall during a run is the
   charger's own AICL or a write outside this driver, not the governor. A weak charger, a thin/long cable or a PC
   USB port is the usual cause. This is the case a USB power meter confirms: the meter's input current also falls.
3. **`CNFG_09` constant at 900 mA but the battery current falls.** The limit did not change, so the battery current
   is following the battery: above about 80% the CV phase lowers it (normal), or the battery is warm (46 C is
   Android's charger limit, 50 C its high-temperature event, 60 C `tmu_batt_stop`), or the system load rose and
   takes the difference. The charger's input stays at the limit while the battery gets only what the phone leaves.
4. **`CNFG_09` constant, `CHG_DTLS` 5-7.** The charger has stopped. Without `max77705_wdt=1` this happened within
   five minutes of a boot; with it, check the `max77705: wdt:` lines for a failed kick and the `CNFG_00` WDTEN bit.

`max77705_fg_s=30` prints the gauge's Current and AvgCurrent; the state line every 5 minutes prints the battery's
voltage, current, temperature and status. Both are the battery side, not the charger's input. A USB power meter in
line with the wall charger is the only way to see the input side; the difference between the two is the phone's own
load.

A worn battery matters too: the S9's cell is from 2018, and a high internal resistance makes it heat more and reach
the CV taper earlier at the same current. The state line's `cycles` and `full` against `design` are the evidence.

## Reading the log

The driver's lines, all read-only except the WDT kick:

```
max77705: every 5 minutes: 47.00%, 3980 mV, 880 mA, 33.0 C (ADC 1150), a battery, charging, 1400 of 3000 mAh (full 2850), 500 cycles
max77705: charger every 5 minutes: 0xb2-0xc5: 40 60 02 00 00 11 80 2a 00 00 00 00 00 00 23 00 00 00 00 00
max77705: charger every 5 minutes: CNFG_00 mode 0x1 WDTEN 1; CHGIN_DTLS 3; CHG_DTLS 0x2 BAT_DTLS 0; BYP_DTLS 0x0; fast charge 2100 mA; input limit code 0x23 (CNFG_09)
max77705: fg: t 42 s, 47.10%, 1410 mAh, current 875 mA, avg 869 mA, QH 1200
max77705: wdt: CNFG_00 0x11 (WDTEN on); CNFG_06 0x0 written 0x1: kicked (0)
max77705: wdt: 32 kicks, 0 with the watchdog off, 0 failed
max77705: usb switch now: CONTROL1 0x9, BC_STATUS 0x83 (VBUS 1, charger type 3), USBC_STATUS1 0x0, SYSMSG 0x0
```

- `CNFG_09` is the input limit code; `CNFG_02` the fast-charge code. The table above decodes them.
- `CHGIN_DTLS 3` means a valid input; `CHG_DTLS` 0-2 charging, 3-4 full, 5-7 not charging.
- `BC_STATUS` bit 7 is VBUS and bits 1:0 the charger type: 0 none, 1 USB host, 2 charging host, 3 wall charger.
  A wall charger that reports 1 or 2 is being treated as a PC port and gets the USB current.
- `WDTEN 1` and a `kicked` line mean the watchdog is fed. `FAILED` or no kick is a reason for the charger to stop.

The `tools/analyze-max77705-log.mjs` script reads such a log (the USB console output, `log` at the console, or a
pstore file) and prints the trend, decodes both registers, and names the likeliest case. It needs Node 18 or later,
nothing else:

```sh
node tools/analyze-max77705-log.mjs s9-charge.log
node tools/analyze-max77705-log.mjs --csv s9-charge.csv --json s9-charge.json s9-charge.log
node tools/analyze-max77705-log.mjs --self-test
```

## Getting a charging log without charging from the PC

The USB console is itself a cable to the PC, so a live capture over it charges the phone from the PC's 500/900 mA
port, not from the wall charger. That is the largest confound in the 0.88 A observation. The two ways around it:

1. **Wall charger first, PC afterwards (preferred).** Boot with the wall charger and

   ```
   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 tmu=3 fps_log=1
   ```

   Let it run 20-30 minutes with the screen in the state being judged (on, or off after the screen-off switches are
   proven). Then unplug the wall charger, plug the phone into the PC, open the console and send `log`: the console
   reprints the kernel's log from its first line, including the whole wall-charging period. Save the output
   (`cat /dev/ttyACM0` on Linux, as in the README's USB section) and run the analyzer on it. The last lines, after
   the PC was plugged in, are the PC's 500 mA period; judge the wall period by the lines before it.
2. **`time_limit` and TWRP.** With `time_limit=1800` (and `esslog=1`) the run ends by itself and the phone returns
   to TWRP; read the pstore tail there with
   `adb shell su -c 'ls /sys/fs/pstore; cat /sys/fs/pstore/pmsg-ramoops-0'`. pstore is 32 KB, so this is the tail,
   not the whole run; the whole kernel log stays in `exynos_ss` with `esslog=1`.

A third test needs no log: a USB power meter between the wall charger and the cable. Read VBUS and the input current
at the same time as the phone's battery current (iOS's battery screen or the `max77705_fg_s` line). If the meter
shows ~0.9-1 A and the battery ~0.47 A, the rest is the phone's load; if the meter also falls to ~0.5 A, the input
limit/cable/charger is the cause.

## Test sequence

Rebuild the installer with `kernel_ref=main` first: an image older than 5 November still streams the front camera at
30 frames a second from boot. Then use the workflow's `boot_args` input, one step at a time:

1. **Charging** (the prime suspect for "plugged in but the battery falls"):

   ```
   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30
   ```

   `max77705_wdt=1` is the only write to the charger: it sets `CNFG_06[1:0]` WDTCLR and nothing else. It is for
   your own phone, as the commit's note says. On USB, check that charging continues past five minutes. In the USB
   console look for
   `max77705: wdt: CNFG_00 ... (WDTEN on); CNFG_06 ... written ...` and the 5-minute `max77705: charger ...` line:
   `WDTEN 1`, `CHGIN_DTLS 3` (valid input), and `CHG_DTLS` in 0-2 (charging) or 3-4 (full), not 5-7 (not
   charging). `max77705_fg_s=30` prints the
   gauge every 30 s, so a drain over minutes can be measured instead of read off a percentage. Both diagnostic
   arguments only read the chip.

   Add the plug-order test: note `CNFG_09`, `BC_STATUS` and the current with the charger in at boot, then unplug
   and plug it back and note them again. A limit that falls only after the hotplug comes from the source or the
   charger; HakiOS does not re-apply the charger-type limit.

2. **Panel sleep**:

   ```
   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 panel_sleep=1
   ```

   Turn the screen off and on with the side button. Look for `s6e3ha8: panel_sleep:` lines and check that the picture
   comes back. If the panel stays black, reboot to TWRP and drop `panel_sleep=1`; do not add `sleep_cores` on top.

3. **M3 power-off while the screen is off**:

   ```
   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 panel_sleep=1 sleep_cores=1
   ```

   Leave the screen off for at least 10 minutes, then wake it. Look for
   `GenericARMPE: sleep_cores: cpu N taken off` and `... started again`, and the `psci: cpu N: started again;
   AFFINITY_INFO` line. `sleep_cores=2` also takes the A55s and is riskier: do not start with it.

4. **Screen-on heat: CPU ceiling and GPU floor** (no rebuild; `tmu=3` is a default):

   ```
   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 tmu=3 fps_log=1
   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 tmu=3 fps_log=1 gov_policy=2 cpufreq_gov_big_max=1469000 mali_gov_frame=455
   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 tmu=3 fps_log=1 gov_policy=2 cpufreq_gov_big_max=1261000 mali_gov_frame=0
   ```

   Keep the same app, brightness and Wi-Fi/Bluetooth state. Compare the `cpufreq_gov` big MHz/load/`temp big`
   lines and the `fps:` GPU MHz/busy/G3D lines. `gov_policy=3` is **not** part of this comparison: it overrides
   `cpufreq_gov_big_max` and may run two M3s at 2314 MHz. `heat.md` has the full sequence and the thresholds the
   analyzer uses.

## What not to expect

The kernel has no system sleep, and CPU_SUSPEND/C2 is not implemented. With the screen off the SoC still runs and
leaks; `panel_sleep` and `sleep_cores` remove the panel scan and the M3s, not the whole idle load. If the charger's
input is below the phone's load, the battery still falls even with a working charger: the `max77705_fg_s` current
and the `CHG_DTLS` line are how to tell that case apart from the watchdog stopping the charge.

The charger current itself is not a heat switch. Charging at 0.9 A into a 2018 cell adds heat; lowering the current
would slow the charge and reduce that heat, but HakiOS has no `sec_battery` to write the limits, and the kernel's
driver deliberately does not write them. A `max77705_chg=auto` boot argument (set `CNFG_09`/`CNFG_02` from the
charger type on VBUS attach, off by default) is the possible next step, but only after a log shows that the limit is
the cause and the phone's owner agrees to a charger write beyond the watchdog's.

If the build is moved to `ios-27`, note that the built-in `cpufreq_gov_big_min=1794000` keeps an online M3 at no
less than 1.794 GHz. That is not in the iOS 16.5 build; `cpufreq_gov_big_min=650000` overrides it if a cooler idle
is wanted.
