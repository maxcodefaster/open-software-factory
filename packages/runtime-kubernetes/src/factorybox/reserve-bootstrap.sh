set -eu
umask 077
unset CODER_AGENT_TOKEN CODER_AGENT_SUBSYSTEM CODER_AGENT_URL
# CRIU cannot checkpoint MPTCP sockets, and Go listens with MPTCP on kernels that enable it.
export GODEBUG=multipathtcp=0
# Sysbox owns the system mounts; keep their private propagation for Resume.
# Reserve templates must use the same qualified storage layout as assigned work.
dockerd --init --storage-driver=overlay2 --host=unix:///var/run/docker.sock >/var/log/factory-dockerd.log 2>&1 &
exec factory-runtime-connector reserve --slot /factory/assignment/slot.json --activation /home/coder/.factory-reserve/activation.json
