# The Galaxy S9's MFC firmware (prebuilt, Samsung's)

Samsung's firmware for the Exynos 9810's MFC v10 video codec block, the image the kernel's
`drivers/media/mfc/hakios.exynos_mfc.c` starts at step 3 (`mfc=5`). It is 682,192 bytes.

**Not in this repository.** Only this README and `SHA256SUMS` are tracked; the file itself is fetched, and checked
against `SHA256SUMS`, by `tools/fetch-firmware.sh` (from your own copy with `--from DIR`, else from the pinned public
community vendor tree it names; `--check` only verifies). `userland/build.sh` with `DEVICE=starlte` runs it for you
when the file is missing and stops with what to do if it cannot be had.

`userland/build.sh` with `DEVICE=starlte` puts every file of `firmware/` (but the READMEs and `SHA256SUMS`) into
`fw/` of the root image. The MFC driver asks `hakios_image_file("fw", "mfc_fw.bin")` first; only when the image does
not carry it does it read `/firmware/mfc_fw.bin` from the phone's VENDOR partition (or `mfc_fw_part=`).

The S9's VENDOR partition on Android 10 is EROFS, which the kernel's ext4 reader cannot read
(`ext4: VENDOR: cannot be read: not a file (or the partition is not ext2/3/4)`), so without this file in `fw/` the
driver stops with "no hardware video" and VideoToolbox falls back to software decoding.

Source: the LineageOS 24 vendor tree for the Exynos 9810,
[`proprietary_vendor_samsung_exynos9810-common`](https://github.com/ExyHyperBrick/proprietary_vendor_samsung_exynos9810-common),
`proprietary/vendor/firmware/mfc_fw.bin`, at the commit `tools/fetch-firmware.sh` pins. The same file is on the
phone's own `/vendor/firmware/mfc_fw.bin`; a copy pulled from the phone can be checked against the sum below.

| file | what it is | sha256 |
|---|---|---|
| `mfc_fw.bin` | MFC v10's firmware (H.264/HEVC decoder, RISC image and its data) | `378f85ce94f8a3f6700c0bf17f2cd0348809728e26d678cf06204fc528f368d4` |
