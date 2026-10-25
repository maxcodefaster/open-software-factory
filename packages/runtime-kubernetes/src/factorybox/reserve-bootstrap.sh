set -eu
umask 077
unset CODER_AGENT_TOKEN CODER_AGENT_SUBSYSTEM CODER_AGENT_URL
# Sysbox owns the system mounts; keep their private propagation for Resume.
dockerd --host=unix:///var/run/docker.sock >/var/log/factory-dockerd.log 2>&1 &
exec factory-runtime-connector reserve --slot /factory/assignment/slot.json --activation /home/coder/.factory-reserve/activation.json
