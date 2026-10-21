# Factory on existing Kubernetes

This is a development chart maintained in the Factory repository, not a published chart release.
Install it from the checkout. The operator supplies Kubernetes; this chart does not install
OrbStack, Docker, a VM, an Ingress controller or a cluster.

## Prerequisites

- Suitable Linux Kubernetes workers for the pinned Envbox/Sysbox images. The cluster must permit
  privileged outer execution Pods and the read-only `/lib/modules` host mount. Factory does not
  disable cluster security policies to obtain these permissions.
- Dynamically provisioned RWO persistent storage with normal POSIX filesystem behavior. Set
  `storageClass` when the cluster has no appropriate default.
- A reachable application image containing the complete exact `runtime-artifacts.json` bundle.
  All worker nodes and private Workspace Docker daemons must be able to pull those images.
  A private registry's additional CA can be supplied through `registryCASecret`, with a `ca.crt`
  key. Node image-pull trust is an operator prerequisite, not a privileged installer DaemonSet.
- Browser-facing Factory and Forgejo origins. Non-development installations require HTTPS.
  DNS, an existing Ingress controller and its certificate are supplied by the operator.
  The Factory hostname also needs `*.runtime.<factory-hostname>` for isolated editors and Apps.
  For `factory.example.com`, route `*.runtime.factory.example.com` to the same Ingress and cover
  that wildcard in its TLS certificate. Each isolated host uses exactly one wildcard label.

The application ServiceAccount can manage the concrete Pods, Namespaces, Secrets and volumes
needed by Factory's Workspace topology, and read readiness diagnostics. It cannot administer RBAC.
It is trusted infrastructure, not a restricted tenant application. Project containers receive
neither that ServiceAccount nor the node Docker socket. This is not a hostile-code public service
or a promise of VM-grade isolation.

## Install

Set a small private values file:

```yaml
image: your-registry/factory@sha256:YOUR_BUILT_APPLICATION_DIGEST
publicURL: https://factory.example.com
forgejoPublicURL: https://git.example.com
ingress:
  enabled: true
  className: your-existing-ingress-class
  tlsSecret: your-existing-certificate-secret
```

Then install from the repository:

```sh
helm install factory ./deploy/helm/factory --namespace factory --create-namespace \
  --values /path/to/private-values.yaml --wait=legacy --timeout 10m
```

The repository pins Helm 4. These commands select its supported `legacy` readiness strategy.
The newer watcher waited for the full timeout when observing an absent cleanup hook in the
local native check; the same hook completed normally with `legacy`. This is Helm's installation
readiness behavior, not a Factory polling implementation. Helm 3 uses `--wait` instead.

Factory bootstraps the retained database, encrypted OpenBao and its scoped credentials, Forgejo
service identities and the native OIDC connection. It checks actual writable runtime storage.
Public readiness requires that complete bootstrap, not merely an open application port.
The application uses an internal Service during bootstrap; public traffic uses the readiness-gated
Service. Internal discovery leaves the public OIDC issuer and browser authorization URL unchanged.
The same Ingress routes `/zero` to the planning cache without a rewrite or another public hostname.
Zero's native optional base path carries its WebSocket protocol there. Keeping the browser on
the Factory hostname also preserves the host-only session cookies forwarded to query and mutation
authorization. The internal cache address is never supplied to the browser.
Preserve the incoming Host header. Factory restores the configured public HTTPS identity for that
host and its isolated runtime hosts across the Ingress's HTTP backend hop. It does not trust
caller-provided forwarding headers to select an identity. Internal Service requests keep their
actual HTTP transport.

The initial account is `admin@factory.local`, unless `adminEmail` was set. Retrieve its generated
password from the installation's Secret without putting it in Git:

```sh
kubectl --namespace factory get secret factory-credentials \
  --output 'jsonpath={.data.admin-password}' | base64 --decode
```

Configure model connections in Factory Settings. Provider keys are not Helm values and are not
required to start the interface. They are encrypted through the normal OpenBao adapter.
For a custom provider endpoint, list its allowed HTTPS origin in `modelAllowedOrigins` first.
The chart preserves its generated signing credentials and OpenBao TLS identity on upgrade.
Authentication cookies are scoped by installation, so local releases on different ports do not
overwrite each other's Factory login.
The unseal material and AppRole login are retained in the private Factory state claim, separate
from OpenBao's encrypted data claim. Protect and back up these installation resources together.

## Local development acceptance

During rapid development, build the application image with the maintained image command and make
it available to the selected cluster. No public chart publication is necessary:

```sh
mise exec -- bun run factory:image
```

The image embeds the currently available, exact runtime role references. This build needs the
existing source-development artifact publication; the installed Factory never invokes that
publication or builds runtime tools. An image loaded into one host Docker daemon is not
automatically available to every Kubernetes distribution.

For a local test, set distinct loopback ports and explicit development mode:

```yaml
image: your-cluster-reachable-development-image
development: true
publicURL: http://127.0.0.1:58000
forgejoPublicURL: http://127.0.0.1:58001
developmentZeroURL: http://127.0.0.1:58002
```

After installation, forward the three browser Services in separate terminals:

```sh
kubectl --namespace factory port-forward service/factory-factory 58000:3000
kubectl --namespace factory port-forward service/factory-forgejo 58001:3000
kubectl --namespace factory port-forward service/factory-zero 58002:4848
```

Run all three forwards for local acceptance. `developmentZeroURL` uses a separate port on exactly
the same loopback hostname as `publicURL`, so browser cookies still accompany planning traffic.
Ordinary Ingress installations do not set this value or need a third browser hostname.
Port-forwarding attaches to a particular Pod connection. Reopen the affected forward after a Pod
replacement or a broken connection; a listening local port alone does not confirm live transport.
An Ingress installation does not use these local forwarding processes.

The local HTTP exception is restricted to loopback browser access. Internal callbacks still use
Kubernetes Services, never the Mac's host alias or a manually selected VM address. Testing on
OrbStack does not establish an AKS or independent Linux-host acceptance.

## Maintenance and upgrades

Save human edits, finish or explicitly stop active work, then select the next built image:

```sh
helm upgrade factory ./deploy/helm/factory --namespace factory \
  --values /path/to/private-values.yaml --wait=legacy --timeout 10m
```

The pre-upgrade Job refuses active or unresolved Coding work, pending Knowledge generation and
active model/setup probes. It commits a maintenance fence under the same database lock used by
new inference admissions. A concurrent request therefore cannot slip into the idle-check window.
A busy installation refuses the upgrade without stopping the running application.

The application uses a single-replica Recreate deployment. A short interruption is expected.
Each Helm revision replaces the Factory Pod, even when its image and configuration are unchanged,
so its bootstrap clears the maintenance fence after a successful same-image upgrade too.
Its replacement uses the same retained data, signing credentials and public identities.
Recovery does not commission another inference. Missing retained credentials or a changed
installation identity refuses startup instead of silently generating replacements.

Chart rollback is not a database rollback. Do not assume an older image can read newer schema
changes. If startup or upgrade fails, retain the installation and inspect its exact failed
bootstrap or maintenance Job; do not delete PVCs to make readiness pass.

Uninstalling the chart is not consent to erase Project source. The installation credentials,
OpenBao TLS identity, Factory state and StatefulSet claims are retained. Explicit deletion must
account for the exact installation's Workspace resources and data, never unrelated Namespaces,
volumes or another Helm release. High availability, automatic backups and migration from the
disposable source-development installation are not part of this chart.
