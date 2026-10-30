---
status: accepted
---

# Settle a retained native Stop without restarting Project execution

OpenCode retains queued input after compute exits. A failed Dev Container can therefore prevent
Factory from confirming an already requested Stop, even when the exact Sandbox is gone. Factory
uses a one-shot native settlement Pod after positively proving the original execution has exited.
It preserves the Stop, Turn, Session, prompt, Workspace and Runtime Attempt identities.

The Pod freezes the published Factory runtime tools image selected by the current installation,
with its matching pinned OpenCode and client versions. It does not depend on the failed Dev
Container's consumer image being usable or cached. The original Runtime Attempt's artifact remains
unchanged. The Pod mounts only that Workspace's retained Git metadata at a separate native-store path.
The original location is an empty, read-only directory, so Project source, Git configuration and
hooks cannot become execution inputs. It receives no provider credentials, Factory capability or
ServiceAccount token. It observes settlement first; interruption and cancellation are limited to
the recorded native Session and input. Unrelated queued input prevents confirmation.

The existing immutable command journal records the declaration and one create attempt before
external creation, then the original Pod UID, native result and cleanup outcome. Lost output
observes the same Pod. A missing Pod after attempted creation does not authorize replacement.
Native success requires actual Pod termination and an exact result; source or identity changes
cannot turn a late result into confirmation of another Stop. The normal authenticated Stop
controller publishes confirmation through its existing compare-and-set boundary.

A corrected tools image or runner can receive a distinct recovery operation after positive
termination or non-execution proof for its predecessor. The immutable journal links those operations;
neither an unknown create outcome nor a missing Pod authorizes replacement. The original Stop,
native input, source and Runtime Attempt are never retargeted.

Recovery is serialized per Factory worker and periodically resumes saved Stop intent without
admitting another Agent Turn. Shutdown cancels and joins its observers; already admitted native
work remains observable after restart. An explicit read-only confirmation cannot create the Pod,
stop compute or dispatch native mutations. Failed or uncertain settlement preserves the barrier.

Restarting the complete Dev Container was rejected because broken Project setup would block Stop
again and rerun Project hooks. Direct SQLite edits or replacing retained state would bypass native
queue semantics and destroy the recovery evidence. Neither is an acceptable Stop implementation.
