# Reproducible runtime measurements

The lifecycle benchmark measures a fresh Factorybox Sandbox containing the maintained
`test/fixtures/runtime-project` Dev Container: an App container, a supporting service and a named
volume. A Node process keeps 256 MiB of random memory and a counter behind an HTTP state probe.
This is a synthetic lifecycle workload, not an enterprise application or a provider performance ranking.

## Run

Use a native Linux Kubernetes node and the same worker admission required by `runtime:conformance`.
Set `FACTORY_FACTORYBOX_WORKER_IMAGE`, `FACTORY_FACTORYBOX_EXECUTABLE_SHA256`,
`FACTORY_FACTORYBOX_ARCHITECTURE`, `FACTORY_FACTORYBOX_NODE` and, where necessary,
`FACTORY_REGISTRY_CA_FILE`. All image references must include their exact digest.
The Runtime Connector image is read from `.factory/runtime-host-image` or
`FACTORY_RUNTIME_CONFORMANCE_IMAGE`.

```sh
FACTORY_BENCHMARK_CYCLES=10 mise exec -- bun scripts/runtime/benchmark.ts
mise exec -- bun test scripts/runtime/benchmark-model.test.ts
```

The existing conformance adapter creates its own Namespace, Pod and private store, retains exact
operation identities and enforces the existing 420-second workload deadline. Passing runs clean up
their own resources. Failed runs retain native evidence and fence the worker rather than deleting
unresolved storage. This command is not a full conformance or production qualification.

## What is measured

- **Worker admission to command-ready:** creation of a new worker, image preparation, Sandbox start
  and a successful private Docker command. Host image caches are not cleared; call this admission,
  not a universal cold start.
- **App setup:** Dev Containers CLI startup and the first successful state probe. This does not
  include a real repository's clone, dependency install, build or database migration.
- **Pause:** request to confirmed capture, including the host's Kubernetes exec transport.
- **Resume to healthy:** request to successful App state response. The same process PID, startup
  timestamp, memory hash and increasing request counter must survive, as must container identities.
- **Anonymous RAM:** the native pause receipt must report zero anonymous bytes and zero resident
  snapshot pages after capture. This is not total worker memory, freed filesystem cache or a cloud bill.

Raw configuration, per-cycle samples and native operation receipts live under
`.factory/test-results/runtime-benchmark/<run-id>/`. Configuration records exact source and image
identities, hardware architecture, kernel and cache treatment. Summaries use nearest-rank median/p95;
the sample count and every failure must accompany any published number. A failed or short run is
not evidence of long-term reliability, and ten samples do not establish a stable tail latency.

## Comparisons and public evidence

Battleships aggregates pricing and external benchmark datasets; it is not itself the workload used
here. StarSling's published target is 4 vCPU, 8 GiB RAM and 40 GB disk, with real repository suites
such as Better Auth, Mastra and OpenClaw. These are not equivalent to our lifecycle fixture.
A provider comparison needs the same pinned ComputeSDK or StarSling suite, resource shape,
toolchain, test commands, cache treatment, timing boundaries and repeat policy on both sides.
Preserve clone, install, typecheck, build and test timings separately, and count failed provisioning
attempts instead of discarding them. State the provider region and the self-hosted node's hardware.

For cost comparisons include allocated node-hours, the Factory control plane, always-running Staging,
retained disk and snapshots, storage I/O and egress. Pausing processes only saves billed compute if
the infrastructure actually releases or reduces that billed capacity. Model and operations costs are
separate. No live vendor accounts or model credentials are required for this lifecycle measurement.

Keep private application evidence outside public repository assets. Public headline numbers must
have sanitized raw samples, a dated setup and the limitations next to them; do not relabel this
synthetic fixture as a large project run or compare its resume time with someone else's cold boot.
