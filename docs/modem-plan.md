# The S9's modem under HakiOS: research and plan

Status: **a driver is written and enabled; nothing has run on the phone under 16.5 yet.** November 2026.
The plan below is kept as it was written (a research plan, before any code); `drivers/modem/hakios.shannon.c`
now carries upstream's seven-stage driver, and `configs/starlte.config` turns it on (`CONFIG_HAKIOS_SHANNON=y`,
`cp=7`, `cp_nv=2`, `cp_delay=40`, `cp_rfs=1`, `cp_if=1`). See "Where the work stands" at the end.

The Galaxy S9 (SM-G960F) has a Samsung Shannon CP inside the Exynos 9810 itself (Samsung's driver calls it
`ss360ap`; FirmWire's model of the same chip family is `S360AP`). It shares DRAM with the AP and talks to it
through a mailbox and rings in that shared memory. That is very different from the POCO's Qualcomm MPSS.

**The goal (owner's decision, 2026-11-02):** stock iOS 16.5 user space. CommCenter, Phone, Messages and cellular
data must work with **no iOS user-space changes**. Everything goes in the kernel, so moving to a new iOS
version stays easy. This plan is built around that goal. It also says where the goal is uncertain and what
we can ship before the goal is reached.

Sources, read for facts only. No code from them goes into our repositories:

| Short name | What | Revision read |
|---|---|---|
| GPL | `Scion-Project/android_kernel_samsung_exynos9810` (GPL-2.0) | `lineage-24.0` @ `e590666` |
| DTS | GPL `arch/arm64/boot/dts/exynos/exynos9810-starlte_eur_open_26.dts` | same |
| KERN | `Scion-Project/scion-kernel` | `6be3ace` |
| lsi | Replicant `libsamsung-ipc` (GPL-2.0-or-later, see `samsung-ipc/ipc.c` header, `COPYING`) | `81a412c` (2023-09-20) |
| FW | FirmWire (BSD-3-Clause), the Shannon emulator | `main` |
| BT | seemoo-lab BaseTrace (GPL-3.0): iPhone QMI tooling, `libqmi-ios-ext` | `main` |

## Hard safety rules (they apply to every milestone)

1. **Nothing writes EFS, SEC_EFS, CPEFS, nv_data or anything that holds the IMEI.** This is already enforced
   for storage: `drivers/storage/hakios.ufs.c:1770` (KERN) lists EFS, SEC_EFS, CPEFS, RADIO and the boot
   chain as partitions that are never written, and the UFS driver is read-only by default. The modem work adds
   no write path. The CP's NV image is uploaded into CP RAM from a **read-only** copy. Every NV or file
   write the CP asks for over RFS is accepted into a kernel RAM overlay and is **discarded** at power-off (see
   section 2). There is no `rfs_persist` option, and none will be added.
2. **The modem firmware is not redistributed.** `modem.bin` is read at run time from the phone's own RADIO
   partition through `/dev/ufs_RADIO`, which is read-only. It is never put into an image, a release or git.
   The same goes for `nv_data.bin`: it is per-device and holds the IMEI. It never enters git, CI artifacts or
   logs. Logs print only its size and a hash.
3. No IMEI, IMSI, ICCID or phone number appears unredacted in a log. The kernel masks them to their last 4
   digits.

---

## 1. How the CP boots on the 9810

### 1.1 The pieces in Samsung's kernel

| Piece | File (GPL) | Role |
|---|---|---|
| modem_if core | `drivers/misc/modem_v1/modem_main.c`, `modem_io_device.c` | Builds the `iodevs` (char devices and `rmnetN` netdevs) from the DT. The ioctl switch is at `modem_io_device.c:672-765` (`IOCTL_MODEM_ON/RESET/BOOT_ON/BOOT_OFF/STATUS/XMIT_BOOT/DL_START/FW_UPDATE`) |
| Modem control | `drivers/misc/modem_v1/modem_ctrl_ss310ap.c` | CP power and reset, the mailbox status bits, IRQs |
| Link device | `drivers/misc/modem_v1/link_device_shmem.c` (3936 lines) plus `link_device_memory_sbd.c` | Boot image copy, secure-boot SMC, command handshake, SIPC5 over SBD rings |
| Shared memory | `drivers/misc/mcu_ipc/shm_ipc.c` | The reserved region, the CP memory map read from the TOC |
| Mailbox | `drivers/misc/mcu_ipc/mcu_ipc.c`, `regs-mcu_ipc.h` | AP<->CP interrupts and 32-bit shared registers |
| PMU CAL | `drivers/soc/samsung/cal-if/pmucal_cp.c`, `exynos9810/pmucal_cp_exynos9810.h` | CP power, reset and status sequences |

### 1.2 Device tree facts (DTS)

- **Reserved memory** (`DTS:29-32`): `modem_if { compatible = "exynos,modem_if"; reg = <0 0xF0000000 0x9200000>; }`
  covers 146 MB at **0xF0000000**. `cp_ram_logging` is at 0xF920_0000 (32 MB, `DTS:34-37`; corrected in section 8). `shm_ipc.c:461-471`
  takes the region with `RESERVEDMEM_OF_DECLARE(modem_if, ...)`.
- **shmem node** (`DTS:12616-12625`): `cp_size` 0x7900000 (121 MB, CP code and data), `vss_size` 7 MB (the
  voice DSP), `ipc_offset` 0x8000000 with `ipc_size` 5 MB, and `zmb_offset` 0x8500000 with `zmb_size` 11 MB.
  At probe, `shm_ipc.c:570-640` reads a memory map from the image already in the region, at offset
  **0x200 (TOC) + 0xA0**. That map is a "MEMn" table with `IPC`, `VSS`, `VPA`, `ZMC` and `LOG` entries, and
  when it is valid it overrides the DT values.
- **Mailbox** (`DTS:13167-13176`): `mcu_ipc@14170000`, compatible `samsung,exynos-shd-ipc-mailbox`, 0x180
  bytes, SPI 69. The register map is `regs-mcu_ipc.h:18-32`: INTGR0/INTCR0/INTMR0/INTSR0 at 0x08-0x18,
  INTGR1.. at 0x1C-0x2C, and the shared registers ISSR0.. from 0x80.
- **Modem pdata** (`DTS:12250-12330`): `mif,name = "ss360ap"`, `ipc_version = 50` (SIPC 5),
  `link_name = "shmem"`, `link_attrs = 1993` = 0x7C9. Decoded with `modem_v1.h:247-262`, those bits are
  SBD_IPC, DPRAM_MAGIC, MEM_BOOT, MEM_DUMP, BOOT_ALIGNED, DUMP_ALIGNED and XMIT_BTDLR.
  - Mailbox registers: ap2cp_msg 0, cp2ap_msg 1, ap2cp_united_status 2, cp2ap_united_status 3.
  - Interrupt numbers: int_ap2cp_msg 0, wakeup 1, status 2, active 3; irq_cp2ap_msg 0, status 2, active 3,
    wakelock 8, ratmode 9.
  - Status bit fields: `sbi_cp_status` mask 0xF at bit 1, `sbi_lte_active` at bit 5, `sbi_cp_wakelock` at
    bit 6, and so on.
  - Interrupts: SPI 74 (CP watchdog) and SPI 440 (CP fail).
- **21 iodevs**, listed after the pdata in DTS. The table below shows the name, SIPC channel and format.

| iodev | ch | format | Use |
|---|---|---|---|
| `umts_ipc0`, `umts_ipc1` | 235, 236 | FMT | Samsung IPC control messages (the RIL's channel) |
| `umts_rfs0` | 245 | RFS | Remote file system: **the CP's NV and file access on the AP** |
| `rmnet0..7` | 10..17 | RAW, io_type NET | Data sessions, raw IP |
| `multipdp`, `multipdp_hiprio` | 0 | MULTI_RAW | The demux for the PDP channels |
| `umts_boot0` | 215 | BOOT | The bootloader channel (cbd) |
| `umts_ramdump0` | 225 | DUMP | Crash dumps |
| `umts_csd` | 1 | RAW | Circuit-switched data / video call |
| `umts_router` | 25 | RAW | "Data Router" (AT routing to USB in factory and DUN modes; unverified) |
| `umts_dm0` | 28 | RAW | Diagnostics |
| `umts_cass`, `smd4`, `umts_ciq0` | 35, 33, 26 | RAW | Misc and Carrier-IQ |

Channel numbers come from `modem_v1.h:128-210`: PDP_0 = 10, BOOT_0 = 215, DUMP_0 = 225, FMT_0 = 235,
RFS_0 = 245. None of the iodevs is a plain AT channel. Control goes over Samsung IPC on ch 235.

### 1.3 The modem.bin layout (TOC)

RADIO holds `modem.bin`. Its first 512 bytes are a TOC of 32-byte entries:
`char name[12]; u32 offset; u32 loadaddr; u32 size; u32 crc; u32 entryid;`. The same layout is in
lsi `partitions/toc/toc.h:25-35` and FW `vendor/shannon/TOCFile.py:83-87`. The entries are `TOC`, `BOOT`,
`MAIN`, `VSS` and `NV`, and often `OFFSET` too. The NV entry gives the place and size for `nv_data.bin` in
CP memory. The data itself does not come from RADIO: cbd reads it from `/efs/nv_data.bin`. A chunk is copied to
`region + (entry.loadaddr - BOOT.loadaddr)`, as in lsi `herolte.c` `upload_chunk()`, with
`m_offset = loadaddr - boot.loadaddr`. In the kernel, `shmem_xmit_boot()` (`link_device_shmem.c:2170-2224`)
copies the user buffer to `boot_base + m_offset` after checking the bounds.

### 1.4 The boot sequence, and who does what

The sequence below comes from the GPL driver and from lsi's `herolte_boot()` (Galaxy S7, Exynos 8890, the
same `modem_v1` driver family). lsi took its order from cbd traces: see `herolte.c:193-400` and Tony
Garnock-Jones, "How to boot the Samsung Galaxy S7 modem with plain Linux kernel interfaces only" (2020).

| # | Step | Side | Where |
|---|---|---|---|
| 0 | EL3 sets up the CP's AP_BAAW (its window onto DRAM) and CP_INIT at cold boot | **EL3 monitor (Samsung's)** | comment `modem_ctrl_ss310ap.c:296-299` |
| 1 | Open `umts_boot0`; `IOCTL_MODEM_RESET` | cbd -> kernel | `modem_ctrl_ss310ap.c:399-445` |
| 2 | `IOCTL_SECURITY_REQ` mode 2 (re-init) | cbd -> kernel -> **SMC 0x82000700** | `link_device_shmem.c:2261-2307`, `shm_ipc.c:280-325`, `pmu-cp.h:114` |
| 3 | Read the TOC from RADIO; `IOCTL_MODEM_XMIT_BOOT` for BOOT, MAIN and NV in 62 KB chunks | cbd -> kernel memcpy | `link_device_shmem.c:2170-2224` |
| 4 | `IOCTL_SECURITY_REQ` mode 0 (size_boot, size_main). The kernel runs `cal_cp_init()` once (on the 9810), then SMC 0x82000700 with `mode |= phys_base`. **EL3 verifies the signature** and locks the CP image | kernel + EL3 | `link_device_shmem.c:2290-2303`; SSS clock via SMC 0x82001011 (`modem_v1.h:31`) |
| 5 | `IOCTL_MODEM_ON`: clear the mailbox, set `pda_active`, then on the 9810 write **AP2CP_CFG (0x14820000) bit 0** ("CP_CPU will work") | kernel | `modem_ctrl_ss310ap.c:265-341` |
| 6 | `IOCTL_MODEM_BOOT_ON`: wait for `cp_status` != 0 in mailbox register 3 (up to about 1-2 s) | kernel | `modem_ctrl_ss310ap.c:447-478` |
| 7 | `IOCTL_MODEM_DL_START`, then the boot-channel handshake 0x900d -> 0xa00d, 0x9f00 -> 0xaf00 | cbd <-> CP bootloader | lsi `herolte.c:300-360` (the 8890 numbers; confirm them on the 9810) |
| 8 | CP -> `CMD_INIT_START` (0x1). The AP builds the SBD link descriptor in shmem and answers `CMD_PIF_INIT_DONE` (0xD) | kernel | `link_device_shmem.c:439-482`, `link_device_memory.h:137-149` |
| 9 | CP -> `CMD_PHONE_START` (0x8). The AP answers `CMD_INIT_END` (0x2) **only when the FMT and RFS iodevs are both open** (`rild_ready`) | kernel, gated on user space | `link_device_shmem.c:410-430, 559-645` |
| 10 | `IOCTL_MODEM_BOOT_OFF` waits for that completion (`init_cmpl`). The state is now ONLINE | kernel | `modem_ctrl_ss310ap.c:480-508` |
| 11 | rild opens `umts_ipc0`. RFS requests start right away | RIL / RFS server | |

PMU detail: `cal_cp_init()` runs the `cp_init[]` sequence (`pmucal_cp_exynos9810.h:2-8`). It sets CP_CTRL_NS
bit 1 and CP_CTRL_S bit 3, then waits for RESET_SEQUENCER_STATUS (PMU 0x14060504) == 5. CP_CTRL_S and
CP_CTRL_NS are **secure registers**, written through SMC 0x82000700 READ_CTRL/WRITE_CTRL
(`pmucal_cp.c:217-290`). Reset assert and release are plain PMU writes at 0x14061320-0x14061338
(`pmucal_cp_exynos9810.h:12-23`). Magic words are in `link_device_memory.h:535-538`: IPC 0xAA, BOOT
0x424F4F54, DUMP 0x44554D50, CRASH 0xDEADDEAD.

**What cbd does that the kernel does not:** it reads the TOC and the partitions, reads `nv_data.bin` (and
**writes and repairs** it, with its `.md5` and backup, which is the EFS danger; section 8 shows that on
LineageOS 24 SELinux keeps cbd read-only and rild's RFS server does those writes), runs the order of ioctls,
does the bootloader handshake, restarts the CP after a crash and collects dumps. Everything else is
kernel-side. On HakiOS **all of cbd moves into the kernel driver**, because the goal forbids user-space changes,
and the kernel does none of cbd's NV writing.

### 1.5 Two facts specific to HakiOS that block M0

1. **Memory conflict.** The S9's UEFI reserves **0xF0000000 + 64 MB for the XNU payload**
   (`uefi/files/.../MemoryMapLib.c:18-20`, README "This port's change to the platform"). That is the start of
   `modem_if`. EL3 programs the CP's BAAW for this physical window at cold boot, so the CP region cannot
   move. **The payload must move first** (for example to a free block below 0xF0000000) and the whole
   0xF0000000-0xF91FFFFF range must be kept out of XNU's memory, uncached.
2. **SMCs pass through Carbon.** Carbon Hypervisor owns EL2. Samsung SiP SMCs already reach EL3 through it:
   `drivers/gpu/hakios.mali.c:121,238` and `drivers/audio/hakios.exynos_abox.c:16` use SMC 0x82000410. Nobody
   has tried 0x82000700 (CP secure boot, CP_CTRL) or 0x82001011 (SSS clock) yet. If Carbon filters them, it
   needs a pass-through rule.

### 1.6 How hard is a minimal XNU driver up to the handshake?

Small and well defined, much smaller than the POCO's MPSS (which needed TZ PIL, SMP2P, GLINK and QRTR):

- An ioremap of 0xF0000000 (146 MB), uncached.
- A mailbox driver: one MMIO block plus GIC SPI 69, for about 16 interrupts and 16 shared registers. About
  200 lines.
- The PMU and SMC sequences above, plus AP2CP_CFG. About 150 lines.
- A TOC reader on `/dev/ufs_RADIO` (read-only), the chunk copy and two SMCs. About 250 lines.
- The boot handshake and the `INIT_START -> PIF_INIT_DONE -> PHONE_START -> INIT_END` command handshake,
  including writing the SBD link descriptor (`link_device_memory_sbd.c`, `init_sbd_link`). The SBD layout is the
  largest piece. About 600-900 lines.

**Estimate:** about 1.5-2.5k lines and 2-4 weeks with the phone on USB. The main risk is that EL3 refuses the
SMC or the signature check from our EL1 under Carbon. The ioctl sequence itself is well known.

---

## 2. Channels: SIPC5, SBD rings, RFS

- **Framing** (`include/sipc5.h:32-61`): byte 0 is the config byte. Its top 5 bits are 0b11111 (the start mark)
  and its low 3 bits are flags: PADDING, EXT_LEN, CTL. Byte 1 is the channel ID and bytes 2-3 are the length
  (LE). An optional control byte or a 2-byte extended length follows, giving 4, 5 or 6 bytes of header. With
  `LINK_ATTR_IPC_ALIGNED` frames are padded to 4 bytes.
- **Transport:** on the 9810 every channel runs over **SBD ring buffers**, because SBD_IPC is set. The AP writes
  a link descriptor in the IPC region. It holds one `sbd_rb_channel` per channel and one `sbd_rb_desc` pair
  (UL/DL) per channel (`include/sbd.h:150-170`). Each ring has a length, rp and wp pointers, and arrays of
  offsets and sizes into the buffer pool (`mif,buff_offset` 5 MB, `buff_size` 9 MB). Doorbells use the mailbox
  `int_ap2cp_msg` / `irq_cp2ap_msg` with the mask bits from `link_device_memory.h:120-150`. The legacy
  `shmem_4mb_phys_map` (`link_device_memory.h:80-118`) still supplies the magic and access words.
- **Samsung IPC on FMT (ch 235):** a header is `u16 length; u8 mseq; u8 aseq; u8 group; u8 index; u8 type`,
  followed by the data. The message groups (PWR, CALL, SMS, SEC, NET, MISC, SVC, SS, GPRS, SAT, CFG, IMEI, GEN,
  RFS) are documented as code in lsi `include/*.h`, and `ipc_strings.c` names them. Those values are mostly from
  the Galaxy S2/S3 (XMM6260/6262) era. The 9810's Shannon firmware speaks a newer dialect, so expect new
  commands and changed TLVs. A fork (`manoedinata/libsamsung-ipc`) claims LTE additions for newer Shannon chips.
  **Every message we use has to be confirmed against a capture from the phone (M1).**
- **RFS (ch 245), the EFS danger.** The CP has no flash of its own. It keeps NV items and some files on the
  AP's `/efs` and reaches them through RFS requests: NV_READ_ITEM 0x4201 and NV_WRITE_ITEM 0x4202 in lsi
  `include/rfs.h:29-30`, and on newer firmware file-level open/read/write/close on `/efs` paths. On Android the
  daemon serving it writes `/efs/nv_data.bin` and its md5 and backup.
  - **How we serve it:** the kernel holds `nv_data.bin` (and any other file the CP asks for) as a **RAM
    image**. It is loaded read-only at boot from one of two sources, A or B below. Reads come from the RAM
    image. Writes **update the RAM image only** and are answered "OK", so the CP sees a consistent store for
    the session. Every write is logged by item or offset and length (never the contents of IMEI items). Nothing
    is ever flushed. Opening a file for create or write on any path outside the RAM set is answered with an
    error. This is the same design as the POCO's RMTFS (KERN `docs/cellular.md` "What works": "writes stay in
    kernel memory for the session").
  - **Where the read-only copy comes from:**
    - (A) For M0-M1: the user's own backup of `/efs/nv_data.bin`, packed by `mkimage.sh` into the boot image's
      RAM disk. It is a local file that is never committed and never cached by CI, the `.gitignore`d
      `local/nv_data.bin`.
    - (B) Later: a small **read-only** ext4 reader in the kernel over `/dev/ufs_EFS`. The UFS driver already
      refuses writes to EFS.
  - Gating: `INIT_END` is sent only when FMT and RFS are "open" (`rild_ready`, `link_device_shmem.c:410`). Our
    driver opens both itself once its RFS server and its IPC client are ready.

---

## 3. What stock CommCenter expects from the kernel

### 3.1 The identity

The loader presents **iPhone10,3** (iPhone X, Qualcomm MDM9655 variant). KERN uses the
`20F66__iPhone10,3_6` cache (`docs/air.md:1567`). On this hardware class:

- CommCenter talks **QMI** (QMux framing) to the baseband. Intel iPhones use ARI. Public sources: seemoo-lab,
  "Catch You Cause I Can" (RAID 2024): "iPhones with Qualcomm basebands use QMI". Kröll et al., "ARIstoteles"
  (ESORICS 2021): "Depending on the underlying chip, Qualcomm or Intel, CommCenter loads shared libraries for
  parsing QMI or ARI".
- The transport is **PCIe**. BaseTrace hooks `libPCITransport.dylib` `pci::transport::th::writeAsync` to see
  outgoing QMI (`qmi-inject/agent/send.ts:57-64`). It hooks `libATCommandStudioDynamic.dylib`
  `QMux::State::handleReadData` for incoming QMI (`qmi-inject/agent/receive.ts:6-12`). The Qualcomm-side router
  is `libmav_ipc_router_dynamic.dylib` (`mav_router::device::pci_shim`). "MAV" is Apple's name for the Qualcomm
  path.
- Apple adds **private QMI services** next to the standard ones. BaseTrace's `libqmi-ios-ext/` defines
  `qmi-service-{bsp,vinyl,mavims,elqm,awd,sft,p2p,ms,mfse,coex,apps,audio,vs,...}.json` beside apple
  variants of DMS, NAS, UIM, WDS, WMS and WDA. CommCenter will use at least BSP (baseband state and power)
  and probably others before it will even show "No SIM".

### 3.2 What our own runs already showed

KERN `userland/mkjobs.py:69-86` (20 recorded crashes of stock CommCenter on HakiOS): it dies right after
**"Unable to communicate with AppleBaseband driver" (com.apple.driver.AppleBasebandPCI)** (SIGABRT), or right
after **"Could not find AppleIPAppender service"** (matched by name; user client **ApplePDPHelperInterface**:
PDP contexts, traffic-class flows, dedicated bearers) (SIGSEGV). With no `baseband` node in the DT, launchd
picks `com.apple.CommCenter-noncellular`.

So a stock-compatible kernel must at least provide:

1. A `baseband` node in the device tree we give XNU, so the cellular CommCenter plist is chosen.
2. An IOService that CommCenter (via `libPCITransport` / the ABM baseband manager) accepts as
   **AppleBasebandPCI**, with the user client's selectors for power state, reset, boot stages,
   firmware-update (BBU) status and the QMI pipes. **These selectors are not documented anywhere public.**
3. **AppleIPAppender** with an **ApplePDPHelperInterface** user client that creates and binds PDP contexts to
   the `pdp_ipN` interfaces.
4. `pdp_ip0..N` ifnets, the names iOS's network stack and configd treat as cellular
   (`IFT_CELLULAR` / `IFNET_SUBFAMILY_CELLULAR` exist in open-source XNU `bsd/net/if_types.h`, `bsd/net/if_var.h`).
5. A **QMI server** answering the standard and Apple-private services, with CommCenter's boot-time
   expectations: firmware version, IMEI from DMS, card status from UIM, and BSP state transitions.
6. Probably also the baseband **boot and update** flow that `abm-helper`/`bbupdaterd` and CommCenter's ABM
   expect (on the real hardware: SAHARA/firehose firmware load over PCIe, fusing and nonce checks). The kernel
   would have to present "baseband already booted, firmware current".

### 3.3 Does the POCO port already provide an Apple-compatible interface?

**No.** `drivers/modem/hakios.cell.c:1-18` says so directly: "Darwin's own cellular interface (pdp_ip0) is
made by its baseband stack, which is not here". The POCO exposes data as `en1`, an Ethernet-looking interface
on which the kernel answers ARP and DHCP so that configd routes through it, and puts the signal bars in the
status bar through a SpringBoard injection (`userland/src/inject_sb.c`), which is a user-space change. Its
QMI code (`hakios.qmi.c`, `hakios.nas.c`, and WDS/WDA/DPM in `hakios.mpss.c`) is a QMI **client** talking
**to** a Qualcomm modem over QRTR.

What carries over to the S9:

- The QMI TLV encoder and decoder and the service and message IDs from `hakios.qmi.c`, refactored into a
  shared `qmi_tlv` module that both a client (POCO) and a server (the emulation) use.
- `hakios.cell.c` (en1, ARP and DHCP in the kernel) as the **interim data path** on the S9, unchanged. It needs
  no iOS changes.
- The RMTFS read-only RAM overlay design, applied to RFS.
- The future Apple-facing layer (section 3.4) is shared too: once a kernel QMI server exists on the S9, the
  POCO can put **the same Apple-facing layer** over its real QMI modem and just pass messages through, which is
  easier there than translating them. Build the Apple-facing layer once, as `drivers/modem/hakios.bb.c`, with
  two back ends.

### 3.4 Architecture for the stock path

```
CommCenter / abm / Phone / Messages  (stock, unmodified)
      |  IOKit: AppleBasebandPCI user client (power, boot state, QMI pipes)
      |  IOKit: AppleIPAppender / ApplePDPHelperInterface (PDP contexts)
      v
hakios.bb.c        Apple-facing layer: the IOService names and classes, the selectors, the QMux pipes,
                   pdp_ipN ifnets (IFT_CELLULAR)
      |
hakios.qmisrv.c    QMI server: CTL client IDs, per-service state machines, indications
      |  translation tables (QMI message <-> Samsung IPC message)
hakios.sipc.c      Samsung IPC client on FMT ch 235: seq numbers, request/response matching, unsolicited
      |
hakios.shannon.c   CP boot (section 1), SBD rings, mailbox, RFS RAM server (section 2), rmnet <-> pdp_ip
      v
Shannon CP  (modem.bin from RADIO, read-only; NV from a read-only copy, writes kept in RAM only)
```

Data plane: `rmnetN` SBD rings (raw IP, ch 10-17) feed `pdp_ipN` directly, with no QMAP and no Ethernet
emulation. Until `hakios.bb.c` exists, the same rings feed `en1` through `hakios.cell.c`.

### 3.5 The minimal QMI subset for each milestone (estimates)

The counts are request/response pairs plus indications CommCenter is expected to need. Names follow libqmi
and BaseTrace.

| Stage | Services | Messages (about) | Translation needed |
|---|---|---|---|
| Boot and idle (CommCenter stays up, shows "No Service" or the carrier name) | CTL (allocate/release CID, version info, sync); DMS (caps, IMEI/MEID, revision, serial, operating mode get/set, power state); UIM (card status, read transparent EF ICCID/IMSI/AD/SPN, get slots); NAS (serving system, system info, signal info, register-indications, network time, PLMN name); **BSP (Apple)** and whatever else BaseTrace logs from a real iPhone X at boot | 50-70 + 15 indications | DMS/UIM/NAS map to Samsung MISC/SEC/NET/PWR messages; BSP is answered by the kernel itself |
| Data | WDS (start/stop network, get runtime settings, packet service status ind, get/modify profile); WDA (data format: answer raw IP); DSD (system status) | +20 | GPRS define PDP / activate / IP configuration in Samsung IPC; ApplePDPHelperInterface |
| SMS | WMS (raw send, event report ind, raw read, delete, set routes, get/set SMSC, list messages, indication register, memory status) | +15 | Samsung SMS group (send msg, incoming msg, deliver report, SVC center address); PDUs are 3GPP on both sides, so this is simple |
| Voice (CS) | VOICE (dial, answer, end, all call status ind, burst/continuous DTMF, get/set supplementary service, call waiting/forwarding, USSD) plus Apple "audio"/"vs" services | +30 | Samsung CALL/SS group; **plus the audio path**, section 4 |

Sizing: the boot-and-idle stage is about 5-8k lines (QMI server and translation). Data adds about 2k, SMS about
1.5k, voice about 3k plus audio. The `hakios.bb.c` Apple-facing layer cannot be sized before its selectors are
known.

---

## 4. Verdicts

**Data, the interim path (en1, no iOS change):** realistic. It is the POCO's proven approach: configd treats
en1 as Ethernet, and Safari and apps get data. There are no bars, and iOS sees no "cellular" interface (it does
not count cellular data use, and it ignores the "cellular data" switch).

**Data with stock CommCenter (pdp_ip0):** possible, but it is the expensive part. All the cost is in the
undocumented Apple layer (`AppleBasebandPCI` selectors, ABM boot states, BSP and other private QMI services,
`ApplePDPHelperInterface`). None of that is in public sources. It has to be found by observation:
- run stock CommCenter against logging stub services and record every `IOServiceOpen`, external-method
  selector, struct size and QMI message it sends;
- compare with BaseTrace's public dissectors and published captures from real iPhones.

This is iterative reverse engineering of an interface Apple can change in any iOS release. That weakens the
"easy to move to a new iOS" argument: the Apple-facing layer is version-coupled, even though the CP and SIPC
layers are not. The Apple binaries must not be redistributed or copied into our repos. Observing their behaviour
on our own device is the only method that fits the rules. Honest estimate: **2-4 months**, with a **real
chance of a hard stop** (for example, if CommCenter demands a signed or nonce-checked baseband state we cannot
fake).

**SMS through stock Messages:** follows from the line above. Once CommCenter accepts the baseband, WMS
translation is the easiest service (PDUs pass through unchanged). Medium-high risk, inherited entirely from the
CommCenter layer.

**Voice through the stock Phone app:** low probability. Signalling is translatable (VOICE <-> Samsung CALL).
The audio is the problem:
- On the 9810, call audio runs CP (VSS, the 7 MB voice DSP image in the TOC) <-> ABOX, with **calliope (ABOX's
  DSP firmware) running the call path**.
- Our ABOX driver deliberately keeps calliope off and runs in bypass (`AUDIO.md:5, 25-46`;
  `drivers/audio/hakios.exynos_abox.c:16`), and even that bypass path is not yet confirmed on the phone.
- On the iOS side, iPhone call audio goes through private baseband-audio plumbing in CommCenter and
  mediaserverd/AudioToolbox, with no public documentation.
- VoLTE would add IMS on top. Many networks now need it, since 2G and 3G are being switched off.

Treat voice as research after M3, not a commitment.

**An emulation layer in general:** the QMI-to-SIPC translation is ordinary engineering, because both protocols
are documented or observable. The uncertain part is purely Apple's kernel and user boundary. An alternative
("our own small daemon plus an app") would be much cheaper, but it is ruled out by the owner's decision, and
this plan does not use it.

---

## 5. Milestones

Effort assumes one engineer with the phone on USB (CDC-ACM console, `README.md` "log and console") and runs
of the kind used for Wi-Fi.

### M0: CP boot handshake

Steps:
1. Move the XNU payload out of 0xF0000000 (in the UEFI's `MemoryMapLib.c` and the loader's window choice).
2. Map `modem_if` uncached and keep it out of XNU's memory.
3. Add the mailbox driver.
4. Run the boot sequence (section 1.4), with SMCs through Carbon.
5. Copy BOOT and MAIN from `/dev/ufs_RADIO` and NV from the RAM copy.
6. Reach `CMD_PHONE_START`. Answer `INIT_END` with the RFS RAM server running (a stub first).

Done when the console shows "CP ONLINE" with `cp_status` != 0 and no CP crash for 10 minutes.

**Effort:** 3-5 weeks. **Risk:** medium. Unknowns: whether EL3 accepts SMC 0x82000700 from our EL1 through
Carbon; whether the S-Boot cold boot left the BAAW/CP_INIT intact; the 9810's exact boot0 handshake values.

**Needed from the phone:**
- A rooted Android (stock or Lineage) to capture the **read-only** facts:
  - `dmesg` from boot, with the `mif`/`shmem`/`cbd` lines and the "CP memory map" print (`shm_ipc.c:582-610`);
  - `logcat -b radio`;
  - `/sys/firmware/fdt`;
  - `ls -l /dev/block/by-name`.
- The user's own `/efs/nv_data.bin` (copied **off** the phone with `cat`, a read operation) and a full **EFS
  backup** (README step 2) before the first run.
- Nothing is written to the phone except the boot image.

### M1: IPC channel, SIM and IMSI query (read-only)

Steps:
1. Add the SBD rings and SIPC5 framing.
2. Add the Samsung IPC client on ch 235 and the full RFS RAM server, with the write log.
3. Query, read-only: PWR phone state, MISC ME version and serial, SEC SIM status, SEC RSIM access (READ BINARY
   of EF_IMSI and EF_ICCID), NET registration status and signal.
4. Expose the results as `sysctl kern.hakios.cell.*`, masked.

Done when the SIM status, the masked IMSI and RSSI show up and the RFS write log shows the CP's writes landing
in RAM only.

**Effort:** 3-4 weeks. **Risk:** medium, because the message dialect differs from lsi's. **Needed:** one
Android capture of `umts_ipc0`/`umts_rfs0` traffic (the GPL kernel's `modem_pktlog` is not built in the LineageOS 24 kernel, section 8.1, so by
interposing on rild), and a SIM card.

### M1.5: the CommCenter probe (parallel to M2, decides the stock path)

Steps:
1. Add the `baseband` DT node.
2. Add stub `AppleBasebandPCI` and `AppleIPAppender` services whose user clients **log every call and refuse
   nothing they don't understand**. Grow them until CommCenter stops crashing.
3. Record the selector map and the first QMI frames CommCenter sends.

Done when there is a written interface note (selectors, struct sizes, the QMI bring-up sequence) and a go/no-go
on the stock path.

**Effort:** 3-6 weeks. **Risk:** high: this is where the stock goal can fail. **Needed:** only HakiOS on the
phone (no SIM needed).

### M2: data via rmnet

The interim step (no iOS change): Samsung IPC GPRS define and activate the PDP context on the SIM's APN, read
the IP configuration, and feed rmnet0's SBD rings into `en1` through `hakios.cell.c`. configd routes through it.

**Effort:** 2-3 weeks after M1. **Risk:** medium (the packet-attach and LTE default-bearer dialect).

The stock step (if M1.5 says go): `pdp_ip0` (IFT_CELLULAR), a QMI server for the boot-and-idle and data
subsets, and ApplePDPHelperInterface.

**Effort:** 6-10 weeks more. **Risk:** high.

**Needed:** a SIM with data.

### M3: SMS

WMS <-> Samsung SMS translation, delivery reports, SMSC from the SIM. Inbound SMS go to CommCenter, so this
needs the stock step of M2.

**Effort:** 2-3 weeks. **Risk:** medium (inherits M1.5).

### M4: voice

VOICE <-> Samsung CALL/SS signalling (2-3 weeks); the CP-ABOX call audio with calliope (unknown, probably more
than 2 months); the iOS baseband-audio interface (unknown).

**Risk:** very high. **Needed:** a network with 2G/3G CS voice, or IMS (VoLTE) support, which is a separate
large project.

## 6. Recommended first step

Two things that need no new code and can start now:

1. **The payload move.** Change the UEFI MemoryMapLib and the loader window so that 0xF0000000-0xF91FFFFF is
   free and untouched. This unblocks everything and is testable without the modem.
2. **One rooted-Android capture session**, read-only:
   - `dmesg` (the CP memory map and cbd's ioctl order);
   - `logcat -b radio`;
   - the FDT;
   - a `umts_ipc0`/`umts_rfs0` packet log;
   - the TOC entries of RADIO (names, offsets, sizes only: `dd bs=512 count=1 | xxd`);
   - the user's private copy of `nv_data.bin` and an EFS backup.

After that, M0 in `drivers/modem/hakios.shannon.c` behind `CONFIG_HAKIOS_SHANNON` (off by default) and
`shannon=N` step arguments, matching the `modem_step=` style of the POCO.

## 7. Prior art outside Samsung's kernel

- **libsamsung-ipc** (Replicant, **GPL-2.0-or-later**): the reference for SIPC message groups, the TOC, the
  `herolte` (Galaxy S7 / Exynos 8890, `modem_v1` family) boot and the RFS NV commands. The kernel still has to
  be Samsung's: it uses Samsung's char devices and ioctls. Packaged in postmarketOS (`libsamsung-ipc`). No
  device file for the 9810. Read for facts only; GPL code is not copied into our APSL kernel.
- **Tony Garnock-Jones (2020)**, "How to boot the Samsung Galaxy S7 modem with plain Linux kernel interfaces
  only": the cbd sequence reconstructed, and the source of lsi's herolte support.
- **FirmWire** (BSD-3-Clause): emulates Shannon firmware (`S360AP` class, `soc/__init__.py:70-84`). Useful for
  TOC parsing and the CP's memory map. It does not boot real silicon.
- **Mainline Linux / postmarketOS:** Exynos modem support exists only for old XMM626x-over-HSIC devices
  (Galaxy S2/S3, Note 2). There is **no known boot of an integrated Shannon CP (8890 onward) without
  Samsung's downstream kernel**. Booting it from XNU would be a first, which is why M0 is rated
  medium-risk rather than low.
- **seemoo-lab BaseTrace** (GPL-3.0) and **ARIstoteles**: the public description of the iPhone side (QMI over
  PCIe for Qualcomm iPhones, Apple's private QMI services). Read for facts only.

## 8. What the LineageOS 24 build shows

Studied offline on 2026-11-02, with no phone: `lineage-24.0-20261025-unofficial-starlte.zip`
(1,148,815,564 bytes, sha256 `fb2c1fd4…ee82c20d`, `samsung/lineage_starlte/starlte:17/CP2A.260605.016`). We read
`boot.img`, the ramdisk and the whole vendor image. `system.new.dat.br` was not opened: nothing modem-related lives
there on this build (cbd, rild, libsec-ril, the RIL configs and all the radio init scripts are on vendor). No vendor
or firmware file was copied into this repository. Only facts are recorded here. Paths are inside the build.

### 8.1 boot.img: the kernel is exactly our GPL tree

- `boot.img` is an Android v0 header with Samsung's DT-size field: kernel 38,334,560 bytes, gzip ramdisk
  1,607,625 bytes, a 305,152-byte `DTBH` blob. The kernel banner is
  `Linux version 4.9.337-ies-20323-ge5906667068e (krazey@meme) … clang 22.0.2 … Sun Oct 25 13:30:13 CET 2026`.
  **`ge5906667068e` is commit `e590666`, the GPL revision this plan cites.** So every GPL file and line reference
  in sections 1-2 describes the kernel that actually runs this build.
- The config is embedded (`IKCFG_ST`). The modem part: `CONFIG_MCU_IPC=y`, `CONFIG_SHM_IPC=y`,
  `CONFIG_SEC_SIPC_MODEM_IF=y`, `CONFIG_SEC_MODEM_SS310AP=y`, `CONFIG_UMTS_MODEM_SS310AP=y`,
  `CONFIG_LINK_DEVICE_SHMEM=y`, `CONFIG_LINK_DEVICE_NAPI=y`, `CONFIG_CP_SECURE_BOOT=y`, `CONFIG_CP_ZEROCOPY=y`,
  `CONFIG_CP_RAM_LOGGING=y`, `CONFIG_CP_PMUCAL=y`, `CONFIG_PMUCAL=y`, `CONFIG_MODEM_IF_QOS=y`,
  `CONFIG_MODEM_IF_NET_GRO=y`, `CONFIG_KLAT=y`. Not set: `CONFIG_LINK_DEVICE_MEMORY`,
  `CONFIG_LINK_DEVICE_WITH_SBD_ARCH`, `CONFIG_CP_SMAPPER`, `CONFIG_LINK_POWER_MANAGEMENT`,
  **`CONFIG_DEBUG_PKTLOG`**, `CONFIG_UH`, `CONFIG_RKP_CFP_JOPP`.
  - `LINK_DEVICE_WITH_SBD_ARCH` being off does **not** turn SBD off. It only guards code in the
    `link_device_memory_*` files, which are not built. `link_device_memory_sbd.o` is always linked with
    `LINK_DEVICE_SHMEM` (`modem_v1/Makefile`), and SBD is chosen at run time from `mif,link_attrs` bit SBD_IPC
    (`link_device_shmem.c:3551-3553`). Section 2's SBD-ring transport stands.
  - `CP_ZEROCOPY=y` means the downlink data path uses the ZMB region (`zmb_offset`/`zmb_size`,
    `link_device_shmem.c:3276-3354, 3723`). Our rmnet path has to fill and recycle ZMB buffers, not only the
    SBD rings.
  - `DEBUG_PKTLOG` is off, so the `modem_pktlog` capture that M1 suggests is **not available** on this kernel. An
    IPC/RFS capture must interpose on rild (or use a kernel built with it).
- The `DTBH` blob (version 2) holds **one** DTB, chip 0x2652, hw_rev 0x1A-0xFF, at offset 0x800, size 0x4993C:
  `model = "Samsung Star rev26 board based on EXYNOS9810"`. It is the board DT itself, not just a SoC DT. Its
  modem nodes are the same as the GPL DTS:

| Node | What the DTB says |
|---|---|
| `reserved-memory/modem_if` | `compatible "exynos,modem_if"`, `reg <0 0xF0000000 0x9200000>` (146 MB, ends at 0xF91FFFFF). **No `no-map`**: Linux keeps it in its linear map. |
| `reserved-memory/cp_ram_logging` | `reg <0 0xF9200000 0x2000000>` (32 MB, to 0xFB1FFFFF) |
| `reserved-memory/abox_rmem` | `reg <0 0xFB200000 0x2800000>` (40 MB, ABOX/calliope) right after it |
| `shmem@F6E00000` | `compatible "samsung,exynos-shm_ipc"`, `cp_size 0x7900000`, `vss_size 0x700000`, `ipc_offset 0x8000000`, `ipc_size 0x500000`, `zmb_offset 0x8500000`, `zmb_size 0xB00000`. **No `reg`**: the unit address `F6E00000` is only a name. The base comes from `modem_if`. |
| `mcu_ipc@14170000` | `samsung,exynos-shd-ipc-mailbox`, `reg <0 0x14170000 0x180>`, `mcu,name "mcu_ipc_cp"`, `mcu,id 0`, SPI 0x45 (69), `irq_affinity_mask 3` |
| `mif_pdata` | `sec_modem,modem_pdata`, `mif,name "ss360ap"`, `modem_type 0xA`, `ipc_version 0x32` (50), `link_types 0x200`, `link_name "shmem"`, `link_attrs 0x7C9`, `num_iodevs 0x15`, `buff_offset 0x500000`, `buff_size 0x900000`, SPI 0x4A (74) and 0x1B8 (440), 8 GPIOs (SIM detect lines) |
| mailbox indices | `mbx_ap2cp_msg 0`, `mbx_cp2ap_msg 1`, `mbx_ap2cp_united_status 2`, `mbx_cp2ap_united_status 3`, `mbx_ap2cp_mif_value 4`, `mbx_cp2ap_dvfsreq_cpu/mif/int 5/6/7`, `mbx_ap2cp_kerneltime 9` |
| interrupt bits | ap2cp: msg 0, wakeup 1, status 2, active 3, smapper 4. cp2ap: msg 0, status 2, active 3, smapper 4, perf_req cpu/mif/int 5/6/7, wakelock 8, ratmode 9 |
| status fields | `sbi_cp_status` mask 0xF pos 1, `sbi_lte_active` pos 5, `sbi_cp_wakelock` pos 6, `sbi_cp_evs_mode` pos 7, `sbi_cp_rat_mode` mask 0x3F pos 26, `sbi_ap_status` mask 0xF pos 1, `sbi_pda_active` pos 5, `sbi_ap2cp_wakelock` pos 0, `sbi_crash_type` mask 0xF pos 23, `sbi_device_type` mask 0x1F pos 18, `sbi_ds_det` mask 3 pos 14, `sbi_sys_rev` mask 0xFF pos 6, kerneltime sec mask 0xFFF pos 20 / usec mask 0xFFFFF pos 0 |
| `exynos-pm` | `cp_call_mode_idx 0xA`, `cp_call_psci_idx 0x85`: a separate low-power mode for "AP asleep, CP in a call". The wakeup IRQ list includes 69, 74 and 440. |

  The 21 iodevs and their channel IDs match section 1.2's table exactly (`umts_ipc0` 0xEB, `umts_rfs0` 0xF5,
  `umts_boot0` 0xD7, `umts_ramdump0` 0xE1, `rmnet0..7` 0xA-0x11 with `io_type 1`, two `multipdp` with
  format 3, …). `umts_ipc0`/`umts_ipc1` carry `iod,app "RIL"`. There is no SMC ID, PMU or CP clock node in
  the DT: the SMC numbers and the PMU sequences exist only in the kernel code (sections 1.4 and 1.5).
- The ramdisk holds only `init` and `fstab.samsungexynos9810`. Nothing modem-related.

### 8.2 Vendor: how cbd is started, and what it does

- `vendor/etc/init/init.baseband.rc`:
  - `on init`: `symlink /dev/block/platform/11120000.ufs/by-name/RADIO /dev/mbin0`.
  - `service cpboot-daemon /vendor/bin/cbd -d -tss310 -bm -mm -P platform/11120000.ufs/by-name/RADIO`,
    `class main`, `user root`, groups `radio cache inet misc audio sdcard_rw log sdcard_r shell system`,
    `seclabel u:r:cbd:s0`.
  - `on property:ro.vendor.multisim.simslotcount=*`: write it to
    `/sys/module/modem_ctrl_ss310ap/parameters/ds_detect`.
- cbd's usage text decodes the flags: `-d` daemon, `-t` modem type (`ss310`), `-b m` boot link = shared memory,
  `-m m` main link = shared memory, `-P` the partition path of the CP binary (getopt string
  `hdt:b:m:n:o:p:P:B:D:`). So cbd reads `modem.bin` straight from the RADIO block device. Note the type is
  **ss310** in cbd and in the kernel config, while the DT says `ss360ap`. They are the same driver family.
- `vendor/etc/ueventd.rc`: `/dev/umts*` 0660 system:radio; `/dev/umts_csd` system:loop_radio;
  `/dev/umts_ciq*` system:bridge_rw; `/dev/umts_dm0`, `/dev/umts_router` radio:radio; `/dev/smd4`,
  `/dev/ramdump_memshare` system:radio; `by-name/RADIO` 0660 system:radio; `by-name/CP_DEBUG` 0660 radio:system;
  `/sys/devices/platform/10000.mif_pdata sim/ds_detect` 0660 radio:system. The rmnet devices are netdevs and get
  no ueventd line.
- cbd's ioctls (immediates found at the `ioctl` call sites, all `_IO('o', nr)`; names from `modem_prj.h:74-128`):
  MODEM_ON 0x19, OFF 0x20, RESET 0x21, BOOT_ON 0x22, BOOT_OFF 0x23, BOOT_DONE 0x24, STATUS 0x27,
  DL_START 0x28, FW_UPDATE 0x29, NET_SUSPEND/RESUME 0x30/0x31, DUMP_START 0x32, DUMP_UPDATE/LINK_CONNECTED 0x33,
  CP_UPLOAD 0x35, DUMP_RESET 0x36, SET_TX_LINK 0x37, **XMIT_BOOT 0x40**, LINK_DEVICE_RESET 0x44,
  GET/SET_SHMEM_SRINFO 0x45/0x46, GET_CP_BOOTLOG 0x47, MIF_LOG_DUMP 0x51, **SECURITY_REQ 0x53**,
  CRASH_REASON 0x55. cbd does **not** call GET_SHMEM_INFO (0x41). It logs the security request as
  `security_req: %x:%x:%x:%x`, which is `struct modem_sec_req { mode, size_boot, size_main, dummy }`
  (`modem_prj.h:185-190`), and has "Request Security : secure mode / non-secure mode / dump mode" messages.
- **The boot-channel handshake on the 9810's cbd**, from disassembly of `vendor/bin/cbd`: a helper writes a
  4-byte word to `umts_boot0` and waits for a 4-byte reply ("send 0x%x, wait 0x%x"). Two builders wrap it, each
  taking a stage number N:
  - stage START: send `0x9000 | N<<8`, expect `0xA000 | N<<8`;
  - stage DONE: send `0x900D | N<<8`, expect `0xA00D | N<<8`.
  The CP can also post `0xA001 | N<<8` and `0xA00C | N<<8` inside a stage (cbd waits for them without sending).
  The final step ("HANDSHAKE COMMAND : send & recv boot_done, fin message") is DONE(0) then START(0xF):
  **0x900D → 0xA00D, then 0x9F00 → 0xAF00**. These are the values lsi uses for the 8890, so the open
  question in step 7 of section 1.4 is answered: **unchanged on the 9810**. Stage numbers come from a run-time
  table built from the TOC (44-byte entries). The exact per-stage N values need a log or deeper disassembly. The
  stage log names are `STEP TOC`, `STEP LOADER` (BOOT), `STEP MAIN`, `STEP NV`, `STEP FIN`, with
  `stage=%u, name:%s b_off=… m_offset=… b_size=…` and `TOC[%d].name = %s, b_off, m_off, size, crc`.
- TOC entry names in cbd: `TOC`, `BOOT`, `MAIN`, `VSS`, `NV`, `OFFSET`, `LOADER` (plus `PSIRAM`/`SECPACK` for
  Intel modems that the same binary also supports). cbd checks the TOC CRC ("TOC: CRC check fail twice!!!"),
  can fall back to "CP img map from default table", and logs `vss_size:%lu`.
- Properties cbd sets or reads: `vendor.cbd.boot_done`, `vendor.cbd.first_xmit_done`, `vendor.cbd.cpboot`,
  `vendor.cbd.reset_done`, `vendor.cbd.rfs_check_done`, `vendor.cbd.deviceOffRes`, `vendor.cbd.dt_revision`,
  `persist.vendor.cbd.*`, `ro.csc.sales_code`, `sys.powerctl`. It reads `androidboot.debug_level=` from the
  kernel command line. Logs go to `/data/vendor/log/cbd` (dmesg, CP crash dumps, `cpcrash_cplog_dump_*.BTL`).
- **EFS paths in cbd:** `/mnt/vendor/efs/nv_data.bin` (also `%s/nv_data.bin`), `/mnt/vendor/efs/nv_5g_data.bin`,
  `/mnt/vendor/efs/fsm_data.bin`, `/efs/factory.prop`, `nvdata.bin`. cbd has code to create a default NV when the
  file is missing (`create_empty_nv`, "nv not exist path = %s create default NV", "nv file write fail"). It
  checks free space on EFS and stops on "EFS filesystem error - stop cpboot". The `%s/.%s_%s.bak` pattern in cbd
  sits among the SR-info/CP-log code, not the NV code.
- **But SELinux on this build gives cbd read-only EFS access.** `vendor/etc/selinux/vendor_sepolicy.cil`:
  `allow cbd efs_file (file (read getattr lock map open …))`, `allow cbd bin_nv_data_efs_file (file (read …))`,
  `allow cbd radio_block_device (blk_file (read …))`, `allow cbd vendor_radio_device (chr_file (ioctl read write …))`.
  There is no write, create or unlink rule for cbd on any EFS type. So in practice cbd only **reads** RADIO and
  `nv_data.bin`. The writer is rild (section 8.4).
- `fstab.samsungexynos9810`: `EFS` → `/mnt/vendor/efs` ext4 rw (`errors=panic`); `CPEFS` → `/mnt/vendor/cpefs`
  ext4 **`ro,noload`**. `init.samsungexynos9810.rc` bind-mounts them at `/efs` and `/cpefs`. Android itself never
  writes CPEFS.

### 8.3 Where the CP firmware comes from

Only from the **RADIO partition** (`modem.bin`, read through `/dev/mbin0` / `-P …/RADIO`). `vendor/firmware`
carries no CP file: it holds the ABOX/calliope images (`calliope_dram.bin`, `calliope_sram.bin`,
`calliope_iva.bin`, `AP_AUDIO_SLSI.bin`, `APBargeIn_AUDIO_SLSI.bin`, `APBiBF_AUDIO_SLSI.bin`,
`APDV_AUDIO_SLSI.bin`, `SoundBoosterParam.bin`, `dsm*.bin`, `vts.bin`), Wi-Fi/BT (`bcmdhd_*`, `bcm4361B2_*.hcd`,
`nvram.txt_*`), camera (`fimc_is_*`, `setfile_*`, `HFD*`, `ois_fw_*`), `mfc_fw.bin`, `iva20_rt-lhotse.bin`,
`cs47l92-dsp1-trace.wmfw`, `nfc/`, `score/`. The VSS voice image is the `VSS` entry inside `modem.bin`, not a
vendor file. The per-device inputs are `nv_data.bin` on EFS and whatever the CP reads from CPEFS over RFS.
`/data/modem.bin` in `ueventd.rc` is a leftover with no user in this build. `vendor/etc/plmn_*.bin` are RIL
operator-name tables, not CP firmware.

### 8.4 The RIL and the RFS server

- `vendor/etc/init/init.vendor.rilchip.rc`: `service ril-daemon /vendor/bin/hw/rild` (no arguments), user radio,
  capabilities `BLOCK_SUSPEND NET_ADMIN NET_RAW SYS_ADMIN CHOWN SYS_TIME`, `onrestart restart cpboot-daemon`;
  `ril-daemon1 … rild -c 2` for the second slot, stopped when `ro.vendor.multisim.simslotcount=1`.
  `secril_config_svc SimConfig` (on fs) and `NetworkConfig` (post-fs-data) set the multisim and default-network
  properties.
- `vendor/build.prop`: `vendor.rild.libpath=/vendor/lib64/libsec-ril.so`,
  `vendor.sec.rild.libpath=/vendor/lib64/libsec-ril.so`, `vendor.sec.rild.libpath2=/vendor/lib64/libsec-ril-dsds.so`,
  `ro.telephony.default_network=9,9`.
- `libsec-ril.so` (19 KB) is a LineageOS shim ("sec-ril-smsc-shim") that `dlopen`s the real Samsung RIL
  `/vendor/lib64/libsec-ril-impl.so` (4.5 MB) and only fixes the GET_SMSC_ADDRESS answer.
- The real RIL speaks **Samsung IPC 4.1** (`IpcProtocol41*` classes; groups Misc, Net, Config, Data, Sim, Call,
  Sms, Ss, Sound, Sap, Stk, Imei, Power, Pb, Gen, Ims, Rfs, Svcmode, Factory, …). It opens `/dev/umts_ipc0`,
  `/dev/umts_rfs0` and `/dev/umts_boot0`, reads `/dev/mbin0`, and uses the data interface prefix `rmnet`.
- **The RFS server is inside rild** (thread `ril-rfs`; `Nv::ProcessRfsMessage`, `IpcProtocol41Rfs`), not a
  separate daemon. Its commands: `RFS_NV_READ_ITEM`, `RFS_NV_WRITE_ITEM`, `RFS_NV_WRITE_ALL_ITEM`,
  `RFS_NV_BUFFER_MESSAGE`, `RFS_NV_RESTORE`, and the file-level `RFS_OPEN_FILE`, `RFS_CLOSE_FILE`, `RFS_READ_FILE`,
  `RFS_WRITE_FILE`, `RFS_LSEEK_FILE`, `RFS_GET_FILE_INFO`, `RFS_GET_HANDLE_INFO`, `RFS_FTRUNCATE_FILE`,
  `RFS_CREATE_FILE`, `RFS_UNLINK_FILE`, `RFS_RENAME_FILE`, `RFS_PUT_FILE`, `RFS_GET_FILE`, `RFS_MAKE_DIR`,
  `RFS_REMOVE_DIR`, `RFS_OPEN_DIR`, `RFS_READ_DIR`, `RFS_CLOSE_DIR`, plus `RFS_EXT_CMD`. So the newer firmware's
  file-level RFS (section 2) is confirmed. The RFS roots are `/mnt/vendor/efs` and `/mnt/vendor/cpefs`.
  A modem config line logs `rfsIfName, nvHeader, modemDev, nvSize, nvDir, nvOffSet`.
- **EFS files the RIL writes or manages** (from strings): `/mnt/vendor/efs/nv_data.bin`, its `%s.md5`, the
  backups `%s/.%s_data.bak` and `%s/.%s_core.bak` (presumably `/efs/.nv_data.bak` and `/efs/.nv_core.bak`), an NV log
  (`Nv::NvLog`, `ShrinkNvLog`), `/mnt/vendor/efs/telephony.prop`, `/mnt/vendor/efs/factory.prop`, and
  `RFS_NV_RESTORE` (restore from backup). It reads `/efs/imei/*` (`mps_code.dat`, `omcnw_code*.dat`,
  `replace_code.dat`, `selective`), `/efs/FactoryApp/serial_no`, `/efs/FactoryApp/keystr`,
  `/mnt/vendor/efs/DAK/sakeccert0.der`. It sets `vendor.cbd.rfs_check_done` when its NV check is done.
- SELinux agrees: `allow rild bin_nv_data_efs_file (file (read write getattr setattr lock append map unlink open …))`
  (the label covers `/efs/nv_data\.bin(.*)`, so also the `.md5`), `app_efs_file` (FactoryApp) read-write,
  `imei_efs_file` and `prov_efs_file` **read-only**.

### 8.5 The call audio path (brief)

- `vendor/etc/mixer_paths.xml`: the `incall-*`, `incall_nb-*` and `incall_wb-*` paths route **ABOX SIFS0** to the
  codec (`ABOX UAIF1 SPK = SIFS0` for the receiver) and to `RSRC0 → WDMA0` (the call-record/echo-reference tap).
  The speaker variant adds `UAIF1 → NSRC3 → WDMA4` and `RDMA7 → SIFS1`. There are separate `apcall-*` and
  `wificall_*` paths for AP-side (VoIP, Wi-Fi calling) audio. So in a CS or VoLTE call the voice samples reach
  ABOX's SIFS0 from the calliope voice path, which talks to the CP's VSS. This is not a plain PCM DMA from the AP.
- `vendor/lib64/hw/audio.primary.universal9810.so` has a "Voice Manager", `is_usage_CPCall`, "Stopped CP Voice
  Call", CP call-recording streams, and loads `libaudio-ril.so`. That library exports `SecRilSetVoicePath`,
  `SecRilSetVoiceVolume`, `SecRilSetAudioMode`, `SecRilSetTxMute`/`RxMute`, `SecRilSetWbamr`,
  `SecRilSetSoundClkMode`, `SecRilSetLoopback`, `SecRilSetVoLTEState`, …, i.e. the audio HAL tells the CP the
  path, volume and clock mode through rild (the IPC SOUND group). A HakiOS voice path would need the same
  messages plus calliope running.

### 8.6 What this confirms and what it changes

Confirmed:
- `modem_if` at 0xF0000000, 0x9200000 (146 MB). The UEFI payload conflict in section 1.5 is real.
- The shmem sizes and offsets, the mailbox at 0x14170000 / SPI 69, the CP IRQs 74 and 440, the mailbox register
  and bit assignments, the 21 iodevs and their channels, `link_attrs 0x7C9`, SIPC 5.
- The running kernel is GPL `e590666`, so the cited driver code is what Android runs.
- The boot handshake values: 0x900D → 0xA00D and 0x9F00 → 0xAF00, now known to be part of a general
  `0x9N00/0xAN00` start and `0x9N0D/0xAN0D` done scheme per stage.
- The TOC names `BOOT`, `MAIN`, `VSS`, `NV`, `OFFSET` (and `TOC`, `LOADER`).
- `modem.bin` only on RADIO; no CP firmware in vendor.
- Newer firmware uses file-level RFS on `/efs` and `/cpefs`.

Changed or corrected:
- **`cp_ram_logging` is at 0xF9200000, not 0xF91F0000** (section 1.2 had an arithmetic slip; the GPL DTS has
  `reg = <0 4179623936 33554432>` = 0xF9200000). It runs to 0xFB1FFFFF, and ABOX's 40 MB `abox_rmem` follows at
  0xFB200000. The range to keep out of XNU is **0xF0000000-0xF91FFFFF for `modem_if`**, plus 0xF9200000-0xFB1FFFFF
  if CP RAM logging is enabled, which the CP may expect.
- **cbd does not write EFS on this build.** SELinux gives it read-only access. All NV writes, the `.md5`, the
  `.nv_data.bak`/`.nv_core.bak` backups and NV restore are done by **rild's RFS server**. Our kernel replaces both,
  and the "RAM overlay, never flushed" rule in section 2 covers both.
- **`modem_pktlog` is not built** (`CONFIG_DEBUG_PKTLOG` is off). The M1 capture needs another method (an
  `LD_PRELOAD`/strace-style interposer on rild's `read`/`write` of `umts_ipc0`/`umts_rfs0`, or a kernel with
  pktlog on).
- **`CP_ZEROCOPY` is on.** Downlink IP packets come through the ZMB region (0xF8500000, 11 MB), so the M2 data
  path must handle ZMB as well as the SBD rings.
- `shmem@F6E00000` has no `reg`. Do not read 0xF6E00000 as an address.
- There is no separate RFS daemon and no `vcd`/`DIAG` binary in this vendor (init references them but they are
  absent). Only cbd and rild matter.

### 8.7 Recommended first kernel step

Unchanged in order, sharper in detail:
1. Move the XNU payload out of 0xF0000000 and reserve **0xF0000000-0xFB1FFFFF** (`modem_if` + `cp_ram_logging`)
   uncached. 0xFB200000 onward is ABOX's and is already handled by the audio driver.
2. Then the first code is `hakios.shannon.c` step 1 only: map the mailbox (0x14170000, SPI 69) and the region, and
   **read** `mbx_cp2ap_united_status` (register 3) and the TOC/memory map at region + 0x200 + 0xA0 (left by the
   bootloader if S-Boot preloaded anything). This is read-only, needs no SMC, and tells us whether Carbon and
   the cold-boot state let us see the CP at all. After that comes `IOCTL_SECURITY_REQ` mode 2 (SMC 0x82000700)
   through Carbon, the first call that can fail at EL3.

---

## Where the work stands

The research plan above became code in upstream's kernel tree (Scion-Project/scion-kernel) and is now carried on
this port's 16.5 line:

- `drivers/modem/hakios.shannon.c` is upstream's driver: the seven stages (`cp=N`; the plan's `shannon=N` name
  was not kept), the CP's image copied from RADIO read-only and checked through EL3's own call, the NV data read
  from EFS through `drivers/modem/hakios.ext4ro.h` (read-only, `cp_nv=2`), RFS file opens answered from RAM
  (`cp_rfs=1`), the FMT link, registration, and an optional data context `pdp_ip0` (`cp_if=1`, needs `cp_apn=`).
- The driver refuses to run where the CP's memory is XNU's. This port's UEFI and loader were already changed for
  that (section 1.5): the payload is moved out at once and `0xF0000000-0xFD9FFFFF` (the CP's `modem_if`,
  `cp_ram_logging` and ABOX's region) is kept from UEFI's allocator and from XNU.
- `configs/starlte.config` turns it on by the owner's decision: `CONFIG_HAKIOS_SHANNON=y`, `cp=7`, `cp_nv=2`,
  `cp_delay=40`, `cp_rfs=1`, `cp_if=1`. **It has not been seen running under 16.5 yet**, and no `cp_apn=` is
  given, so the CP registers on the network but opens no data context. `cp=0` for a run leaves it alone.
- `userland/build.sh` builds and installs `scion-celld` (from `tools/ios27/modem/scion-celld.c`), which makes
  `pdp_ip0` a configd network service when the data context exists and ends at once on a boot without the modem.
- The safety rules of this plan stand: nothing writes EFS, SEC_EFS, CPEFS or `nv_data.bin`, and the modem image
  is never redistributed.
