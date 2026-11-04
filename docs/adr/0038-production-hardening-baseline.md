---
status: accepted
---

# Production hardening baseline

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
Factory itself still runs as root and keeps cluster-wide Secret and `pods/exec` access because
it creates Sandbox namespaces and workers at runtime; narrowing that needs a separate
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
