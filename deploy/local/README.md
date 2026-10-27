# Source-development data services

This Compose file runs only PostgreSQL, Forgejo and Zero for the source-development launcher.
It does not install Factory or provision Kubernetes. Use the
[repository Helm chart](../helm/factory/README.md) to install Factory into an existing cluster.

Follow the root [source-development commands](../../README.md#source-development). The launcher
configures separate retained service credentials, starts encrypted local OpenBao, publishes the
exact runtime artifacts when needed and starts the source server. Disposable test installations
have their own recorded identity and data services. Never use `down --volumes` on retained data.

The [application image command](../../README.md#development-and-checks) embeds the available exact
runtime references. It does not rebuild Factorybox, the IDE or browser tools. The installed image uses
Kubernetes Services and a ServiceAccount, not this Compose file or the host Docker socket.

The release image-publication workflow builds native amd64 and arm64 images when distribution
is needed. It runs only when a release is published, and local chart acceptance does not require
publication.
Locally built images still need to be available to the selected cluster.
