FROM ghcr.io/agent-substrate/substrate/ateworker-gvisor@sha256:f8987236c6256f58c4b2625e543b43f4ae4bdded6ee6821c03d966effb7c0f17
# Configuration only: never replace the release worker executable.
COPY deploy/substrate/internal_flags.json /var/run/ko/internal_flags.json
