# Project release recipe

This is an adaptable Kubernetes example, not a mandatory Project format or a production installer.
Source-only Projects need no release configuration. Factory publishes their versioned source
without starting a workflow. No consumer is required for either path.

For this image-and-chart example, copy `release.json` to `.factory/release.json`,
`factory-release.yml` to `.forgejo/workflows/factory-release.yml`, `publish.mjs` to
`.factory/publish.mjs` and `chart/` to `deploy/chart/` in the Project. Adapt the Docker build,
application port, chart resources and health checks to the application. The Project Dev Container
must supply Node, Git, Docker and its explicitly pinned Helm CLI. Adopt these sources through the normal
reviewed Change and Delivery path before publication.

Image/chart publication requires a reachable HTTPS Forgejo public origin with trusted
certificates. The runner uses that registry origin, not an internal plaintext Git API address.
Factory does not weaken Docker's TLS checks to make a local HTTP registry work.

The contract declares package names under the Project's private Forgejo package organization.
It may declare `images`, one `chart`, and `files`, for example
`"files": [{"name": "client", "filename": "client.tar.gz"}]`. File-only Projects can omit
`images` and publish through the native Generic Package endpoint
`/api/packages/{owner}/generic/{name}/{version}/{filename}` using their publication credential.
Factory reads back the native file checksum. No application image is required for this path.
Files and images may already be visible before the overall Release is confirmed. Consumers
that need the complete set should follow the final native Release metadata, not an early upload.
The workflow has one explicitly dispatched `publish` job and the two exact runner labels shown
in the example. Factory freezes the delivered commit and version. A fresh one-job Sandbox starts
without Development/Main-Preview variables or registries. Its credential endpoint confirms the
native running task, source SHA, run number and job-attempt handle before giving it temporary
Project package-write access. Do not add production credentials to this workflow.

The recipe builds the image, confirms its digest, packages that digest in the chart and publishes
the chart last. A chart version is the Kubernetes consumer's signal, not a Factory status or a
Forgejo Release draft. Published versions must not be reused. Partial artifacts remain retained;
use a new version rather than overwrite them. Factory records the actual manifest digests after
the native workflow succeeds. It never requires a consumer acknowledgement.

## External consumption

In Project Settings → Releases → External access, create distinct read credentials for each
purpose. A repository reader can read that entire repository, including branches and history.
A package reader can read that Project's images and charts, not another Project's private packages.
Credentials are shown once; rotation replaces the identity and revokes the old access.
Install credentials directly into the consumer's secret store, never in Git or chat.

`argocd-application.yaml` is an external operator-owned example, not an object Factory applies.
The operator configures Argo's private Helm-OCI repository credentials with `enableOCI: "true"`,
chooses an approved version constraint and explicitly enables automated synchronization if wanted.
Argo uses its native polling; Factory installs no outbound webhook or deployment controller.
For more restrictive release control, the operator pins one exact version instead.

Argo chart-read credentials are separate from workload `imagePullSecrets`. Install the latter
in the destination workload namespace and reference their names through the chart's
`imagePullSecrets` values. Production credentials, network routing, certificates, destination
authorization, availability and rollback remain external. Argo and the runtime nodes need access
to the relevant Forgejo endpoints, not the Factory UI. If the operator needs independence from
the release source's availability, it must take custody of the artifacts itself.

## Verification

```sh
mise exec -- bun run test:controllers project-releases factory-mcp
mise exec -- bun run test:native native-project-releases
FACTORY_RUN_RELEASE_RUNTIME_PROOF=1 FACTORY_RUN_ARGO_RELEASE_PROOF=1 \
  mise exec -- bun run test:native native-project-releases
```

The ordinary native proof checks Git/package isolation, read-only permissions, protected source
and tags, native job attribution and revocation of an already-issued OCI bearer. The opt-in
runtime proof needs the locally prepared immutable runtime image metadata. It runs a real
Envbox publication against its own Forgejo, OpenBao and database without a consumer.
The separate Argo compatibility fixture uses a pinned repository server to resolve `1.4.*`
to `1.4.3`, excluding `1.5.0`, and render a private chart containing the confirmed image digest.
It also rejects invalid credentials. It installs no CRDs, deploys no workloads and is not an
Argo version recommendation or a Factory dependency. Generated evidence stays under
`.factory/test-results/releases/`; fixtures clean up only their own resources.
