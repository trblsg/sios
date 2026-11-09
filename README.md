# Samsung Galaxy S9 (starlte, SM-G960F, Exynos 9810)

HakiOS on the Galaxy S9 the way it runs on the POCO: the phone's boot loader starts a UEFI, the UEFI starts `xnuloader`, the
loader starts XNU. Nothing of Android's virtualization is involved (that is the Pixel's route, `avf/`).

**The repository.** This is the S9's device repository: its configuration, its UEFI platform (the SoC's layer is the common repository's, `socs/exynos9810`) and
the UEFI built from it (`uefi/`, `prebuilt/`), and the image script. It is checked out at `devices/starlte` of the kernel's
common repository, [Scion-Project/scion-kernel](https://github.com/Scion-Project/scion-kernel), which names it in
`devices/manifest.conf` at a revision (`tools/hakios-device.py sync starlte`). The S9's drivers are in the common
repository, as the POCO's are: `drivers/core/hakios.exynos_hsi2c.c`, `drivers/input/hakios.exynos_keys.c` and
`hakios.s6sy761.c`, `drivers/power/hakios.max77705.c`, `drivers/gpu/hakios.s6e3ha8.c` and `hakios.mali.c`/`.cpp`; and so
are the GICv2, the loader's platform and the image packing (`mkxnuimg.py`).

**State: iOS 16.5 runs on the phone, from its own flash, as a daily-usable system.** Seen working on the phone (1 to
3 November 2026), and on by default on every image (Defaults, below):
- all eight cores, the four A55s and the four M3s (`cpus=8 bootcpu=2 m3_prep=3 pan=0 isa_floor=1`; The cores), the
  clusters' clocks moved by the governor with the load and the touch screen (`cpufreq_gov=1`; CPU clocks);
- the storage: iOS's system from SYSTEM through the kernel's own UFS driver (`ufs=3`), `/private/var` kept between runs
  in USERDATA (`ufs_write=1 var_hfs=ufs_USERDATA_data`); the RTC's time of day (`rtc_pmic=1`);
- touch, the keys, the battery and charger, vibration, the thermal watch, the kernel's live log and a console over USB,
  the whole log kept for TWRP (`esslog=1`), and every run's return to TWRP;
- the display: the GPU through Mesa's Panfrost (`mali=9`, its clock after its load, `mali_gov=1`), the frame scaled by
  the DPP (`fb_dpp=1`) and scanned out of the window server's own surface with nothing copied (`fb_zc=1`), and iOS's
  brightness slider moving the panel (`backlight=2 brightness_bridge=1`);
  the frame in the panel's own shape, 1125 x 2313 (375 x 771 points; `fb_native`, needs `libhakios.sb.dylib` from the kernel's
  version), and XNU given the low RAM bank's free memory too, 3218 MB (`extra_ram`; Memory layout);
- a passcode in Settings and on the lock screen, with iOS's delays (kernel `docs/passcode.md`; needs `passcoded` in the RAM
  disk). No Secure Enclave: with the key store on by default (kernel `docs/keystore.md`) it protects keychain items, but no
  files, and a 6-digit code falls to offline guessing by anyone who reads the flash;
- Wi-Fi: joined from iOS's Settings (WPA2), DHCP, the Internet (`wifi_pcie=6 brcmfmac=8 wifi=1`; WIFI.md);
- the front camera in the stock Camera app at 30 frames a second (`cam_s9=7 cam=5`; CAMERA.md);
- hardware H.264 and HEVC through the MFC block for VideoToolbox (`mfc=5 mfc_irq=1`; 128 MB of RAM kept for it), Safari's video seen smooth (4 November);
- the speakers through ABOX and the two MAX98512s, iOS's own sounds (`abox=8 max98512=3`; AUDIO.md); the codec, a
  CS47L93 on SPI, with its main microphone recorded through ABOX on the USB console (`cs47l93=6`, `abox rec`; AUDIO.md).

Defaults once they were built in (Defaults): the sensors, the hub in the BCM4775 read at
50 Hz and iOS's orientation and proximity from it (`shub=6`; SENSORS.md); Bluetooth in iOS, Settings'
switch through BlueTool and `bluetoothd`, and a paired device that stays connected (`bt=7`, with
`libhakios.bluetoothd.dylib`; BLUETOOTH.md); the codec's microphone as iOS's
"iPhone Microphone" (`abox_mic=1`, given for a run; AUDIO.md, "The microphone in iOS").

Not working yet: the headphones (written behind `cs47l93_hp=1`, not yet tried: AUDIO.md), the modem
(docs/modem-plan.md), the rear cameras, and the iris camera (`iris_s9=N`, off unless asked: the sensor answers, no frame
reaches memory; CAMERA.md). The
kernel's and loader's half is also tested in QEMU with the same interrupt controller (`qemu/run.sh` with `QEMU_GIC=2`).
`device.conf` is the record of what is known and what is not, and the sections below give the detail.

## How it starts

```
S-Boot (Samsung's, unlocked)  -->  boot image on BOOT      -->  HakiOS UEFI                    -->  xnuloader  -->  XNU (EL1)
  power on                          BootShim + FD + XNUP         Mu-Silicium's starltePkg,           (platform        GIC-400, 4 x A55,
                                                                 Carbon Hypervisor at EL2 (PSCI),    "starlte")       UEFI's framebuffer
                                                                 the panel's buffer as GOP
```

- **The UEFI** is [Project Silicium's](https://github.com/Project-Silicium/Mu-Silicium) `starltePkg` on the `S5E9810Pkg`
  silicon package, with HakiOS's changes (`uefi/`: the boot shim copies the payload, the boot manager starts the loader).
  It is open source throughout, unlike a Qualcomm phone's: no vendor driver is extracted from the phone. The one binary in
  it, `Hyp.bin`, is Silicium's [Carbon Hypervisor](https://github.com/Project-Silicium/Carbon-Hypervisor) (GPL-2.0), which
  takes EL2 and answers PSCI itself, because the Exynos 9810's own firmware does not do it properly. `uefi/BASE` pins a
  Silicium commit of 2026-10-09, older than Carbon's update of 2026-10-13.
- **This port's change to the platform** (`uefi/files/`): the region the payload is copied to, 0xF0000000 + 64 MB, is
  reserved in the memory map. In Samsung's device tree that is the modem's region (`modem_if`); Android's `cbd` puts the modem
  image there and the boot loader does not. It is only where the payload lands: the shim and the boot manager in the prebuilt
  UEFI are fixed to it. The loader moves the payload out first thing (`payload_move`, to 0xD0000000) and keeps the CP's and
  ABOX's memory from UEFI and XNU (Memory layout, below), so that a modem driver can have 0xF0000000-0xFB1FFFFF whole.
- **The image** (`mkxnuimg.py`, `UEFI_TARGET=starlte`): an Android boot image (header v1) whose kernel is the boot shim, the
  UEFI image and the payload, **uncompressed and without a device tree** (Samsung's boot loader takes the device tree from
  the phone's own `dtb` partition and does not unpack a gzip), as Silicium's `starlte.toml` says.

## The BSP: ExyHyperBrick's trees

The S9's drivers here are written afresh from the facts of Samsung's BSP (its LineageOS trees, by ExyHyperBrick). Each
tree is listed at the commit that was read. Scion-Project keeps a fork of the kernel, so that what the drivers cite
does not move. The kernel is GPL-2.0: it is read
for register addresses, fields and sequences, never copied into this kernel (APSL, `LICENSE` of the common repo).
A driver's "Sources" comment names files of the kernel fork at the commit below.

| Tree | Branch | Commit read |
|---|---|---|
| [`android_kernel_samsung_exynos9810`](https://github.com/Scion-Project/android_kernel_samsung_exynos9810) | `lineage-24.0` | `e5906667068e` |
| [`android_device_samsung_starlte`](https://github.com/ExyHyperBrick/android_device_samsung_starlte) | `lineage-24.0` | `bdfc23b06e4d` |
| [`android_device_samsung_exynos9810-common`](https://github.com/ExyHyperBrick/android_device_samsung_exynos9810-common) | `lineage-24.0` | `c386c0516b98` |
| [`proprietary_vendor_samsung_starlte`](https://github.com/ExyHyperBrick/proprietary_vendor_samsung_starlte) | `lineage-24.0` | `372082bbd32f` |
| [`proprietary_vendor_samsung_exynos9810-common`](https://github.com/ExyHyperBrick/proprietary_vendor_samsung_exynos9810-common) | `lineage-24.0` | `4884d8b2e4be` |
| [`android_hardware_samsung_slsi`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi) | `lineage-20-slsi` | `34f6c246e7fe` |
| [`android_hardware_samsung_slsi_exynos`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi_exynos) | `lineage-20-slsi` | `41256bda9dd8` |
| [`android_hardware_samsung_slsi_exynos_dtbh`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi_exynos_dtbh) | `lineage-23.2` | `c9bceb0d9b7e` |
| [`android_hardware_samsung_slsi_graphics`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi_graphics) | `lineage-20-slsi` | `e48c45d324c1` |
| [`android_hardware_samsung_slsi_openmax`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi_openmax) | `lineage-20-slsi` | `04b17f6f0470` |
| [`android_hardware_samsung_slsi-linaro_config`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi-linaro_config) | `lineage-21` | `bfe1bee06e1e` |
| [`android_hardware_samsung_slsi-linaro_exynos`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi-linaro_exynos) | `lineage-23.2` | `ab48fc5ba935` |
| [`android_hardware_samsung_slsi-linaro_graphics`](https://github.com/ExyHyperBrick/android_hardware_samsung_slsi-linaro_graphics) | `lineage-21` | `c7361ca484db` |

## The hardware, and where each fact comes from

| What | Value | Source |
|---|---|---|
| RAM | 4 GB: 0x80000000-0xFFFFFFFF and 0x880000000 on; secure holes taken out by Silicium's RamManagerLib | Silicium `SamsungPkg/Library/RamManagerLib`, the device tree's `androidboot.dram_info` |
| Kernel window | the largest free block UEFI reports (the loader's choice) | `xnuloader/loader.c` `choose_window()` |
| Memory layout | see "Memory layout" below | the device tree's `reserved-memory`, this port's UEFI memory map, `xnuloader/loader.c` |
| Interrupts | GIC-400 (GICv2): distributor 0x10101000, CPU interface 0x10102000 | device tree `interrupt-controller@10100000` (`arm,cortex-a15-gic`) |
| Timer | the architected timer, 26 MHz; virtual timer PPI 27 | device tree `timer` |
| Cores | 0-3 Cortex-A55 ("ananke", MPIDR 0x000-0x003), 4-7 Exynos M3 ("meerkat", 0x100-0x103); PSCI by SMC | device tree `cpus`, `psci` |
| Display | 1440 x 2960, 32 bits, at 0xCC000000 (the boot loader's buffer, `s3cfb.bootloaderfb`); S6E3HA8 panel on DSIM 0x16080000 | Silicium `starlte.dsc`, the device tree |
| Touch | Samsung S6SY761 (`sec,sec_ts`) at 0x48 on HSI2C 0x104B0000 (SPI 0x194) | device tree `touchscreen@48` |
| Buttons | GPIO keys: power, volume up and down, Bixby | device tree `gpio_keys`; Silicium `KeypadDeviceLib` |
| Storage | UFS at 0x11120000 (UFSHCI), its vendor registers at 0x11121100, UniPro 0x11110000, the protector (FMP) 0x11130000, the PHY's PMA 0x11124000; SPI 242; PMU UFS_PHY_CONTROL 0x14060724; Silicium's UEFI has UniPro at 0x11130000 (base + 0x10000), the Samsung kernel and its device tree at 0x11110000 | device tree `ufs@11120000` (its reg, `ufs-phy`, `ufs-phy-sys`); the Samsung kernel's `ufs-exynos.c`; Silicium `PlatformUfsLib` |
| GPU | Mali-G72 MP18 at 0x17500000 (GPU_ID >> 16 = 0x6221); SPI 282/281/283 (job, MMU, GPU); power domain `pd-embedded_g3d` (PMU 0x14064040/44); PLL_G3D in CMU_G3D 0x17400000 | device tree `mali@17500000`; ExyHyperBrick's kernel (G3D CAL) |

The device tree is Samsung's own (Silicium's `Resources/DTBs/starlte.dts`). Pull your phone's
(`adb shell su -c 'cat /sys/firmware/fdt'`) and compare before believing an address from it. The
[WoA port for the S9+](https://github.com/ntdevlabs/exynos9810-woa) and
[ExyHyperBrick's kernel](https://github.com/ExyHyperBrick/android_kernel_samsung_exynos9810) (GPL-2.0: read for facts, never
copied into this tree) are the references for the drivers still to write.

## Memory layout

RAM is 0x80000000-0xFFFFFFFF and 0x880000000-0x8FFFFFFFF (4 GB). Where everything is during a run, from low to high, with
where each value comes from (DT: Samsung's device tree, `reserved-memory`; UEFI: `uefi/files/.../MemoryMapLib.c`; L: the loader,
`xnuloader/loader.c`). The loader's two `layout:` lines say the run's own values.

| Range | What | Source |
|---|---|---|
| 0x80000000 + 4 KB | `sec_debug_magic` | DT |
| 0x8F000000 + 2 MB, + 256 KB, + 60 MB | the UEFI image, its stack, the DXE heap | UEFI |
| 0x91300000 + 4 KB | `zswap_debug` | DT |
| 0xA1000000 | the loader's image (`/base`), its buffers with it: the UFS page given to the kernel as `ufs_shared_pa` (0xa1456000 in a run) | L, `build.sh` |
| 0xAF800000 + 32 MB, 0xB8000000 + 2 MB, 0xC0000000 + 512 KB | `rkp_region`, `tima_region` (disabled), `seclog_mem` | DT |
| 0xCC000000 + 0x1043000 | the panel's buffer (GOP), reserved | UEFI, DT `s3cfb.bootloaderfb` |
| **0xD0000000 + 64 MB** | **the payload, moved here at the start** (a step of 64 MB up if that is taken); its last MB the panic log (`pram`) | L `payload_home` |
| 0xD4000000-0xD6FFFFFF | the display's scan-out buffers (`fb_flip`: two of the panel's size, to 0xD60A0000; `fb_dpp`: three of the display's, to 0xD71E0000 at the most of the panel's size) | `hakios.exynos_dpu.c` |
| 0xD7000000-0xD7FFFFFF | the display's pool for `fb_zc`, its first part: one slot | `hakios.exynos_dpu.c` |
| 0xD8000000-0xD9FFFFFF | the front camera's ring of four frames, camshot's still and picture (`cam_s9=4` and up): the WDMA's addresses are 32 bits, so it is here, outside XNU's RAM, mapped through IOKit | `hakios.exynos_camera.c` |
| 0xD8000000-0xD8FFFFFF | also the iris camera's raw frame (2400 x 2400 RAW8) and irshot's picture (`iris_s9=4` and up): never with the front camera | `hakios.exynos_iris.c` |
| 0xDA000000-0xDA3FFFFF | UFS's own-mode list, command descriptors and buffers (`ufs=3`; the controller is kept to 32 bits) | `hakios.ufshc.c` |
| 0xDA400000-0xDBFFFFFF | the display's pool for `fb_zc`, its second part: two slots of 12 MB | `hakios.exynos_dpu.c` |
| 0xDC000000-0xDEBFFFFF | Wi-Fi's DMA pool, only with `wifi_dma_at=0xDC000000` (off by default: the radio's memory is the kernel's own) | `hakios.lx.c` |
| 0xDEC00000-0xDFFFFFFF | the display's pool for `fb_zc`, its third part: one slot (with 0xD7000000's and 0xDA400000's, four; nothing the display scans out is at or above 0xE0000000) | `hakios.exynos_dpu.c` |
| 0xE1900000 + 30 MB | `secure_camera`, reserved | DT, UEFI |
| 0xF0000000 + 64 MB | where the shim puts the payload and the boot manager finds `loader.efi`; reserved in UEFI | UEFI, hakios-uefi `XnuLoader.h` |
| **0xF0000000-0xF91FFFFF** | **`modem_if`, the CP's memory** (its window fixed by EL3 at cold boot) | DT |
| **0xF9200000-0xFB1FFFFF** | **`cp_ram_logging`** | DT |
| **0xFB200000-0xFD9FFFFF** | **`abox_rmem`** (calliope's; calliope does not run here: the ABOX driver puts its 256 KB ring at its start, the kernel's own RAM being above 4 GB) | DT |
| 0xFDA00000-0xFF607FFF | `exynos_ss`: its header 0xFDA00000, `log_kernel` 0xFDA10000 (the kernel's log for TWRP with `esslog=1`), ..., `log_pstore` 0xFED10000 + 32 KB (the loader's RAM log and ramoops' record; reserved in UEFI) | DT, UEFI |
| 0xFF800000 + 8 MB | `fimc_is_lib`, no-map | DT |
| 0x880000000 + 2 GB | XNU's RAM: the largest free block (`physBase`, `memSize`); in it the kernel at +48 MB, the ramdisk after it, the device tree (64 KB) and `boot_args` after that | L `choose_window`, `run_kernel` |
| the free pieces of 0x80200000-0x8EFFFFFF, 0x98000000-0xCBFFFFFF (less `rkp_region`, `tima_region`, `seclog_mem`) and 0xE3700000-0xEFFFFFFF | XNU's RAM too, beside the window: about 1170 MB in 7 ranges, for 3218 MB in all (below) | L `extra_ram_claim`, kernel patch 1512 |

The kernel's ranges from 0xD0000000 to 0xE18FFFFF, and the keep-outs above, are one table in the common repository,
`xnu/files/bsd/sys/hakios.exynos9810_mem.h`, which the display, the camera and UFS take theirs from, with checks at build
time that no two overlap (until 3 November the display's `fb_zc` pool ran from 0xD7000000 up to `secure_camera`, over the
camera's, UFS's and Wi-Fi's ranges).

The three ranges in bold from 0xF0000000 to 0xFD9FFFFF are the platform's keep-outs: at the start the loader takes every free
page of them from UEFI as reserved memory (`keep_out_reserve`), so nothing UEFI hands out while it stays alive beside the kernel
lands there, and XNU's window is never allowed to cover them; nor is any of the extra RAM below.

### The low bank's free RAM: XNU's too

The window is the 2 GB bank from 0x880000000; the low bank's free RAM, about 1.1 GB of the other 2 GB, is the kernel's as
well. Apple's XNU knows one bank (`[physBase, physBase + memSize)`, the pmap's tables indexed from `physBase`), so the kernel
has a patch for it (`xnu/patches/1512-arm-extra-ram.patch` in the common repository): the loader names the extra ranges in
the device tree (`/chosen` `hakios-extra-ram`, pairs of base and size); `arm_vm_init()` maps them in the physical aperture
(more `ptov_table` entries) and counts them in `max_mem`; the pmap gives their pages indices after the window's
(`pa_valid()`, `pa_index()`), so they are managed pages like any other; and `arm_vm_prot_finalize()` gives them to the VM
before `bsd_init()`, as `vm_page_create()` pages (the way `ml_static_mfree()` gives back the kernel's boot memory), so that
jetsam's and the pageout daemon's levels count them. `hw.memsize` says the sum.

Where it may come from is a list in the loader (`exynos9810_extra_ram`; on by default on the S9, the S9+ and the Note9,
which have not been seen with it, only with `extra_ram=1`), and only what UEFI's
memory map calls free there is taken (`extra_ram_claim`): 0x80200000-0x8EFFFFFF (`sec_debug_magic` at 0x80000000 kept),
0x98000000-0xAF7FFFFF, 0xB1800000-0xB7FFFFFF, 0xB8200000-0xBFFFFFFF and 0xC0080000-0xCBFFFFFF (`rkp_region`, `tima_region`,
`seclog_mem` between them), 0xE3700000-0xEFFFFFFF (from the end of `secure_camera` to the CP's). Never in it: the UEFI image,
its heap and 80 MB more for UEFI's allocator, which stays alive beside the kernel (0x8F000000-0x97FFFFFF, `zswap_debug` with
them); the loader's image at 0xA1000000; the secure holes Silicium's RamManagerLib takes out of the map and whatever else the firmware holds (in the run below
0xBC800000-0xBFFFFFFF was not free); the panel's buffer; every range of `hakios.exynos9810_mem.h` (0xD0000000-0xE18FFFFF); `secure_camera`;
and everything from 0xF0000000 (the keep-outs, `exynos_ss`, `fimc_is_lib`). The pieces are taken from UEFI as reserved
memory, and each 16 KB page is written at both ends and read back from the RAM itself (out of the cache) before it is given:
a piece that reads back wrong stays out. `extra_ram=0` among the kernel's arguments leaves it all out (the window alone, as
before). The loader's third `layout:` line names the ranges.

Seen on the phone (3 November, `ram-a` and `ram-c`, the daily's arguments): "extra RAM: 1170 MB in 7 ranges taken from
UEFI beside the window (7 pieces free, 0 MB failed the test)", "layout: extra RAM for XNU: 80200000..8effffff
98000000..a0ffffff a1994000..af7fffff b1800000..b7ffffff b8200000..bc7fffff c0080000..cbffffff e3700000..efffffff
(1170 MB); XNU's RAM in all 3218 MB"; `sysctl hw.memsize` 3375284224 (2147483648 before), iOS's "memory 3218 MB". With
SpringBoard, the camera's stream and Wi-Fi up, the kernel's memory line at three to five minutes: "free 434-458, files
1632-1646, programs 588-621, wired 513-518 ... compressor 0 (holding 0) MB; available 2067-2104, kills below 282 (the idle)
and 125 (anybody)", where the daily (the same arguments, the window alone) says "free 12-22, files 766-776, programs
672-675, wired 539-541 ... compressor 34 (holding 120) MB; available 787-789, kills below 196 (the idle) and 98 (anybody)":
jetsam's levels rise with `max_mem`, and the room above them is 1.3 GB more. (`ram-a` counted the extra pages as wired
too, "wired 1695": `vm_page_bootstrap()` had counted every page of `max_mem` not free then as wired; the patch takes them
off again, as `ml_static_mfree()` does its own, and `ram-c` says 517.)

The drivers whose DMA engines have 32-bit addresses (the camera's WDMA, UFS's own mode, the display's) still take the
fixed ranges of `hakios.exynos9810_mem.h`; with RAM of the kernel's own below 4 GB now, they could take it from the VM
instead.

## The cores

Cores 0-3 are Cortex-A55s (MPIDR 0x000-0x003). Cores 4-7 are Exynos M3s (0x100-0x103, 2.7 GHz), which Carbon's PSCI
starts. The loader numbers them through `platform_starlte.core_mpidr`. `cpus=2 bootcpu=2` (the SoC's own
configuration, and what a bare line `mkimage.sh -n` falls back to) gives the kernel A55s 2 and 3; the S9's defaults give it
all eight (below). Seen on the phone from 30 October 2026:

- core 1: S-Boot starts it for its own display work ("[boot_exynos] Powers up core(1)", then log lines headed `[1:`) and has
  it off again by the hand-over. The first run on this phone (29 October) started the kernel on it, got nothing back, and took
  it for a core that never comes; that kernel had no patch 1504 yet, so it read core 1's MPIDR (0x81000100) as an M3's number.
  With patch 1504 CPU_ON for it answers 0 and the core is in the kernel 1.1 ms later (seen 3 November). `core1=1` lists it
  (`platform_starlte.parked_cores` leaves it out otherwise; below);
- the M3s: the firmware's CPU_ON for one (Carbon, then Samsung's EL3) never returns, and the processor that asked stays
  inside it for good (patch 1505's log). The likely reason, from source (below): six PMU fields of the big cluster that
  Samsung's kernel writes before it starts any other core, and nothing here did. `m3_prep=N` writes them;
- the A55s' own MPIDR has them one affinity field up (core 2 reads 0x81000200, MT set) from the numbers the device tree and
  the firmware use (0x2); the kernel notices and translates (patch 1504).

Why the M3s' CPU_ON hung, and what goes first (`m3_prep=3`: seen working, six cores, 2 November). Samsung's kernel, before `smp_init`, runs the
PMU's "lpm init" sequence (`pmucal_lpm_init`, from `cal_if_init` in the clock driver's init); six of its entries are the
big cluster's: `CPU_QCH_CLUSTER1_NONCPU_SYS_PWR_REG` (PMU +0x1088) [31:24] = 0x8D, and `MEMORY_CLUSTER1_CPU0..3_OPTION`
(+0x2114, +0x2180, +0x21EC, +0x2258) and `MEMORY_CLUSTER1_NONCPU_OPTION` (+0x2384) [1:0] = 2 (BSP
`drivers/soc/samsung/cal-if/exynos9810/flexpmu_cal_system_exynos9810.h`, lines 4 and 29-33). S-Boot leaves 0xC7 and 1 there.
The mainline Linux port to the S9+ found that without these writes CPU_ON for an M3 answers 0 and the core never
arrives, and with them all eight cores come up (its `scripts/build/patch_tree.py`, "M3 cluster: vendor PMU defaults
before PSCI CPU_ON"); behind Carbon the call does not answer at all, as Samsung's EL3 seems to wait for the core it starts
(an A55's CPU_ON answers 76 us after the call, 9 us before that core is in the kernel). Nothing else is done to the big
cluster before its first CPU_ON on Android: the hot-plug callbacks (`exynos-powermode.c`) run on the new core once it is
up, ACPM and cpufreq start later, and `uh_init` is not configured in this BSP. Nothing in Silicium or Carbon touches
the cluster (Carbon forwards CPU_ON to EL3 through a trampoline, the same for both clusters).

`drivers/core/hakios.exynos_m3.c` (patch 1508 asks it before every CPU_ON) does it in steps, each logged before it is
taken: `m3_prep=1` reads and logs the cluster's PMU state, the six fields, the cpucl0/cpucl1 DVFS rates and BUCK2/BUCK3
(vdd_cpucl1/vdd_cpucl0) before the first CPU_ON of the boot; `m3_prep=2` also writes the six fields, only those bits,
each read back; `m3_prep=3` also lets the M3s be started. Steps 1 and 2 are for `cpus=2 bootcpu=2`; below 3 an M3 the
kernel is given is refused (not started), not hung on. The S9+ port also found that an M3 does not come back after a
CPU_OFF, nor from a cluster power-down: this kernel idles with WFI and starts each core once.

The M3s implement ARMv8.0, while the A55s and the iPhone X's A11 implement 8.2. That does not keep iOS off them: a count
over three files of the iPhone X's shared cache (57.6 million words) found 7088 `LDAXR`s and 7208 `STLXR`s, the 8.0 way of
doing atomics, while `CAS`/`LDADD`/`SWP` turn up no more often than random bytes would. What remains is code that asks
which features the processor has (`hw.optional.arm.FEAT_*`) and then uses them. XNU answers from the core it boots on, so
**a kernel with the M3s boots on one: `bootcpu=4 cpus=8`.** It then reports no more than every core can do, runs on
the big cores first, and leaves core 0 to the loader, which is also what the storage needs (below).

Seen on the phone (2 November 2026): **six cores run iOS, booted on an A55: `cpus=6 bootcpu=2 m3_prep=3 pan=0`** -- A55s 2
and 3 and the four M3s. Two things were needed beyond `m3_prep=3`'s writes: `pan=0` (patch 1509: PAN is ARMv8.1, and
every PAN instruction is UNDEFINED on an M3, starting with `arm_init_cpu()`'s first), and patch 1510's `isa_floor`, on by itself with
`m3_prep>=3`: user space is told only the ARMv8.0 set every core has (ID_AA64ISAR0 lowered to AES, PMULL, SHA1, SHA2 and
CRC32; nothing of ISAR1, MMFR2 or PFR1; PFR0's FP and AdvSIMD without half precision). Without it launchd, told the A55's
8.2 set, was killed with SIGILL once it ran on an M3. `m3_diag=1`, `m3_flush=1` and `m3_ids=1` (patch 1509) are the
diagnostics used on the way (patch 1509 also maps esslog's buffer uncached, so that a hard hang keeps its last lines);
none is needed for the boot. Booting on an M3 (`bootcpu=4`) has not been tried.

**All eight: `cpus=8`, with `ufs=3`** (seen on the phone, 3 November 2026: `hw.ncpu` 8, `hw.activecpu` 8, the governor's "lit
... 4 online ... big ... 4 online"). On this SoC the loader takes `cpus=8` for `core1=1` and, with `ufs=3`, `core0=1`, which the
line has no room to say (607 characters); `core0=0` keeps core 0 the loader's. Core 1 starts as core 3 does, by CPU_ON, 28 s into the run with the other
slower cores (`small_cores_after=`). Core 0 is the loader's for as long as the kernel needs it: it serves the storage
(`ufs=3` up to the switch), feeds the watchdog, watches the kernel's heartbeat and writes the log on a hang. After `ufs=3`'s
switch the kernel needs none of that, and with `core0=1` it takes the core (patch 1513, `osfmk/arm64/psci_smp.c`;
`xnuloader/loader.c`, `core0_into_kernel`):

1. the loader lists its own core last among the kernel's (`cores for the kernel, in the order it takes them: 2 3 1 100 101
   102 103 0`) and writes its MPIDR into the kernel's box; the kernel does not start it ("psci: cpu 7 (MPIDR 0x0) is the boot
   loader's core (core0=1): not started now");
2. once the loader only watches (24 s in) it offers the core, with where it comes back to and the watchdog to feed;
3. after the switch ("ufs: nufs: step 5: switched"), or when the core gets its number if the switch came first, the kernel
   asks: "psci: cpu 7, the boot loader's core: nothing needs the loader any more (core0=1); asking for it";
4. the loader quiets its timers and its half of the GIC, empties its caches and jumps to the kernel's entry with its MMU off,
   as CPU_ON would have started the core: "psci: cpu 7: stage 3 after 1035 us (the loader: 3)", "psci: cpu 7: the loader's core
   has joined: 8 processors are running (hw.ncpu 8)";
5. the kernel feeds the cluster watchdog every 10 s from then on (the loader armed it for 60 s); a request to the loader's
   storage service fails at once ("ufs: a request to the loader ..., whose core is the kernel's now: refused");
6. on the way out (the console's `return`, `loader_return_after=`, a panic) the core is not switched off but given back
   ("psci: cpu 7 (the boot loader's core) goes back to the loader"); the loader takes up its watch and the run ends as before
   (the log into the pstore RAM, the restart into recovery).

While the kernel has the core, a whole-system hang is the watchdog's to catch (a restart into BOOT, the run again), not the
loader's: no "THE KERNEL HUNG" log in the pstore, and what is left of the kernel's log is in `exynos_ss` with `esslog=1`. The
governor, the thermal limits and `isa_floor` take the two new cores as they take the others: all three go by cluster and by
which cores have been idle. Without `core0=1`, or with `ufs=2`, nothing changes: the core stays the loader's. `core0=2`
asks for the core at once, for a loader that serves the kernel nothing (QEMU, `QEMU_GIC=2 QEMU_SMP=8`, `cpus=8 bootcpu=1
core0=2`); on this phone the storage still needs the loader then, so it is not for here.

## Build

In the kernel's common repository, with this repository at `devices/starlte` (`tools/hakios-device.py sync starlte`):

```sh
make unpack IPSW=/path/to/iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw   # your own IPSW, once (sysimage/unpack.sh)
make starlte_defconfig && make kernel        # the common kernel, no driver of another phone (configs/starlte.config)
make loader                                  # with the iPhone identity from your own IPSW
(source ./xnu-env.sh; cd userland && GL=1 NO_AIR=1 REST=1 ALONE=1 bash build.sh)   # the small root, the whole root here (ALONE=1)
devices/starlte/mkimage.sh -s 120            # xnu-starlte.img: the shim, the UEFI, the loader, the kernel, the small root, the defaults
devices/starlte/mkimage.sh -s 300 fps_log=1 wifi=     # the same, a diagnostic added and Wi-Fi's station dropped from the defaults
devices/starlte/mkimage.sh -s 300 -n cpus=2 bootcpu=2 # only these arguments, none of the defaults (a first run of something)
```

The S9's vendor firmware (ABOX's, Wi-Fi's, Bluetooth's, the sensor hub's: `firmware/*/`) is not in this repository, only its
sums. `tools/fetch-firmware.sh` fetches it and checks it (from your own copy with `--from DIR`, else from the public vendor
trees pinned in the script), and the `DEVICE=starlte` step of `userland/build.sh` runs it when a file is missing, so the
commands above need nothing more; run it by hand to do that first, or `--check` to see what is missing.

To install iOS on the phone's flash with one TWRP zip, build the system image too (`make images`), then use
[scion-installer](https://github.com/Scion-Project/scion-installer)'s `build-installer.sh` (Storage, below).

Samsung has no `fastboot boot`, and Silicium's UEFI has no USB gadget, so there is no resident loader to send runs to as
on the POCO (the kernel's own USB link, below, gives the log and a console, not a way to send runs). Each run is an image, and the run returns to the loader by itself after `-s` seconds. The loader then keeps
the log in RAM and restarts the phone. The UEFI comes from `prebuilt/` (built from source, open throughout:
`prebuilt/README.md`), or from `Mu-Silicium/` when one is built here (`devices/starlte/uefi/apply.sh`, then
`build_uefi.py -d starlte -r RELEASE`).

## Defaults

What has been seen working on the phone is on by default: every image `mkimage.sh` makes carries the S9's default
boot-arguments, which are `configs/starlte.config`'s (its last part, "The S9's defaults"; `tools/hakios-config.py args
--defconfig starlte_defconfig` prints them). No other device's defaults change with them.

```
cpus=8 bootcpu=2                                        all eight cores (The cores)
m3_prep=3 pan=0 isa_floor=1                             what the M3s need (The cores)
exynos_keys=1 max77705=1 panel=1 s6sy761=1              the keys, the battery and charger, the panel, touch
max77705_usbsw=1 usb_gadget=5                           the USB-C port to the SoC, the log and console over USB
cpufreq_gov=1 mali=9 mali_gov=1                         the CPU governor (and touch boost), the GPU and its clock
max77705_haptic=1 tmu=3 esslog=1                        vibration, the thermal stop, the log kept for TWRP
poster_retry=2 backlight=2 brightness_bridge=1          SpringBoard's poster; iOS's brightness slider to the panel
ufs=3 system_apfs=ufs_SYSTEM                            the kernel's own UFS driver; iOS's system from SYSTEM
ufs_write=1 var_hfs=ufs_USERDATA_data                   /private/var kept in USERDATA (a memory filesystem if it holds no HFS Plus)
fb_dpp=1 fb_zc=1 rtc_pmic=1                             scaling by the DPP, zero-copy scan-out, the RTC's time
cam_s9=7 cam=5                                          the front camera, for the Camera app
abox=8 max98512=3 cs47l93=6                             the speakers; the codec and its main microphone
wifi_pcie=6 brcmfmac=8 brcmfmac_poll=1 brcmfmac_tcm_idx=1 wifi=1    Wi-Fi, joined from iOS's Settings
```

Arguments given to `mkimage.sh` go over them, word by word: `name=value` replaces the default of that name where it
stands, a name with no default is added, `name=` (nothing after the =) takes a default out, and `-n` leaves all of them
out. The kernel, the loader and user space each take the first of two words with one name, so a default is replaced,
never just followed. Diagnostics are never defaults: `fps_log`, `systrace`, the `*_probe`, `*_log` and `*_trace`
arguments are given for a run. What only the kernel reads is built into the kernel (`CONFIG_BUILTIN_ARGS`): given on the line, such an argument goes over its built-in
value, and to turn one off give it as 0 (`name=` does that for you). The line itself holds about 140 characters of the 607, the loader adds
about 110 and `mkimage.sh` about 45, and `mkimage.sh` warns when a line would not fit (the end of it would be cut). `-n` leaves out only what is on the line.
A driver goes into the defaults once it has been seen working on the phone, in `configs/starlte.config`, and this list,
`device.conf` and scion-installer's installers (which give only `system_apfs=`) follow it. The sensors (`shub=6`,
SENSORS.md), Bluetooth (`bt=7`, BLUETOOTH.md) and the microphone in iOS (`abox_mic=1`, AUDIO.md) have been seen
working and are defaults.

## On the phone

**First, the backups. Samsung has no `fastboot boot`, so every try is a flash.**

1. Make sure the bootloader really is unlocked: Download mode (Vol Down + Bixby, then plug in USB) shows `OEM LOCK: OFF`.
2. In TWRP, or with root, back up `EFS` (the IMEI: losing it is permanent), `BOOT` and `RECOVERY` to the computer.
3. Flash the image to **BOOT** and keep TWRP in RECOVERY, as the WoA port for the S9+ does: TWRP is where the log is
   read after a run and where Android is put back. From TWRP: `adb push xnu-starlte.img /sdcard/`, then Install, Install
   Image, Boot (or `heimdall flash --BOOT xnu-starlte.img` from Download mode).
4. Power on: HakiOS starts. A run restarts the phone into recovery when it ends (the loader sets the reset reason
   S-Boot reads, PMU INFORM2 = 0x12345678 and INFORM3 = 0x12345674, as Android's `reboot recovery` does, right before
   it restarts the phone with the PMU's software reset, SWRESET, as Samsung's kernel does; `recovery=0` turns it off),
   so TWRP comes up with the log still in RAM. S-Boot's log in TWRP (`/proc/last_kmsg`) then reads `SW_RST
   (0x20000000)` and `INF3: 12345674`. The cluster watchdog's reset (`WDT_RST2 (0x800000)`) is different: S-Boot finds
   INFORM2/3 cleared after it and starts BOOT, the run again. That is what a hang of the whole phone ends in, and what
   every run ended in before the loader restarted with SWRESET itself (its echo of the kernel's log on the screen
   outlasted the watchdog). If the phone hangs or comes back into HakiOS, hold Vol Down + Power until it restarts,
   then at once Vol Up + Bixby + Power for TWRP. Android back: restore the BOOT backup in TWRP.

The default command line (Defaults, above, and `-v` from `mkimage.sh` unless `-q`) runs the kernel on all eight cores. Core 0
is the loader's until `ufs=3`'s switch, while it serves the flash and watches: a hang before that has its log written into the
pstore RAM and the phone restarted. After the switch the core is the kernel's, and a hang is the watchdog's to catch (a restart
into BOOT; `esslog=1` keeps the kernel's log in `exynos_ss`). `core0=0` keeps the core with the loader for a run whose hang you
want the log of. `-v` shows the kernel's log on the screen while it starts.

What to look for, in this order:
1. Scion's logo (the UEFI started).
2. The loader's banner (SCION, `hello scion-kernel!`), with `platform starlte, GICv2` and `CurrentEL=1` (Carbon has EL2).
3. The kernel's log, `gic: v2 ... cpu 0 is interface 2` (the kernel starts on core 2), `6 of 6 processors are running`.
4. launchd.

With `splash=1` among the arguments (kernel `docs/boot-screen.md`; not a default, not yet seen on a phone) the screen shows the
Scion sprout with a thin progress line and the kernel's last few lines in dim text instead of 2 and 3. `-v`, or Volume Down held while
the phone starts, gives the full log on the screen as above.

Photograph the screen as well. The loader's `logdump` is a Qualcomm partition, and this phone has none. Instead, the
loader keeps the log in Samsung's pstore RAM (0xFED14000, 16 KB: the head of the loader's log and the tail of the kernel's),
which a restart leaves alone. Restart into TWRP or Android (Vol Down + Power) and read it:
`adb shell su -c 'ls /sys/fs/pstore; cat /sys/fs/pstore/pmsg-ramoops-0'`. If no file shows up there, the phone's own kernel
lays the zones out differently: `cat /sys/module/ramoops/parameters/*` and the `log_pstore` node say how, and
`platform_starlte.ram_log` in `xnuloader/loader.c` is the one number to change.

The pstore's first half (0xFED10000, 16 KB) is ramoops' one dmesg record. The loader writes the start of the kernel's
log there, behind the header line ramoops needs, so a run that comes back leaves `dmesg-ramoops-0` (the start) beside
`pmsg-ramoops-0` (the loader, then the end). Before the panic buffer exists (`arm_vm_init`), a panic's text, the last
exception's ESR/FAR/ELR and the frames that led to it go straight into that log (patch 1503). With boot-arg
`early_log=1`, every kprintf from `PE_init_platform` on and the processors as the kernel sees them (MPIDR, the
topology's phys ids) go there as well. That's for a phone that dies before its console works, at the cost of filling
the 32 KB sooner.

## Building in CI: the installer in one click

Actions > **s9-installer** > Run workflow (`.github/workflows/s9-installer.yml`). One job, about two hours on GitHub's
Ubuntu runner:
1. It downloads iOS 16.5 (20F66) for iPhone10,3 from Apple's CDN, checked by size and hash, and unpacks it.
2. It builds the S9 kernel, the loader with the iPhone identity, Mesa, the small root and the system image.
3. It makes the TWRP installer (scion-installer), with the system image going to SYSTEM unless the run says
   otherwise. The installer also formats USERDATA as HFS Plus and makes `/private/var` persistent, which is what
   lets the jailbreak prefix survive a boot. **This erases Android's data in USERDATA.**
4. The prefix carries the Procursus bootstrap with Sileo. With `tweaks` on (the default) it also carries ElleKit
   and PreferenceLoader; in both cases it carries `ipainstaller` at `/var/jb/usr/bin/ipainstaller`
   ([docs/IPA.md](docs/IPA.md)).

The artifact `scion-exynos9810-installer-format-userdata` is a 7z archive, AES-256 with its file names hidden. Its
passphrase is the repository secret `INSTALLER_PASSPHRASE`, and the job refuses to run without it. The installer
carries iOS's own files, and anyone signed in to GitHub can download a public repository's artifacts. Artifacts are
kept for 3 days.

To use it:
1. Download the artifact.
2. Open the archive with the passphrase (`7zz x scion-exynos9810-installer-format-userdata.7z`, or Keka / 7-Zip).
3. Check `SHA256SUMS`.
4. In TWRP, back up Boot, SYSTEM, EFS and USERDATA first and copy the backup off the phone. **This installer
   erases Android's data in USERDATA** (apps, photos, accounts); that is what makes `/private/var` persistent.
5. Flash `scion-exynos9810-installer-format-userdata.zip` from TWRP as it is. Keep `format-userdata` in its file
   name: TWRP's update-binary refuses the zip without it.
6. Reboot. Sileo appears on the home screen after about 30 seconds (the prefix is copied to `/var/jb`); see
   [docs/IPA.md](docs/IPA.md) for `ipainstaller`.

The run's inputs: the kernel and packaging refs, the partition, extra boot-arguments, the time limit, `tweaks`
(default `true`, ElleKit and PreferenceLoader), and `userdata_blocks` (default `starlte=13615227`, in 4096-byte
blocks; **it formats USERDATA**, so the size must match the phone). 13615227 blocks is the S9 64 GB's
55,767,969,792-byte USERDATA; for the S9+ or Note9 add their sizes (`star2lte=... crownlte=...`), or the installer
refuses `-U` on those phones.

## Storage: iOS from the phone's flash

**The installer:** [Scion-Project/scion-installer](https://github.com/Scion-Project/scion-installer) `build-installer.sh`
makes one TWRP zip for the S9, S9+ and Note9. On the S9 it writes the boot image (`-s 0`, `ufs=2 system_apfs=ufs_SYSTEM`) to BOOT and `userland/system.apfs`
to SYSTEM, then checks both by SHA-256. On boot, init mounts the system image from `/dev/ufs_SYSTEM` and makes it the
root, and the boot goes on as a RAM boot does. This is rehearsed in QEMU up to SpringBoard (GICv2, 4 GB, a GPT
partition read through the loader). The small root for it is built with `ALONE=1 RC=rc.launchd`.


Silicium's UEFI drives the UFS and stays resident. With `ufs=2` (or `ufs=3`, the default, until its switch), the loader keeps core 0 and reads for the kernel, which runs on cores 2 and 3: the same
service the POCO uses (`drivers/storage/hakios.ufs.c`). Every GPT partition becomes `/dev/ufs_NAME`, read-only, and
`root_apfs=ufs_NAME` mounts iOS's root volume from one.

The iOS system image (`userland/system.apfs`) needs a partition of its own, written once from TWRP:
`adb push system.apfs /tmp/ && adb shell dd if=/tmp/system.apfs of=/dev/block/by-name/NAME bs=4M`. Which partition
decides what is lost:
- `SYSTEM`: Android stops booting, TWRP still works.
- `USERDATA`: Android's data is wiped.

List the partitions and their sizes first: `adb shell ls -l /dev/block/by-name`.
Then: `devices/starlte/mkimage.sh -n cpus=2 bootcpu=2 exynos_keys=1 ufs=2 root_apfs=ufs_NAME`. Nothing writes to the flash: `ufs_write=1` is for the
POCO's `darwin` partition only, and the loader refuses any other.

**The kernel's own UFS driver** (`drivers/storage/hakios.ufshc.c`, `ufs_native=4 ufs_native_soc=exynos9810` by hand, or
through `ufs=3`, the default, below) drives the controller itself instead, with no core kept back for the loader. It does not
reset or bring up anything: it takes the controller as Silicium's UEFI left it (HS-G3, two lanes), reads back what UEFI set
up, and gives it back as it was at the end. It goes in steps, `ufs_native_step=N`, 1 by default:

| Step | What it does | What it writes |
|---|---|---|
| 1 | look: UFSHCI and vendor registers, the PHY's power (PMU), the device's reset line, the clock gating, IO coherency, UEFI's own descriptors (their PRDT entry size: the FMP's descriptor type) | nothing |
| 2 | the link: lanes, gears, power mode and series by DME_GET; UniPro's last results; the PHY's calibration read back | DME_GET's registers only |
| 3 | NOP OUT through the kernel's own transfer list, then UEFI's list back | its own list |
| 4 | each unit's descriptor, TEST UNIT READY, READ CAPACITY; UEFI's list back | its own list |
| 5 | LBA 0 and each unit's GPT; `/dev/ufs_NAME` for every partition, read only | its own list |

It is read only. `ufs_native_write=NAME` alone makes one partition writable, and never EFS, SEC_EFS, CPEFS, BOOT, RECOVERY,
PARAM, PERSISTENT, STEADY, RADIO or the rest of the boot chain (the list is in `drivers/storage/hakios.ufs.c`), nor a
boot or write-protected unit; the controller's driver refuses any write outside that partition's blocks again. Leave it
unset. Without `ufs=2`, the root comes from the image (the small root, `-s`). The first runs, one image each, the log read
in TWRP after each (with `-n`, which leaves the defaults' `ufs=3` and the rest out):

```sh
devices/starlte/mkimage.sh -s 60 -n cpus=2 bootcpu=2 ufs_native=4 ufs_native_soc=exynos9810                     # step 1
devices/starlte/mkimage.sh -s 60 -n cpus=2 bootcpu=2 ufs_native=4 ufs_native_soc=exynos9810 ufs_native_step=2   # the link
devices/starlte/mkimage.sh -s 60 -n cpus=2 bootcpu=2 ufs_native=4 ufs_native_soc=exynos9810 ufs_native_step=3   # NOP OUT
devices/starlte/mkimage.sh -s 60 -n cpus=2 bootcpu=2 ufs_native=4 ufs_native_soc=exynos9810 ufs_native_step=4   # READ CAPACITY
devices/starlte/mkimage.sh -s 60 -n cpus=2 bootcpu=2 ufs_native=4 ufs_native_soc=exynos9810 ufs_native_step=5   # the GPTs, /dev/ufs_*
```

Each step says what it found (`ufs: own: ...`) and stops with `ufs: own: step N done`; go on only when it says what
the table above expects.

### ufs=3: the kernel's own driver, checked against the loader's reads

`ufs=3` (a default; seen working on the phone, kernel PR 155, starlte PR 33) puts the two together. The loader serves the storage as with
`ufs=2`, and the kernel's own driver takes the controller from it only after it has read the same blocks both ways and
found them the same. Anything wrong before the switch gives the controller back to UEFI and the run goes on through the
loader (`ufs=2`, unchanged). In order, each step said in the log before it is taken:

1. **References through the loader**: every unit's head (protective MBR, GPT header and table: blocks 0-5 of LUN 0 on this
   phone) and its backup GPT, and the first, middle and last block of every partition.
2. **The controller**, as Silicium's UEFI left it: own mode's steps 1-5 (`exynos9810`, read back, never reset).
3. **The self-test**: each of the loader's units is the one logical unit of the same capacity whose head reads the same,
   byte for byte; its GPT read by the kernel is right (header and table CRCs, the backup's) and has every partition of the
   loader's table at the same blocks and of the same size; the backup GPT and the three blocks of every partition read the
   same both ways. One difference and the kernel aborts.
4. **The fences**, set in the controller driver's whitelist before any write window, and checked on every WRITE(10/16)
   and SYNCHRONIZE CACHE after the window's own check: LBA 0-5 and both GPTs of every unit; EFS, SEC_EFS, CPEFS, RADIO,
   CP_DEBUG, PERSISTENT, KEYSTORAGE, PARAM, UP_PARAM, STEADY, BOTA0-2, DTB, DTBO, BOOT, RECOVERY, NAD_REFER, OMR, HIDDEN
   (and the rest of own mode's never-written list, and any name with "efs" in it) by their GPT blocks; every logical unit
   but USERDATA's (the boot units hold the boot loaders); and everything of USERDATA's unit before and after USERDATA.
   UNMAP, FORMAT UNIT, WRITE BUFFER, the security protocols, vendor commands, task management and every query that writes
   (descriptors, attributes, flags) are not on the whitelist at all; on the S9 not even fDeviceInit is sent. Each refusal
   is logged with its reason (`ufs: native: REFUSED (protected: EFS) ...`), and the fences are then tried on made-up
   writes that are judged and never sent: LBA 0, the GPTs, the first and last block of every partition, the other units.
5. **The window**: USERDATA's blocks, only with `ufs_write=1` (the loader's offer, checked as for `ufs=2`).
   `ufs_native_ro=1` makes the whole run read only, USERDATA and the loader's write path included.
6. **The switch**: every read, and USERDATA's writes, through the kernel's driver; the loader is asked for nothing more.
   A read that fails afterwards gives the controller back and goes on through the loader; a write that fails is an
   error, never retried the other way. `ufs_native_verify=1` reads every write back.

The loader (`xnuloader/loader.c`) takes `ufs=3` for `ufs=2`, and refuses every request while its page says the kernel's
list is in, so UEFI's driver never rings behind a list that is not its own. Core 0 stays the loader's: it is the
reference and the fallback, and it also feeds the cluster watchdog, watches the kernel's heartbeat and writes its log on a
hang -- unless `core0=1`, with which the kernel takes it after the switch and gives it back at the end (The cores, above);
the fallback through the loader is then gone, and a read that fails after the switch is an error.

The first runs, one image each, the log read in TWRP (pstore) or over USB (`usb_gadget=5`):

```sh
# A: read only, the self-test and the fences (USERDATA not written)
devices/starlte/mkimage.sh -s 150 cpus=6 bootcpu=2 ... ufs=3 ufs_native_ro=1 system_apfs=ufs_SYSTEM
# B: /private/var in USERDATA through the kernel's driver
devices/starlte/mkimage.sh -s 150 cpus=6 bootcpu=2 ... ufs=3 ufs_write=1 var_hfs=ufs_USERDATA_data ufs_native_verify=1 system_apfs=ufs_SYSTEM
```

`ufs_native_step=1..4` with `ufs=3` stops own mode at that step and goes on through the loader. What the log says:

| Where | Line |
|---|---|
| loader | `ufs: ufs=3: the block service as ufs=2, for the kernel's own driver to check itself against and to fall back to ...` |
| kernel | `ufs: nufs: ufs=3: this kernel's own UFS driver (exynos9810) takes the controller after a self-test ...` |
| step 1 | `ufs: nufs: the loader's unit 0 (NAME, N blocks): a GPT; blocks 0..5 read through the loader (fnv ...), and its backup GPT`, then `references through the loader: N unit(s), M partition blocks` |
| step 2 | own mode's lines (`ufs: own: ...`), ending with each LUN's capacity |
| step 3 | `ufs: nufs: the loader's unit 0 is LUN 0: blocks 0..5 read both ways, the same`, `... GPT right ...`, `ufs: nufs: self-test passed: ...` |
| step 4 | `ufs: nufs: fences set: ...`, one `ufs: nufs: protected: EFS LUN 0 blocks ...` per partition, `ufs: nufs: fence test: N writes made and judged, none sent: every one as it should be` |
| step 5 | `ufs: own: writes may go to LUN 0, blocks 2000768..15615994, and nowhere else` (B only) |
| switch | `ufs: nufs: step 5: switched: every read ... through this kernel's own driver from now on` |
| end | `ufs: native: at the end: ...`, `transfer list back to UEFI's ...` |

On any difference instead: `ufs: nufs: ABORTED: <why>`, then `UEFI's list is back as it was: the storage goes through the
loader for this run (ufs=2)`, and the boot goes on as with `ufs=2`.

## /private/var kept between runs: USERDATA

Without it `/private/var` is a memory filesystem, empty at every boot (and about 1 GB). With `ufs_write=1
var_hfs=ufs_USERDATA_data` it is HFS Plus in Android's USERDATA, given up for it: all 52 GB, journaled, kept between
runs. This is the POCO's data volume (`docs/u-boot.md` in the kernel repository, "The data volume") with USERDATA in
place of the POCO's `darwin`. Seen working on the phone: what iOS keeps in `/private/var`
is there at the next boot. `ufs_write=1 var_hfs=ufs_USERDATA_data` are defaults; without the volume made (below), init
falls back to the memory filesystem. The CI installer with `-U`
(`scion-exynos9810-installer-format-userdata.zip`) makes this volume and then seeds the jailbreak prefix to
`/var/jb`; **it erases Android's data in USERDATA.**

- **Writes go through the loader**, as the reads do (`ufs=2`): the loader calls Silicium's `UfsDxe` `WriteBlocks` on
  core 0. The kernel's own UFS driver (`ufs_native_write=`) is not used: none of its steps has run on the phone yet.
- **Only USERDATA is ever written.** The loader's starlte platform names it (`data_part`). The loader serves writes
  only to the partition of exactly that name, only if it is a partition (not a unit) on unit 0, at least 1 GiB in blocks
  of 4096, as long as its GPT entry says and writable as UEFI gives it out, and only with `ufs_write=1`. The kernel
  (`drivers/storage/hakios.ufs.c`) takes the loader's offer only for that name and block 0, and refuses any request
  outside the partition. UEFI's partition driver bounds it a third time. EFS, BOOT, RECOVERY, SYSTEM and the rest are
  never offered. Without `ufs_write=1`, nothing writes, as before.
- **A bad partition cannot stop the boot.** If `/dev/ufs_USERDATA_data` is missing (an older loader, no `ufs_write=1`)
  or the volume does not mount (not formatted, damaged), init says `HFS Plus from /dev/ufs_USERDATA_data: ...; a
  memory filesystem instead` and the boot goes on with the RAM `/private/var`.
- **Seeding.** On the kept volume init makes only the template's directories and files that are not there yet
  (`etc/var.skel`), and empties `tmp`, `run` and `vm`. The rest is what earlier runs left. It prints which run of the
  volume this is (`/private/var/hakios-runs`) and what is in `/private/var/mobile/Library/Logs/CrashReporter`.
- **The end of a run.** Before the return to the loader (`-s`, or `return` on the USB console) the kernel syncs the
  file systems (`ufs: the run is ending: the file systems synced ...`). A hard hang or a panic misses that sync, and
  the journal makes the volume whole at the next mount. Silicium's `FlushBlocks` does nothing, so the order the
  journal asks for depends on the UFS device's own write cache.

**Once, from TWRP: the empty volume.** `tools/mkdatavol.py --userdata BLOCKS OUTDIR /sbin/newfs_hfs` (on a Mac, or
with `mkfs.hfsplus` on Linux) makes it for USERDATA's size in blocks of 4096. This phone's USERDATA is LBA
2000768..15615994 of unit 0: 13615227 blocks, 55767969792 bytes. Only the blocks the volume uses are written: the
first 1 GB (headers, bitmap, catalog, journal) and the last block (the alternate header). **This erases Android's
data.** TWRP can no longer mount `/data` or `/sdcard` after it, so push images to `/tmp`. TWRP's Wipe > Format Data
makes it ext4 again.

```sh
adb push userdata-head.img.gz userdata-tail.img /tmp/
adb shell blockdev --getsize64 /dev/block/by-name/USERDATA    # must say 55767969792; stop if not
adb shell 'umount /sdcard; umount /data'                      # nothing may have it mounted (errors are fine)
adb shell 'D=$(readlink -f /dev/block/by-name/USERDATA); grep "$D" /proc/mounts; ls /sys/class/block/${D##*/}/holders'
                                                              # must print nothing: not mounted, no dm-crypt on it
adb shell 'gunzip -c /tmp/userdata-head.img.gz | dd of=/dev/block/by-name/USERDATA bs=4194304'
adb shell dd if=/tmp/userdata-tail.img of=/dev/block/by-name/USERDATA bs=4096 seek=13615226
adb shell sync
adb shell 'dd if=/dev/block/by-name/USERDATA bs=4096 count=253090 | sha256sum'   # userdata.txt's head sha256
adb shell 'dd if=/dev/block/by-name/USERDATA bs=4096 skip=13615226 count=1 | sha256sum'   # userdata-tail.img's
```

What the log of a run says (pstore or `usb_gadget=5`):

| Where | Line |
|---|---|
| loader | `ufs: USERDATA (LBA 2000768..15615994 of unit 0): the data volume, all of its blocks may be written this run` |
| kernel | `ufs: /dev/rufs_USERDATA takes writes, whole blocks from 0 on (53184 MB of it)`, then `/dev/ufs_USERDATA_data: ... writes flushed when the file system asks` |
| init | `/private/var: HFS Plus from /dev/ufs_USERDATA_data, kept between boots`, `[ ok ] mount the data volume on /private/var`, `run N on this data volume` |
| end | `ufs: synced (0); N writes, M MB this run`, and the loader's `ufs: N writes into USERDATA, ...; 0 refused` |

Run it twice: the second run says `run 2 on this data volume: what the runs before wrote is here`. Crash reports:
the system image's job list leaves out `ReportCrash` and `osanalytics` (`userland/mkjobs.py`, DENY), so nothing writes
`/private/var/mobile/Library/Logs/CrashReporter` yet. That needs an image built with `ALLOW="ReportCrash osanalytics"`.

## Touch

`drivers/input/hakios.s6sy761.c` (`s6sy761=1`, a default; seen working on the phone, 1 November). Its first run on the phone should go one step at a
time: `s6sy761_steps=1` only reads (the bus's clock divider among other things: if it says the HSI2C's input clock is not
200 MHz, `s6sy761_ipclk=` corrects the timing); 4 asks the chip its boot status, which should be 0x20 (its firmware
running, powered as the boot loader left it); 6 is touch. The coordinates are the chip's own range (its panel
information, else 0-4095 on both axes), spread over the whole panel, which is where the iPhone's picture is drawn.

## Battery

`drivers/power/hakios.max77705.c` (`max77705=1`, a default; seen working on the phone, 1 November) reads the MAX77705's fuel gauge (0x36) and charger
(0x69) on CMGP's HSI2C every 5 seconds, and hands the charge, voltage, current, capacity, cycles and charger state to
iOS's power source. It never writes the chip. The temperature is the battery's thermistor (channel 4 of CMGP's ADC,
through the phone's own table), as Android reads it. Touch and battery share `drivers/core/hakios.exynos_hsi2c.c`.

## Brightness

`drivers/gpu/hakios.s6e3ha8.c` (`panel=1`, a default). The S6E3HA8 has no DCS brightness command, so the driver
sends Samsung's AOR, the part of each frame the pixels are off, through DSIM0's command FIFO. The range runs from
the boot loader's level down to about 2 % of it; the gamma for the panel's full range is this panel's own and comes
from Android's boot log (`dmesg | grep 'gamma\['`). `sysctl kern.hakios.brightness=0..255` sets it, and
`panel_brightness=N` sets it at start. The panel's gamma and AOR tables were checked against the BSP (every value of the
256 AOR levels and 74 gamma rows, and the calculation for 702 MTPs, byte for byte).

What iOS sets reaches the panel through `drivers/gpu/hakios.backlight.cpp`, where the driver registers at start
(`hakios: panel brightness: s6e3ha8 registered`); on a phone without a panel driver nothing registers and nothing
changes. Which property iOS sets when its slider moves is not known yet, so there are two ways in, both logged:

- the display service: a key named `brightness` (0-1 or 0-255), always; each key it is sent is said
  (`IOMobileFramebuffer: <process> sets <key> = <value>`);
- `backlight=1` publishes `AppleARMBacklight` (the class XNU knows as an ARM phone's backlight) under `disp0`, with
  IOGraphics' `IODisplayParameters` (`brightness` and `linear-brightness`, 0-65536). It says every key it is set
  (`AppleARMBacklight: <process> sets ...`), every property asked of it that it lacks (`... asks for ...: not there`)
  and who opens it. `backlight=2` also takes its `brightness` and `linear-brightness` as the panel's brightness.

Seen working on the phone: iOS's slider in Control Center and Settings moves the panel's brightness with `backlight=2`
and the user-space bridge `brightness_bridge=1` (both defaults; kernel PRs 150, 154). `backlight=1` only logs what iOS
sets, for a new panel.

## The GPU

`drivers/gpu/hakios.mali.c` and `hakios.mali.cpp` (`CONFIG_HAKIOS_MALI`, built in): HakiOS's Mali-G52 driver of the
Infinix Hot 20 ([hakios-mt6768](https://github.com/oosexgang/hakios-mt6768), `redwood_mali.c` and `RedwoodMali.cpp`),
with MediaTek's power and clocks replaced by the Exynos 9810's, as the mainline Linux port to the S9+ brings the same
GPU up from S-Boot's state. `mali=N` makes the first N of nine steps, each said in the log before it is made, and
nothing without it (`mali=9` is a default):

| Step | What |
|---|---|
| 1 | reads only: the PMU's G3D configuration and status, CMU_G3D (PLL_G3D and its rate, the muxes, the bus dividers), and through ACPM the S2MPS18's B6CTRL and B6OUT (BUCK6, vdd_g3d). The GPU itself is not read |
| 2 | B6OUT = 0x68 (950 mV, the regulator's most in the device tree) through ACPM and read back, or the steps end; PLL_G3D to `mali_mhz` (260, S-Boot's, unless said); then, if the domain is off, Samsung's power-on: CMU_G3D +0x148 = 0x30000003, +0x140 and +0x100 bit 4, PMU 0x14064040 [3:0] = 0xF and its status waited for |
| 3 | after a power-on of its own only: the DTZPC restore, SMC 0x82000410 (1, 0x17410204), passed to EL3 by Carbon; then the bus dividers (BUSD = the PLL, BUSP = a quarter) |
| 4 | the first read of the GPU: GPU_ID (a G72, arch 6, product 1), MMU_FEATURES (35 bits of GPU address at least, 36 of physical), the cores |
| 5 | a soft reset (a hard one if it does not finish), COHERENCY_ENABLE = 31 (none: the phone's device tree asks kbase for no coherency), L2_MMU_CONFIG's external read and write limits cleared |
| 6 | the L2, then the shader cores, then the tiler, each waited for |
| 7-8 | one write-value job on slot 1, in identity mode, then through the GPU's own AArch64 page tables (four levels on a GPU of 48 bits, as kbase and panfrost walk it) |
| 9 | HakiosMali, the IOKit service Mesa's panfrost draws through |

`mali_mhz=455` or `572` picks another of the stock table's rates (M/P/S inside the PLL's range: Samsung's PLL_1018X
limits); `mali_acpm=0` leaves the rail as found, which hung the S9+ (a test only). Short of step 9 a domain the driver
switched on is switched off again (reset first, Samsung's low-power settings, the DTZPC save) and B6OUT put back; a
domain the boot left on is left on, with the rail at 950 mV under it. Start with `mali=1`, then one step more per run
(`mkimage.sh cpus=2 bootcpu=2 mali=1 ...`); `sysctl kern.hakios.mali` says the last step done. With 9,
`/redwood/bin/mali_test` (run by rc.jobs) checks the program side without Mesa, and the window server draws with
OpenGL ES through Mesa's panfrost (`tools/mesa`, the root built with `GL=1`). Written and checked against Samsung's
kernel (CAL, kbase, ACPM, the device tree) and the S9+ port. Seen on the phone (1 November): `mali=9` ran ("THE GPU
WROTE IT"), and CoreAnimation draws through Mesa's Panfrost. Metal on the Mali has not been run yet.

How programs reach it, what Mesa's panfrost and the kernel's service were checked to agree on, why Metal goes through
panfrost and not panvk, and the runs after `mali=9` (mali_test, the window server, gl_test, Metal): [GPU.md](GPU.md).
Programs' buffers get GPU addresses between 32 MB and 4 GB, given back when freed, code kept off 16 MB lines, as Linux
panfrost gives them and Mesa expects.

## The display: tearing, and the scaling in hardware

How a frame reaches the panel today. CoreAnimation draws the iPhone's 1125 x 2436 into an IOSurface and hands it to
`MiniIOMobileFramebuffer.cpp` (SwapEnd). Its presenter thread waits for the GPU, waits for its own 60 Hz beat (a
timer: `fb_beat`), then scales the surface on the processor (`fb_threads` of them; nearest neighbour while frames
come, bilinear once they stop: `fb_filter=2`) straight into the boot framebuffer at 0xCC000000. The DECON (DECON0,
0x16030000) runs as S-Boot left it: MIPI command mode, each frame started by the panel's TE, one window on one DMA
channel whose IDMA reads that same buffer. Nothing ties the presenter to the DECON's frame: the processor writes the
next frame while the DECON is sending the last one to the panel, and the panel gets half of each (the tearing, and most likely
text that is gone for a refresh while its rows are being rewritten). There is no vsync interrupt: the driver's
"vsync" is its own timer.

`drivers/gpu/hakios.exynos_dpu.c` gives the presenter the DECON (`fb_dpp=1` and `fb_zc=1` are defaults, seen working on the
phone from 2 and 3 November; kernel PRs 145, 160):

- `fb_flip=1`: three buffers of the panel's size (the boot one and two more, below 4 GB: see the first run below); a frame is drawn
  into one that is neither shown nor waiting, then its address goes to the channel's IDMA and a shadow update is asked
  for, which the DECON takes at the start of its next frame. The next flip waits for that. No buffer is written while
  it is read; frames reach the panel at most once a refresh. The scaling stays on the processor.
- `fb_dpp=1`: the window is moved to the channel VGF0, one of the two whose DPP has a scaler; it reads three buffers of
  1125 x 2436 and scales them to 1440 x 2960 (Catmull-Rom, 8 taps across and 4 down). The processor only copies the
  frame (a row-by-row memcpy, about a third of the bytes of a scaled frame and none of the arithmetic). Flips as above.
- Either goes back to drawing into the boot framebuffer, on the boot loader's channel, when the DECON is not as
  expected (one window, its IDMA reading 0xCC000000 at 1440 x 2960, command mode), when VGF0 reports a configuration
  error after the switch, or when a flip is not taken within 100 ms.
- `fps_log=1`: a line a second, "fps: N presented, N drawn, N flips, N lost, N held; drawing N us a frame ...; N
  refreshes; ...", the refreshes being the DECON's FRAME_COUNT. With `fps_log=1` alone the DECON is only read
  ("exynos_dpu: DECON0: ...", the window, the channel's registers), which is the first thing to see.

| Run | Arguments (with the six-core ones) | What to look for |
|---|---|---|
| 31 | `fps_log=1` | "exynos_dpu: DECON0: control ... (command mode, running), trigger ... (HW on ...)", "window N ... on channel N (G0)", the channel's base 0xcc000000; "fps:" lines while the screen moves, and how many refreshes a second |
| 32 | `fb_flip=1 fps_log=1` | "exynos_dpu: flips on G0 between 3 buffers", "fps: ... mode flip" with flips close to drawn; no tearing; no "scan-out given up" |
| 33 | `fb_dpp=1 fps_log=1` | "exynos_dpu: VGF0 scaler: 1125x2436 to 1440x2960", "VGF0 after 3 refreshes: ... errors 0", "VGF0 scales"; then "fps: ... dpp: VGF0 scales" with drawing a few ms at most |

First run of 33 (`60fps-a`, 2 November): the probe as expected ("windows 100000 (1 on)", "window 5 ... on channel 5
(G0)", G0 reading 0xcc000000 at 1440 x 2960; its IDMA ENABLE reads 0 while the DPP's reads 1, which nothing checks), and
then nothing of fb_dpp: every "fps:" line said "boot framebuffer". The buffers were never had: the presenter asked IOKit
for memory in one piece below 4 GB, and this kernel has none there (the loader gives XNU the bank from 0x880000000 on;
the kernel itself is at 0x883416000), and it said so only with IOLog, which does not reach the loader's log. Now the DPU
driver puts the buffers in the device tree's free gap of the lower bank, from 0xD4000000 (above the moved payload and
panic log, 0xD0000000-0xD3FFFFFF) to secure_camera at 0xE1900000 (no reserved-memory node; never 0xF0000000 and above,
the modem's and ABOX's), mapped write-combined (fb_dpp's three buffers take 33.8 MB, fb_flip's two 34.2 MB); and
every step says what it decided in the loader's log. What a run says now, in order:

- "MiniIOMobileFramebuffer: scan-out: fb_dpp=1 fb_flip=0 fps_log=1; the boot framebuffer at 0xcc000000, 1440x2960 ..."
- the probe's lines, then "exynos_dpu: probe: as expected (window 5 on G0 ...)"
- "exynos_dpu: memory: 3 buffers of 11239424 bytes at 0xd4000000 to 0xd6040000 (the device tree's gap below
  secure_camera ...)"
- "MiniIOMobileFramebuffer: fb_dpp: 3 buffers of 1125x2436, 4608 bytes a row, at 0xd4000000 0xd4ac0000 0xd5580000 (the DPU
  driver's, below 4 GB)"
- at the first frame of the home screen: "scan-out: the first frame drawn into buffer 0 ...", "exynos_dpu: attach:
  VGF0's scaler (fb_dpp) asked for ...", the VGF0 dumps and "VGF0 after N refreshes: ... errors ...", then
  "fb_dpp: taken: ..." or "attach: VGF0's scaler not taken" and "the scan-out given up (...)"
- "fps: ... dpp: VGF0 scales" (or "flip" for run 32).

That run's frame rate (10 presented a second, against more on runs without fb_dpp) is what iOS sent: no swap was held
or lost, and drawing took 10-15 ms of every 100. Nothing of fb_dpp ran in it.

## Vibration and the flashlight

`max77705_haptic=1` gives iOS the vibration motor: the MAX77705's haptic block (the same chip as the charger: two of
its registers written, in their haptic bits only, each read back) driven by channel 1 of the SoC's PWM, as Samsung's
driver drives it. `torch=1` looks at the S2MPB02's flash block, `torch=3` gives iOS the flashlight (lit by a pin, so a
restart puts it out; never above Android's 60 mA). The vibration is a default, felt on the phone (1 November); the
flashlight is not: written, not yet seen.

## The cameras

`drivers/camera/hakios.exynos_camera.c` (`cam_s9=N`; `cam_s9=7 cam=5` a default) is the front camera,
the S5K3H1: `cam_s9=1` looks (the S2MPB02's camera LDOs, CIS_CLK1, the pins), `cam_s9=2` powers the sensor up in
Android's order (three LDOs of the S2MPB02 at Android's voltages, reset, MCLK at 26 MHz), reads its model ID over I2C
(0x35 on USI08_I2C of PERIC1) and powers it down. `cam_s9=3` switches the ISPPRE power domain on (with the DTZPC
restore SMC, as the GPU's) and reads CSIS1 and the SysMMU; `cam_s9=4` has the CSIS's own test pattern generator write
one frame through CSIS1's VC0 DMA into a buffer below 4 GB (0xD8000000) and logs its checksum; `cam_s9=5` streams the sensor at
1632 x 1224 RAW10 on two lanes and keeps one frame, with the mean of a patch to tell a picture from black; `cam_s9=6`
does that and then answers the USB console's `camshot [N]` (`tools/usb-shot.py --cam -o cam.png`): one frame each time,
debayered on the processor and sent as a picture, or the CSIS's and the WDMA's registers when it fails; `cam_s9=7`
streams the sensor into a ring of four frames, `/dev/hakios-camera`, which the stock Camera app's preview shows at 30
frames a second with `cam=5` (run cn3-7, 3 November; kernel PRs 159, 162). Each step seen on the phone (camshot run C6,
2 November). The rear cameras are not started. [CAMERA.md](CAMERA.md) has the hardware of both cameras, the steps'
expected lines and how iOS's camera stack is fed.

`drivers/camera/hakios.exynos_iris.c` (`iris_s9=N`, off unless asked) is the iris scanner's camera, the S5K5F1 infrared
sensor on CSIS3, and its IR LED: written, not yet seen. Its steps, its eye-safety limits and the plan for Face ID are in
[CAMERA.md](CAMERA.md), "The iris camera".

## Wi-Fi

Seen working on the phone (3 November, kernel PR 157): joined from iOS's Settings (WPA2), DHCP from configd, the
Internet; `wifi_pcie=6 brcmfmac=8 brcmfmac_poll=1 brcmfmac_tcm_idx=1 wifi=1` are defaults. [WIFI.md](WIFI.md) has
every run. Stage 1, `drivers/wifi/hakios.exynos_pcie.c` (`wifi_pcie=N`): the Exynos 9810's PCIe root complex of
channel 0 and the BCM4361 behind it, as far as the link and the chip's identity. 1 only looks (the PHY's isolation in the
PMU, CMU_FSYS1's gates, the pins), 2 powers the radio (WLAN_REG_ON, gpg0-5, 200 ms), 3 brings the PHY up, 4 trains the
link, 5 reads the endpoint's ID (Broadcom 14e4:441f expected) and sizes and places its BARs. No firmware is loaded.
Go up one step a run: `mkimage.sh -s 60 cpus=2 bootcpu=2 wifi_pcie=1`, and so on; every line starts with `exynos_pcie:`.
[WIFI.md](WIFI.md) has the steps and what each should print.

Stage 2 (`drivers/wifi/hakios.brcmfmac.c`, `wifi_pcie=6 brcmfmac=N`): Linux's brcmfmac
(ISC) on the Linux layer the POCO's ath11k runs on, its object made by `tools/mk-brcmfmac.sh` before the kernel is
built. 6 hands the device on; then `brcmfmac=1` reads the chip's ID through BAR0, 2 reads which module it is from its OTP
and asks for the firmware, NVRAM (the module's) and CLM (`firmware/wifi/`, fetched by `tools/fetch-firmware.sh`, in `fw/`, or the phone's own
VENDOR partition read at run time with `ufs=2`: WIFI.md has the table), 3 starts the firmware, 4 sends
it its first command (the first DMA) and registers the wiphy. 5 takes the chip's interrupt by INTx (SPI 253) instead of
a thread that looks (`brcmfmac_poll=1` keeps the thread), 6 gives the firmware the phone's address (`fw-wifi/mac.info`,
the phone's `/efs/wifi/.mac.info`), 7 is the station: the interface up, en0 on it, iOS's Wi-Fi settings scan through it,
and 8 joins: an open network or WPA2 with a passphrase (the four-way handshake by the kernel's own `lx_wpa.c`, as on the
POCO), and the network of `fw-wifi/network` at once if there is one. On the way back to the loader the driver is taken
down and the radio unpowered (WLAN_REG_ON low). iOS's Settings reach it through the kernel's
Apple80211 surface, as on the POCO; nothing in user space changes (WIFI.md, "iOS's side"). The first image to run is
`wifi-a` (WIFI.md, "The plan on the phone": `wifi_pcie=6 brcmfmac=7 brcmfmac_poll=1`, stages a to c in one run).

## Speaker audio

Two drivers, both on by default (`abox=8 max98512=3`): `abox=N` (`drivers/audio/hakios.exynos_abox.c`, 8 steps) is the SoC's
side, ABOX with its own CPU off: memory -> RDMA0 -> SIFS1 -> UAIF1, I2S at 48 kHz, 2 x 16 bits; `max98512=N`
(`drivers/audio/hakios.max98512.c`, 3 steps) is the two amplifiers on I2C. Step 8 of ABOX makes it the sink of
`/dev/hakios-audio`, the same way in for iOS's sound as on the POCO, with iOS's volume and mute followed.

It plays (phone 2, 3 November): ABOX's DMA runs without its firmware at 192000 bytes a second, `abox=7 max98512=3`
plays a 1 kHz tone through both amplifiers, and with `abox=8 max98512=3` iOS's own sounds come through (frames from iOS,
none lost, the amplifiers on while they play). Nobody has listened yet: the proof is the DMA's rate, the guard's peaks
and the amplifiers' registers ([AUDIO.md](AUDIO.md), with how to hear it). `abox` on the USB console says the state and `abox tone 3` plays the tone again (with `abox=7`).
The codec, a CS47L93 on SPI (`cs47l93=6`, a default; `drivers/audio/hakios.cs47l93.c` on `drivers/core/hakios.exynos_spi.c`):
its ID, power, FLL and main microphone, recorded through UAIF0 -> WDMA1 by the console's `abox rec S` (phone 1,
3 November; [AUDIO.md](AUDIO.md), "The codec"); with `abox_mic=1` it is iOS's microphone, through
`/dev/hakios-mic` (AUDIO.md, "The microphone in iOS"). The headphones are written behind `cs47l93_hp=1`, not yet tried.

## Temperatures

Android keeps the S9 cool with Linux's thermal framework and Samsung's APM firmware: the big cores slowed from 83
degrees and taken away at 96, the GPU slowed from 88, every zone's "hot" trip at 115. HakiOS has none of that, so
`drivers/power/hakios.exynos_tmu.c` (`tmu=N`; `tmu=3` a default) at least watches. It reads the Exynos 9810's TMU
itself: TMU_TOP at 0x10070000 (BIG: sensors 1, 2, 3, 4, 6; LITTLE: 5) and TMU_SUB at 0x10074000 (G3D: 1; ISP: 2), each
sensor's 9-bit code made degrees with its own fuses (TRIMINFO: the codes at 25 and 85 degrees), the arithmetic of the
BSP's `exynos_tmu.c` (checked on the host: `tools/exynos-tmu-test.sh`). `tmu=1` only reads (the TMU's clock gate in
CMU_PERIS first, then the blocks as the boot left them, every sensor's fuse, code and temperature, and the thresholds
S-Boot may have armed), `tmu=2` publishes `sysctl kern.hakios.temp.*` (`big_mc`, `little_mc`, `g3d_mc`, `isp_mc`,
`max_mc`, `hottest`, `sensors`, `battery_c`) and the POCO's `kern.hakios.thermal_*`, `tmu=3` ends the run when a zone
reads `tmu_stop` (110, five under Android's hot trip) or the battery `tmu_batt_stop` (60) three times in a row: a loud
"TOO HOT" in the log, then back to the loader, which stops every core and restarts into TWRP with the log kept. With
`tmu_off=1` and no charger it powers the phone off instead (PS_HOLD low, as Samsung's power-off does; the log is lost).
Nothing slows anything down: the stop is the whole protection. If S-Boot leaves the TMU stopped, `tmu_enable=1` starts
it the way Android does, but never arms its hardware trip. Running on the phone since 1 November (the zones read); its
stop at 110 C has not been reached there.

## The clock

The time of day was the moment the image was made: `mkimage.sh` puts `epoch=$(date +%s)` on the command line and the
kernel's calendar starts there on every boot (iOS showed 2:11 at 08:49 UTC). The phone has a real-time clock that keeps
running while it is off, the RTC block of the S2MPS18 PMIC, and `drivers/power/hakios.s2mps18_rtc.c` (`rtc_pmic=1`, a
default; its read seen working on the phone, 2 November) reads it once, when the kernel first asks for the time of day. It only reads: the PMIC is on SPEEDY,
which the APM owns, and its registers are asked for through ACPM (channel 2, block 2, the path the GPU and touch drivers
take), CTRL to YEAR (0x00-0x0B), never written. Binary, 24-hour, the year since 2000, Linux's own test for a reset clock
(CTRL bit 1 and CAPSEL[7:4] = 0xF), from Samsung's `rtc-s2mps18.c` and `rtc-s2mp.h`. What it reads is what S-Boot last
latched (S-Boot reads the clock on every boot; latching it again would be a write), so the kernel's uptime is added when
it says the timer started with this boot. The calendar starts at the clock when it is valid, its year 2024-2099 and not
behind `epoch=`; otherwise at `epoch=`, as before. Every register and the decision go to the loader log (`rtc: ...`).

What to expect: on every Android boot logged so far, S-Boot and Linux read 2018-01-01 (`runs/auto-210855/last_kmsg`): the
clock was reset and nothing set it again. Then the log says "rtc: not used (the year is not 2024-2099 ...)" and `epoch=`
stays. Setting the clock (from Android, which sets it when it has network time, or from iOS's time through a write here)
is the step after this one.

## CPU clocks

The clusters' rates go through the APM's ACPM firmware (DVFS domain 2 is the A55s, cpucl0; 3 the M3s, cpucl1). A request
names a rate, never a voltage: the APM keeps each level's voltage (the ASV's, set at boot) and applies it with the rate,
as it does for Samsung's kernel, which only reads that table (`cal-if/fvmap.c`). Two ways to use it, the governor a default:
fixed rates (`cpufreq_lit=`, `cpufreq_big=`, `drivers/core/hakios.exynos_acpm.c`), or `cpufreq_gov=1`,
`drivers/power/hakios.exynos_cpufreq.c`, which moves both with the load and the heat, and then the fixed ones are not used.

What Samsung's kernel allows on this phone (its device tree and the phone's own, `cpufreq`, `hotplug_governor`):

| | levels (kHz) | min | max |
|---|---|---|---|
| cpucl0 (A55) | 1950000 1794000 1690000 1456000 1248000 1053000 949000 832000 715000 598000 455000 | 455000 | 1950000 (Samsung's tree; none in the phone's) |
| cpucl1 (M3) | 2886000 2860000 2704000 2652000 2496000 2314000 2106000 2002000 1924000 1794000 1690000 1586000 1469000 1261000 1170000 1066000 962000 858000 741000 650000 598000 | 650000 | 2314000 in Samsung's tree (policy-max 1794000), 1794000 in the phone's; by M3s online: 1 or 2, 2314000; 3 or 4, 1794000 |

So with all four M3s online Android never runs them above 1.794 GHz (`cpufreq_big=2106000`, the fixed rate of the six-core
runs, is above that), and never above 2.314 GHz at all; 2704000, the S9's advertised top, is a level of the table that
no limit lets through. The governor's ceilings: the M3s at the online count's limit and by default 1794000 at most
(`cpufreq_gov_big_max=` up to that limit), the A55s 1794000 (`cpufreq_gov_lit_max=` up to 1950000); floors 650000 and
1053000 (core 0, the loader's UFS service, is an A55 the scheduler cannot see). Every `cpufreq_gov_ms` (40) the busiest
core of each cluster sets its rate (75% busy wanted; up at once, down after three windows). With temperatures from
`tmu=2` or more, a cluster at its zone's control point (83 C BIG, 76 C LITTLE, Samsung's) loses a level of its ceiling a
second, gets it back 5 degrees under, and goes to its lowest level at 96 (BIG's hotplug_out); without them the M3s stay
at 1794000 or under. Once a second a line "cpufreq_gov: N s: lit ... MHz load ...% ... | big ... | temp big ... lit ... C"
goes to the loader's log. Run on the phone, with the touch and frame boosts (kernel PRs 147, 152, 158).

## Powering off

A halt (iOS's "slide to power off", or `halt` at the console) used to hand the phone back to the loader and no more:
nothing let the PMIC's rails go, and the panel, an S6E3HA8 in MIPI command mode, keeps a copy of the last frame in its
own memory and goes on showing it with nothing sending it anything, so the phone looked frozen on the last spinner
frame. `halt_off=N` (`drivers/power/hakios.exynos_poweroff.c`, built in, off by default) makes a halt a power-off.
`halt_off=1` saves the data volume, blanks the panel through DSIM0's command FIFO (DCS display-off, 0x28, and sleep-in,
0x10, each between the level-1 key, as Samsung's display-off and exit sequences send them, then their 100 ms), then
lets go of PS_HOLD (the PMU's PS_HOLD_CONTROL at 0x14060000 +0x330C, bit 8), as Samsung's `sec_power_off()` does: the
phone is off and the log is lost with it. `halt_off=2` first asks the APM to stop as well (ACPM's STOP request on the
acpm node's channel 4, Samsung's `acpm_enter_wfi()`, which `exynos_acpm_reboot()` sends before every PS_HOLD). With a
charger reported by the battery driver, or the phone still running a second after PS_HOLD (a charger it did not see,
the power key still held), the halt goes the loader's way as before, the panel already dark: TWRP, with the log. The
same PS_HOLD is `tmu_off=1`'s (Temperatures, above). Without `halt_off`, a halt is what it was. Written, not yet run;
whether PS_HOLD alone powers the S9 off while the APM still runs (Samsung never tries it) is what runs 33 and 34 tell.

## USB: the whole log and a console over the cable

pstore holds 32 KB, read in TWRP after the run. `usb_gadget=N` (drivers/core/hakios.dwc3.c with the Exynos 9810's glue
hakios.exynos_usb.c; `usb_gadget=5` a default) makes the phone's USB-C port a USB serial device instead: the kernel's
log from its first line, live, for as long as the run lasts, the panic text at the end, and a line console back. It is
the DWC3 at 0x10C00000 in device mode, high speed, with a CDC-ACM function (pid.codes' test ID 1209:0001, "HakiOS kernel
log and console"): `/dev/ttyACM0` on Linux, `/dev/cu.usbmodem*` on a Mac. The PHY is brought up with the BSP's USB 3.1
CAL sequence for the 2.0 side only, the SuperSpeed lanes held idle (the head of hakios.exynos_usb.c has every register
and its line in the BSP). Silicium's UEFI has no USB driver in this FD, so only S-Boot can have touched the controller:
step 1 says what it left, step 2 stops it if it runs, step 3 resets it whatever it finds.

The steps: 1 reads (the PMU's isolation, the clocks, LDO9-14 through ACPM, the PHY's and the DWC3's registers), 2 the
PHY, 3 the core reset and set up as a device with the pull-up off, 4 the pull-up on and the host's requests answered
(each said in the log), 5 the log streamed and the console. On the way back to the loader the rest of the log is sent
for up to `usb_gadget_drain` ms (1000) before the controller is stopped. Options: `usb_gadget_clk=1` opens a clock S-Boot
left shut (Android's mux, divider and gate), `usb_gadget_ldo=1` puts LDO9-14 into Android's USB mode (read back),
`usb_gadget_fs=1` full speed.

On the host (a Linux machine; a Mac the same with `/dev/cu.usbmodem*`):

```sh
sudo systemctl stop ModemManager       # or it may open the port first; a udev rule with ID_MM_DEVICE_IGNORE=1 for 1209:0001 does the same
dmesg -w                               # step 4: "idVendor=1209, idProduct=0001", "cdc_acm ...: ttyACM0: USB ACM device"
while :; do [ -e /dev/ttyACM0 ] && stty -F /dev/ttyACM0 raw -echo && cat /dev/ttyACM0 >> s9-run.log; sleep 0.2; done
picocom -q /dev/ttyACM0                # the console: type help and Enter (the phone echoes the line, "usb> help")
```

The console's commands: `help`, `stat` (the link's counters), `uptime`, `sysctl NAME`, `log` (the kernel's log again from
its start), `shot [N]` (the panel's picture, every Nth pixel, as a framed binary blob; the log is held back while it goes
out), `return` (end the run: the loader restarts the phone into TWRP). It is the kernel's, not a shell.
Seen on the phone (1 November): it enumerates at high speed as 1209:0001, the log streams live, and the console's
`return` ends a run into TWRP. The MAX77705's switch has to route D+/D- to the SoC: `max77705_usbsw=1` (with
`max77705=1`) does it. The descriptors and requests are also checked on the host (`tools/usb-acm-test.sh`).
`tools/usb-shot.py -n 4 -o s9.png --log s9-run.log` (in the kernel tree; stop the `cat` loop above first, `--log` keeps
its file going) sends `shot 4` and writes the picture as a PNG: 360x740 from the 1440x2960 panel, some 0.8 MB. The shot is written, not yet run.

## First runs of the drivers, one flash each

Each driver is written from the BSP's facts. Those seen working since (touch, the battery, vibration, USB, the
GPU, the M3s: runs 3-7, 18-24 and 26-29) are kept here as the record of their bring-up. Bring the rest up one at a time, each
step on its own flash, reading the pstore log in TWRP after each (`devices/starlte/mkimage.sh -s 120 -n cpus=2 bootcpu=2
<args>`). The runs below were written for a line of their own arguments alone: since the S9's defaults (Defaults, above),
`mkimage.sh` puts its arguments over the defaults, so give these with `-n` to run them as written (and keep `cpus=2
bootcpu=2` in each, as the column below leaves them out), or without `-n` to try one driver beside everything that works.

| Run | Arguments | What to look for |
|---|---|---|
| 1 | none of the drivers | the loader's banner, "2 of 2 processors are running" |
| 2 | `exynos_keys=1` | "exynos_keys: power: bank 0x60 pin 4, CON f (interrupt), released", then down/up on presses |
| 3 | `s6sy761=1 s6sy761_steps=1` | "USI mode 4 ... divider ...": if the divider is not 1 on a 400 MHz branch, add `s6sy761_ipclk=` |
| 4 | `s6sy761=1 s6sy761_steps=4 s6sy761_ldo=0` | "boot status 20 (its firmware runs)" and "panel: 1440 x 2960 ..."; with no answer, again without `s6sy761_ldo=0` |
| 5 | `s6sy761=1` | "step 6: watching the IRQ pin", then touches |
| 6 | `max77705=1 max77705_steps=1`, then `_steps=4` | "version N, revision N", "now: NN.NN%, NNNN mV ..."; `max77705_ipclk=` if the clock logged differs |
| 7 | `max77705=1 max77705_haptic=1` | "haptic: the motor for iOS ... PWM 1270 ticks of 26000000 Hz" |
| 8 | `torch=1`, then `torch=2 torch_secs=2` | "ID ...; FLED_CTRL1 ..., CTRL2 ..." (reads only), then lit for 2 s at 60 mA |
| 8a | `cam_s9=1`, then `cam_s9=2` | "S2MPB02 ID ...", the LDOs "off"; then "THE SENSOR ANSWERS: model ID 0x...." and "powered down ... off as found" ([CAMERA.md](CAMERA.md)) |
| 8b | `cam_s9=3`, then `4`, then `5`, one a run | "SMC 0x82000410 returned 0" and "MMU_CTRL 0x0"; then "THE PATTERN REACHED MEMORY"; then "frame end 1" and "THE PATCH ...: mean ..." (CAMERA.md's runs C3 to C5) |
| 8c | `cam_s9=6 usb_gadget=5`, then `tools/usb-shot.py --cam -o cam.png` | "6: CAMSHOT READY"; then "usb: camshot 1 sent" and a picture from the front camera, or "usb: camshot failed: ..." with the CSIS's and the WDMA's registers (CAMERA.md's run C6) |
| 8d | `cam_s9= iris_s9=1`, then `2`, `3`, `4`; then `iris_s9=5 usb_gadget=5` and `tools/usb-shot.py --iris -o iris.png` | the LDOs and the FLED registers (reads only); "model ID 5f1."; the seven LED registers read back; "a whole frame" and the middle patch's mean; then a grey infrared picture ([CAMERA.md](CAMERA.md), runs I1 to I5) |
| 9 | `panel=1 panel_gamma=1`, then `backlight=1` | the gamma read and logged only; then which key iOS's brightness slider sets (Brightness, above) |
| 10 | `abox=6 max98512=2` (run a1, seen) | "ABOX IP_INDEX ... = 0x41424f58", "PLL_AUD 1179648040 Hz", "gpb1-0..3 with UAIF1 on: 1856, 192, 0, 0 changes", "max98512: top (0x39): MAX98512, revision 0x41" and the bottom one's ([AUDIO.md](AUDIO.md)) |
| 11 | `abox=7 max98512=3` (runs b1, seen) | "ABOX's SysMMU translates (CTRL 0x4) ... switched off", "the ring: 16384 bytes in abox_rmem at 0xfb200000", "192417 bytes a second read", "the guard: peaks in 3277"; `abox tone 3` on the USB console again |
| 12 | `abox=8 max98512=3` (runs b2, b3, seen) | "abox: 8: iOS plays: starting the amplifiers", "max98512: on: ... (start N, unmuted only, 31054 us)", "from iOS N frames (0 lost)" |
| 13 | `tmu=1` | "tmu: 1: gate ... open", each block's "CONTROL ... (CORE_EN 1 ...)", every sensor's "TRIMINFO ... (25 C = NN ...), code NN = NN.0 C" near the room's temperature plus a few; if CORE_EN is 0 or no sensor reads, again with `tmu_enable=1`; if the gate is CLOSED, with `tmu_ungate=1` |
| 14 | `tmu=2` | "tmu: 2: publishing ...", then `sysctl kern.hakios.temp` from the shell (the big zone is the M3s', which cannot be started yet: The cores, above) |
| 15 | `tmu=3 tmu_stop=T`, T a degree or two under the hottest zone run 13 read (40 at least) | within a few seconds "tmu: 3: ... 1 of 3 reads in a row", then "--- tmu: TOO HOT ..." and TWRP with the log: the stop works; later runs keep `tmu=3` at its default 110 |
| 16 | `mali=1` up to `mali=9`, one step a run | "PLL_G3D as found: ... 260.000 MHz" and "B6OUT ... mV"; then "BUCK6 (vdd_g3d) now: ... 0x68 = 950 mV", "the domain is on", "SMC 0x82000410 returned 0", "GPU_ID 0x6...", "reset", "all powered", "the GPU ran it" twice ([The GPU](#the-gpu)) |
| 17 | `bt=7 bt_scan=1 wifi_pcie=6 brcmfmac=8 ...` (the patch from the phone's VENDOR, the module from the chip's OTP); then `bt` and `bt scan` on the USB console | "loopback: all 16 bytes came back", "manufacturer 000f (Broadcom)", the patch and "build 232" after it, "at 4000000 baud ... Read Local Version answers", the scan's devices ([BLUETOOTH.md](BLUETOOTH.md)) |
| 18 | `usb_gadget=1` | "usb: exynos9810: PMU USB PHY ...", "CMU_TOP CLKCMU_FSYS0_USB30DRD: ... gate ..." (if SHUT, the next runs add `usb_gadget_clk=1`), "LDO9-14 CTRL: ...", "USBCON as the boot left it", "DWC3 as the boot left it: GSNPSID 5533...", DCTL's RUN_STOP |
| 19 | `usb_gadget=2` | "2a: PMU +0x72C ... -> ...1" to "2l: COMBO_PMA_CTRL ...", none "(NOT as written)"; "USBCON after: ... (SIDDQ 0, line ...)" |
| 20 | `usb_gadget=3` | "3: reset done in N us", "DWC3 set up: ... DCTL ... event buffer ..."; "did not finish in 500 ms" means the PHY gives the link no clock |
| 21 | `usb_gadget=4`, the cable in a Linux host running `dmesg -w` | the host: a new high-speed device 1209:0001 and ttyACM0; the phone: "bus reset 1", "connected at high speed", "setup 1: 80 06 0100 ...", "address N", "configured"; with none, "waiting for a host: line ..." every 10 s (then `usb_gadget_ldo=1`, or `usb_gadget_fs=1`) |
| 22 | `usb_gadget=5`, `-s 300` | the whole log on the host as it is written (above); `help`, `stat`, then `return`: the phone restarts into TWRP and the host's log ends with the run's last lines |
| 23 | `mali=9`, root `GL=1 NO_AIR=1` with `gl=0` | "mali_test: 4: ... the word 0xc0ffee01 -- THE GPU WROTE IT" ([GPU.md](GPU.md), run G1) |
| 24 | `mali=9`, the same root | "HakiosMali: a client opened the GPU" (backboardd), and every minute "M job chains (0 failed)" with M growing; then `RC_JOBS=rc.jobs.gltest`: "mali: gl_test drew on THE MALI" (G2, G3) |
| 25 | `mali=9`, root `GL=1` (with the AIR library) and `RC_JOBS=rc.jobs.malimetal` | "the compiler library Mali-G72 ...", "drvtest: dispatched image_calcminmax0: status 4", the drawn pixel equal to softpipe's (M1) |
| 26 | `m3_prep=1` | "m3: m3_prep=1: 1: the big cluster's state, before CPU_ON for cpu 1 (MPIDR 0x3)", the CLUSTER1 STATUS words (0 off), each of the six fields "NOT as Samsung's kernel leaves it" (expected: 0xC7..., 1), "DVFS cpucl1 N kHz ... BUCK2 ... mV"; then the boot as run 1 |
| 27 | `m3_prep=2` | "m3: 2: CPU_QCH_CLUSTER1_NONCPU_SYS_PWR_REG (PMU +0x1088): c7...... -> 8d......" and five OPTION lines, "the six CLUSTER1 fields hold Samsung's values", the state "after the writes"; then the boot as run 1 (nothing else changes) |
| 28 | `m3_prep=3 cpus=3 bootcpu=2` (in place of `cpus=2`) | "m3: 3: CPU_ON for cpu 2 (MPIDR 0x100) next", "psci: cpu 2: the firmware answered 0 (success)", "stage 3", "3 of 3 processors are running". A hang after "CPU_ON with entry" is the old one: then the fields were not the cause (the watchdog restarts into TWRP) |
| 29 | `m3_prep=3 cpus=6 bootcpu=2` | the four M3s, each "answered 0" and "stage 3", "6 of 6 processors are running". (`bootcpu=4` stays out: the loader starts the boot core itself, before this kernel can write the fields) |
| 30 | run 29's arguments and `cohtest=1` | 30 s after start-up: a "cohtest: cpu N ...: A55" (or "M3") line for each processor with its MPIDR and MIDR, "cohtest: 2 A55s and 4 M3s: every pair, both ways", the first pair's steps 0 to 7c each "0 of 128 lines wrong: ok" (step 1: "100000 of 100000 rounds, 0 stale ... 0 stuck"), a line "A55 0 -> M3 2: 9 of 9 checks passed: ok" for each of the 16 directions, then "cohtest: summary: PASS: COHERENT" or "summary: FAIL: NOT COHERENT: n of 16 directions failed" (the head of hakios.exynos_m3.c says how to read which). `cohtest=3` runs it three times, 30 s apart, while the screen draws. (Its first version took MPIDR's Aff1 for the cluster and said "no A55" with six cores: the A55s number themselves in Aff1) |
| 31 | `rtc_pmic=1` | "rtc: CTRL 0x02 ... YEAR 0x..", "rtc: the clock says YYYY-MM-DD hh:mm:ss ...", then "rtc: using the clock: ..." or "rtc: not used (why)" (The clock, above) |
| 32 | run 29's arguments and `tmu=3 cpufreq_gov=1` | "acpm: fvmap: plugin N \"...\"" and "cpufreq_gov: big: the APM's table (DVFS 3), kHz/uV: ..." (or "the device tree's 21 levels"), "cpufreq_gov: big (DVFS 3): 650000 to 1794000 kHz, now N kHz", then a "cpufreq_gov: N s: ..." line a second, the rates moving with the load and never above the "max" they show (CPU clocks, above) |
| 33 | `halt_off=1`, no charger in, then power off from iOS (or `halt` at the console) | the screen goes black and the phone is off: the power key starts it again into BOOT, not TWRP; if it lands in TWRP instead, the log ends with "halt_off: 3: still running a second after PS_HOLD" or "a charger is attached" (Powering off, above) |
| 34 | `halt_off=2`, the same | the same, after "halt_off: 2: the APM asked to stop ... answered (0)"; run it if run 33 stays on |

The HSI2C core has no bus recovery: a chip that holds SDA low makes every transfer time out after 1 s. With
`max77705_haptic=1` the MAX77705 driver writes two registers (haptic bits only, read back); without it, it only reads.

## What comes next

| Step | How |
|---|---|
| Speaker audio | plays (runs 10-12); to hear it, and the speakers' order (top/bottom, left/right) by ear; the mixer's way (SIFS0) and the amplifiers' current/voltage sense back over UAIF1 for a measured proof ([AUDIO.md](AUDIO.md)) |
| Headphones, microphones | the main microphone is iOS's (`cs47l93=6 abox_mic=1`); next the headphones' first run (`cs47l93_hp=1`), the jack's microphone and the other microphones ([AUDIO.md](AUDIO.md), "The headphones") |
| Bluetooth | on the phone (3 November): the chip powered and patched, 4 Mbaud, an inquiry and an LE scan from the USB console (`bt=7`, given for a run, not a default; `bt scan`); for iOS, `/dev/cu.bluetooth` and the address `bluetoothd` needs are there and it stays up, waiting on BlueTool's boot ([BLUETOOTH.md](BLUETOOTH.md)) |
| Wi-Fi | works (joined from Settings, DHCP, the Internet); next: roaming, power saving ([WIFI.md](WIFI.md)) |
| A longer log | USB works (`usb_gadget=5`, runs 18-22 above); a partition of the phone's would keep one without a host |
| Storage, writing | /private/var kept in USERDATA works (above); next an image with ReportCrash allowed for crash reports |
| The M3s | all four run; booting on an M3 (`bootcpu=4`) has not been tried |
| The low RAM bank | its free RAM is XNU's beside the 2 GB window (Memory layout, "The low bank's free RAM"): 3218 MB in all; next, the drivers with 32-bit DMA could take their buffers from it instead of fixed ranges |
| Sensors | the hub reads six sensors and iOS takes orientation and proximity (`shub=6`, [SENSORS.md](SENSORS.md)); a default once the line has room; the gyroscope's and magnetometer's units, auto-brightness |
| The modem, the rear cameras | the Shannon CP ([docs/modem-plan.md](docs/modem-plan.md)) and the rear cameras are not started |
