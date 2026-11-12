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

For attribution runs with an instrumented worker, set `FACTORY_BENCHMARK_PROFILE=1`.
This enables bounded native phase diagnostics on individual worker commands and
saves command-category timings in `command-timings.json`. Native phase lines remain
in each operation's stderr evidence. `resources-<cycle>.json` records raw CPU,
throttling, memory and available I/O counters for the exact worker/Sandbox cgroups
before pause, while paused and after resume; these probes run outside the timers.
Labels omit command arguments, source and
credentials. Profiling is off by default; use separate untraced runs for speed
comparisons, since diagnostic work contributes to measured latency.

`FACTORY_BENCHMARK_MEMORY_MIB` selects 64–1536 MiB of random App memory under the
same 3 GiB native fixture ceiling. The default remains 256 MiB. Record memory size
with every comparison: a larger working set is a different workload, not a slower
result on the original fixture.

`FACTORY_BENCHMARK_READY_PROBE=1` additionally measures the first lightweight
App-ready response as `resumeToReadyMS`, then runs the unchanged full memory-hash
and state-preservation assertions. The original `resumeToHealthyMS` still ends
after integrity verification; in this optional mode it also includes the earlier
ready request. Compare matching probe modes only. A cached marker in the ready
response is not proof of preserved memory; the subsequent full probe supplies it.

`FACTORY_BENCHMARK_BATCH_PREFLIGHT=1` evaluates the worker's optional combined
read-only worker-status/capacity command. It applies only to consecutive pause
preflight reads for the exact same worker and phase; mutations, native admission,
Kubernetes identity validation and original intent boundaries remain unchanged.
This needs an experimental worker supporting `--include-worker-status`. There is
no silent fallback to an older binary, and no production worker is selected by
this flag. Compare matching probe, memory, cache and resource settings.

With a pinned experimental worker, `mise exec -- bun scripts/runtime/benchmark-comparison.ts`
runs four serial ten-cycle trials in baseline/combined/combined/baseline order.
All use the same worker binary, 256 MiB workload, original full-integrity probe
and resource shape, with profiling disabled. It retains every trial and verifies
matching inputs and confirmed cleanup. A failure stops the comparison without
discarding the failed native evidence. Twenty samples per mode do not establish
a stable tail latency or a platform/release qualification.

For explicitly owned offline codec analysis only, `FACTORY_BENCHMARK_EXPORT_PAGES`
can name a new private artifact file for the first pause's RAM-image tar export.
The destination is created exclusively with mode `0600`, the immutable checkpoint
is untouched, and export occurs outside lifecycle timers. This is a diagnostic
mode, not a speed comparison. Treat RAM bytes as sensitive even for fixtures;
never place these exports in public assets or use this as a project-data export.

The existing conformance adapter creates its own Namespace, Pod and private store, retains exact
operation identities and enforces the existing 420-second workload deadline. Passing runs clean up
their own resources. Failed runs retain native evidence and fence the worker rather than deleting
unresolved storage. This command is not a full conformance or production qualification.

Preparation failures retain the owned Pod state and bounded worker logs before
cleanup when available. Missing or replaced-Pod logs remain unavailable; diagnostics
do not replace the original error or extend its deadline.

On a desktop host, an external automounter can hold a private loop filesystem
after Kubernetes removes its Namespace. Namespace absence is not proof of physical
store release. The standalone Factorybox `tools/fixture_mount_release.py` observes
and, with `--release`, normally unmounts only a completed, exactly owned local
fixture whose UUID, loop device, node boot and Namespace closure match its receipts.
It never changes automount policy, touches foreign storage or forces an unmount.
This desktop test procedure is not an AKS hosting requirement or production cleanup API.

`project-benchmark.ts` pins public Fastify v5.6.2, runs dependency installation,
lint, the original unit suite, TypeScript checks and validation build, then checks
an independent prepared fork of the running App. The first two default-DNS native
runs failed and remain retained. An ordinary-container control reproduced the
custom-server failure on a bridge and passed with Node's standard `ipv4first`
ordering. `FACTORY_PROJECT_BENCHMARK_DNS_ORDER=ipv4first` selects that explicit
workload setting; it is not a host/kernel change, test patch or automatic product
configuration. Dependency locks, partial command output and original skips are
retained. Do not relabel a configured workload proof as an unconfigured platform
qualification or compare its prepared fork with an unrelated provider cold start.

## Integrity and gated experiments

`filesystem-integrity.ts`, `capacity-integrity.ts` and `resume-copy-integrity.ts`
create separate, exactly owned native fixtures with the ordinary pinned admission.
They check foreign mounts/dirty backing, bounded-store write refusal, and an
unattempted destination-prefix corruption/continuation respectively. Known faults
must be refused before restore or Pause dispatch. Only exact known fixture bytes,
mounts or pressure files may be repaired/released; failed native stores remain
retained. The copy shim belongs to one request's environment, not host PATH or a
replacement of the pinned runtime. Workload and cleanup each keep their original
420-second windows and Sandbox limits remain 3 CPU / 3 GiB.

`advanced-capabilities.ts` observes pinned CRIU memory-tracking/userfaultfd features
and opens/closes worker userfaultfds without changing host policy. A local positive
feature probe is not stock AKS availability or a lazy-restore acceptance gate.
The separate Factorybox `tools/incremental_experiment.py` retains a selected-pin
pre-dump failure in both ordinary/read modes. Its `--full-controls` lane measures
full captures at explicit dirty-page regimes on a disposable process; it does not
claim an incremental comparison, nested Sysbox restore or selected optimization.

`pool-lookup-benchmark.ts` measures the real Factory producer/reserve SQL with a
separate Factory database and **synthetic** native observations. Run it with
`mise exec -- bun --no-env-file scripts/runtime/pool-lookup-benchmark.ts`.
It performs 20 hit/20 empty-ready-pool miss decisions in alternating ABBA order
and rolls back assignment/setup mutations. No Kubernetes worker is created and
no model is called. These samples measure controller decision cost, not native
prepared-slot readiness, a real pool hit rate or production template promotion.

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
