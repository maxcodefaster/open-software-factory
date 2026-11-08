# Open Software Factory

Self-hosted software development with coding agents. Import your repository and Dev Container,
write requirements, and let an agent implement them. Tests and an independent review check the exact
commit before you approve delivery.

Runs on Kubernetes. Linux arm64 and amd64. Apache-2.0. No telemetry.

[Install](#install) · [Factorybox](#isolation) · [Develop](#developing)

## The workflow

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/lifecycle-dark.svg">
  <img alt="Idea, Interview, Requirements, Design, Build, Review, Deliver and Learn. People approve requirements and delivery." src="assets/lifecycle-light.svg" width="100%">
</picture>

### Write requirements

Tickets hold the request, acceptance criteria and discussion. Write them yourself or ask the AI
Interview to read the repository and clarify missing decisions. Approve the product spec before
technical planning and implementation.

<img alt="Product specification and acceptance criteria awaiting approval" src="assets/screens/spec.jpg" width="100%">

### Work with the agent

Each Sandbox has your Dev Container, a private Docker daemon and running services. Open the IDE
to inspect or edit the source. Open the Preview to use the App. Idle development Sandboxes pause
with their memory and resume the same processes.

<img alt="Project source and running application in the Factory IDE" src="assets/screens/ide.jpg" width="100%">

### Review and deliver

Verification and independent review use the same commit. Review includes a recording of the App.
Your approval promotes the change to Staging. Production deployment remains your responsibility.

<img alt="Passed checks and an App QA recording before delivery" src="assets/screens/review.jpg" width="100%">

Project Wikis keep revisions and human edits. Roles separate product work, development and
administration. OpenBao encrypts secrets. Backups include Git, database, objects and secrets.
Learning proposals need approval before adoption.

## Pause and resume

<img alt="Median pause 4.07 seconds, median resume to a healthy App 2.99 seconds, ten of ten state checks passed" src="assets/story/lifecycle.svg" width="100%">

Ten warm cycles on one Ryzen 7 4800U node with k3s, a 3-CPU / 3-GiB worker, two Node containers
and 256 MiB of random App memory. Times include Kubernetes transport. All ten restores preserved
the process, memory and counters. These are warm restore times, not cold starts.
[Samples](assets/story/lifecycle.json) · [Measurement command](scripts/runtime/README.md).

## Isolation

[Factorybox](https://github.com/maxcodefaster/factorybox) runs user-namespaced system containers
with Sysbox and checkpoints their RAM and filesystem with CRIU. It supports private Docker
without KVM or a custom kernel.

| | Containers | gVisor | MicroVMs | Factorybox |
| --- | --- | --- | --- | --- |
| Kernel | Shared | Userspace kernel | Separate guest kernel | Shared, user namespaces |
| Hardware virtualization | No | No | Required | No |
| Memory checkpoint | Additional tooling | Supported | Runtime-dependent | Built in |
| Node setup | Container runtime | Sandbox runtime | VMM and virtualization | Privileged worker Pod |

The outer worker is privileged and shares the node kernel. Use separate installations and nodes
for mutually untrusted tenants. The [chart guide](deploy/helm/factory/README.md) covers node,
storage and network requirements. For provider pricing comparisons, see [Battleships](https://battleships.dev/).

## Install

```sh
helm install factory oci://ghcr.io/maxcodefaster/charts/factory --version 0.1.0-beta.1 \
  --namespace factory --create-namespace --values private-values.yaml \
  --wait=legacy --timeout 20m
```

Set the node, public addresses and Ingress in `private-values.yaml`. The chart supplies the services
and credentials and pins signed images. On amd64, also pass the released
[worker values](https://github.com/maxcodefaster/open-software-factory/releases/download/v0.1.0-beta.1/factory-amd64-0.1.0-beta.1.yaml).
[Installation, backups and recovery](deploy/helm/factory/README.md).

## Developing

On macOS with OrbStack and [mise](https://mise.jdx.dev):

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run factory:up
```

Open http://127.0.0.1:3000. The launcher prints the generated administrator-password file.
Configure model connections in Settings. Calls send context to the model provider you select.

`bun run check` checks source and the Connector. `bun run check:integration` adds database and
controller tests. `bun run test:browser` runs UI journeys. `bun run beta:gate` writes a release
receipt. Native runtime and clean-install commands are in [scripts/runtime](scripts/runtime/README.md)
and the [chart guide](deploy/helm/factory/README.md). GitHub checks run only for releases or by request.

Built with Solid 2, TanStack Start, Bun, PostgreSQL, Zero, Mastra, OpenCode and Forgejo.
[AGENTS.md](AGENTS.md) holds contributor rules. Report bugs in GitHub Issues and vulnerabilities
through [SECURITY.md](SECURITY.md). [Apache-2.0](LICENSE); bundled assets keep their own notices.
