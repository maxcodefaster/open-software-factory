# Delivered Change branches remain protected with no writers

Delivery cleanup seals the exact Change branch through the existing durable Forge protection
intent and confirms an empty writer set. It retains the protected source ref and its history.
Compute and runner cleanup still complete; branch retirement must be confirmed before clearing
the cleanup outcome.

The native forge rejects deletion of protected branches. Removing protection merely to delete
a ref would open a write-permission gap while developers retain repository access. Retaining a
closed branch avoids that gap and preserves any late source work instead of blindly deleting it.
Delivery Approval, the merge and Staging remain bound to the exact verified commit.

This replaces the earlier merged-branch deletion detail in ADR 0003. It does not relax default-branch
protection, reopen delivered Changes or grant another writer.
