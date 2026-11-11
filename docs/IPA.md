# Installing IPAs

Scion's kernel replaces Apple's code-signing policy with a stub (`libkern/amfi/miniamfi.c`): there is no trust cache
and no CoreTrust behind it. **An app needs no Apple ID, no AppSync and no TrollStore.** What it needs is a place in the
rootless prefix and a LaunchServices registration. `ipainstaller`, which the S9 installer carries at
`/var/jb/usr/bin/ipainstaller`, does both, with `uicache`.

TrollStore is not used and is not needed: it relies on CoreTrust and on a trust cache, and this kernel has neither.
(Sileo manages `.deb` packages; `ipainstaller` is for `.ipa` files.)

## What the installer ships

The `s9-installer` workflow puts the Procursus prefix with Sileo in the system image as `/jb`. The first boot copies it
to `/private/var/jb` (a launchd job, `com.hakios.jbseed`, about 30 seconds after SpringBoard; see
`userland/src/jb_seed.c` in the kernel repository). The prefix also carries:

- `/var/jb/usr/bin/ipainstaller` -- this tool, a POSIX `sh` script;
- `/var/jb/usr/bin/unzip` and `/var/jb/usr/bin/ldid` (with `libplist3`) -- what it unpacks and signs with;
- with tweaks on (the default): ElleKit (`/var/jb/usr/lib/TweakLoader.dylib`, `libsubstrate.dylib`) and
  PreferenceLoader. `tweaks=false` leaves those two out and keeps `ipainstaller`.

The prefix has to be on a **persistent** `/private/var`. Install the `...-format-userdata.zip` build: it formats
USERDATA as HFS Plus and sets `ufs_write=1 var_hfs=ufs_USERDATA_data`, so `/var/jb` and everything installed in it
last across boots. With `/private/var` in RAM, `JB_KEPT_ONLY=1` means init does not graft `/var/jb` at all and
`ipainstaller` is not there. **The `-U` installer erases Android's data in USERDATA.**

## SafariViewService and Google sign-in

Google's sign-in sheet in YouTube and Google Maps is not a web view inside the app: it runs in
`SafariViewService`, a hidden system view service. Its entitlements carry
`com.apple.private.security.container-required = com.apple.mobilesafari`, so it starts in
MobileSafari's data container. On a first boot LaunchServices can register MobileSafari before that
container exists and keep `/var/mobile` in its record; `SafariViewService` then has no container to
start in, and native sign-in fails before Google's page loads.

`prep.sh`, which `com.hakios.jbseed` runs after the prefix is at `/var/jb`, now checks both records.
While either one is wrong it calls `uicache -p` for `/Applications/MobileSafari.app` and
`/Applications/SafariViewService.app` -- the same repair that works by hand -- and retries for two
minutes because LaunchServices can still be busy right after SpringBoard. On the first boot it asks
SpringBoard to restart once after the repair (the prefix arrived after SpringBoard had read the
database). Later boots only check, and repair a record that has gone wrong again; if
`SafariViewService` had already started in that boot, a respring is still needed. No re-signing of
`SafariViewService` and no change to its `container-required` entitlement is involved.

To check the records by hand:

```sh
LC_ALL=C /var/jb/usr/bin/uicache -i com.apple.mobilesafari | grep -E 'Bundle Identifier|Container Path'
LC_ALL=C /var/jb/usr/bin/uicache -i com.apple.SafariViewService | grep -E 'Bundle Identifier|Container Path'
```

Both must print the same `Container Path` under
`/private/var/mobile/Containers/Data/Application/` (the UUID differs between installs). If
MobileSafari prints `/var/mobile`, repair it and respring:

```sh
sudo /var/jb/usr/bin/uicache -p /Applications/MobileSafari.app
sudo /var/jb/usr/bin/uicache -p /Applications/SafariViewService.app
sudo /var/jb/usr/bin/killall SpringBoard
```

The boot-time repair says `prep.sh: safari's container recorded (try N)` on the console when it
succeeds, and `prep.sh: safari's container could not be recorded` if LaunchServices stays busy for
two minutes.

A `/private/var/jb` that already exists is not replaced by a later system image, so a phone that
already has a prefix from an older image does not get the boot-time check from the new image. The
manual commands above are the repair there; a fresh install gets it automatically.

## Get a root shell

`ipainstaller` writes to `/var/jb/Applications` and runs `chown`, so it must run as root. The prefix's `sudo` is
set-user-ID root and `%mobile ALL=(ALL) ALL` is in `/var/jb/etc/sudoers.d/procursus`.

1. In Sileo, add/keep the Havoc source and install **NewTerm 3** (or any terminal). If SSH is already configured on
   your image, use that instead.
2. Open NewTerm and run:

   ```sh
   sudo -i
   ```

   The Procursus bootstrap's default mobile password is `alpine`. The port skips the bootstrap's first-run password
   prompt, so that is the password until it is changed. **Change it** with `passwd` (as mobile) or `passwd mobile`
   (as root). Root itself is locked (`root:!` in `/var/jb/etc/master.passwd`); `sudo` from mobile is the way in.

`giveMeRoot` inside `Sileo.app` is **not** a general root runner: it refuses to run unless its parent process is
Sileo itself.

## Use it

Copy the IPA somewhere readable (`/var/mobile/Documents` is convenient: Filza from Sileo, or `scp` if SSH is
configured), then:

```sh
sudo /var/jb/usr/bin/ipainstaller /var/mobile/Documents/App.ipa
sudo /var/jb/usr/bin/ipainstaller -f /var/mobile/Documents/App.ipa   # replace the copy already installed
sudo /var/jb/usr/bin/ipainstaller -n /var/mobile/Documents/App.ipa   # do not sign; install the files as they are
```

With `sudo -i` already done, the `sudo` is implicit. `ipainstaller` with no arguments prints its usage.

What it does:

1. lists the zip with `unzip -Z1` and refuses absolute names and any `..` component before writing anything;
2. unpacks it into a temporary directory under `$TMPDIR` (`/private/var/tmp`);
3. requires exactly one `Payload/*.app` with an `Info.plist`, and refuses a symlink that resolves outside the
   unpacked tree;
4. copies the bundle to a staging directory, `chown -R 0:0`, and signs every Mach-O with `ldid -S`, keeping the
   entitlements the IPA already had (`ldid -e`); `-n` skips this;
5. moves it to `/var/jb/Applications/NAME.app` and registers it with `uicache -p`.

It refuses to install a bundle whose name collides with an application in `/Applications` (the system image's own
apps). `prep.sh` registers `/var/jb/Applications/*.app` again at every boot, so a bundle that `uicache` missed at
install time is picked up after a reboot.

To remove an app:

```sh
sudo rm -rf /var/jb/Applications/NAME.app
sudo /var/jb/usr/bin/uicache -a
```

## Limits

- **iOS 16.5, arm64.** A fat IPA with an arm64 slice runs; an arm64e-only binary does not (the Exynos 9810 has no
  Apple pointer authentication). An app whose `MinimumOSVersion` is above 16.5 may be refused by LaunchServices or
  crash.
- **No FairPlay.** App Store IPAs are encrypted; they do not run, with or without this tool. This project does not
  decrypt, crack or strip apps. Use an unencrypted IPA you are allowed to run.
- **Entitlements.** At the kernel's default `security=bringup`, unsigned code runs, but it has no entitlements. The
  ones that matter to real apps -- keychain, app groups, push -- may need a pseudo-signature carrying them;
  `ldid -S` preserves the entitlements the IPA already has, but whether the AMFI stub then honours them is not
  something this port has read. An app that fails on keychain or push is a candidate for a re-sign with the right
  entitlements, not for AppSync.
- **No signature, no AppSync.** The kernel's `miniamfi.c` accepts what it is given; there is no trust cache to
  install into and no CoreTrust to fool.
- **App containers and extensions.** LaunchServices registers the bundle; an app that expects a container, an app
  group or an extension may still find the port missing the iOS service behind it. That is a property of the port,
  not of `ipainstaller`.

## Troubleshooting

| What you see | What it means |
|---|---|
| `ipainstaller: run as root (sudo /var/jb/usr/bin/ipainstaller ...)` | Run it through `sudo`; NewTerm's mobile shell is not root. |
| `/var/jb/usr/bin/unzip is missing` | The prefix is incomplete: `sudo apt install unzip` (Sileo/apt), or rebuild with the workflow's default `PREINSTALL`. |
| `no /var/jb/usr/bin/ldid: installing unsigned` | `ldid` is not in the prefix; the app is installed without a signature (it has no entitlements). `sudo apt install ldid libplist3` adds it. |
| `expected exactly one Payload/*.app, found N` | The file is not an IPA this tool understands: it must have one top-level `Payload/NAME.app`. |
| `Payload/NAME.app is not a directory` or `has no Info.plist` | The IPA is malformed or has a nested/odd bundle layout. |
| `refusing an entry that escapes the archive` / `refusing a symbolic link that leaves the archive` | The zip tries to write outside the unpack directory. Do not install it; repack a clean IPA. |
| `/var/jb/Applications/NAME.app is already installed (use -f to replace it)` | Use `-f`, or remove the old copy first. |
| `uicache: Error ...` | `/var/jb` may not be grafted yet (wait for Sileo to appear), or SpringBoard is busy: respring/reboot, then `sudo /var/jb/usr/bin/uicache -p /var/jb/Applications/NAME.app`. |
| The icon does not appear | `sudo /var/jb/usr/bin/uicache -a`, then respring; `prep.sh` also retries at boot for two minutes. |
| The app exits immediately | Check the architecture (arm64 slice), `MinimumOSVersion` (16.5 or lower), FairPlay encryption, and the entitlements it asks for. |

The prefix is copied once: a later system image does not replace `/private/var/jb`. To start it over (this removes
every package and app installed in the prefix), remove it on the phone and reboot:

```sh
sudo rm -rf /private/var/jb
```

`com.hakios.jbseed` copies `/jb` from the system image again on the next boot.

## See also

- `docs/apps.md` in the kernel repository: what runs without a signature, and the route for apps.
- `installer/README.md` in scion-installer: the `-U` installer and the `format-userdata` name check.
- `tools/ipainstaller` in this repository: the script itself.
