# Heat on the Galaxy S9

Status: 10 November 2026. This page is the heat side of the "hot, and charging fell from 0.88 A to 0.47 A"
report. **There is no heat log from that phone yet**: nothing below was measured on it. The measurements were
made on the development phone ("phone 2") on 5 November, and the constants are from the kernel tree as it is
on 10 November. The charging side — `CNFG_09`, AICL, the CV taper and the four cases — is in
[power-charging.md](power-charging.md).

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
  busy, rounded up; up at once, down after 300 ms to the highest rate any of those windows wanted;
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

With the screen off and every app closed, the heat has to come from the platform's screen-off path:

- the panel may still be scanning, with DSIM/DECON up, unless `panel_sleep=1` was in the boot arguments;
- there is no system sleep and no `CPU_SUSPEND`; the cores only WFI, so every powered cluster leaks, and
  Wi-Fi/BT, the sensor hub and the UFS service keep running;
- a background process can still keep the A55s at a high rate; the `cpufreq_gov` lines say which cluster
  and how much;
- the GPU, the camera ISP or the front camera can be busy with the screen off; `fps:`, `mali: GPU busy`
  and `exynos_camera: STREAM ON/OFF` are the evidence;
- the PMIC and the SoC's uncore sit in the center of the board; even unplugged, a high SoC load makes them
  hot.

The tests, all screen off, unplugged, one change at a time:

1. **Baseline log with `panel_sleep=1 sleep_cores=1`.** 10-15 minutes. Confirm the `s6e3ha8: panel_sleep:`
   lines and the `GenericARMPE: sleep_cores: cpu N taken off` lines; then read `cpufreq_gov` big/lit MHz and
   load, `tmu:` zones and `fps:`. If the M3s are off and big is cool but little is hot, the A55s are next.
2. **`sleep_cores=2`.** Also takes the A55s off after the display goes off; prove the wake before keeping it.
   If the center cools only here, the A55s (and their background load) were the source.
3. **Wi-Fi/Bluetooth off.** If the center cools, the radios are part of it.
4. **Camera/ISP.** Check `exynos_camera: STREAM ON`; if the ISP zone is the hottest, close Camera.app and any
   reader; `cam_s9=7` is lazy but a reader still starts it.
5. **`mali_gov_frame=0`** only if `fps:` shows the GPU above its floor with the screen off.

All with `tmu=3 fps_log=1 max77705_diag=1 max77705_fg_s=30` (add `max77705_wdt=1` when charging). Capture the
unplugged baseline without the PC cable attached: run it for 10-15 minutes, then connect the phone to the PC
and type `log` at the console (it reprints the kernel log from its start), or set `time_limit=900` and read
pstore in TWRP. If the PC cable is attached during the run, the PC becomes the charger and the baseline is
lost. The log's `cpufreq_gov` big/lit MHz and load, the `fps:` GPU MHz/busy/G3D, the `tmu:` zones
(BIG/LITTLE/G3D/ISP) and the `GenericARMPE: the display off` / `s6e3ha8: panel_sleep:` lines name the block
that is hot.

If the log shows big/little/G3D/ISP all under their cooling points with the M3s off and the A55s off, yet
the center is still very hot, the remaining heat is the SoC uncore, the display pipeline or the PMIC. The
boot-arg fixes are then exhausted; the next step is the kernel's `CPU_SUSPEND`/cluster power-down work
(below, "What is not implemented"), not another governor switch.

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
| GPU frame floor | 572 MHz while a frame arrived within 100 ms | `mali_gov_frame`, `GOV_FRAME_MS` |
| GPU caps | 455 MHz from 85 °C, 260 MHz from 95 °C, 5 °C hysteresis | `GOV_CAP1_MC`, `GOV_CAP2_MC`, `GOV_HYST_MC` |
| TMU stop | 110 °C SoC, 60 °C battery, three readings | `tmu_stop`, `tmu_batt_stop` |
| Battery events | 46 °C charger high, 50 °C high event, 60 °C stop | `battery_data_starlte_common.dtsi`, `tmu_batt_stop` |
| Panel / sleep | no system sleep; WFI; panel sleeps only with `panel_sleep=1`; `sleep_cores=1` after 10 s | kernel `docs_screen-off-power.md` |

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
