# Local deployment

Factory has one runtime architecture. Compose runs the application and its database, Forgejo,
Zero cache and encrypted OpenBao. Kubernetes runs independent IDE/source services and the
pinned Envbox/Sysbox Sandboxes. A Linux kernel is still necessary on Mac through OrbStack.

## Host prerequisites

- Mac: OrbStack Docker and Kubernetes enabled. The default kubeconfig must be self-contained.
  The Compose application uses host networking; this was checked against the local OrbStack host.
- Linux: Docker Engine with Compose/buildx, a reachable Kubernetes API, cgroup v2, kernel modules
  under `/lib/modules`, privileged Envbox Pods and dynamically provisioned persistent volumes.
  An existing single-node Kubernetes installation can be used. Set `FACTORY_RUNTIME_HOST` to the
  host address reachable from both Pods and Docker containers, not `127.0.0.1`.
- Start with 8 GiB available RAM and reserve more for concurrent work. A small machine can run
  the control plane without keeping spare execution slots. The local reserve defaults to zero.

For a fresh Linux host without Kubernetes, the optional installer uses the checksum-pinned K3s
binary from `upstream.json` and its own systemd service and data directory:

```sh
sudo bash scripts/factory/install-linux.sh
export FACTORY_KUBECONFIG=/etc/rancher/factory-k3s.yaml
export FACTORY_RUNTIME_HOST=<host-address-reachable-from-pods>
```

Install Docker, curl, Python 3 and systemd first. The installer refuses existing cluster state.
It never resets another cluster. Keep the kubeconfig private; it grants cluster administration.
Kubeconfigs need embedded credentials and CA data, not host-only certificate paths
or external authentication executables. The fresh-Linux systemd installation has not been exercised
on a separate host; the containerized control plane has been exercised on OrbStack's Linux host.

## Published images

Run the repository's `Publish distribution images` GitHub workflow with a new release version.
It builds each runtime role natively on amd64 and arm64, creates multi-architecture manifests,
and embeds their exact digests in the Factory image. It does not run on pushes. Ensure that the
published GHCR packages are readable by the cluster. A successful workflow does not automatically
make private packages public.

After publication, select the actual release, preferably by digest:

```sh
export FACTORY_IMAGE=ghcr.io/maxcodefaster/open-software-factory/factory:<published-version>
export FACTORY_RUNTIME_HOST=host.orb.internal
docker compose --project-name factory-compose -f deploy/local/compose.yaml up -d factory
docker compose --project-name factory-compose -f deploy/local/compose.yaml logs -f factory
```

Use the Linux host address instead of `host.orb.internal` on Linux. `FACTORY_KUBECONFIG` defaults
to `$HOME/.kube/config`. `FACTORY_KUBERNETES_CONTEXT` selects a context; an empty value uses the
kubeconfig's current context. Native source development retains the `orbstack` default on Mac.

The launcher generates the database password, Zero password, signing secret and initial
administrator password under `.factory/compose/` with private permissions. The initial account
is `admin@factory.local`. Its password is in `admin-password` unless supplied before first startup.
Changing bootstrap variables never resets an existing account. Set provider keys in Factory Settings.
OpenBao stores encrypted values in its own retained volume, with private unseal material in state.
The application receives an AppRole login, not a root token. No development-mode OpenBao is used.

This recipe is local development, with HTTP browser access. It is not an internet-facing production
deployment. Production authentication still requires HTTPS. The Factory container has the Docker
socket and Kubernetes credentials and is trusted infrastructure. Project containers receive neither.

## Build locally and keep installations separate

Maintainers with an existing complete published runtime set can build the application image:

```sh
mise exec -- bun run factory:image
```

The resulting `open-software-factory:local` embeds those exact references. It does not rebuild
Envbox, the IDE or browser tools. The image only works where those references are reachable.
A first source-development `factory:up` builds the runtime set; later starts reuse it.
Use `publish-runtime` explicitly to rebuild changed runtime artifacts.

Container state defaults to `.factory/compose`, separate from the native `.factory` installation.
Choose a project name other than `local`. One state directory belongs to one Compose project.
The state directory is mounted at the same absolute path inside the application so Docker can
mount OpenBao's private TLS configuration. Do not mount another installation's state.

When native Factory is also running, select separate host ports before starting Compose:

```sh
export FACTORY_LOCAL_PORT=3100
export FACTORY_LOCAL_POSTGRES_PORT=58432
export FACTORY_LOCAL_FORGEJO_PORT=34030
export FACTORY_LOCAL_ZERO_PORT=5048
docker compose --project-name factory-compose -f deploy/local/compose.yaml up -d factory
```

`up -d factory` starts the launcher; it prepares dependent services with the retained credentials
and only announces readiness after Zero is healthy. Health status is available through Compose.
A kernel lock prevents concurrent bootstrap of one state directory and releases on process death.
`docker compose ... stop factory` stops the control plane, not its retained data or admitted Pods.
`docker compose ... restart factory` resumes it. Do not use `down --volumes` on retained installations.

## Image footprint and checks

The browser image copies upstream's pinned Chromium unchanged into Node's slim Debian image.
It no longer inherits Firefox, WebKit and Playwright development tools. The local arm64 Docker
image size fell from 1,013,986,944 to 308,407,679 bytes. This is local image size, not compressed
registry transfer size. Native headless rendering was checked. MCP and Factory browser workers
remain in the image. The application image uses production dependencies and a built frontend;
compilers and frontend build dependencies stay in build stages.

Release workflow execution and fresh-Linux provisioning require separate verification. Local
image builds do not publish packages or prove both native architectures.
