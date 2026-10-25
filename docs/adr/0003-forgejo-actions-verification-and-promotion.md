---
status: accepted
---

# Forgejo Actions is the Change CI path and Factory owns promotion

Forgejo remains the internal source forge for repositories, commits, branches, pull requests, Action runs, and merge results. Factory remains the only product control plane. It exposes Factory concepts in its own UI and uses a narrow Forgejo adapter instead of exposing Forgejo as a second product UI or implementing Git hosting and pull-request semantics itself.

Factory protects the default branch against direct pushes and creates one pull request per Change after the first commit reaches its Change branch. Factory records its intent before creating the pull request and recovers an unclear result by finding the pull request for the expected repository and branches. Forgejo branch protection is an additional safeguard; Factory still decides whether the current commit may be delivered.

The binding Verification runs through the native Forgejo Actions `pull_request` event. Opening the pull request or pushing another commit starts `.forgejo/workflows/factory-verification.yml`; Forgejo owns scheduling, cancellation, concurrency, and manual retries. Factory does not implement a second workflow scheduler. Factory accepts the result only while the workflow definition matches the protected default-branch version. An agent-authored Change cannot alter that protected workflow.

Each pending verification run receives a fresh Factory Verification Sandbox using the standard Envbox, Sysbox, Dev Containers, and Runtime Connector topology. Factory registers a repository-scoped, one-job Forgejo runner inside that Sandbox and revokes it after the run. The runner executes in host mode inside the disposable Project Dev Container, where the Sandbox provides the isolation that a shared host runner would lack. It has read-only source access, receives no delivery secrets, cannot reach the Kubernetes control plane, and never uses a shared host Docker socket. The workflow checks that it is testing the pull request's current commit before running the Project toolchain.

Fresh Verification may consume approved immutable prebuilt images and dependency artifacts, or a
never-used prepared execution slot. It never adopts development source, a mutable dependency tree,
an already-used Sandbox or a cached Verification result. Preparation cannot weaken exact-commit,
protected-workflow or one-job runner authority.

Forgejo keeps workflow logs and retry state. Factory records which commit ran, whether it passed, and a compact result summary. Webhooks wake reconciliation, but Factory confirms the final result through the Forgejo API. Repeating a run needs no separate Factory retry system.

A failed run does not mark the Change complete. Factory sends a bounded failure summary from the Forgejo run back to the same Change Agent, which may edit, run local checks, and push another controlled commit. Forgejo then starts another pull-request run. This repair loop continues while the developer leaves the agent running, but it pauses on user stop, an unresolved agent question, exhausted execution limits, or repeated failure without a new code change. Factory never stores the full CI log as product state.

Factory permits merge only when the current pull-request commit passed and a Delivery Approval names that same commit and test result. The Project default branch must also still point to the commit from which the Change started. Factory uses fast-forward-only merge, so the tested commit itself becomes the default-branch and Staging revision. If either branch moved, the code must run through CI and approval again.

After Forgejo confirms the merge, Factory persists Promotion intent for the exact merged commit and creates replacement Staging compute. The existing healthy Staging Preview continues serving traffic until the replacement is ready. Only then does Factory switch the Preview and clean up owned compute and runners. The delivered Change branch stays protected with no writers, rather than dropping its protection to delete the ref; [the branch-retirement decision](0011-delivered-branch-retention.md) records that constraint. A failed Verification, merge, or Promotion leaves enough state for deterministic retry and does not replace healthy Staging.

Factory owns desired state for Development Workspaces and Project Staging. This delivery path
ends at the healthy Staging Preview, with Forgejo Actions providing exact-commit Verification.

[Independent Release publication](0023-independent-project-releases.md) is a separate explicit
action after Delivery. It does not extend Promotion into production or require a release per Ticket.
