# Runtime artifacts

`runtime-host` is the inner host used by Envbox for Development and Staging. It contains Docker
Engine 29.9.0, the integrity-checked Dev Containers CLI 0.89.0 and the static Factory Runtime Connector.
It contains no editor, Change Agent or Verification runner.

`build-runtime-host` adds the pinned OpenCode server and Factory's admitted Skill package installer.
`verification-runtime-host` adds only the
pinned Forgejo runner. The Connector injects the tools required by the assigned role into its primary
Dev Container. A Runtime Attempt records its exact role-specific artifact before creating compute;
recovery cannot replace that artifact through changed installation settings.

`developer-ide` contains the independent pinned Theia 1.76.0 composition. One developer backend
serves authorized Workspace-qualified source through Factory. Theia does not run in each execution
Sandbox. Its package composition and npm integrity lock remain in `deploy/theia-ide/`.

Publish the artifacts with:

```sh
bun scripts/factory/index.ts publish-runtime
```

Publication updates the local digest files without restarting Factory or replacing existing runtime
identities. `factory:restart` loads those pins for new Attempts; existing artifact intents remain fixed.
Runtime manifests use registry digest references, never publication tags.

Normal `factory:up` reuses a complete published set instead of rebuilding all roles. The manual
[distribution workflow](../../.github/workflows/images.yaml) builds amd64/arm64 roles and embeds
their exact multi-architecture digests in the Factory image. A release bundle replaces defaults
atomically during container startup; it cannot change a persisted Runtime Attempt. See
[local deployment](../local/README.md) for Compose and Linux setup.

The clean execution reserve prepares fresh Staging and Verification only. It contains pinned tools
and base images, no checkout, user/model/forge capabilities or used containers/volumes. Default target
is one slot per role, with one concurrent creation, two spare slots and sixteen total admitted or
spare/creating/retiring slots. Unassigned slots expire after fifteen minutes; preparation is bounded
at three minutes and failure replacement waits thirty seconds. `FACTORY_EXECUTION_RESERVE_TARGET`
accepts 0–4 per role; `FACTORY_EXECUTION_MAX_SLOTS` accepts 2–256 and must cover the configured reserve.
Every Pod has role-specific CPU/memory/storage requests and limits, including reserve Pods.
Assignment preserves its exact Pod/PVC, issues new Attempt capabilities and immediately requests
refill. Used slots are destroyed, never returned. Development Workspaces retain their canonical
source and normal retained-storage preparation; no running Pod/PVC hot swap is performed.

Development compute idles after thirty minutes without use. `FACTORY_EXECUTION_IDLE_MINUTES`
accepts 0–1440; zero disables it. Admitted/uncertain Build, working Sessions, pending commits,
retained PTYs, live runtime streams and Run views prevent automatic Stop. Terminal counts are
bounded change events, not polling; browser detachment does not end a PTY. Stop intent is committed
under the Build admission locks before external Stop. Restart grants a fresh inactivity period.
Source/approved data and the independent editor are retained. Staging and Verification do not idle.

After successful prebuild and compute cleanup, private Docker trims unused build cache toward
1 GB within fifteen seconds. It never prunes images, containers, volumes, installed dependencies or
checkout. This is a best-effort cache target, not a filesystem quota. The local RWO provisioner's
8 GiB claim request does not establish a hard disk quota; deployments need storage-enforced quotas
for that guarantee. CPU bursts and RAM/ephemeral storage use the outer Pod's declared role limits;
local measured RAM remains unavailable when Kubernetes Metrics is not installed.

The parent resolves the approved Dev Container configuration before startup and prepares only the
selected registry images and their required Compose dependencies. Images must be digest-pinned;
Docker's canonical repository/digest identity, rather than a tag's text, confirms a cache hit. At most
two acquisitions run concurrently, with an overall 180-second deadline and Stop cancellation. Required
Dev Container hooks and resolved-container boundary checks still run. Each Workspace retains its own
private Docker graph. Registry artifacts can be reused; mutable dependency trees and prior
Verification results cannot.

The host also includes `factory-project-prebuild`. Run it inside the assigned Sysbox host, where it
uses that Workspace's private daemon, with an exact commit, target architecture and Project-owned
registry repository:

```sh
factory-project-prebuild --commit <full-commit> --platform linux/arm64 \
  --config .devcontainer/prebuild/devcontainer.json \
  --image-repository <approved-registry>/open-factory/prebuilds/<project-id>
```

The optional configuration is a normal committed Dev Container image/Dockerfile recipe, not a new
Factory configuration format. The producer resolves it with the pinned CLI, builds local Features
from the exact committed tree, requires digest-pinned external image/Feature inputs and uses the
CLI's committed frozen Feature lock. Local Features must remain inside `.devcontainer`, as required
by that pinned CLI. Put locked dependency installation in the Dockerfile. Its image can
carry immutable dependency seeds; required normal lifecycle hooks populate each owner's writable
checkout without sharing a mutable dependency tree. Compose consumers reference the resulting
ordinary registry digest. This producer does not prebuild a multi-image Compose stack or run a
background build service.

The producer snapshots committed inputs separately from human/Agent files. Its identity includes
Project, commit/tree, configuration, platform, exact CLI integrity and immutable image inputs.
It persists intent before build/publication, verifies image ownership/platform, recovers a produced
image after lost acknowledgement and never treats a publication tag as the consumer identity.
Publication names retain the first creating Runtime Attempt, so independent private daemons cannot
race on a shared tag; Stop/restart retains that persisted name. Dockerfile snapshots receive ordinary
Factory ownership labels at each selectable stage because the pinned CLI forwards its label option
only in the image/Feature path. Neither the canonical Dockerfile nor upstream CLI is modified.
One producer runs per Workspace, with a ten-minute bound, bounded snapshot size and owned interrupted
snapshot cleanup. It passes no reusable Factory, model or forge capabilities into the build. Git,
CLI and registry output does not become product Evidence. This freezes the recipe and identifies
the resulting artifact; arbitrary network-dependent Dockerfile commands are not a reproducibility
guarantee. Private cache eviction does not delete canonical source or approved data.

Snapshot creation uses a temporary root-private Git configuration trusting only that canonical
checkout and its Git directory. This passes the exact trust boundary to local upload-pack on Git
versions that discard command-line overrides, without changing user or installation configuration.
