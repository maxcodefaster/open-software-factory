---
status: accepted
---

# Installation, releases and production hardening


This record holds the decisions formerly numbered 0013, 0023, 0038. Each section keeps its original wording.


## One Kubernetes installation, independent of the workstation

Factory is installed into an existing suitable Kubernetes cluster through one repository-owned
Helm chart. The chart is kept in Git during development; public chart distribution is not an
installation prerequisite for this work. Cluster and VM provisioning remain the operator's
responsibility. Local validation may use OrbStack's Kubernetes without making OrbStack a product
dependency or claiming an unperformed AKS acceptance.

The application and its standard PostgreSQL, Forgejo, Zero, encrypted OpenBao and private
Garage object storage services run
inside Kubernetes. Internal Services carry callbacks and server-to-server traffic; browser-facing
origins remain explicit and independent. Factory uses its ServiceAccount rather than a person's
administrator kubeconfig or the node's Docker socket. Execution uses an admitted, pinned
Factorybox worker with Sysbox and a private Docker daemon per Sandbox, as defined in
[ADR 0002](0002-factorybox-worker-and-execution.md#run-workspace-execution-in-factorybox-with-shared-canonical-source). Compatible Linux workers, privileged outer
worker Pods and usable persistent storage are explicit prerequisites, not automatically relaxed
security settings.

The installed application builds an ephemeral connection configuration from its projected
ServiceAccount files, using `tokenFile` rather than copying the token. Configuration is passed
explicitly to subprocesses. Internal transports are independent of the public OIDC issuer.
App and editor browser hosts use one DNS label beneath `runtime.<factory-hostname>`, so ordinary
wildcard DNS, Ingress and TLS certificates can route them without workstation-only hostnames.
Loopback development uses the same host layout beneath `runtime.localhost`.
The planning cache has an internal Service and a separate browser address. Standard Ingress
routes `/zero` on the Factory hostname to Zero's native optional base path, without a custom
application proxy or controller-specific rewrite. This keeps host-only authentication cookies
available to Zero's authorized query and mutation callbacks. Local port-forwarding uses another
port on the same loopback hostname.

Use the same application and runtime adapters in every environment, not a provider abstraction
or a second control plane. The local source-development launcher is not the installed product's
service supervisor. Separate internal addresses from retained public identity rather than
rewriting issuers or accepted resource identities when installing on another host.

Updates may require a short maintenance window. Active work must settle or be explicitly stopped
before replacement. Upgrades preserve durable state and do not resubmit inference. High
availability, automatic cluster management and migration of the disposable development
installation are outside this decision.

Startup retains a successful storage write/read result with its original probe identities until
cleanup is confirmed. After interruption, it finishes that same cleanup instead of creating another
probe. Changed image or storage-class inputs still require a fresh check. This is recovery of one
unfinished operation, not cached readiness for later starts; replacement identities and foreign
resources continue to refuse cleanup.

The maintenance fence serializes with inference admission in PostgreSQL, including detached
background workers. An idle-check followed by an unrelated deployment command would leave a
window for new paid work. A busy installation refuses upgrade instead of interrupting it.

## Release publication has no dependency on consumers

Factory publishes a human-confirmed version of one delivered, healthy Staging commit through
native Forgejo Releases and optional Project-owned publication workflows. Delivery and Release
are separate: source handoff needs neither an image nor a mandatory release per Ticket.
The last published version informs editable, human-confirmed version-bump suggestions.

Factory retains intent before external writes, correlates native dispatch by an immutable
attempt input and confirms source and artifact identities. A lost response is not permission
to dispatch again. Published versions are not overwritten or automatically deleted by Factory.
Runtime and workflow cleanup cannot remove release artifacts. Explicitly ending an attempt
revokes its write access without pretending already published content or external deployments
were rolled back.

Publication uses the standard pinned Factorybox/Sysbox/Dev Containers/Connector Sandbox and an
unchanged ephemeral Forgejo runner bound to one job-attempt handle. Publication receives no
Development/Main-Preview environment. Package-write credentials are issued only after native
task observation confirms the expected run number, exact SHA, workflow and running job handle.
Verification receives no publication rights.

Private packages use a distinct native Forgejo organization per Project because repository
linkage does not establish package isolation. Machine repository reads and package reads have
separate native credentials. Passwords and temporary publication tokens are stored in OpenBao;
external PAT material is shown once. Rotation and revocation remove current native ACLs as well
as prohibiting the machine identity, so revocation does not rely only on PAT deletion.

External access is a local permission grant, not a registered deployment target. Release success
never waits for an external URL, health check, acknowledgement or deployment. The Kubernetes
recipe publishes images by digest and a versioned OCI Helm chart last. Argo is an independently
configured consumption example, not a Factory runtime dependency. Consumer version rules,
polling, secrets, production reliability, artifact custody and rollback remain outside Factory.
There is no cluster provisioning, provider framework, outbound notification engine or production
control credential in this boundary.

## Production hardening baseline

The prototype phase left development conveniences on production paths. These rules close them
without changing product behavior.

**One signing secret rule.** `factorySigningSecret()` is the only reader of `FACTORY_AUTH_SECRET`.
The development constant is available only to a non-production listener bound to loopback.
Elsewhere Factory refuses to start without a unique secret of at least 32 characters. Bootstrap
replaces a retained development administrator password once a real one is configured, and the
local launcher generates its own password instead of publishing a default. Splitting the secret
into per-purpose keys is deferred: it would invalidate issued monitoring URLs and the registered
Forgejo client.

**Ordered migrations.** The migrator applies the shipped `NNNN_*.sql` files in sequence after the
baseline. It refuses gaps, unknown history and a database newer than the image. Each file
registers its own version in the transaction that applies it.

**Least privilege in the chart.** The Factory ClusterRole lists only calls the code makes.
Stateful services run non-root with dropped capabilities. Default-deny NetworkPolicies allow
the real flows, and Sandbox namespaces cannot reach PostgreSQL, OpenBao or the object store.
Factory runs as uid 1000 with a read-only root filesystem; a once-only init container hands the
retained state claim to that user. It keeps cluster-wide Secret and `pods/exec` access because it
creates Sandbox namespaces and workers at runtime; narrowing that needs a separate
runtime-namespace design.

**Attested releases.** Publication is re-runnable: an architecture image from an earlier attempt
is reused only when its revision label matches. Images carry provenance and an SBOM and are
signed with keyless cosign. The Factory image is started and scanned before its manifest is
published.

**Pinned Factorybox builds.** A worker build names the exact Factorybox commit, refuses a dirty
tree and records its provenance. The worker itself remains qualified in the standalone
repository.

**Connector git.** The Parent runs git with hooks, fsmonitor and global configuration disabled,
an allowlisted environment and bounded runtime. Repository filter drivers and URL rewrites can
still run as the Parent; removing that needs a privilege drop.
