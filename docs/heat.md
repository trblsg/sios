# Heat on the Galaxy S9

Status: 13 November 2026. This page is the heat side of the "hot, and charging fell from 0.88 A to 0.47 A"
report. The first log (12 November) was screen-on and charging and covers two minutes. The second one (the same day,
"Second hardware result" below) is the first screen-off run: 755 s, the screen off for 4.5 minutes, Safari/YouTube
after the wake, and a hard reset at 101-102 °C — but it was charging through the PC's 500 mA port with the console
attached, so it is **not** the unplugged baseline. The third one ("Third hardware result") repeats the same shape
with hardware video decode working: 900 s, peak 96.0 °C, and a return to the loader at 916 s. Its last lines are a
panic in the console policy on the way out, not a thermal reset; the driver fix is described there. The fourth
("Fourth hardware result") is the console fix with `abox=0`: 601 s of log, 88 °C in the video band, within 1-2 °C of
the third run, so `abox=0` changed nothing measurable; the owner stopped the capture at 601 s, so the 900 s return is
still unchecked. The fifth ("Fifth hardware result") adds `mfc_zc=1`: the console fix returned cleanly at 913 s, zero
copy engaged, and the video band was 6-9 °C cooler (81/78.8 °C at 600 s, 85/81.9 °C at 870 s). But the picture stood
still: the block's DMA never raised the IOSurface seed, so the compositor kept showing a cached frame. Its 85 °C is
**not** a valid heat result. The sixth ("Sixth hardware result", 13 November) is the same zero-copy path with the
seed raised (`4fe0b7cd`): the MFC made H.264 sessions with `error 0`, the GL layer refilled the surfaces, and there
was no fallback. Its screen-off tail was 80/76.8 °C, but it is not a floor measurement: no `panel_sleep=1
sleep_cores=1`, only about 50 s with the screen off, and `com.apple.voicemail.vmd` held a core. `vmd=0` leaves that
daemon out of the next small root. The seventh ("Seventh hardware result", 13 November) confirms it: no `vmd`,
screen-off CPU 13-14%, `backboardd` 11-13% — but the clean 27-minute floor is 72-73 °C, and `sleep_cores=1` parked
nothing because the loader's device tree names no `cluster-type`; the fix is in `xnu/files/GenericARMPE.cpp` and
the next run is its A/B. The first G3D screen-off gate is in `e3501e0b` (`g3d_sleep=1`, opt-in, default
off), with runtime switches in `d836f89c`; it has not been on the phone yet, so it is the first domain patch, not a
measured result.
The idle ranking below is now ordered around the power domains and a real suspend: ABOX and polling are measured
negatives, not the next fixes. The measurements
before these were made on the development phone ("phone 2") on 5 November, and the constants are from the kernel
tree as it is on 12 November. The charging side — `CNFG_09`, AICL, the CV taper and the four cases — is in
[power-charging.md](power-charging.md).

## The short answer

The S9 under HakiOS has several independent heat sources, and the kernel sees only some of them:

| Source | What makes it hot | What the kernel does now | Where it appears |
|---|---|---|---|
| CPU, big cluster | `gov_policy=2` (the S9 default) keeps all four M3s online and allows 1794 MHz; the touch floor is 1469 MHz, the frame floor 1261 MHz while frames are moving | a ceiling that steps down from 83 °C, lowest level at 96 °C, back under 78 °C | `cpufreq_gov: ... big N MHz load N% ... temp big N C` |
| CPU, little cluster | four A55s, floor 1053 MHz (core 0 runs the loader's UFS service and is not counted as load); touch floor 1248 MHz under the scion law | same ceiling law from 76 °C, back under 71 °C | the same line, `lit ...` |
| GPU | `mali_gov=1`, 260/455/572 MHz; **572 MHz floor whenever a frame arrived in the last 100 ms**, even at 10 fps and low busy | 455 MHz at G3D 85 °C, 260 MHz at 95 °C; the floor is applied **before** the cap; the G3D domain and BUCK6 stay on unless `g3d_sleep=1` (opt-in, unvalidated) | `fps: ... gpu: ... MHz ... G3D N C`, `mali: GPU busy`, `mali: mali_gov: the G3D at ...`, `mali: g3d_sleep:` |
| Video decode | without the MFC firmware, VideoToolbox decoded H.264/HEVC on the M3s (the VENDOR partition is EROFS, so step 3 failed) | `mfc=5` with `fw/mfc_fw.bin`: the MFC decodes, VideoToolbox registers `avc1` and `hvc1` | `exynos_mfc: 3:`, `hakios: mediaserverd: the MFC's decoder registered for 'avc1'` |
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
   in WFI, the panel may still scan, and the A55s plus Wi-Fi/BT/sensor hub keep running. `panel_sleep=1` removes
   the scan; `sleep_cores=1` was meant to remove the M3s, but on 10 November and again on 13 November it parked
   nothing (the loader's device tree has no `cluster-type`), so the M3s are still untested as a screen-off term.
   The next candidates are the G3D/display domains and the A55/uncore/memory interconnect, not the panel scan
   alone.

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
| Sensor hub | `drivers/input/ssp/hakios.ssp.c` | `idle_us=4000` | 250/s | `shub=6`; `HOST_REQ` gpa1-7 is a level-high IRQ, polled; six sensors: three at 20 ms and three at 200 ms, about 165 requested samples/s |
| ABOX | `drivers/audio/abox/hakios.exynos_abox.c` | `POLL_MS 2` | 500/s | `abox=8`; step 8 `stream_run()` never returns |

The aggregate is about 2,500 checks/s, before the 40 ms CPU governor, the 1 s TMU, the 30 s gauge, user-space
timers and the display's frame thread. At roughly 10-20 us a wake, that is about 2.5-5% of one core,
plus cache/uncore effects. It is not enough, by itself, to explain a hot mainboard centre; if `lit` and `big`
are near idle in the log and the centre is still hot, the candidates are the GPU domain/BUCK6, DECON/DSIM, the
A55/SoC uncore and memory interconnect, and the PMIC, not ABOX or the pollers alone (ABOX was measured later and
is negative).

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
95 C points at the uncore, the GPU domain, the display pipeline or the charger; ABOX was measured on 12 November
and is not the term. The screen-off, unplugged case was already captured on 10 November (above), and it is the
case this ranking is about.

ABOX is more than a poller. Step 8 keeps RDMA0, UAIF1, the AUD domain and the Q-channels on; it reads RDMA0's
status every 2 ms, refills the ring with silence every 10.7 ms, and runs the speaker guard over every period,
silence included. The amplifiers stop after `QUIET_STOP_US` (3 s), but the pipeline does not. Demand-stop after a
silence grace period is still the right architectural change; the "DMA IRQ" is not a drop-in because the driver
comment says no interrupt is used and the GIC line is not set up. But the 12 November A/B (`abox=0`: 65/64.6 °C
screen-off against 64/63.6 °C with ABOX normal, video within 1 °C) says it will not move the idle floor; it is
power/architecture work now, not the first thermal fix.

The GPU is frequency-DVFS only. `mali_gov=1` switches PLL_G3D between 260/455/572 MHz, but step 2 raises
BUCK6/vdd_g3d to 950 mV and the G3D domain stays on; without `g3d_sleep=1`, `g3d_off()` is only the undo path at
unload. At 260 MHz the rail is still 950 mV. Do not copy S-Boot's 644 mV: the source records
`DATA_INVALID_FAULT` on the S9+ at that combination. The first domain patch is now in the tree: `g3d_sleep=1` (with
`mali_gov=1`) waits `g3d_sleep_ms` with no GPU job and no frame, runs the existing `g3d_off()` path and brings the
domain back through `step_power()`/`step_dtzpc()` at the first job. It is opt-in, new in `e3501e0b`, and has no
hardware result yet. Voltage-per-OPP from the G3D ASV/fvmap is the second step, not a blind write.

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

**Hardware video decode was absent, then present.** The 755 s boot log has:

```
ext4: VENDOR: cannot be read: not a file (or the partition is not ext2/3/4) (79)
exynos_mfc: 3: /firmware/mfc_fw.bin is not on the phone's VENDOR partition: no hardware video
```

The S9's VENDOR partition on Android 10 is EROFS, which the kernel's ext4 reader does not read, so MFC never started
and VideoToolbox decoded in software. That was the largest avoidable heat source in a YouTube run, and it also explains
why the README's 4 November "hardware H.264/HEVC" result no longer reproduced. This tree now fetches `mfc_fw.bin`
(682,192 bytes, sha256 `378f85ce...f368d4`) into `fw/` of the root image, and the MFC driver asks
`hakios_image_file("fw", "mfc_fw.bin")` before the VENDOR partition. The third result below confirmed it:

```
exynos_mfc: 3: mfc_fw.bin, 682192 bytes, from fw/ of the small image
exynos_mfc: 3: the firmware runs: its date 21-01-12 (kind E), the block's version 0x1200
exynos_mfc: 4: 6 frames shown, 6 with the right CRC, of 6, in 10435 us (error 0)
```

VideoToolbox registered the decoder for `avc1` and `hvc1`, the first session was H.264 640x360, and by the end the
controller had taken 567 interrupts with 0 missed.

**The reset was not the kernel's thermal stop.** `tmu_stop` is 110 C for three consecutive reads; the last `tmu:` line
is 100.0 C at 739 s, and `cpufreq_gov` reported 101.0-102.0 C at 750-754 s. There is no `tmu: TOO HOT` line and no
panic. The log ends in the middle of a line (`c`, the start of the next `cpufreq_gov` line), which is a hard reset:
the SoC's own TMU trip (RISE7 is 115 C), the PMIC, or the watchdog. The loader then restarts into recovery by design.
The battery was 47 C, below the 60 C `tmu_batt_stop`; the MAX98512s reported `BROWNOUT` at 724.5 s and 754.5 s while
ABOX was still moving 192 KB/s. Those are observations, not yet a proven cause; a loader/PMIC reset-reason register is
the missing evidence.

What was done next, one variable at a time (the third result below is step 1; step 4 is the run after it):

1. **MFC first.** Build with this tree's `firmware/mfc/mfc_fw.bin` in `fw/`, boot args unchanged (`mfc=5` is already
   there), and repeat the same YouTube run. If the two `exynos_mfc: 3` lines appear, the CPU/GPU load and the
   temperature after 5-6 minutes are the measurement. Do not add `mfc_irq=1` in the same run; test it after MFC works.
   **Done:** both lines appeared, VideoToolbox used the MFC, and the peak was still 96.0 °C; the `abox=0` run was
   done next and was negative (fourth result).
2. **Do not use the PC port as the charger for the heat run.** Run unplugged from a cool start, or on a 5 V/2 A source.
   If the console must stay attached, say so in the result; the 500 mA port changes the battery term.
3. **Screen-off baseline after settling.** Wait 10-15 minutes after boot, then lock. `panel_sleep=1` was added
   first and `sleep_cores=1` in a later run; both together on battery still left the board centre hot (10 November),
   so neither the panel scan nor the four M3s is the whole cause. Do not change both with MFC.
4. **The `abox=0` diagnostic was run (fourth result) and was negative:** 65/64.6 °C screen-off against 64/63.6 °C
   with ABOX normal, and the video band within 1 °C. ABOX demand-stop stays architecture/power work; the GPU and
   display domain gating come first. **This is the run after the third result below.**

### Third hardware result (12 November): MFC decodes, 96 °C, the return's last line

This is the run the second result asked for: kernel `mfc-fw-image` at `28fd333c` (the device repository at
`db83d83`), built by `s9-installer` run #11 (id `43250249998`, artifact `13961040707`) with `partition=SYSTEM`,
`userdata_blocks=starlte=13917184`, `time_limit=900` and `boot_args=s6sy761_irq=1 brcmfmac_poll=0`. The running
kernel is `g28fd333c`; its built-in and command-line arguments include `mfc=5` and `loader_return_after=900`. The
cable was again the PC's 500 mA port, so this is still not the unplugged baseline.

**MFC works on the phone.** The driver loaded the firmware from the small image, before the VENDOR partition:

```
exynos_mfc: 3: mfc_fw.bin, 682192 bytes, from fw/ of the small image
exynos_mfc: 3: the firmware runs: its date 21-01-12 (kind E), the block's version 0x1200
exynos_mfc: 4: 6 frames shown, 6 with the right CRC, of 6, in 10435 us (error 0)
exynos_mfc: the interrupt, 388: attached (0)
```

`/dev/hakios-mfc` exists, and VideoToolbox uses it: `hakios: mediaserverd: the MFC's decoder registered for 'avc1' (0)`
and `'hvc1' (0)`; the first session was `hakios: mfc: a H.264 session of 640x360, 2 parameter sets (0)`. By the end of
the run the controller had taken `567` interrupts with `0` answers missed. The `mfc_irq` question is settled too: the
interrupt was attached without that boot arg.

**Touch and Wi-Fi stayed on their interrupt paths.** `gpa1-0` as SPI 44 took up to 544 IRQs a minute, with 69 touches,
641 events and 1156 transfers; the Wi-Fi INTx handled 74,874 interrupts and never fell back to the poller.

| Uptime | What happened | BIG / LITTLE | Notes |
|---|---|---|---|
| 207-208 s | lock (`Set Blanked: YES`) | 66.0 / 64.6 C | `panel_sleep` was not set, so the panel and DSIM/DECON stayed up |
| 208-444 s | screen off | 64-67 / 62.6-65.6 C | M3 650 MHz, asked load 6-15%; 0 touches, 0 frames; battery 39.6 C, 99.90%, "on a charger, not charging" |
| 444-450 s | wake, Safari | 92.0 / 85.0 C at 450 s | the ceiling steps down from 83 C; the load jumps in the first seconds |
| 460-490 s | Safari | 80-84 / 78-80 C | M3 650 MHz, 70-100% busy; H.264 on the MFC from 491 s |
| 491-890 s | YouTube | 82-95 / 78-92 C | M3 650 MHz, 70-100% load; A55 455 MHz, up to 87% asked; GPU only 10% busy, G3D 69-76 C |
| 820-860 s | the hot band | 94.0-96.0 / 91.1-92.1 C | M3 650 MHz, 68-100% busy; A55 455 MHz, 0-87% asked |
| 832 s | peak | **96.0 C** | the lowest M3 rate, the lowest A55 rate |
| 916 s | timed return | - | `loader_return_after=900`; no hard reset |

**The result is about 6 °C cooler than the 755 s run, and still hot.** The previous run peaked at 101-102 °C and ended
in a hard reset; this one peaked at 96.0 °C and reached the loader. Hardware decode removed the software-decode term,
but it did not remove the load: with the MFC working, the four M3s still sat at their 650 MHz floor at 70-100% busy
and the A55s at 455 MHz with up to 87% asked, while the GPU was only 10% busy. The remaining heat is in the CPU's copy/hand-off
path, the uncore and ABOX, not in the GPU and not in software video decode. The battery went from 99.90%/39.6 C to
99.64%/43.5 C and was taking 59 mA **from** the cell at the end; the PC port cannot feed this load.

**The panic at the end was the console policy on the way out, not a thermal reset.** The log has, after
`--- loader_return_after expired ---` and the driver teardown:

```
--- panic on MPIDR 0x0000000000000200: Console I/O from interrupt-disabled context @serial_console.c:168
--- the last exception: ESR_EL1 0x0000000056000080 FAR_EL1 0x0000000100be4000 ELR_EL1 0xfffffff007485d88
--- panic() called from
  0xfffffff00742d144
```

The last driver line before it is `abox: at the run's end: RDMA0 stopped (1 us), UAIF1's SPK_ENABLE off`. The loader
still got control (`--- loader_return() from 0xfffffff0072d8818, unslid 0xfffffff0072d8818 ---`), and the TMU never
said `TOO HOT`; this is a bug in the way out, not the reason the run ended.

The cause is in `drivers/core/hakios.platform.c`: `hakios_say()` wrote each line to `loader_log_line()` (so it appears
in the loader's log) and then called `printf()` unconditionally. `loader_return()` calls `psci_smp_stop_others()`
first, which sets `DAIFSet` for all interrupts, so every quiesce step runs with interrupts off; `printf()` from that
context enters `console_io_allowed()` and panics. The UFS quiesce lines survive because they use `hc_say_late()` (the
loader's log only), and the MAX98512 quiesce printed nothing because no amplifier was playing. The `abox` line is the
first `hakios_say()` in that state.

The fix is branch `console-irq-guard`, commit `eaf877f3` on `trblsg/s-kernel` (based on `mfc-fw-image`): `hakios_say()`
always writes `loader_log_line()` and calls `printf()` only when `ml_get_interrupts_enabled()`, exactly as `tell()` in
`hakios.cpufreq.c` and the haptic, torch and camera drivers already do. The line still reaches the log the loader
gets back; only the kernel console copy is skipped. The next build includes it.

The panic frames cannot be named from the checked-in `prebuilt/hakios-kernel`: that binary says
`Darwin Kernel Version 22.5.0: Sun Oct 25 22:52:46 PDT 2026`, while this run's kernel is the 12 November build
(`Thu Nov 12 15:47:18 UTC 2026`), so its layout does not match. Keep the unstripped kernel of the next build with the
log.

### Fourth hardware result (12 November): `abox=0`, still 88 °C

Kernel `geaf877f3` (the console guard), built `Thu Nov 12 18:14:48 UTC 2026`; boot args `... mfc=5 ...
s6sy761_irq=1 brcmfmac_poll=0 abox=0`, `loader_return_after=900`. There is no `abox:` line at init or at the end: the
driver never came up, which is what `abox=0` asks. The MFC is unaffected: `mfc_fw.bin, 682192 bytes, from fw/ of the
small image`, firmware `21-01-12`, block `0x1200`, `6 frames shown, 6 with the right CRC, of 6, in 10992 us (error 0)`,
`the interrupt, 388: attached (0)`, `/dev/hakios-mfc`, `'avc1'` and `'hvc1'` registered. No panic in the 601 s the log
covers.

| Uptime | What happened | BIG / LITTLE | Notes |
|---|---|---|---|
| 116 s | first app, the peak | 91.1 / 86.0 °C | M3 1261 MHz, 100% asked; no video yet |
| 162 s | lock (`Set Blanked: YES`) | 72.0 / 70.7 °C | |
| 162-393 s | screen off | 72-65 / 70.7-64.6 °C | M3 650 MHz, 7-9% asked; the last 90 s at 65-66 / 64.6; battery 40.5 °C at 299 s, 99.74%, "on a charger, not charging" |
| 393-401 s | wake | 89.0 / 81.9 °C at 401 s | M3 1261 MHz, 98% asked; the launch spike |
| 420-601 s | YouTube | 88.0 / 86.0 °C at 601 s | M3 650 MHz, 88-100% asked, `sum big` 212-354%; A55 455 MHz; H.264 640x360 sessions at 455 and 464 s; battery 44.4 °C at 600 s, 99.44%, -21 mA, "on a charger, not charging" |
| 601 s | the log ends | 88.0 / 86.0 °C | the last line is a complete `cpufreq_gov` line; no `--- loader_return`, no panic, no new boot banner |

**`abox=0` changed nothing measurable.** At the same uptime the new run is +1.0/+1.1 °C at 570 s and +1.0/+2.1 °C at
600 s; at the same time since the video started it is within 1 °C (88/85-86 against 88/85-86). The screen-off floor is
+1 °C (65/64.6 against 64/63.6). The 91.1 °C peak is the first app at 116 s, not the video. The video band was still
rising when the log stopped (84 at 420 s, 87 at 510 s, 88 at 570-601 s), and the third run needed another 240 s of video
to reach 95-96 °C, so this log cannot say the new run would have stayed at 88 °C. What it does say is that the ABOX is
not the term to chase: with it off, the four M3s still sit at 650 MHz at 2.1-3.5 cores' worth of asked load (`sum big`
212-354%) and the A55s at 455 MHz. The heat is the video pipeline on the CPU, the MFC frame hand-off and the uncore,
not the audio DSP.

**The end at 601 s was the capture being stopped, not a reset.** The owner confirmed it. The last line is complete, the
sensors are still ticking at 601 s, and there is no `--- loader_return_after expired ---` (900 s had not arrived), no
panic and no new loader banner. The old capture ended mid-line at 849 s, the same signature of a stopped capture. The
phone did not reset; the run was cut short, so the console fix's clean return at 900 s is still unverified.

What to run next, one variable at a time:

1. **The build this list asked for was run as the fifth result below: `console-irq-guard` head `fa4ced23`,
   `abox=0 mfc_zc=1`, `time_limit=900`.** The head adds
   `/redwood/bin/cputop 5 &` to the demo job list, so every run now logs `cputop: N s: ...% in all: <process> ...%`
   every 5 s; the heat runs need the owner of the 2-3 cores the `cpufreq_gov` line reports. This one run does three
   things: the first full 900 s return (the console fix), the zero-copy copy-path test, and the per-process
   attribution. Check the picture before trusting the temperature: the one earlier zero-copy run had wrong frames, so
   `mfc_vt` at full speed and the test page's frame count first. If the frames are wrong, the return still answers the
   console question; park zero-copy and keep the cputop lines.
2. **If zero-copy is wrong or does not move the temperature**, the remaining screen-on terms are the GL layer's 314
   refills a second (about 80 MB/s) and its 171 GL calls/24 draws at 30 ms, the MFC frame hand-off and the uncore. The
   cputop line says which process owns the cores; use it before another driver change. The kernel's own `frame_out`
   copyout is only about 10 MB/s, so it is not the big term by itself.
3. **The screen-off test is not a new measurement:** `panel_sleep=1` and `sleep_cores=1` were already tried together
   on battery and the board centre stayed hot. What is left for the unplugged case is the one-peripheral A/B series
   (`bt=0`, `shub=0`, `mfc=0`, `wifi_pcie=0`) in "The idle floor" below, after 10-15 minutes of settling, unplugged
   or on a 5 V/2 A source.
4. **Do not combine** `mfc_zc` with `panel_sleep`/`sleep_cores`; one variable per run.

### Fifth hardware result (12 November): zero copy engaged, the picture stood still

Kernel `gfa4ced23` (`console-irq-guard`); boot args `s6sy761_irq=1 brcmfmac_poll=0 abox=0 mfc_zc=1`,
`loader_return_after=900`. (The CI input carried a stray `oot_args:` prefix before the first argument; the arguments
took effect.) The console fix is verified: `--- loader_return_after expired ---` at 913 s, `ufs: nufs: summary (the run
is ending, up 913 s)`, `brcmfmac: the run ends in order`, `--- loader_return() ---`, no panic. The zero-copy path
engaged: the MFC sessions at 378 and 386 s are 640x360, with no `surfaces of the block's memory are not to be had:
copying` line; during the video the GL layer logged `0 textures refilled` and `1 picture drawn in place`, and the run's
summary was `408 IOSurfaces were the textures' memory, 872 had to be copied`.

| Uptime | What happened | BIG / LITTLE | Notes |
|---|---|---|---|
| 100 s | first app, the peak | 91.0 / 82.9 °C | no video yet |
| 378-386 s | YouTube, two H.264 sessions | 80-85 / 78-82 °C | zero copy: no fallback line |
| 550 s | `cputop` during the video | 80.0 / 77.8 °C | 201% in all: `backboardd` 111%, `mediaserverd` 43%, `com.apple.WebKit.GPU` 19%, `com.apple.WebKit.WebContent` 19%, `MobileSafari` 5%; 200-224% over the band |
| 600 s | video | 81.0 / 78.8 °C | against 88.0 / 86.0 °C in the fourth run |
| 870 s | video | 85.0 / 81.9 °C | against 94 / 91 °C in the fourth run |
| 913 s | the run ends | 85 / 81.9 °C | orderly teardown; no panic |

**The 6-9 °C is not a heat result: the picture stood still.** The owner saw a frozen/repeating video, not moving frames.
The block writes the frame into the surface by DMA, which is not an IOSurface lock, so the surface's seed never rose;
the compositor (eagl's textures, and any shadow keyed on `IOSurfaceGetSeed`) saw the same seed and never loaded the new
frame. The copy path raised it every frame because `decode_unit()` locked the pixel buffer. With the picture frozen the
compositor was not copying the video frames at all, so the temperature measured a pipeline that was not showing the
video.

**The fix is `4fe0b7cd`** on `trblsg/s-kernel` `console-irq-guard`: in the zero-copy branch of `decode_unit()`, after the
ioctl returns and before the frame is emitted, `IOSurfaceLock(surface, 0, NULL)` / `IOSurfaceUnlock(surface, 0, NULL)`
raises the shared seed exactly as the copy path's `CVPixelBufferLockBaseAddress` does. No kernel change is needed; the
trap is the one `surf_test` checks (`IOSurfaceGetSeed` changes after a write lock, not after a read-only one).

What to run next, one variable at a time:

1. **`console-irq-guard` head `4fe0b7cd`, the same boot args, `time_limit=900`.** Check the picture and the frame count
   before reading any temperature: the video must move, `mfc_vt` must not repeat a frame, and the GL line must show
   refills during the video (the seed now changes). The kernel copyout is still gone; the compositor's refill is not, so
   expect a temperature **above** the invalid 85 °C, and compare it with the fourth run's 88/86 °C at 600 s and 94/91 °C
   at 870 s.
2. **If the picture moves and the temperature is still below the copy path's**, zero copy stays; the next screen-off
   variable is the one-peripheral A/B series below, not `panel_sleep`/`sleep_cores` (both already tried).
3. **If the picture moves and the temperature returns to 88+ °C**, the remaining term is the compositor's refill of the
   video surface (the same copy the copy path paid); the next change would be to let the GL layer sample the NV12
   surface directly instead of refreshing a BGRA texture, not another MFC change.
4. **Do not combine** `mfc_zc` with `panel_sleep`/`sleep_cores`; one variable per run.

### Sixth hardware result (13 November): zero copy works; the screen-off heat is `vmd`

Kernel `ga378502a` (`console-irq-guard`), built `Fri Nov 13 15:07:31 UTC 2026`; boot args `... mfc=5 ...
mfc_zc=1`, `loader_return_after=900`. This run has neither `panel_sleep=1` nor `sleep_cores=1`, and no
`fps_log=1`: it answers the zero-copy question, and its screen-off tail is a heat-soaked sample, not a floor
measurement.

**Zero copy is correct this time.** The MFC made H.264 sessions of 640x334 at 200 s and 640x360 at 209 s, each
with `error 0`; there is no `surfaces of the block's memory are not to be had: copying` line. The GL layer
refilled the video's surfaces while the picture was up (`6 textures refilled from IOSurfaces (1012 KB)`), the
five-second summary reached `300 refilled (59.8 a second)`, every frame line says `0 pictures copied out, 1
drawn in place`, and the run's summary says `0 errors; 0 frames paced, not waited for`. That is the evidence the
fifth run did not have: the zero-copy path was live and the video's surfaces were being refreshed. The logged GL
frames are 32-39 ms apart in the video band (about 26-31 fps); without `fps_log=1` the log does not prove the
player's own cadence, only that the surfaces were updated.

| Uptime | What happened | BIG / LITTLE | Notes |
|---|---|---|---|
| 100 s | first app, the peak | 87.0 / 80.9 °C | no video yet |
| 200 s | video starts | 87.0 / 82.9 °C | 640x334 H.264, `error 0` |
| 350 s | video, the peak | 93.0 / 90.0 °C | `sum big` 311-327%, A55 455 MHz |
| 600 s | video | 78.0 / 75.8 °C | `cputop` 149%: `vmd` 102%, `launchd.darwin` 29% |
| 850 s | lock, the launch spike | 82.0 / 78.8 °C | `cputop` 291%: `backboardd` 73%, `SpringBoard` 39% |
| 860 s | backlight fading, still on | 85.0 / 81.9 °C | `cputop` 385%: `backboardd` 128%, `SpringBoard` 71% |
| 864 s | `Set Blanked: YES` + 1 s | 86.0 / 81.9 °C | 0 frames in the last second, off from here |
| 899 s | screen off + 36 s | 80.0 / 76.8 °C | `cputop` 148%: `vmd` 102%, `launchd.darwin` 29% |
| 913 s | the run ends | 80 / 76.8 °C (last sample) | orderly return, no panic |

**This is not a 65 °C-floor measurement.** The screen was blanked at about 863 s and the timer returned at 913 s:
50 seconds, after a video band that peaked at 93/90 °C. With no `panel_sleep=1`, the panel still scans; with no
`sleep_cores=1`, the M3s stay up. The board is still shedding the video's heat (it fell only from 86/81.9 at
864 s to 80/76.8 at 899 s), and `cputop` says who is using the cores: `com.apple.voicemail.vmd` at 98-103%,
`launchd.darwin` at 27-30%, `backboardd` at 11-13% — about 1.5 cores for the whole screen-off tail. Closing the
apps did not stop any of them.

**`vmd` is the immediate term, not the floor.** `com.apple.voicemail.vmd` is in `/redwood/LaunchDaemons`; the
job is started on demand (`launching: ipc (mach)`, pid 207) and never exits. It asks for
`com.apple.commcenter.coretelephony.xpc` every few milliseconds, which is absent because CommCenter is denied,
so launchd writes a failed lookup each time (`Last log repeated 1784 times` at the end). It was already at
88-101% at 120 s, before the video, so it is part of the 93/90 °C video band as well as the screen-off tail. The
102% is `vmd`; `launchd.darwin`'s 27-30% is the failed-lookup log it feeds (`SpringBoard` asks for
`com.apple.commcenter.xpc` too, so some of that may remain after `vmd` is gone). It cannot work on this port:
voicemail needs CommCenter, and CommCenter needs the cellular IOKit drivers this kernel has not got.

The fix is `vmd=0`, passed in `boot_args`. The installer workflow reads it when it builds the small root and sets
`VMD=0` for `userland/build.sh`; `mkjobs.py` then adds `voicemail` to `DENY`, so the plist is not in
`root.apfs` and launchd never has a job to start. It is a build-time change: a new image is needed, and
`ALLOW=voicemail` in the userland build keeps the job for an A/B. It is not in `configs/starlte.config`.

What to run next, one variable at a time:

1. **Clean screen-off baseline after `vmd` is gone.** `time_limit=0` or `3000`, boot args
   `tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 vmd=0`, no `mfc_zc`. Boot, leave the screen on and idle for
   10-15 minutes to settle, lock it, then measure 10-15 minutes. Compare the `tmu: 8 sensors` zones and
   `cputop` at the same uptime with the 64-67 °C floor runs; this is the first screen-off run without the
   voicemail retry storm.
2. **The `vmd` A/B, if wanted:** two images with the same boot args
   (`tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1`), one with `vmd=0` and one without; change only `vmd`. Two
   images, because the token is read when the small root is built. Compare `cputop` and `tmu` at the same uptime.
   Do not add `mfc_zc` to either.
3. **G3D A/B only after that baseline:** `sysctl kern.hakios.g3d_sleep=1`, watch the gate and power-on
   lines, then `=0`; the 10 s grace sequence is `=0`, `g3d_sleep_ms=10000`, `=1`.
4. **If video pacing is the question,** add `fps_log=1` to the same zero-copy run. The current log has no
   `fps:` line, so it cannot say whether the player was at 30 fps; it can only say the surfaces were refreshed.

### Seventh hardware result (13 November): `vmd=0`, and the real screen-off floor is 72-73 °C

Kernel `gea3e2419` (`console-irq-guard`), built `Fri Nov 13 19:10:44 UTC 2026`; boot args
`... tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 vmd=0`, `loader_return_after=3000`, no `mfc_zc`. The screen was
blanked at about 468 s, came on for about 8 s at 2086 s, blanked again at 2094 s, and the run returned at 3013 s:
about 27 minutes with the screen off between the two blanks. This is the first screen-off run in which `vmd` is not
in the small root, so it is the first one that measures the rest of the floor.

**`vmd=0` worked.** There is no `vmd` line and no `com.apple.voicemail.vmd` in `cputop`; the screen-off total fell
from 146-150% to 13-14%, of which `backboardd` is 11-13%. `panel_sleep=1` is also confirmed by the
`s6e3ha8: panel_sleep: screen off: display off (28) sent, sleep-in (10) sent` lines at 468 s and 2094 s. The
remaining software term is `backboardd`, not an app: the apps had exited.

| Uptime | BIG / LITTLE | Notes |
|---|---|---|
| 600 s | 73.0 / 71.7 °C | screen off, 8% / 0% asked load, `big 650 MHz`, `lit 1053 MHz` |
| 900 s | 71.0 / 70.7 °C | `cputop` 13-14%, `backboardd` 12% |
| 1200 s | 72.0 / 70.7 °C | no `vmd` |
| 1800 s | 72.0 / 70.7 °C | G3D 70-71 °C, ISP 70-71 °C, battery 45 °C |
| 2400 s | 73.0 / 71.7 °C | `max77705`: 99.51%, 4262 mV, 0 mA, 45.2 °C, on a charger, not charging |
| 2999 s | 74.0 / 71.7 °C | still screen off; the return is at 3013 s |

**This is the real floor of this configuration, and it is not 64-67 °C.** The earlier 64-67 °C runs were not 27
minutes of a clean screen-off: some still had `vmd`, some had the panel scanning, and the 10 November run was
unplugged. In this run the biggest remaining terms are:

1. **Charger and battery.** `max77705` says the battery is at 45.2 °C, `on a charger, not charging`, 0 mA. That is
   a PC's 5 V USB port feeding the board, not a fast charger; the charger IC and the cell are heating the centre of
   the phone. The 45 °C battery is a confound, not an SoC zone.
2. **`sleep_cores=1` did not park anything.** `cpufreq_gov` still says `big ... 4 online` and `big 650 MHz asked
   load 7-9%` at 2700 s. The reason is in the device tree: the loader's `/cpus` nodes have `small-core` but no
   `cluster-type`, so every CPU is `CLUSTER_TYPE_SMP`; the fork's `sleepCoreWanted()` took only
   `CLUSTER_TYPE_P`, which is no CPU on this tree. The absent `GenericARMPE: sleep_cores: cpu N taken off` lines
   do not prove otherwise: those are `IOLog`, and `disable_iolog_serial_output` keeps `IOLog` off the serial console.
   The kernel in this run therefore left all four M3s and all four A55s online.
3. **The A55s and the domains.** The A55s stayed at 1053 MHz (0% asked load), and G3D/ISP stayed at 70-71 °C with
   the screen off. `sleep_cores=2` would take the A55s too once `sleep_cores=1` is fixed; `g3d_sleep=1` is the
   next domain gate, still unvalidated.
4. **Uncore, memory and the board itself.** With 13-14% CPU and the panel asleep, the rest is static power in the
   SoC's domains and the board; the 64-67 °C figure cannot be recovered by CPU governor changes alone.

The fix for (2) is in `trblsg/s-kernel`: `xnu/files/GenericARMPE.cpp` (copied over the fork's file by
`profiles/ios-16.5.copy`) falls back to `small-core`/`l2_access_penalty` when the tree names no P cluster, and the
cpufreq governor skips a core whose bit is in `hakios_cpu_exit_mask` so an off core is not counted as 100% busy.
The next run is the A/B for that fix, still with `mfc_zc` out: `sleep_cores=1` first, then `sleep_cores=2`, and the
same recipe once unplugged to remove the 45 °C battery term.

### The idle floor: what the A/B runs have ruled out (12 November)

The 10 November case is still the one to solve: screen off, unplugged, every app closed, brightness at its
minimum, the mainboard hot in the centre. These results narrow it:

| Test | Result | What it rules out |
|---|---|---|
| ABOX normal vs `abox=0`, same workload | screen-off 64/63.6 °C vs 65/64.6 °C; video within 1 °C at the same elapsed time | ABOX as the main idle source; demand-stop is architecture/power work, not the thermal fix |
| `panel_sleep=1 sleep_cores=1`, unplugged (10 November) | the board centre stayed hot; the 13 November run shows why: `sleep_cores=1` parked nothing (the loader's tree has no `cluster-type`) | the panel scan as the sole cause; the M3s are **not** tested until the `xnu/files/GenericARMPE.cpp` fix runs |
| touch SPI 44/INTID 76; Wi-Fi INTx SPI 253/INTID 285 | up to 806 touch IRQs a minute; 74,874 Wi-Fi INTx; no poller fallback; floor unchanged | polling as the 65 °C source (it is still an idle tax, and `s6sy761_irq=1`/`brcmfmac_poll=0` stay) |
| software decode vs MFC | 101-102 °C and a hard reset vs 96 °C peak | MFC as an idle fix; it is a video-load fix |
| screen off, M3 6-15% busiest, A55 1053 MHz at near-zero load | 64-67 °C | load and governor as the idle source; the remaining power is in domains, uncore and memory |

The fifth run does not change this table: its video was frozen, so its 6-9 °C is not a heat result. The sixth run
has live zero-copy video, but it still does not test the floor: it has no `panel_sleep=1 sleep_cores=1`, its
screen-off tail is about 50 s, and `vmd` was loading a core throughout. Remove `vmd` and run the clean screen-off
baseline above before using the sixth run's 80/76.8 °C as a floor.

No single peripheral has been removed yet, so the next step is diagnostic, not a patch. Run each of these
unplugged from a cool start, lock after 10-15 minutes of settling, one per run, and compare the `tmu:` zones at
the same uptime (the case temperature is not the measurement):

```
bt=0
shub=0
mfc=0
wifi_pcie=0
```

`bt=0` overrides the installer's `bt=7`; `shub=0` may make iOS retry its sensor services, so judge it by the
`tmu:` lines, not by a warmer case. If each run is 0-2 °C from the baseline, no single peripheral causes the
floor, and the rest is the A55/uncore/memory interconnect plus the G3D/display domains. The A55 floor A/B
(`cpufreq_gov_lit_min=949000`, then `832000`) is a useful cross-check: a 1-2 °C change confirms that clock rate
is not the lever and that deep idle is the missing piece.

The first domain A/B is the G3D gate, in `e3501e0b`; the runtime switches are in `d836f89c`. Keep
`panel_sleep=1 sleep_cores=1` as the screen-off baseline. Either flash one image per line, unplugged after 10-15
minutes of settling:

```
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 g3d_sleep=1
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 g3d_sleep=1 g3d_sleep_ms=10000
```

or flash the first line once (the gate is off) and switch it from the USB console in 10-15 minute windows:

```
# window 1: baseline, gate off (the boot's g3d_sleep is unset)
sysctl kern.hakios.g3d_sleep=1          # window 2: 3 s grace
sysctl kern.hakios.g3d_sleep=0          # back on before the next window
sysctl kern.hakios.g3d_sleep_ms=10000
sysctl kern.hakios.g3d_sleep=1          # window 3: 10 s grace
sysctl kern.hakios.g3d_sleep=0          # gate off, domain on again
```

Each command is acknowledged and logged. `=0` while the domain is off powers it back on at once; if that power-on
fails the command returns `EIO`, the gate stays on and the next job retries. `=1` wakes the job worker, which at
260 MHz with no jobs otherwise sleeps with no timeout. The grace only applies to the next gate, so the 10 s window
needs the `=0`, `g3d_sleep_ms=10000`, `=1` order. The three separate flashes are still the clean confirmation:
the board's heat carries over between windows in one run.

Compare the `tmu:` zones at the same uptime, read the `mali: g3d_sleep:` lines for the off and the power-on, and
check the first frame after wake (and a scroll) before keeping it. A gate that never fires leaves the log without
those lines; a power-on that cannot finish leaves `mali: g3d_sleep: ... did not ...: no job is run` and a frozen
picture, which is a failed run, not a cooler one.

### Two orders, not one

Heat impact for the screen-off, unplugged, centre-hot case is not the same as implementation risk. This ranking
replaces the earlier one: ABOX and polling are no longer near the top, because the A/B runs above measured them.

| Rank | Heat impact | Why it is here |
|---|---|---|
| 1 | No system sleep: no `CPU_SUSPEND`, no cluster power-down (CPD) or SoC idle clock-down (SICD); remaining A55s, uncore, PMIC | The whole SoC stays powered and leaks; `sleep_cores=1` only removes the M3s |
| 2 | GPU G3D domain and BUCK6 950 mV | Frequency falls to 260 MHz, but without `g3d_sleep=1` the domain stays on and the rail stays at 950 mV; leakage does not follow frequency |
| 3 | DECON/DSIM and the display domain | `panel_sleep=1` puts the panel in sleep-in, but the supplies, Q-channel and display clocks are not proven off |
| 4 | A55 cluster, SoC uncore, memory interconnect | The M3s have been `CPU_OFF` and the board centre stayed hot; A55 sits at 1053 MHz with near-zero load screen-off |
| 5 | Radios: BT + Wi-Fi/PCIe + sensor hub | `bt=7` keeps the chip powered; Wi-Fi/PCIe is up; `shub=6` keeps the hub MCU and six streams; the one-peripheral A/B is pending |
| 6 | MFC domain idle | `mfc=5` from boot and no runtime `pd-mfc` off; the `mfc=0` A/B is pending; MFC is proven only as a video-load fix |
| 7 | ABOX step 8 | A/B is negative (65/64.6 °C vs 64/63.6 °C screen-off; video within 1 °C); demand-stop is still worth doing for architecture/power |
| 8 | Touch/Wi-Fi polling | Both IRQ paths are validated and the floor did not move; an idle tax, not the 65 °C source |
| 9 | Camera/ISP | Lazy since 5 November, but a reader still starts it |
| 10 | Scheduler/M3 | Slow-secondary pairing, not native AMP; a longer-term placement issue |
| 11 | Thermal pressure | Makes iOS reduce work under load; not an idle heat source |

One term sits outside the ranking because it is not the floor and not a boot-time power domain: the sixth result's
`com.apple.voicemail.vmd` holds about one core and drives `launchd.darwin` while the screen is off. Remove it with
`vmd=0` before the next screen-off measurement; with it gone, the ranking below is the list to work through.

The low-risk implementation order is different:

1. **Unplugged A/B series, no patch:** `bt=0`, `shub=0`, `mfc=0`, `wifi_pcie=0`, one per run. If each is 0-2 °C,
   no single peripheral causes the floor.
2. **G3D screen-off power gating (first patch):** implemented in `e3501e0b` as `g3d_sleep=1` (with `mali_gov=1`,
   `g3d_sleep_ms=3000` by default). After no GPU job and no frame for the grace, the job worker runs `g3d_off()`,
   returns BUCK6 from 950 mV, and restores through `step_power()`/`step_dtzpc()` plus a reset and the cores at the
   first job. It is unvalidated: A/B it against the same run without it, and check the first frame after wake.
3. **MFC runtime power gating (conditional):** `pd-mfc` off when there is no decode session; power-on/re-init at the
   first decode. Do it only if `mfc=0` shows a term.
4. **A55 floor A/B:** `cpufreq_gov_lit_min=949000`, then `832000`; expect 1-2 °C and watch UFS latency. A small
   change confirms that deep idle, not the governor, is the missing piece.
5. **`CPU_SUSPEND`/CPD/SICD + DECON/DSIM clock-off:** the structural fix, and the one that turns screen off into
   standby. Highest risk; do it after the two domains have been measured.
6. **ABOX demand-stop/AUD gating:** still the right architectural change; do it for power and audio-path hygiene,
   not as the idle thermal fix. The DMA IRQ only after that.
7. **Radio power-save:** Wi-Fi power save, BT low-power/host-wake; `bt=0 wifi_pcie=0` only as a diagnostic.
8. **Remaining IRQ conversions:** BT UART and sensor `HOST_REQ`; touch and Wi-Fi are done and validated.
9. **Native AMP E/P for A55/M3:** scheduler/topology change, after suspend.
10. **Thermal pressure bridge:** useful under load, can be parallel and low priority.

## The log that names the source

Use the installer workflow's `boot_args` input. Nothing below needs a code change, but a `boot_args` line is baked into
the boot image's payload, so each one is a new installer run (the same `kernel_ref`; the workflow rebuilds, there is no
boot-args file on the phone). Where a runtime sysctl exists, one image covers the A/B: the G3D gate is the first one
(`kern.hakios.g3d_sleep`, `kern.hakios.g3d_sleep_ms`). `fps_log=1` is the one
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

For screen-off, keep `panel_sleep=1 sleep_cores=1` as the baseline (both were already tried; the floor remained)
and add one peripheral change per run:

```
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 bt=0
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 shub=0
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 mfc=0
tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1 wifi_pcie=0
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
| screen off, `panel_sleep` lines present, still warm | both `panel_sleep=1` and `sleep_cores=1` have already been tried unplugged and the board centre stayed hot; run the one-peripheral A/B series (`bt=0`, `shub=0`, `mfc=0`, `wifi_pcie=0`), then gate the G3D/display domains |
| `mali: g3d_sleep: no job and no frame for ...: the G3D goes off` | the gate fired; the next line says the domain is off and the first job will power it on |
| `mali: g3d_sleep: the G3D is on again after N ms` | the first job after the gate powered the domain back; N is the wake latency to compare with the run without it |
| `mali: g3d_sleep=1: the gate is on ...` / `mali: g3d_sleep=0: the gate is off` | the runtime switch from the console; `=0` also powers the domain back on if it was off |

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

## A timed run: 900 s, and the log it leaves

`time_limit=900` is the installer's `-t 900`: `mkinstaller.sh` puts `loader_return_after=900` in the boot arguments,
and `loader_return_timer_init()` (`osfmk/arm64/loader_return.c`) schedules the return 900 s after early boot. The phone
restarts into TWRP by itself, and the loader's pstore record holds the end of the log. The console's `return` is the
same way out by hand. A 900 s run is for one picture or one thermal band: two 10-15 minute screen-off windows plus
settling do not fit in it, so the G3D A/B below uses `time_limit=0` (manual `return`) or `3000`.

### 1. The workflow

Actions > **s9-installer** > Run workflow
(`https://github.com/trblsg/sios/actions/workflows/s9-installer.yml`), with:

| Input | Value |
|---|---|
| `kernel_ref` | `console-irq-guard` (head `ea3e2419`: the seed fix `4fe0b7cd`, the G3D gate `e3501e0b`, the runtime sysctls `d836f89c`, the `vmd=0` small-root switch) |
| `packaging_ref` | `main` |
| `partition` | `SYSTEM` |
| `boot_args` | `s6sy761_irq=1 brcmfmac_poll=0 abox=0 mfc_zc=1` |
| `time_limit` | `900` |
| `tweaks` | on |
| `userdata_blocks` | `starlte=13917184` |

Paste the `boot_args` line exactly, with no `boot_args:` prefix and no quotes. The workflow puts its own
`starlte=shub=6 bt=7` in front; do not repeat them. `mfc=5`, `mali=9` and `mali_gov=1` are `configs/starlte.config`
defaults, so this line adds only `mfc_zc=1` to the fifth run's arguments. `abox=0` is kept for comparability, not
because it cools (the fourth result says it does not). Do not add `g3d_sleep=1` here: the zero-copy picture comes
first, and the gate is a separate A/B.

The job takes about two hours; the artifact is kept for three days.

### 2. Download, decrypt, verify

Download `scion-exynos9810-installer-format-userdata` from the run page. It is a 7z archive with encrypted file names;
the passphrase is the repository secret `INSTALLER_PASSPHRASE`. On Windows, with 7-Zip installed:

```
"C:\Program Files\7-Zip\7z.exe" x scion-exynos9810-installer-format-userdata.7z
```

The archive holds the zip, `SHA256SUMS` and `README.txt`. Check the zip:

```
certutil -hashfile scion-exynos9810-installer-format-userdata.zip SHA256
type SHA256SUMS
```

The hash must match the first field of `SHA256SUMS` (case does not matter). On Linux/macOS: `sha256sum -c SHA256SUMS`.

### 3. Back up and flash

**The installer formats USERDATA and erases Android's data** (apps, photos, accounts). In TWRP, back up Boot,
`SYSTEM`, EFS and USERDATA, and copy the backup off the phone first. Keep the zip off internal storage: formatting
USERDATA unmounts `/sdcard`, and the zip reads itself while it formats. Use a microSD card or a USB OTG drive, or put
it in TWRP's RAM:

```
adb shell mount -o remount,size=3G /tmp
adb push scion-exynos9810-installer-format-userdata.zip /tmp/
adb shell twrp install /tmp/scion-exynos9810-installer-format-userdata.zip
```

Do not unpack the zip; keep `format-userdata` in its name. `adb sideload` does not work (TWRP's sideload host keeps
the size in 32 bits). The README inside the archive has the same steps.

### 4. Capture the console from the first line

The full log is the USB console, not pstore: pstore is 16 KB per record (the loader's head and the kernel's tail).
Attach the phone to the PC before the run if the PC port is the charger you want to measure (runs 3-5 did). For an
unplugged run, let it run, then plug in and type `log`: it replays the kernel's log from its start, but the 1 MB USB
output ring may drop bytes if the replay is larger than the ring, so the live capture from boot is the complete one.

On Windows the phone is `USB Serial Device (COMx)` (1209:0001) in Device Manager. In PuTTY:

- `Session` > `Serial`; `Serial line` `COMx`; `Speed` `115200`.
- `Connection` > `Serial`: `Data bits` 8, `Stop bits` 1, `Parity` None, `Flow control` **None**.
- `Terminal`: `Local line editing` **Force off**; `Local echo` **Force on** (the phone echoes the line again).
- `Session` > `Logging`: `All session output`, a fresh file such as `C:\Users\ADMIN\Documents\GitHub\sios\putty-900.log`.

Open the port as soon as it appears, before the kernel writes much; if you connect late, `log` replays what the
kernel still holds (the replay may be truncated by the 1 MB ring). There is no prompt and no echo until Enter: type
`help` and Enter; the answer is `usb> help` and the command list. If
nothing is answered, the kernel at `8901f8c3` or later prints the host's first bytes in hex; a line without `usb> help`
means the bytes did not end a line. Only one program may hold the port.

### 5. The 900 s timeline

The timer runs on kernel uptime, not on when the video starts; use the console's `uptime` and the log's
`cpufreq_gov: N s:` lines. For the zero-copy picture check:

| Uptime | Do | Look for |
|---|---|---|
| 0-100 s | boot; `help`; `sysctl kern.hakios.g3d_sleep`; `sysctl kern.hakios.g3d_sleep_ms`; `log` once; `stat` | `usb> help`; `... g3d_sleep = 0`, `... g3d_sleep_ms = 3000` (ENOENT means the image is old); `mali: came up to step 9 of 9` and `(mali_gov)` in the `fps:` lines; `stat` shows the link's counters and `0 lost` |
| ~100 s | the first app; its peak is expected | `91 °C` in the fifth run, not the video |
| ~300 s | open YouTube and play the same 640x360 H.264 video as the fifth run | the picture must move; the test page's `mfc_vt` must not repeat |
| 400 s, 600 s, 870 s | `uptime` (and `stat` if wanted); leave the video playing | `usb: up N s`; `cpufreq_gov`, `tmu: 8 sensors` and `fps:` lines continue |
| ~900 s | nothing; the timer returns | `--- loader_return_after expired ---`, `ufs: nufs: summary`, `brcmfmac: the run ends in order`, `--- loader_return() ---`; the COM port disappears |

`sysctl kern.hakios.mali` is not readable from the console (it is not `CTLFLAG_KERN`); use the `log` lines. `stat` is
the USB link's counters, not the Wi-Fi `wifi stat`. If the phone does not return by ~920 s, the tail says where it
stopped; five fingers for 1.5 s (or Vol Down + Power) returns to TWRP.

### 6. The pstore in TWRP

When the phone is in TWRP, the console's COM port is gone and adb is back:

```
adb devices
adb shell ls -l /sys/fs/pstore
adb pull /sys/fs/pstore/pmsg-ramoops-0 s9-900-pmsg.txt
adb pull /sys/fs/pstore/dmesg-ramoops-0 s9-900-dmesg.txt
```

`pmsg-ramoops-0` is the loader's head and the kernel's tail; `dmesg-ramoops-0` is the start. They are small (16 KB
each) and do not replace the PuTTY capture. If no file appears, `adb shell cat /sys/module/ramoops/parameters/*`
and the `log_pstore` node say how the zones are laid out.

### 7. Read the log

```
node tools/analyze-max77705-log.mjs s9-900.log
node tools/analyze-max77705-log.mjs --csv s9-900.csv --json s9-900.json s9-900.log
```

The tool prints the **Heat** section and writes the samples. The lines that decide the run:

```
grep -E "cpufreq_gov: [0-9]+ s:|tmu: 8 sensors|fps:|mali: GPU busy|cputop:" s9-900.log
```

On Windows:
`Select-String -Path s9-900.log -Pattern 'cpufreq_gov: \d+ s:|tmu: 8 sensors|fps:|mali: GPU busy|cputop:'`.

For the zero-copy run, read the picture before the temperature: the video must move, the test page's `mfc_vt` must not
repeat a frame, the per-frame GL line must show `refilled` during the video (`hakios-gl: frame ... textures refilled
from IOSurfaces`) and must not stay at the fifth run's `0 textures refilled`. A frozen picture invalidates the
temperature, as the fifth result says. If the picture moves, compare 600 s and 870 s with the fourth run (88/86 °C and
94/91 °C); zero copy should be above the invalid 85 °C.

The G3D A/B is separate: build `time_limit=0` or `3000` with `tmu=3 fps_log=1 panel_sleep=1 sleep_cores=1`, boot,
settle 10-15 minutes, lock the screen, then switch `kern.hakios.g3d_sleep` in 10-15 minute windows as in "The idle
floor" above. `=0` while the domain is off brings it back at once; the clean confirmation is still one flash per line.

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
9. **ABOX:** already measured on 12 November. `abox=0` did not cool the idle case (65/64.6 °C screen-off against
   64/63.6 °C with ABOX normal) and the video was within 1 °C. It is not a heat fix; demand-stop remains
   architecture/power work. iOS may retry its audio service, so any future run is judged by the `tmu:` zones, not
   by the case temperature.
10. **Voicemail daemon:** add `vmd=0` to `boot_args` when building the next image. The workflow passes `VMD=0` to
    `userland/build.sh`, and `mkjobs.py` leaves `com.apple.voicemail.vmd` out of `root.apfs`: the daemon cannot
    work without CommCenter, and in the sixth result it held 102% of a core screen-off and made `launchd.darwin`
    write the same failed lookup. It is a build-time change (new image), not a runtime switch; `ALLOW=voicemail`
    in the userland build keeps it for an A/B. Do not count it as the 65 °C floor until the clean screen-off run
    above has been made.

With a kernel at `e3501e0b` or later, the first G3D gate is also a boot arg, opt-in: `g3d_sleep=1` (it needs
`mali_gov=1`, which `configs/starlte.config` already sets) with `g3d_sleep_ms=3000` by default. From `d836f89c` the
same two are writable at run time: `sysctl kern.hakios.g3d_sleep=0|1` and `sysctl kern.hakios.g3d_sleep_ms=500..60000`
on the USB console. It is deliberately
not in `configs/starlte.config`: run the A/B in "The idle floor" before keeping it.

The one heat lever that is not a boot arg is hardware video decode: the image carries `fw/mfc_fw.bin`, and the MFC
driver asks for it before VENDOR (step 3). With `mfc=5`, YouTube no longer decodes on the CPU: the third result has
the firmware line, the 6/6 decoded frames, and VideoToolbox registering `avc1`/`hvc1`. The phone is still hot, so the
MFC is no longer the open question.

`max77705_wdt=1` is still needed for a charger that stops after five minutes, but it is not a heat fix.
`max77705_diag=1` and `max77705_fg_s=30` only read the chip.

## What is not implemented (and what it would take)

These are mostly sketches, not switches in the tree. Each needs a log first and the owner's agreement, because each
changes behaviour on a phone that is already hot. The G3D gate is the exception: it is in the tree behind
`g3d_sleep=1`, but it has not been on the phone.

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
  latency/click is the thing to measure. The `abox=0` A/B is negative for idle heat, so this is power and
  architecture work, not the first thermal fix.
- **GPU idle gating and G3D OPP.** `g3d_sleep=1` is implemented (with `mali_gov=1`; `g3d_sleep_ms` sets the grace,
   default 3000, 500..60000). It powers the domain off through `g3d_off()` after no GPU job and no frame for the
   grace, and brings it back through `step_power()`/`step_dtzpc()`, a reset, the cores and address space 0 at the
   first job. It also skips the MMU update while the domain is off, since the power-on does one full update. From
   `d836f89c` both knobs change at run time (`sysctl kern.hakios.g3d_sleep`, `...g3d_sleep_ms`), so one image can
   do the A/B. It is
   the first domain patch: smaller than full suspend and a clean A/B, but it has not been run on the phone yet.
   Per-OPP voltage still needs the G3D ASV/fvmap table; do not copy S-Boot's 644 mV, which the source records as a
   `DATA_INVALID_FAULT` on the S9+.
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
  the evidence: the remaining A55s, uncore and PMIC need a real idle state, not another governor switch. It is
  the structural fix after the G3D and MFC domain measurements, not a replacement for them.
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
| GPU rail / domain | BUCK6 950 mV fixed; G3D domain on unless `g3d_sleep=1`; no per-OPP voltage | `hakios.mali.c` |
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
