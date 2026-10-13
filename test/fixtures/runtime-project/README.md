# Runtime fixture

This maintained fixture proves the runtime topology and repository System Contract. The Dev
Containers CLI starts `app` as the primary container and `support` as a healthy Compose dependency.
Factory reads `.factory/system.json` at the exact commit and starts its declared App process in the
primary container. The conformance runner verifies service DNS, HTTP, WebSocket upgrade, source
changes, and named-volume persistence.
