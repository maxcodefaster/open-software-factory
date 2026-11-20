# Runtime fixture

This maintained fixture defines the runtime topology and repository System Contract. The Dev
Containers CLI starts `app` as the primary container and `support` as a healthy Compose dependency.
Factory reads `.factory/system.json` at the exact commit and starts its declared App process in the
primary container. See [runtime checks](../../../scripts/runtime/README.md) for the current proof
commands and their qualification limits.
