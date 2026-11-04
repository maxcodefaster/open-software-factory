---
status: accepted
---

# Admit fresh execution storage only after confirmed drain

Ordinary admitted-worker recovery keeps the exact store as defined in
[ADR 0031](0031-recover-an-admitted-worker-with-its-retained-store.md).
An undersized store may instead require an explicit System Manager recovery
with `storage: "fresh"`. Observe the exact original terminal Pod, settle every
execution and confirm private backing cleanup across all admissions sharing
that store before retaining the new admission and its distinct claim intent.

The new worker selects its fixed capacity within the configured range on the
actual backing volume. Safe whole-byte quantities, claim headroom and native
capacity admission bound that range, rather than a universal 32 GiB ceiling.
The default fresh range is 8 through 64 GiB with a 128 GiB claim.

Keep the original store, admission, execution identities and history unchanged.
Canonical Source stays on its original claim, Namespace and node. There is no
resize, migration, automatic storage replacement or replay of old execution.
Unconfirmed reclamation requires ordinary retained-store recovery so cleanup
can continue there; logical Stop alone cannot authorize abandoning its backing.
