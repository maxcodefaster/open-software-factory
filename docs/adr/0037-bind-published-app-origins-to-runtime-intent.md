---
status: accepted
---

# Bind published App addresses to their Runtime Attempt

An application cannot derive its browser address from an internal Dev Container port.
Freeze the public Factory origin with new runtime artifact intent, then provide declared
App processes with `FACTORY_APP_ORIGINS`, a JSON object mapping their declared ports to the
isolated origins of that exact Attempt. Use the existing process-environment contract,
without an additional Connector protocol or Project-specific Factory adapter.

These are public addresses, not access grants. Factory credentials, proxy trust, Project
authorization and App authentication remain separate. Existing intents without this
declaration keep their exact assignments; recovery never fills the value retrospectively.
Prepared templates exclude Attempt-specific address metadata, and assignment supplies it
for the consumer. Internal health and service connections still use their declared local
targets.

Top-level App links without a runtime cookie return through Factory's existing session-
and Project-authorized access issuer, preserving the exact App path and query. The issuer
still decides access and creates the one-use grant. API calls, embedded frames and invalid
grant redemptions remain denied; App cookies are never shared across isolated origins.
