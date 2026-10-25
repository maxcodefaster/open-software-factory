set -eu
umask 077
unset CODER_AGENT_TOKEN CODER_AGENT_SUBSYSTEM CODER_AGENT_URL
cp /factory/assignment/parent-token /run/factory-parent-token
cp /factory/assignment/child-token /run/factory-child-token
chmod 0400 /run/factory-parent-token /run/factory-child-token
# Sysbox already prepares proc, sysfs and cgroups. The DinD host wrapper would
# make those mounts shared again, which cannot be checkpointed in the child.
dockerd --host=unix:///var/run/docker.sock >/var/log/factory-dockerd.log 2>&1 &
exec factory-runtime-connector parent --assignment /factory/assignment/assignment.json --token-file /run/factory-parent-token --child-token-file /run/factory-child-token
