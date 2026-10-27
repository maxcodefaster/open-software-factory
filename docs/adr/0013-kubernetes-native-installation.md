# One Kubernetes installation, independent of the workstation

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
[ADR 0022](0022-factorybox-workspace-execution.md). Compatible Linux workers, privileged outer
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

The maintenance fence serializes with inference admission in PostgreSQL, including detached
background workers. An idle-check followed by an unrelated deployment command would leave a
window for new paid work. A busy installation refuses upgrade instead of interrupting it.
