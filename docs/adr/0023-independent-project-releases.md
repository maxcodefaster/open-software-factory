---
status: accepted
---

# Release publication has no dependency on consumers

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

Publication uses the standard pinned Envbox/Sysbox/Dev Containers/Connector Sandbox and an
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
