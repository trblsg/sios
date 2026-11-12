#!/bin/bash
# Put the Galaxy S9's vendor firmware into firmware/<kind>/, where userland/build.sh (DEVICE=starlte) takes it from.
# The files are Samsung's and Broadcom's and are NOT kept in this repository (only their sha256 sums are: the
# SHA256SUMS of each firmware/ directory). This script gets exactly the files those sums name, from one of
#
#   1. a directory of your own, --from DIR (repeatable): the phone's /vendor/firmware pulled with adb, a mounted or
#      unpacked vendor partition of your own phone or of your own firmware package, or a checkout of a LineageOS
#      vendor tree. DIR is searched recursively by file name; a file whose sum is not the pinned one is ignored.
#   2. else the public community vendor trees, at the pinned commits below (GitHub, no login):
#        ExyHyperBrick/proprietary_vendor_samsung_starlte            (the audio DSP's images)
#        ExyHyperBrick/proprietary_vendor_samsung_exynos9810-common  (Wi-Fi, Bluetooth, DSM, MFC, the codec's DSP)
#        ExyHyperBrick/android_kernel_samsung_exynos9810             (Samsung's GPL kernel: the sensor hub's image,
#                                                                      as hex in a header file, turned into bytes here)
#
# Every file is checked against its sum before it is put in place, the one in place is kept when it is right, and a
# file that cannot be had, or does not match, stops the script with what to do. Nothing is written for a bad file.
#
#   tools/fetch-firmware.sh [--from DIR]... [--offline] [--check] [--force]
#
#   --from DIR  look in DIR first (also for bcm_sensorhub_a1.bin, or bbd_patch_file_star.h of Samsung's kernel)
#   --offline   do not download: only --from and what is already in place
#   --check     only verify what is in place against the sums (exit 1 if anything is missing or wrong)
#   --force     replace files that are in place and right as well
#
# Exit status: 0 every file is in place and right; 1 something is missing or wrong; 2 usage.
# Needs: bash, curl (unless --offline), python3, sha256sum or shasum.
set -u

# The pinned sources: change a commit here and the sums of firmware/*/SHA256SUMS together, never one alone.
RAW=${SCION_FW_RAW_URL:-https://raw.githubusercontent.com}
STARLTE_REPO=ExyHyperBrick/proprietary_vendor_samsung_starlte
STARLTE_REV=372082bbd32fcad3fce6a8cc0b793a449c41b48a
COMMON_REPO=ExyHyperBrick/proprietary_vendor_samsung_exynos9810-common
COMMON_REV=2b130daba60bfb1d97cf6e520b226facddb62918
KERNEL_REPO=ExyHyperBrick/android_kernel_samsung_exynos9810
KERNEL_REV=e5906667068efe49ad6a5494296f77965f2e5c5e
KERNEL_HDR=drivers/sensorhub/brcm/bbdpl/q_os/bbd_patch_file_star.h
SHUB=bcm_sensorhub_a1.bin

HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(cd "$HERE/.." && pwd)
FW=$TOP/firmware
FROM=()
OFFLINE=
CHECK=
FORCE=

usage() { sed -n 2,28p "$0" | sed 's/^# \{0,1\}//'; }
say() { echo "fetch-firmware: $*" >&2; }

while [ $# -gt 0 ]; do
	case $1 in
	--from) [ $# -ge 2 ] || { say "--from needs a directory"; exit 2; }
		[ -d "$2" ] || { say "--from $2: not a directory"; exit 2; }
		FROM+=("$(cd "$2" && pwd)"); shift 2 ;;
	--offline) OFFLINE=1; shift ;;
	--check) CHECK=1; shift ;;
	--force) FORCE=1; shift ;;
	-h|--help) usage; exit 0 ;;
	*) say "unknown argument: $1"; usage >&2; exit 2 ;;
	esac
done

if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else say "needs sha256sum or shasum"; exit 1; fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/scion-fw.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# where a file comes from when it is downloaded: REPO REV PATH
origin() {
	case $1 in
	AP_AUDIO_SLSI.bin|APBargeIn_AUDIO_SLSI.bin|APDV_AUDIO_SLSI.bin|APBiBF_AUDIO_SLSI.bin|SoundBoosterParam.bin|\
	calliope_sram.bin|calliope_dram.bin|calliope_iva.bin|dsm_tune.bin)
		echo "$STARLTE_REPO $STARLTE_REV proprietary/vendor/firmware/$1" ;;
	dsm.bin|cs47l92-dsp1-trace.wmfw|bcm4361B2_murata.hcd|bcm4361B2_semco.hcd|bcmdhd_clm.blob|bcmdhd_sta.bin_b0|\
	bcmdhd_sta.bin_b2|nvram.txt_murata_r041_b2|nvram.txt_r02a_b2|nvram.txt_r02b_b2|mfc_fw.bin)
		echo "$COMMON_REPO $COMMON_REV proprietary/vendor/firmware/$1" ;;
	*) return 1 ;;
	esac
}

# Samsung's header: "<Blob=HEX...>" in quoted C string lines; the bytes are the hex, nothing else
shub_from_header() { # HEADER OUT
	python3 -I - "$1" "$2" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="latin-1").read()
m = re.search(r"<Blob=([^>]*)>", text, re.S)
if not m:
    sys.exit("no <Blob=...> in " + sys.argv[1])
hexdigits = "".join(re.findall(r"[0-9A-Fa-f]", m.group(1).replace("\\n", "")))
open(sys.argv[2], "wb").write(bytes.fromhex(hexdigits))
PY
}

fetch() { # URL OUT
	curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"
}

# try to make $TMP/cand for NAME with sum WANT; 0 if it matches. Says where it came from in $HOW.
HOW=
candidate() { # NAME WANT
	local name=$1 want=$2 d f repo rev path
	rm -f "$TMP/cand"
	for d in ${FROM[@]+"${FROM[@]}"}; do
		while IFS= read -r f; do
			[ -n "$f" ] || continue
			if [ "$(sha "$f")" = "$want" ]; then cp "$f" "$TMP/cand"; HOW="$f"; return 0; fi
		done < <(find "$d" -type f -name "$name" 2>/dev/null)
		if [ "$name" = "$SHUB" ]; then
			while IFS= read -r f; do
				[ -n "$f" ] || continue
				if shub_from_header "$f" "$TMP/cand" 2>/dev/null && [ "$(sha "$TMP/cand")" = "$want" ]; then
					HOW="$f (hex of its <Blob=>)"; return 0; fi
			done < <(find "$d" -type f -name "$(basename "$KERNEL_HDR")" 2>/dev/null)
		fi
	done
	[ -z "$OFFLINE" ] || return 1
	if [ "$name" = "$SHUB" ]; then
		fetch "$RAW/$KERNEL_REPO/$KERNEL_REV/$KERNEL_HDR" "$TMP/hdr" 2>/dev/null || return 1
		shub_from_header "$TMP/hdr" "$TMP/cand" 2>/dev/null || return 1
		HOW="$RAW/$KERNEL_REPO/$KERNEL_REV/$KERNEL_HDR (hex of its <Blob=>)"
	else
		read -r repo rev path < <(origin "$name") || return 1
		fetch "$RAW/$repo/$rev/$path" "$TMP/cand" 2>/dev/null || return 1
		HOW="$RAW/$repo/$rev/$path"
	fi
	[ "$(sha "$TMP/cand")" = "$want" ]
}

have=0 got=0
MISSING=()
shopt -s nullglob
sums=("$FW"/*/SHA256SUMS)
[ ${#sums[@]} -gt 0 ] || { say "no firmware/*/SHA256SUMS under $TOP: is this the scion-starlte tree?"; exit 1; }
for sf in "${sums[@]}"; do
	dir=$(dirname "$sf")
	while read -r want name; do
		case $want in ''|'#'*) continue ;; esac
		name=${name#\*}
		dest=$dir/$name
		if [ -f "$dest" ] && [ -z "$FORCE" ] && [ "$(sha "$dest")" = "$want" ]; then have=$((have + 1)); continue; fi
		if [ -n "$CHECK" ]; then
			if [ -f "$dest" ]; then MISSING+=("firmware/$(basename "$dir")/$name (wrong sum)"); else MISSING+=("firmware/$(basename "$dir")/$name"); fi
			continue
		fi
		if candidate "$name" "$want"; then
			install -m 0644 "$TMP/cand" "$dest.part" && mv -f "$dest.part" "$dest"
			got=$((got + 1))
			say "$(basename "$dir")/$name <- $HOW"
		else
			MISSING+=("firmware/$(basename "$dir")/$name")
		fi
	done < "$sf"
done

if [ ${#MISSING[@]} -gt 0 ]; then
	say "ERROR: ${#MISSING[@]} file(s) missing or not matching their sha256 in firmware/*/SHA256SUMS:"
	for m in "${MISSING[@]}"; do echo "  $m" >&2; done
	cat >&2 <<EOF

The vendor firmware is not stored in this repository. Either
  - let this script download it (needs network, and these pinned public sources reachable:
    github.com/$STARLTE_REPO @ ${STARLTE_REV:0:12},
    github.com/$COMMON_REPO @ ${COMMON_REV:0:12},
    github.com/$KERNEL_REPO @ ${KERNEL_REV:0:12}); or
  - point it at your own copy: tools/fetch-firmware.sh --from DIR, where DIR holds the phone's /vendor/firmware
    (adb pull /vendor/firmware DIR, or the unpacked VENDOR partition of your phone or of your own stock firmware
    package) and, for the sensor hub, bcm_sensorhub_a1.bin or Samsung's kernel header $(basename "$KERNEL_HDR").
    Only files with exactly the pinned sums are taken: the sums are of the LineageOS 24 vendor build of the S9,
    and a phone on another firmware build may carry other bytes under the same names. (Without a file in
    fw/ of the image the Wi-Fi, Bluetooth, sensor and MFC drivers read the phone's own VENDOR partition at run time, ufs=2;
    the MFC firmware cannot be read there when VENDOR is EROFS.)
EOF
	exit 1
fi
if [ -n "$CHECK" ]; then say "ok: $have file(s) in place, all match"; else say "ok: $have already right, $got fetched; firmware/ is complete"; fi
