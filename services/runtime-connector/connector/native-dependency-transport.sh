#!/bin/sh
set -eu

# Called only in the private, networkless base-image preparation. Tests pass a
# temporary root explicitly; no default path can modify the caller's system.
[ "$#" -eq 2 ] || exit 1
root=$1
trust=$2
case "$root" in /*) ;; *) exit 1 ;; esac
[ -f "$trust" ] && [ ! -L "$trust" ]
grep -q -- '-----BEGIN CERTIFICATE-----' "$trust"
if grep -q -- 'PRIVATE KEY' "$trust"; then exit 1; fi

store="$root/usr/local/share/ca-certificates"
mkdir -p "$store"
for prior in "$store"/factory-native-transport-*.crt; do
  [ ! -e "$prior" ] && [ ! -L "$prior" ]
done
# Keep each root in the normal local trust store too. Installing ca-certificates
# during a Feature must not erase the Actor's roots when it rebuilds the bundle.
awk -v directory="$store" '
  /-----BEGIN CERTIFICATE-----/ { count++; file=sprintf("%s/factory-native-transport-%03d.crt", directory, count) }
  file != "" { print > file }
  /-----END CERTIFICATE-----/ { close(file); file="" }
' "$trust"
chmod 0644 "$store"/factory-native-transport-*.crt

mkdir -p "$root/etc/ssl/certs"
bundle="$root/etc/ssl/certs/ca-certificates.crt"
[ ! -L "$bundle" ]
printf '\n' >> "$bundle"
cat "$trust" >> "$bundle"

# APT's image defaults often use HTTP. Keep the same repository hosts, paths,
# signatures and pinning, but require TLS before Features run. Egress stays 443.
for source in "$root/etc/apt/sources.list" "$root/etc/apt/sources.list.d/"*.list "$root/etc/apt/sources.list.d/"*.sources; do
  [ -f "$source" ] || continue
  [ ! -L "$source" ]
  sed -i 's#http://#https://#g' "$source"
done
