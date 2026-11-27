# Runtime fixture

This maintained fixture defines a native Project ActorTemplate and repository System Contract.
Substrate starts one direct non-root `work` container. Factory starts the source-based Support,
Web and Worker Apps there after Source admission; no container shares Source with another service.
Web checks Support over `127.0.0.1:4100`. A cold startup race returns HTTP 503 rather than crashing
Web or treating a missing dependency as healthy.

The Source volume is mounted at `/workspace`, with the checkout in its `project/` subdirectory.
The separate `fixture-data` durable directory is mounted at `/data`. Commands and Verification
run relative to the actual checkout. Verification checks the assigned Git commit with Git itself,
not the representation of `.git/HEAD`, and runs `npm run check`.

The checked-in image reference is deliberately an **unpublished fixture marker**, not a released
image. `runtimeProjectFiles` and the explicit `prepare-fixture` command must materialize it using
the selected native platform's published Starter work image. They validate the digest catalog;
there is no mutable-tag, upstream-root-image, architecture or legacy-recipe fallback. Publication
of the prepared Starter images remains a separate prerequisite. Do not execute the raw marker.

Host mounts, root-user setup and Docker/Dev Container/Compose configuration are not retained.
Native schema rejection tests own unsafe-input coverage, not executable recipes in this checkout.
See [runtime checks](../../../scripts/runtime/README.md) for proof commands and qualification limits.
