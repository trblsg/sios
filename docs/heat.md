# Heat on the Galaxy S9

Status: 12 November 2026. This page is the heat side of the "hot, and charging fell from 0.88 A to 0.47 A"
report. The first log (12 November) was screen-on and charging and covers two minutes. The second one (the same day,
"Second hardware result" below) is the first screen-off run: 755 s, the screen off for 4.5 minutes, Safari/YouTube
after the wake, and a hard reset at 101-102 °C — but it was charging through the PC's 500 mA port with the console
attached, so it is **not** the unplugged baseline. The measurements before it were made on the development phone
("phone 2") on 5 November, and the constants are from the kernel tree as it is on 12 November. The charging side —
`CNFG_09`, AICL, the CV taper and the four cases — is in [power-charging.md](power-charging.md).

## The short answer

The S9 under HakiOS has several independent heat sources, and the kernel sees only some of them:

| Source | What makes it hot | What the kernel does now | Where it appears |
|---|---|---|---|
| CPU, big cluster | `gov_policy=2` (the S9 default) keeps all four M3s online and allows 1794 MHz; the touch floor is 1469 MHz, the frame floor 1261 MHz while frames are moving | a ceiling that steps down from 83 °C, lowest level at 96 °C, back under 78 °C | `cpufreq_gov: ... big N MHz load N% ... temp big N C` |
| CPU, little cluster | four A55s, floor 1053 MHz (core 0 runs the loader's UFS service and is not counted as load); touch floor 1248 MHz under the scion law | same ceiling law from 76 °C, back under 71 °C | the same line, `lit ...` |
| GPU | `mali_gov=1`, 260/455/572 MHz; **572 MHz floor whenever a frame arrived in the last 100 ms**, even at 10 fps and low busy | 455 MHz at G3D 85 °C, 260 MHz at 95 °C; the floor is applied **before** the cap | `fps: ... gpu: ... MHz ... G3D N C`, `mali: GPU busy`, `mali: mali_gov: the G3D at ...` |
| Panel | the S6E3HA8 keeps scanning and DSIM/DECON stay up; brightness is AOR dimming, not an off switch; no system sleep and no CPU_SUSPEND | nothing unless `panel_sleep=1`; `sleep_cores=1` only after screen off | `GenericARMPE: the display off/on`, `s6e3ha8: panel_sleep:` |
| Charger / battery | 5 V input, `CNFG_09`/`CNFG_02`, a 2018 cell; the charger adds heat on top of the SoC | only the watchdog is ever written (`max77705_wdt=1`); no current limit is set | `max77705:` lines |
| Radios, camera, sensor hub | Wi-Fi/BT on by default; the front camera is lazy since 5 November; `shub=6` | none | `exynos_camera: STREAM ON/OFF` |
| Storage | UFS service on A55 core 0, always on | none | — |

The three facts that decide a heat test:

1. **Four M3s at 1794 MHz are the largest sustained CPU load this phone can make.** Two M3s at 1794 MHz sit at
   78-83 °C once they have run a while; two at 2314 MHz went from 46 °C to 92 °C in seconds (phone 2, 5 November).
   The S9 default is not the "two cores" case: `gov_policy=2` keeps four online.
2. **The GPU's 572 MHz floor is a performance floor, not a thermal one.** It is held while any frame arrived in
   the last 100 ms; a nearly static screen still presents about ten frames a second. The governor only caps it
   after the sensor reaches 85 °C, and the cap is applied after the floor.
3. **With the screen off the phone is not asleep.** There is no system sleep and no `CPU_SUSPEND`; the cores idle
   in WFI, the panel may still scan, and the A55s plus Wi-Fi/BT/sensor hub keep running. `panel_sleep=1` and
   `sleep_cores=1` remove two of those, not all of them.

And one negative result: **`gov_policy=3` is not the heat switch.** It can be hotter. The next sections say
why, then how to find the actual source with a log that needs no kernel rebuild.

## What the thermal chain does today

The TMU driver (`drivers/power/hakios.exynos_tmu.c`, `tmu=3`) reads four zones — BIG, LITTLE, G3D, ISP —
once a second, publishes them as `kern.hakios.temp.*`, and stops the run at 110 °C for the SoC or 60 °C for the
battery, three readings in a row. It does **not** slow anything: the stop is the last resort, not a control
loop. It also prints a warning when a zone passes the point where Android would start cooling it (83 °C BIG,
88 °C G3D, for example), because HakiOS has no Android thermal framework.

The CPU governor (`drivers/power/hakios.exynos_cpufreq.c`) is the control loop:

- it measures each core's idle time every 40 ms and asks for the rate at which the busiest core would be 60%
  busy, rounded up; up at once, down after 200 ms (five 40 ms windows) to the highest rate any of those
  windows wanted;
- every second, a zone at its control point or above loses one ceiling level: BIG from 83 °C, LITTLE from
  76 °C; the ceiling reaches the cluster's lowest level at 96 °C; it regains one level a second only once the
  zone is 5 °C under its control point (under 78 °C for BIG, under 71 °C for LITTLE);
- it does not offline cores at 96 °C. It lowers the frequency ceiling to the minimum (650 MHz for the M3s);
  Samsung's `hotplug_out_threshold` is not implemented. The only core parking is the scion law's, and only
  under `gov_policy=3` while the phone is cool.

The scion law (`gov_policy=2/3/4`) adds floors: `big_touch=1469000`, `big_frame=1261000`, `big_floor=650000`,
`lit_floor=1053000`, `lit_touch=1248000`; `gov_boost_lit=1690000` applies only to the older `gov_policy=1`. The M3s' default ceiling is
1794000, not the table's top (2314000): `cluster_setup(..., 1794000, ...)`.

The GPU governor (`drivers/gpu/hakios.mali.c`, `mali_gov=1`) uses three rates, 260/455/572 MHz, targets 50%
busy, and caps at G3D 85 °C → 455 MHz and 95 °C → 260 MHz, with 5 °C hysteresis. The order in `gov_window()` is
important: it computes the load's rate, raises it to `mali_gov_frame` if a frame arrived within 100 ms, **then**
applies the temperature cap. So a 572 MHz floor is held up to 85 °C even if the GPU is only 10% busy.

The panel and the idle path are in the kernel's `docs_screen-off-power.md`: no system sleep, WFI only, no
cluster power-down, and the panel only sleeps with `panel_sleep=1`. `sleep_cores=1` takes the M3s off through
PSCI `CPU_OFF` ten seconds after the display goes off; it does not help with the screen on.

Finally, iOS never hears about the heat. `userland/src/thermald.c` reads `kern.hakios.thermal_running` and
`kern.hakios.thermal_pressure` and posts `com.apple.system.thermalpressurelevel`; no S9 driver defines either
sysctl (the TMU provider exposes `temp.*`/`thermal_max_mc` and the sensors, not a pressure level). `thermald`
therefore exits with "no thermal service", `ProcessInfo.thermalState` stays nominal, and apps have no reason
to reduce their work while the kernel is already lowering clocks.

## Why `gov_policy=3` is not a cooling policy

`gov_policy=3` is the same scion law as `2` with M3 parking. The control law is in
`drivers/power/hakios.scion_gov.c` and the numbers in `hakios.exynos9810_soc.h`:

- with all four M3s online, it parks two only when the busiest M3 is at least 62% busy **at the four-core
  limit** (1794 MHz), the next M3 is at most 11% busy, the A55s are under 20%, the big zone is **under 70 °C**,
  and that state lasts 100 ms; then the ceiling rises to 2314 MHz for the two that remain;
- the two come back at **78 °C**, when the rate no longer needs more than 1794 MHz, or when the two cannot hold
  the load;
- `decide_scion()` calls `cores_set(SCION_BIG_CORES, ...)` — all four — whenever the temperature is not fresh,
  is not plausible, **or `c->thermal != 0`**. `c->thermal` becomes non-zero at 83 °C and stays non-zero until
  the zone is under 78 °C. So at the moment the phone is hot enough to need cooling, parking is disabled and
  all four M3s are recommended to the scheduler again;
- even while parked, the two M3s are not powered off. They are only removed from the scheduler's recommended
  set; they stay powered in WFI and leak (the kernel cannot do `CPU_OFF` in that path).

The measured result is consistent with that law: 2 × 2314 MHz is a burst that heats the phone from 46 °C to
92 °C in seconds; 2 × 1794 MHz sits at 78-83 °C. A policy that parks two cores when cool, then lets the
remaining two run at 2314 MHz, is not a cooler policy than four at 1794 MHz. It is a burst policy.

`gov_policy=2` is the same law without parking: four M3s, ceiling 1794 MHz. `gov_policy=4` is `2` plus
`scion_pace()` (a frame-late floor while a finger is down); it does not park either. `cpufreq_gov_big_max=` is
honoured by `2` and `4`, but **overridden by `3`**: `ceiling_now()` replaces the boot ceiling with
`scion_limit(big_cores)` whenever policy 3 has a fresh temperature (1794 MHz for four cores, 2314 MHz for two).
That is why a previous `cpufreq_gov_big_max=1469000` test under policy 3 changed nothing.

## What the 0.88 A / 0.47 A numbers do and do not say

The 0.88 A and 0.47 A figures were measured at the powered hub's port, so they are input current at about 5 V,
not the battery gauge. 0.88 A is about 4.4 W at the port; 0.47 A is about 2.35 W. A screen-on S9 can use more
than 2.35 W, so at 0.47 A the battery can fall even while `CHG_DTLS` says charging: the charger is feeding the
system first, the battery last. That is a power-budget problem, not proof that the charger is the heat source.

The charger adds heat of its own, but it cannot explain a phone that is hot with the cable out. To separate the
two, repeat the same workload with the cable out. If the battery temperature falls only when unplugged, the
charger or the source is part of the heat; if the SoC temperatures stay high either way, the CPU/GPU/panel are.

The battery limits are Android's, not HakiOS's: `battery,chg_high_temp=460` (46 °C, the charger's high-temperature
point), `battery,temp_high_threshold_event=500` (50 °C), and the kernel's `tmu_batt_stop=60` (60 °C, end of run).
HakiOS does not implement `sec_battery`'s JEITA steps, so those are thresholds to watch, not a charger current
that is automatically reduced.

## The screen-off, unplugged, mainboard-hot case (10 November)

The owner's answers on the 0.88 A / 0.47 A report:

- the hub is rated 2 A; the phone, not the hub, is hot;
- at 0.47 A the battery is at 30% and iOS says charging;
- the screen is off and the phone is locked; every app is closed; brightness is at its minimum;
- **the phone is hot with the charger out too**, and with the back cover off the **mainboard** is very hot.

That last pair changes the priority. The charger and the cell are not the main heat source: a phone that
stays hot unplugged is making the heat itself. The 0.47 A is a separate charging-limit problem, not the
cause of the heat.

The 2 A rating does not mean the phone may draw 2 A. A hub port is normally a standard USB data port
(SDP): it advertises 500 mA, and the S9's device tree maps cable type 4 (`USB`) to `current_group_12`,
475 mA input / 550 mA charge. The 2 A is the hub's capacity, not the port's advertised current. 0.47 A is
therefore the expected input for this port, not a fault by itself. At 30% the cell is far from its CV
phase, so the 500 mA is not the battery asking for less: it is the port/register limit. The log's
`CNFG_09` says which:

- `0x13` (500 mA): the input limit is in the charger's register (S-Boot or the boot state left it
  there). HakiOS never writes `CNFG_09`, so a hotplug does not raise it. Only a charge-only/DCP source,
  or the opt-in charger patch, can ask for more.
- `0x23` (900 mA) or higher, but the port still shows 0.47 A: the charger's AICL or the cable is
  limiting; the log then shows `CNFG_09` falling in 100 mA steps, or the current staying low while the
  register stays high.
- `CNFG_02` (fast charge) at 500 mA is a second cap; the battery current then stops at 500 mA even if
  `CNFG_09` is higher.

The owner has already booted with **both** `panel_sleep=1` and `sleep_cores=1`; the phone is still hot
unplugged, and the hottest part of the mainboard is its **center**. That rules out the panel scan and the
M3s as the whole story. `sleep_cores=1` only takes the M3s off; the A55s, the GPU/ISP and the SoC's uncore
stay up. The center of the board is the SoC/PMIC area; the charger is at the bottom, so the charger is not
the hot spot either.

The first thing to fix is the mental model: on this port **screen off is not sleep**. `docs_screen-off-power.md`
says `IOPMrootDomain` refuses sleep (`gSleepDisabledFlag = 1`), the cores idle in WFI only, and nothing asks
for `CPU_SUSPEND` or a cluster power-down, so every powered cluster keeps its supply and leaks. `panel_sleep=1`
sends display-off and sleep-in, but the panel supplies stay on and the DECON/DSIM clocks are not turned off;
`sleep_cores=1` takes only the four M3s. The phone is an awake phone with a dark screen, not a phone in standby.

Two things are still on even when iOS says the connections are off:

- the installer appends `shub=6 bt=7` to every S9 boot (`s9-installer.yml`), and `configs/starlte.config`
  defaults Wi-Fi to `wifi_pcie=6 brcmfmac=8`. `BLUETOOTH.md` says the chip stays powered from `bt=7` and
  that turning the Settings switch off has not been tried; the iOS switches do not run the kernel's
  power-down path. The log's `brcmfmac`/`bt` lines say whether the radios really came up.
- a background process, or a reader of `/dev/hakios-camera`, can keep the A55s or the ISP busy; the
  `cpufreq_gov` load and `exynos_camera: STREAM ON` say so.

So the heat has to be one of these blocks, and one log tells which:

| What the log shows | Block | One next step |
|---|---|---|
| `lit` MHz near its ceiling, high `lit` load, `little` hottest | A55s and background work | `sleep_cores=2` after the wake is proven, or `cpufreq_gov_lit_max=1053000` for a test |
| `brcmfmac`/`bt` lines show the station or chip up, though iOS says off | Wi-Fi/BT still powered | one run `bt=0 wifi_pcie=0` (a run argument overrides the installer's `bt=7`); leave them off if you do not need them |
| `exynos_camera: STREAM ON`, or `isp` hottest | camera/ISP | close Camera.app and every reader; `cam_s9=7` is lazy, a reader still starts it |
| `fps:` lines keep coming after the display-off event | frame thread/display pipeline | no boot-arg fix: DECON/DSIM clock-off belongs with `CPU_SUSPEND` |
| `g3d` hottest, or GPU above its floor | GPU | `mali_gov_frame=0` |
| big/little/G3D/ISP all under their cooling points, center still hot | SoC uncore/PMIC | `CPU_SUSPEND`/cluster power-down, not another governor switch |
| no `GenericARMPE: the display off`, or no `taken off` line | the switch never ran | check the boot args and the display-off event first |

Capture the failing state once: `panel_sleep=1 sleep_cores=1 tmu=3 fps_log=1 max77705_diag=1
max77705_fg_s=30`, screen off, unplugged, 10-15 minutes. Then plug the phone into the PC and type `log` at the
console, or set `time_limit=900` and read pstore in TWRP. If the PC cable is attached during the run, the PC
becomes the charger and the baseline is lost. That one log picks a row; only then make the one change in that
row. Do not try `sleep_cores=2`, radios off and the camera in separate blind runs: the log already says which
of them matters. The sensor hub is appended too (`shub=6`); `shub=0` turns it off for a test, but iOS may
retry its services, which adds CPU load, so judge that run by the `tmu:` zones, not by the case temperature.

At the console, before `log`, type `abox`, `sensors` and `bt`: each prints its live state (RDMA/UAIF/amps,
the sensor list and rates, the chip and tty). Also keep the `fps:` lines after the display-off event and the
startup `mali: 2: ACPM: BUCK6` line; they separate the display/GPU cases from ABOX and the radios.

The console is the phone's USB-C port as a CDC-ACM serial device (1209:0001), not the iOS Console app, not
Xcode, not SSH. On Windows it is a `USB Serial Device (COMx)`; open it in PuTTY or Tera Term at 115200 8N1
and type `log` (README.md, "USB: the whole log and a console over the cable"). The cable also charges the
phone from the PC, so run the unplugged period first, then plug in and send `log`: it reprints the kernel log
from its first line.

If big, little, G3D and ISP are all under their cooling points with the M3s and A55s off, yet the center is
still very hot, the remaining heat is the SoC uncore, the display pipeline or the PMIC. The boot-arg fixes are
then exhausted; the next step is the kernel's `CPU_SUSPEND`/cluster power-down work (below, "What is not
implemented"), not another governor switch.

## The polling layer, ABOX and the GPU rail (11 November)

A second read of the drivers found five periodic pollers that are on by default. They are real, but their
sum is an idle tax, not proof by itself that the centre of the board is hot:

| Block | File | Period | Approx. | When it runs |
|---|---|---|---|---|
| Touch S6SY761 | `drivers/input/touch/hakios.s6sy761.c` | `POLL_MS 4` | 250/s | after step 6; thread priority 92; `gpa1-0` is an active-low IRQ pin, not used |
| Wi-Fi | `wifi/lx/brcmfmac/lx_pci.c` | `brcmfmac_poll_ms` 2 | 500/s | only with `brcmfmac_poll=1`; the INTx path is SPI 253 from `brcmfmac=5` |
| Bluetooth | `drivers/bluetooth/bcm4361/hakios.bcm4361_bt.c` | 1 ms idle | 1,000/s | `bt=7` publishes the tty; `bt_tty_pump` wakes even when no byte moves |
| Sensor hub | `drivers/input/ssp/hakios.ssp.c` | `idle_us=4000` | 250/s | `shub=6`; `HOST_REQ` gpa1-7 is a level-high IRQ, polled; six sensors at 20 ms, slow ones at 200 ms |
| ABOX | `drivers/audio/abox/hakios.exynos_abox.c` | `POLL_MS 2` | 500/s | `abox=8`; step 8 `stream_run()` never returns |

The aggregate is about 2,500 checks/s, before the 40 ms CPU governor, the 1 s TMU, the 30 s gauge, user-space
timers and the display's frame thread. At roughly 10-20 us a wake, that is about 2.5-5% of one core,
plus cache/uncore effects. It is not enough, by itself, to explain a hot mainboard centre; if `lit` and `big`
are near idle in the log and the centre is still hot, the candidates are ABOX, DECON/DSIM, the GPU domain/BUCK6
and the SoC uncore/PMIC, not the pollers alone.

What the pollers do mean:

- they keep the A55s and the uncore out of deeper idle, and they are cheap to remove;
- a touch IRQ also cuts touch latency from up to 4 ms to the IRQ latency; it removes the AP's poll, not the
  controller's own scan (the driver leaves it in `SENSE_ON`), which is a separate low-power/tap-to-wake change;
- the Wi-Fi INTx is a boot arg (`brcmfmac_poll=0`), and the driver now falls back to the 2 ms poller when the
  line cannot be attached (`wifi/lx/brcmfmac/lx_pci.c`), so `brcmfmac_poll=0` cannot leave Wi-Fi dead; on the
  S9 the line attaches (SPI 253) and the fallback is not used (12 November);
- the BT UART IRQ removes the 1 ms pump, not `BT_EN` or the forced UART clocks; the chip stays powered under
  `bt=7`, so the low-power/host-wake protocol is the bigger saving;
- the sensor `HOST_REQ` is level-high: the handler must mask or acknowledge it until the hub is read, or it
  will fire again immediately.

### First hardware result (12 November)

`wifi_pcie=6 brcmfmac=8 brcmfmac_poll=0` on the S9 attached the line: SPI 253 (INTID 285), level-triggered,
through the root complex's INTA; `brcmf_pcie_intr` ran when INTx fired, the fallback was never used, and the
station joined 233 ms after connect (`Work`, 2462 MHz, WPA2/CCMP). 36-channel scans returned 26-28 access
points in 2.3 s, so commands, events and frames all cross the interrupt path with the 2 ms poller off.

That log is not the screen-off measurement: it was screen-on and charging (`LCD On_Off 1`, `charger=1
charging=1`) and covers only about 110 s. By 65-75 s the BIG cluster was already at its 650 MHz floor and
LITTLE at 455 MHz, with `hottest big` 94-95 C, `g3d1` 88 C and the battery at 50 C. A CPU at its floor and
95 C points at the uncore, ABOX, the GPU domain, the display pipeline or the charger, which is the ranking
below; it also means the screen-off, unplugged run still has to be made.

ABOX is more than a poller. Step 8 keeps RDMA0, UAIF1, the AUD domain and the Q-channels on; it reads RDMA0's
status every 2 ms, refills the ring with silence every 10.7 ms, and runs the speaker guard over every period,
silence included. The amplifiers stop after `QUIET_STOP_US` (3 s), but the pipeline does not. The first fix is
demand-stop after a silence grace period; the "DMA IRQ" is not a drop-in because the driver comment says no
interrupt is used and the GIC line is not set up. Demand-stop is the smaller and more valuable change; the IRQ
can follow if the poll still shows.

The GPU is frequency-DVFS only. `mali_gov=1` switches PLL_G3D between 260/455/572 MHz, but step 2 raises
BUCK6/vdd_g3d to 950 mV and the G3D domain stays on; in normal operation `g3d_off()` is only the undo path at
unload. At 260 MHz the rail is still 950 mV. Do not copy S-Boot's 644 mV: the source records
`DATA_INVALID_FAULT` on the S9+ at that combination. The safe first step is screen-off idle gating: after no
jobs for a grace period (and only when the display is off), run the existing `g3d_off()` path; power on through
the existing PMU/BUCK6 sequence at the first job. Voltage-per-OPP from the G3D ASV/fvmap is the second step,
not a blind write.

Two corrections to the earlier notes:

- the CPU governor's down delay is **200 ms** (5 windows x 40 ms), not 300 ms; the source comment says
  "about 200 ms". The rest (60% target, touch 1469 MHz, frame 1261 MHz) is correct.
- `sleep_cores=1` is not "no cluster power-down"; it is an opt-in `processor_exit()`/PSCI `CPU_OFF` for the
  M3s after 10 s, and `sleep_cores=2` adds the A55s. It is not enabled by default and it is not `CPU_SUSPEND`.
  The remaining cores still idle in WFI; CPD/SICD and the DECON/DSIM clocks are not done.

Scheduler: XNU has the AMP scheduler (`PSET_AMP_E/P`, `osfmk/kern/sched_amp.c`), but the S9 profile is
`BCM2837`, and `pexpert/pexpert/arm64/board_config.h` sets `MAX_CPU_CLUSTERS 1` then `#undef __ARM_AMP__`.
The loader only writes `small-core = 1`; it does not write `cluster-type`. `osfmk/arm64/hakios_ml.h` pairs each
A55 with an M3 (`processor_set_primary()`, `sched_slow_secondaries`; default `small_cores=2`), so an A55 is a
slow secondary, not an E-cluster. Native AMP would be a real thermal change for background work, but it is a
scheduler/topology change after the IRQ and suspend work, not before it.

Thermal pressure is still a mitigation, not a heat source: `userland/src/thermald.c` reads
`kern.hakios.thermal_running` and `kern.hakios.thermal_pressure`, but the S9 TMU provider publishes only
`kern.hakios.temp.*` and the `thermal_*` sensor values, so `thermald` exits and iOS stays nominal. This matters
under load; it does not cool an idle, screen-off phone.

### Second hardware result (12 November): screen off, YouTube, reset

The next run used the same phone, kernel `g85ddcb1b` (branch `irq-fallback`) and
`... s6sy761_irq=1 brcmfmac_poll=0`, with `mfc=5` but **without** `panel_sleep` or `sleep_cores`. The sequence was:
boot, join Wi-Fi, lock the screen at 172 s, wake at 439 s, open Safari at 443 s, play YouTube, and let it run until
the phone reset at 755 s. The console cable was also the charger (the PC's 500 mA port).

**The two IRQ conversions passed.** Touch attached `gpa1-0` as SPI 44 (INTID 76), level low, at step 6; the per-minute
lines show 197, 558 and up to 806 IRQs, with 94 touches / 1274 events / 1818 transfers and 2 failed in the busiest
minute, and no fallback to the 4 ms poller. Wi-Fi INTx was unchanged: SPI 253 (INTID 285), `brcmf_pcie_intr` called,
station joined 233 ms after connect.

| Uptime | What happened | BIG / LITTLE / G3D | Notes |
|---|---|---|---|
| 0-3 s | boot | 52 -> 75 / 68 / 58 C | the usual boot spike |
| 42-127 s | screen on, idle | 70 / 68.7 / 68 C | charging; battery 41-42 C |
| 127-150 s | foreground burst | 77 -> 95 / 72.7 -> 83.9 / 68 -> 78 C | the clocks drop to 650/455 by 160 s |
| 172 s | lock (`Set Blanked: YES`) | - | `LCD On_Off 1` still, because `panel_sleep` was not set |
| 185-435 s | screen off | 77-81 (86 once at 317 s) / 73.8-76.8 / 73-74 C | 0 touches, 0 frames; battery 43-44 C |
| 439-442 s | wake, Safari | 83 -> 90 / 76.8 -> 82.9 / 74 -> 80 C | the load jumps in the first second |
| 496 s | G3D at 85 C | 90 / 86 / 84 C | GPU capped at 455 MHz |
| 556-569 s | YouTube | 95 / 91 / 89 C | battery 46 C |
| 629 s | YouTube | 98 / 94 / 92 C | |
| 739-755 s | YouTube, then reset | 100 -> 102 / 96-98 / 94 C | M3 650 MHz, A55 455 MHz, GPU 260 MHz from 751 s |

The screen-off period is **not an idle floor**: the four M3s were about 38-40% busy each (`sum big` 150-158%) at
962-1469 MHz, while the A55s were at 1%. The log does not name the process, but the pattern is post-boot background
work — `wifid` link-quality calls, the sensor hub and launchd/XPC churn — so the first 10-15 minutes after boot are not
a baseline. The 80 C screen-off reading is therefore "awake with a dark screen and iOS still working", not "idle".

**The frequency levers were already exhausted when the heat arrived.** From 450 s the M3s were at their 650 MHz floor
and the A55s at 455 MHz; the GPU was capped at 455 MHz from 496 s and at 260 MHz from about 751 s. A phone at 100-102 C with
every clock at its floor is heating through the uncore, ABOX, the display pipeline, the charger and software video
decode, not through CPU frequency.

**The battery reading was temperature, not charge.** The TMU's `battery=39 ... 47` is the cell's temperature in C.
The gauge put the state of charge at 99.57% early and 99.23% at the end: the phone was on the charger but **not
charging** (`on a charger, not charging`), and by the end it was taking 177 mA **from** the battery at 46.7 C. A 500 mA
PC port cannot feed a screen-on S9 playing video; the cell buffers the difference and heats. That is a reason to run the
next measurement unplugged (or on a 5 V/2 A source), not proof that the charger caused the reset.

**Hardware video decode was absent.** The boot log has:

```
ext4: VENDOR: cannot be read: not a file (or the partition is not ext2/3/4) (79)
exynos_mfc: 3: /firmware/mfc_fw.bin is not on the phone's VENDOR partition: no hardware video
```

The S9's VENDOR partition on Android 10 is EROFS, which the kernel's ext4 reader does not read, so MFC never started
and VideoToolbox decoded in software. That is the largest avoidable heat source in a YouTube run, and it also explains
why the README's 4 November "hardware H.264/HEVC" result no longer reproduced. This tree now fetches `mfc_fw.bin`
(682,192 bytes, sha256 `378f85ce...f368d4`) into `fw/` of the root image, and the MFC driver asks
`hakios_image_file("fw", "mfc_fw.bin")` before the VENDOR partition. The next run has to confirm:

```
exynos_mfc: 3: mfc_fw.bin, 682192 bytes, from fw/ of the small image
exynos_mfc: 3: the firmware runs: ...
```

**The reset was not the kernel's thermal stop.** `tmu_stop` is 110 C for three consecutive reads; the last `tmu:` line
is 100.0 C at 739 s, and `cpufreq_gov` reported 101.0-102.0 C at 750-754 s. There is no `tmu: TOO HOT` line and no
panic. The log ends in the middle of a line (`c`, the start of the next `cpufreq_gov` line), which is a hard reset:
the SoC's own TMU trip (RISE7 is 115 C), the PMIC, or the watchdog. The loader then restarts into recovery by design.
The battery was 47 C, below the 60 C `tmu_batt_stop`; the MAX98512s reported `BROWNOUT` at 724.5 s and 754.5 s while
ABOX was still moving 192 KB/s. Those are observations, not yet a proven cause; a loader/PMIC reset-reason register is
the missing evidence.

What to do next, one variable at a time:

1. **MFC first.** Build with this tree's `firmware/mfc/mfc_fw.bin` in `fw/`, boot args unchanged (`mfc=5` is already
   there), and repeat the same YouTube run. If the two `exynos_mfc: 3` lines appear, the CPU/GPU load and the
   temperature after 5-6 minutes are the measurement. Do not add `mfc_irq=1` in the same run; test it after MFC works.
2. **Do not use the PC port as the charger for the heat run.** Run unplugged from a cool start, or on a 5 V/2 A source.
   If the console must stay attached, say so in the result; the 500 mA port changes the battery term.
3. **Screen-off baseline after settling.** Wait 10-15 minutes after boot, then lock. Add `panel_sleep=1` first, then
   `sleep_cores=1` in a later run; do not change both with MFC.
4. **If MFC works but the phone still reaches ~95 C,** the next diagnostic is `abox=0` for one run (no audio) to size
   the ABOX/amplifier term, then ABOX demand-stop. The GPU/display gating is after that.

### Two orders, not one

Heat impact for the screen-off, unplugged, centre-hot case is not the same as implementation risk:

| Rank | Heat impact | Why it is here |
|---|---|---|
| 1 | No system sleep: no `CPU_SUSPEND`, no cluster power-down (CPD) or SoC idle clock-down (SICD); remaining A55s, uncore, PMIC | The whole SoC stays powered and leaks; `sleep_cores=1` only removes the M3s |
| 2 | ABOX step 8 | RDMA0/UAIF1/AUD/QCH stay on; 2 ms poll, 10.7 ms guard, silence refill |
| 3 | DECON/DSIM clocks with the panel asleep | `panel_sleep=1` puts the panel in sleep-in, but the supplies and display clocks stay on |
| 4 | GPU G3D domain and BUCK6 950 mV | Frequency scales, voltage does not; the domain is left on |
| 5 | Radios | `bt=7` keeps the chip powered; Wi-Fi is up even when iOS says off; both poll |
| 6 | Polling aggregate and six sensor streams | About 2,500 wakeups/s plus about 300 sensor frames/s; an idle tax |
| 7 | A55/background/UFS service | Core 0 runs the loader's UFS service; background work keeps the A55s up |
| 8 | Camera/ISP | Lazy since 5 November, but a reader still starts it |
| 9 | Scheduler/M3 | Slow-secondary pairing, not native AMP; a longer-term placement issue |
| 10 | Thermal pressure | Makes iOS reduce work under load; not an idle heat source |

The low-risk implementation order is different:

1. Wi-Fi INTx: done and validated on the phone (12 November, `brcmfmac=8 brcmfmac_poll=0`); the polling
   fallback is in the driver.
2. Touch IRQ: `gpa1-0`, threaded handler, poll fallback; implemented and validated on the phone (12 November,
   `s6sy761_irq=1`: SPI 44/INTID 76, 197-806 IRQs a minute under use, no poller fallback).
3. BT UART IRQ: UART RX/SPI 422, `BT_WAKE`/`BT_HOST_WAKE`, poll fallback.
4. Sensor `HOST_REQ` IRQ: `gpa1-7`, level-high acknowledge, poll fallback.
5. ABOX demand-stop/AUD gating; the DMA IRQ only after that.
6. GPU screen-off idle gating; OPP voltage after the ASV/fvmap table.
7. Radio power-save: Wi-Fi power save, BT low-power; `bt=0 wifi_pcie=0` only as a diagnostic.
8. A55 floor test: `cpufreq_gov_lit_min=949000`, then `832000`, not 598; watch UFS latency.
9. `CPU_SUSPEND`/CPD/SICD and DECON/DSIM clock-off: largest structural fix, highest risk.
10. Native AMP E/P for A55/M3: scheduler/topology change, after suspend.
11. Thermal pressure bridge: useful under load, can be parallel and low priority.

## The log that names the source

Use the installer workflow's `boot_args` input. Nothing below needs a kernel rebuild. `fps_log=1` is the one
addition to the earlier charging recipe; it prints the GPU once a second.

Baseline (screen on, the workload that gets hot, Wi-Fi/BT in the state being judged):

```
tmu=3 fps_log=1 max77705_diag=1 max77705_fg_s=30
```

Then the same workload, one change at a time:

```
tmu=3 fps_log=1 gov_policy=2 cpufreq_gov_big_max=1469000 mali_gov_frame=455
tmu=3 fps_log=1 gov_policy=2 cpufreq_gov_big_max=1261000 mali_gov_frame=0
```

For screen-off, add `panel_sleep=1` first; add `sleep_cores=1` only after the picture comes back:

```
tmu=3 fps_log=1 panel_sleep=1
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1
```

Do not capture a wall-charging run through the PC USB cable: the PC becomes the charger. Charge from the wall
or the hub first, let it run 20-30 minutes, then plug into the PC and type `log` at the console (it reprints the
kernel log from its start), or use `time_limit` and read pstore in TWRP. See
[power-charging.md](power-charging.md#getting-a-charging-log-without-charging-from-the-pc).

The lines to read:

```
cpufreq_gov: 12 s: lit 1248 MHz load 31% (avg 22%, 2 online, 1794 max, measured 1251) | big 1794 MHz load 64% (avg 60%, 4 online, 1794 max, measured 1794) | temp big 82.1 lit 48.0 C | 9 changes | boost: 41 touch, 58 frames, 2 raised, touch on
cpufreq_gov: big at 83.1 C: its ceiling now 1690000 kHz
fps: 0 refreshes missed while moving, the longest gap 0.0 ms; zc: 8 in place, 0 copied, 0 into the one shown; gpu: 18% busy, 1200 us a frame shown, 60 jobs (20 us each, 2 us queued), 572 MHz (mali_gov), 1 switches, G3D 79 C
mali: GPU busy 22% of 5 s: vertex and tiler 10 jobs 6 ms (600 us each), fragment 120 jobs 40 ms (333 us each)
mali: mali_gov: the G3D at 85.0 C: 455 MHz at most now
```

How to read them:

| Reading | What it means |
|---|---|
| `big ... MHz load ...%` with `temp big` 78-83 °C and M3 at or above 1.7 GHz | CPU is a sustained source; the ceiling is already stepping down |
| `temp big` near 96 °C, `big` at 650-858 MHz, `big at ... C: its ceiling now ...` many times | the CPU hit its thermal wall; the phone is hot because the load outran the ceiling |
| `fps:` at 572 MHz with busy under 25%, `G3D` 75-85 °C | the GPU floor is adding heat for frames it does not need to hurry |
| `G3D` at 85 °C and `mali_gov: ... 455 MHz at most now` | the first GPU cap engaged; from here a 572 MHz floor is capped to 455 |
| battery 42-46 °C while charging, falling to normal with the cable out | charger/battery heat, not the SoC |
| screen off, no `s6e3ha8: panel_sleep:` line, phone still warm | the panel is still scanning; add `panel_sleep=1` |
| screen off, `panel_sleep` lines present, still warm | the A55s, GPU idle, Wi-Fi/BT and sensor hub are still running; `sleep_cores=1` and the radios are the next test |

`tools/analyze-max77705-log.mjs` now reads the `fps:` and `mali: GPU busy` lines too, prints a **Heat** section
(CPU, GPU, battery, panel), names the likely source above the thresholds, and writes them to CSV/JSON:

```
node tools/analyze-max77705-log.mjs s9-heat.log
```

Its thresholds are deliberately simple: CPU if the big zone is at least 78 °C and the M3s are at or above
1.7 GHz in half the samples (or 80 °C at all); GPU if G3D is at least 85 °C, or at least half the samples are at
455 MHz or more with under 25% busy; charger if the battery is at least 42 °C while charging; panel if a
display-off event has no `panel_sleep` line. A log that meets none of them is not "cool"; it means the source is
not one of those four and the radios, camera, sensor hub or charger deserve the next run.

## What can be changed today

In order, without a kernel patch:

1. **CPU ceiling:** `gov_policy=2 cpufreq_gov_big_max=1469000`, then `1261000`. This is the only CPU lever that
   works while the phone is hot. Do not use policy 3 for heat: it overrides the ceiling and allows 2314 MHz.
2. **GPU floor:** `mali_gov_frame=455`, then `0`. Keep `mali_gov=1`; the cap at 85/95 °C stays. If the picture
   becomes visibly late while scrolling, `455` is the compromise; `0` is for the measurement, not necessarily
   for daily use.
3. **Panel:** `panel_sleep=1` when the screen is off; prove that the picture returns before keeping it.
4. **Radios and camera:** Wi-Fi/Bluetooth off when not needed; close Camera.app (the lazy stream stops at the
   last close or after 2 s without a reader); do not use `cam_s9_always=1`.
5. **Brightness:** the panel is dimmed by AOR, not switched off. A dark screen still scans and composites; the
   brightness level changes the panel's power, and the frame rate/compositing changes the SoC's.
6. **Charger:** if the log shows charger heat, use a source that can hold 5 V at the phone's load (a 5 V/2 A
   charger, a short thick cable, a hub whose port is rated for it), and do not charge from the PC while
   measuring. Do not raise `CNFG_09`/`CNFG_02` to make the phone charge faster while it is already hot.
7. **Wi-Fi poll:** `brcmfmac_poll=0` with `brcmfmac=8`; done on 12 November, the line attached (SPI 253) and
   the station joined 233 ms after connect. If a future phone cannot attach it, the driver's fallback keeps
   the 2 ms poller; the INTx path is SPI 253 from `brcmfmac=5`.
8. **A55 floor:** `cpufreq_gov_lit_min=949000`, then `832000`. Do not start at 598000: core 0 runs the loader's
   UFS service, and a too-low floor can cost more time (and heat) in UFS waits than it saves.
9. **ABOX diagnostic:** `abox=0` for one screen-off run (no audio). If the centre cools, the step 8 pipeline
   is a source; do not keep it off if the phone needs audio. iOS may retry its audio service, so judge the
   run by the `tmu:` zones, not by the case temperature.

The one heat lever that is not a boot arg is hardware video decode: the image must carry `fw/mfc_fw.bin`, and the
MFC driver now asks for it before VENDOR (step 3). With `mfc=5`, YouTube should stop decoding on the CPU; verify the
`exynos_mfc: 3` lines before judging the temperature.

`max77705_wdt=1` is still needed for a charger that stops after five minutes, but it is not a heat fix.
`max77705_diag=1` and `max77705_fg_s=30` only read the chip.

## What is not implemented (and what it would take)

These are sketches, not switches in the tree. Each needs a log first and the owner's agreement, because each
changes behaviour on a phone that is already hot.

- **A "cool law" for the CPU (`gov_policy=5`).** The smallest patch with a chance of beating the default:
  keep two M3s parked even when `c->thermal != 0`; cap the four-core case at 1469 MHz and the two-core case at
  1794 MHz (never 2314); start the BIG ceiling at 75 °C instead of 83 °C, with the same 5 °C recovery. It
  would not make the phone fast; it would make the hot state predictable. It needs a log that shows the CPU is
  the main source, and a measurement of the same workload with and without it.
- **IRQ conversions for the five pollers.** Touch `gpa1-0`, Wi-Fi INTx SPI 253, the BT UART/SPI 422, the sensor
  `HOST_REQ` gpa1-7 and ABOX's RDMA0. Each needs a threaded handler, a level/edge rule and a fallback to the
  existing poll. Wi-Fi is done (`brcmfmac_poll=0`, with the poller as its fallback); touch is implemented and
  validated on the phone behind `s6sy761_irq=1`; the other three are still polled.
- **ABOX demand-stop.** After a silence grace period, stop RDMA0, UAIF1 and the Q-channels and power the AUD
  domain down; on the first iOS frame, re-prime the ring and start the path again. The amplifiers already stop
  after 3 s; the pipeline does not. This is the smaller change than a new DMA interrupt, and the audio start
  latency/click is the thing to measure.
- **GPU idle gating and G3D OPP.** In normal use the G3D domain and BUCK6 at 950 mV stay on even at 260 MHz.
  Gate the domain after no jobs for a grace period while the display is off, and power it through the existing
  PMU/BUCK6 sequence at the first job. Per-OPP voltage needs the G3D ASV/fvmap table; do not copy S-Boot's
  644 mV, which the source records as a `DATA_INVALID_FAULT` on the S9+.
- **Native AMP E/P for the A55/M3.** The S9 profile is `BCM2837`, `MAX_CPU_CLUSTERS=1`, `__ARM_AMP__` is
  undefined and the loader writes only `small-core`; `hakios_ml.h` pairs each A55 with an M3 as a slow
  secondary. A real E/P split is a scheduler/topology change, not a boot-arg test.
- **Thermal pressure for iOS.** Define `kern.hakios.thermal_running` and `kern.hakios.thermal_pressure` in the
  S9's TMU provider (0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping), update the level from the BIG/G3D
  zones with hysteresis, and let `thermald` post it. Then `ProcessInfo.thermalState` and apps that honour it
  (games, video, navigation) would reduce work before the kernel has to. Off by default until the levels are
  tuned; the S9's TMU already has the sensors, so this is a userland/kernel bridge, not a new driver.
- **System sleep / `CPU_SUSPEND`.** The bigger fix for screen-off heat and drain: `CPU_SUSPEND` with the
  device tree's `0x10000` state, cluster power-down, and the panel/DSIM/DECON clocks off. Kernel
  `docs_screen-off-power.md` describes the pieces and the risks. Not a screen-on fix. The 10 November case
  (screen off, `panel_sleep=1` and `sleep_cores=1` already on, still hot unplugged, center of the board) is
  the evidence: the remaining A55s, uncore and PMIC need a real idle state, not another governor switch.
- **Charger current control (`max77705_chg=auto`).** Set `CNFG_09`/`CNFG_02` from the charger type on VBUS
  attach, off by default, only after a log shows the input limit is the cause. It is a charging fix, not a
  heat fix: lowering the current slows charging and reduces charger heat, but it does not cool a hot SoC.

## The numbers, with their sources

| Number | Value | Source |
|---|---|---|
| M3 levels | 2886 ... 2314, 2106, 2002, 1924, 1794, 1690, 1586, 1469, 1261 ... 650, 598 kHz | `hakios.exynos_cpufreq.c` (APM table) |
| M3 default ceiling / floor | 1794000 / 650000 kHz | `cluster_setup(&clusters[1], ..., 1794000, 650000)` |
| A55 default ceiling / floor | 1794000 / 1053000 kHz | `cluster_setup(&clusters[0], ..., 1794000, 1053000)` |
| BIG thermal control / cut / hysteresis | 83 °C / 96 °C / 5 °C | `clusters[1].control_mc`, `HOT_CUT_MC`, `HYSTERESIS_MC` |
| LITTLE thermal control / cut / hysteresis | 76 °C / 96 °C / 5 °C | `clusters[0].control_mc`, `HOT_CUT_MC`, `HYSTERESIS_MC` |
| Scion limits | 2 cores → 2314 MHz, 4 cores → 1794 MHz | `EXYNOS_SCION_GOV.big_limit` |
| Scion floors | big 650000, touch 1469000, frame 1261000; lit 1053000, touch 1248000 | `EXYNOS_SCION_GOV` |
| Parking thresholds | park under 70 °C, unpark at 78 °C | `park_under_mc`, `unpark_at_mc` |
| GPU rates / target | 260, 455, 572 MHz; 50% busy | `g3d_rates`, `GOV_TARGET` |
| GPU rail / domain | BUCK6 950 mV fixed; G3D domain on; no per-OPP voltage | `hakios.mali.c` |
| Pollers | touch 4 ms, Wi-Fi 2 ms, BT 1 ms, sensor 4 ms, ABOX 2 ms; about 2,500/s | driver constants above |
| ABOX step 8 | RDMA0/UAIF1/AUD/QCH on; 2 ms status poll; 10.7 ms guard; amps stop after 3 s | `hakios.exynos_abox.c` |
| CPU down delay | 5 x 40 ms = 200 ms | `DOWN_WINDOWS`, `window_ms` |
| Scheduler | A55 paired to M3; `small_cores=2`; `MAX_CPU_CLUSTERS=1`, no `__ARM_AMP__` | `hakios_ml.h`, `board_config.h` |
| GPU frame floor | 572 MHz while a frame arrived within 100 ms | `mali_gov_frame`, `GOV_FRAME_MS` |
| GPU caps | 455 MHz from 85 °C, 260 MHz from 95 °C, 5 °C hysteresis | `GOV_CAP1_MC`, `GOV_CAP2_MC`, `GOV_HYST_MC` |
| TMU stop | 110 °C SoC, 60 °C battery, three readings | `tmu_stop`, `tmu_batt_stop` |
| MFC firmware | 682,192 bytes, `fw/mfc_fw.bin`; sha256 `378f85ce...f368d4`; `fw/` first, VENDOR as fallback | `firmware/mfc/SHA256SUMS`, `hakios.exynos_mfc.c` |
| Battery events | 46 °C charger high, 50 °C high event, 60 °C stop | `battery_data_starlte_common.dtsi`, `tmu_batt_stop` |
| Panel / sleep | no system sleep; WFI; panel sleeps only with `panel_sleep=1`; `sleep_cores=1` (M3) / `2` (M3+A55) are opt-in PSCI `CPU_OFF` after 10 s, not `CPU_SUSPEND` | kernel `docs_screen-off-power.md` |

## Open questions for the phone's owner

The answers change which test comes first:

- Is the phone hot **while charging**, **while on battery**, or both? The 0.88 A → 0.47 A fall was observed
  while charging; if it is also hot with the cable out, the charger is not the main source.
- What is the hub's rating, and what is VBUS under load? A hub port rated for 0.9 A may sag to 5 V or below
  when the phone asks for more; the meter's voltage is the evidence.
- Which device is hot, the phone or the hub? A hot hub is a source/cable problem; a hot phone with a cool hub
  is the phone's load.
- What was on the screen: brightness, app, Wi-Fi/BT, camera, GPS? The same phone can be 10 °C apart between a
  static home screen and a game.
- What is the battery's temperature, cycle count and full capacity? A 2018 cell with high internal resistance
  heats more at the same current, and reaches the CV taper earlier.
- Does iOS say "charging" or "not charging" at 0.47 A? That distinguishes a charger that is still supplying the
  system from one that has stopped.

Until those are known, the honest answer is: **fix the heat first, then judge the charging current**. The log
above is how to do it without guessing.
