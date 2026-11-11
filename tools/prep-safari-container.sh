# hakios: safari container repair
#
# SafariViewService -- the hidden view service Google's sign-in sheet runs in -- carries
# com.apple.mobilesafari in com.apple.private.security.container-required, so its LaunchServices
# record must name MobileSafari's data container.  On a first boot LaunchServices can register
# MobileSafari before that container exists, leaving /var/mobile in the record; nothing rewrites
# it later.  uicache -p writes the record from the bundle and its entitlements and creates the
# container, which is the repair that works by hand.  Do it here, every boot, and ask SpringBoard
# to read the record again once, on the first boot, when the prefix (and so uicache) arrived after
# SpringBoard had already read it.
#
# This file is inserted after prep.sh's shebang by .github/workflows/s9-installer.yml.  jb_seed
# (userland/src/jb_seed.c) runs prep.sh after the prefix is at /var/jb.
safari_container_path() {
	LC_ALL=C /var/jb/usr/bin/uicache -i "$1" 2>/dev/null |
		/var/jb/usr/bin/sed -n 's/^[[:space:]]*Container Path:[[:space:]]*//p' |
		/var/jb/usr/bin/sed 's/[[:space:]]*$//' |
		/var/jb/usr/bin/head -n 1
}

safari_container_ok() {
	safari_mobile=$(safari_container_path com.apple.mobilesafari)
	safari_view=$(safari_container_path com.apple.SafariViewService)
	case "$safari_mobile" in
	*/var/mobile/Containers/Data/Application/*) ;;
	*) return 1 ;;
	esac
	[ "$safari_mobile" = "$safari_view" ]
}

if ! safari_container_ok; then
	(
		# lsd may still be busy right after SpringBoard; prep.sh's own application
		# registration retries for two minutes for the same reason.
		safari_try=0
		while [ "$safari_try" -lt 24 ]; do
			safari_try=$((safari_try + 1))
			/var/jb/usr/bin/uicache -p /Applications/MobileSafari.app >/dev/null 2>&1 || true
			/var/jb/usr/bin/uicache -p /Applications/SafariViewService.app >/dev/null 2>&1 || true
			if safari_container_ok; then
				echo "prep.sh: safari's container recorded (try $safari_try)"
				# Only a kept /private/var can remember that this was done; on a
				# memory filesystem the prefix is grafted anew at every boot, and
				# the repair is done again there.
				if [ -e /private/var/hakios-runs ] && [ ! -e /var/jb/.safari-container ]; then
					: > /var/jb/.safari-container
					/var/jb/usr/bin/sync
					/var/jb/usr/bin/killall SpringBoard >/dev/null 2>&1
				fi
				exit 0
			fi
			/var/jb/usr/bin/sleep 5
		done
		echo "prep.sh: safari's container could not be recorded"
	) &
fi
