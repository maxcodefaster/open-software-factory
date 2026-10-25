set -eu
umask 077
test -n "$FACTORY_POD_UID"
test -n "$FACTORY_STORE_ID"
test -n "$FACTORY_RUNTIME_IMAGE"
test ! -e /factory-seed/intent
test ! -e /factory-seed/rootfs.tar
printf '%s\n%s\n%s\n' "$FACTORY_POD_UID" "$FACTORY_STORE_ID" "$FACTORY_RUNTIME_IMAGE" > /factory-seed/intent
sync /factory-seed/intent
# This runs in the exact consumer image before the worker starts. Project
# source, assignment credentials and host files are never mounted here.
tar -C / -cpf /factory-seed/rootfs.partial \
  --exclude=./proc --exclude=./sys --exclude=./dev --exclude=./factory-seed \
  --exclude=./var/run/secrets --exclude=./etc/hosts --exclude=./etc/hostname \
  --exclude=./etc/resolv.conf .
sync /factory-seed/rootfs.partial
mv /factory-seed/rootfs.partial /factory-seed/rootfs.tar
cd /factory-seed
sha256sum rootfs.tar > rootfs.sha256
sync rootfs.sha256
sync .
