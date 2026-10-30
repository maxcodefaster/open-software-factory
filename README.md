# Open Software Factory

Factory turns approved product intent into reviewed source changes. A Project brings together a
source repository, Tickets, revisioned Knowledge, shared development and a promoted Preview.
People approve the requirements and the exact verified commit. A Project monitoring delegation can
commission eligible application-code fixes and Delivery under those same independent gates.
Factory records the delegation rather than pretending a human reviewed generated results.

The application uses TanStack Start with Solid 2, Bun and PostgreSQL. Zero supplies planning mutations and cached read
projections. Mastra handles Project research and Requirements Interviews; OpenCode 2 implements
approved Changes. Forgejo owns Git and Verification runs. Every new execution Sandbox uses an
admitted Factorybox worker, pinned Sysbox and CRIU, a private Docker daemon, the Dev Containers CLI
and the Factory Runtime Connector.

Non-development App startup publishes authenticated process state before HTTP readiness.
A required App process that has exited fails with its exit code and a bounded, redacted cause
instead of waiting for the health timeout. HTTP readiness failures retain the last response
status and the App's sanitized startup cause, not the response body or credential-bearing URL.
Startup output never establishes readiness.

The runtime host builds Docker Compose from the verified upstream source archive pinned in
`upstream.json`. It includes the configured-input grants needed for Dev Containers' temporary
Dockerfiles while keeping Bake's filesystem checks enabled. This is an upstream development
commit, not an upstream stable release tag; the exact runtime image still needs its native gates.

Shared updates are change-driven. Zero synchronizes permission-scoped read versions for the
existing authenticated lifecycle, conversation, Review and Inbox reads rather than polling
unchanged state. Board History and Trash load in explicit batches; Ticket quick-find searches
retained work independently of those batches. Wiki navigation syncs metadata without every page
body. Sync failures and expired sessions keep cached work and drafts visible with explicit recovery.

Projects, Tickets, Wiki pages, Settings and Inbox have shareable URLs. Copy link in a document
window copies its resource URL. Opening a link still requires sign-in and current access; it does
not share a draft, start an Agent or grant runtime access. Back and Forward select resources
without discarding the other open tabs and local drafts.

## Install into existing Kubernetes

Select `registryCASecret` before admitting the installation's first Factorybox worker and keep
that CA bundle unchanged for the retained worker. This configures its private Sandbox registry
trust; it does not configure Kubernetes node image pulls. Node image-pull trust is an operator
prerequisite. Publishing new digest-pinned runtime tools does not itself require changing this
setting, and Factory refuses to overwrite a retained worker's shared trust declaration.

The development Helm chart lives in [deploy/helm/factory](deploy/helm/factory/README.md).
Install it directly from this repository; a public chart repository and release publication are
not required during development. Kubernetes is provided by the operator. Factory does not
install a VM or cluster, require OrbStack, or manage the node's Docker daemon.
Local tools and the Factory image pin `kubectl` 1.35.6. Use a Kubernetes API server
within one minor version, 1.34 through 1.36, as required by the upstream version-skew policy.
Use the repository-pinned Helm 4.2.2 for installation and upgrades. Helm 4.2.0 and 4.2.1
can wait indefinitely for deletion of a missing pre-upgrade hook, including Factory's
maintenance Job. The [upstream fix](https://github.com/helm/helm/issues/32231) is included in
4.2.2; skipping hooks would bypass Factory's work-settlement guard rather than fix the wait.

The chart and owned Forgejo fixtures pin 17.0.0 by image digest. Its native job/step/log API
supplies Verification diagnostics. Upgrading an existing Forgejo is an explicit operator action:
back up its database, repositories, configuration and secrets, review the upstream 16/17 breaking
changes, and verify the upgrade before normal work resumes. Changing the repository pin or running
an owned proof never upgrades a retained installation.

The chart runs Factory, PostgreSQL, Forgejo, Zero, encrypted OpenBao and one private Garage
object store in Kubernetes. It creates the file bucket, credentials and persistent volume
automatically; no separate S3 provisioning is required. Internal
callbacks use Services and the application uses its ServiceAccount, without a personal kubeconfig
or a mounted host Docker socket. Factorybox execution requires an admitted Linux node/kernel
profile, permission for privileged outer Pods and usable persistent storage. Supply the exact
private worker image and executable hash in the chart's `factorybox` values.

Fresh workers reserve 100 millicores for scheduling and share spare CPU up to their qualified
three-core limit. `factorybox.cpuRequestMilli` selects the reserve before first admission;
the 3 GiB memory ceiling remains unchanged. Existing workers retain their admitted profile,
including an older full CPU reservation. Changing defaults never resizes or replaces them.
Operator values can independently size `postgres.resources`, `forgejo.resources`,
`openbao.resources`, `zero.resources` and `objectStorage.resources`; their defaults are unchanged.
CPU requests are reservations, not instantaneous usage. Keep scheduling headroom for startup,
storage checks and runtime helpers without bypassing admission or lowering required memory.

There is one active worker admission per Factory. A fresh commissioned Start can recover a failed
initial setup only after the exact original terminal Pod is observed, no native worker identity
was recorded and all previous execution is settled. The new admission has its own Pod and private
store; canonical Source, old Pods, stores and Runtime Attempts retain their original identities.
Opening a Project or reconnecting does not replace a worker. Recovery of an already admitted
worker remains an operator decision. See [bootstrap admission recovery](docs/adr/0029-worker-bootstrap-admission-recovery.md).
Fresh admissions check actual backing-filesystem availability before native allocation. The chart
defaults to an 8 GiB minimum, 32 GiB maximum and 64 GiB claim. The pinned worker selects a fixed
size in that range on the actual volume while preserving its native host floor and operating
write reserve. Factory records the
selected size in its immutable native identity. The worker must support `bounded-min-bytes` and pass
its native qualification. Insufficient space fails explicitly rather than waiting indefinitely.
This does not resize a retained worker or reclaim unrelated node data.

Before dispatching a fresh Sandbox Start or Fork, Factory observes the original worker's native
write-admission decision. A known disk refusal leaves the mutation unattempted, so Stop can release
its prepared inputs without inventing a native Delete receipt. The native runtime still checks
again at dispatch; an uncertain result after dispatch remains retained and is never replayed.

Choose an available development application image containing the exact runtime artifact bundle,
then supply the browser-facing Factory and Forgejo origins. See the chart's
[installation and maintenance instructions](deploy/helm/factory/README.md) for local access,
Ingress, credentials and retained data. Development images may be built locally; the installed
application does not build its own tools or require a source checkout on the operator's machine.

The image workflow publishes only when a GitHub release is published, never on branch pushes or
pull requests. A release tag such as `v0.1.0` must point to a commit contained in `main`.
The shared verification workflow runs the standard checks, PostgreSQL/controller tests and
owned UI journeys natively on AMD64 and ARM64 for `main` and its pull requests. Release publication
must pass those same checks on its exact tagged source before any image build or push.
These non-live checks do not qualify a Factorybox worker or replace paid and native acceptance.
Native AMD64 and ARM64 jobs build the runtime roles and Factory, then publish their combined
manifests. Existing versioned architecture images are not overwritten. Publishing Factory does
not admit a Factorybox worker or activate an installation.
Before pushing each native runtime-host image, an offline Compose proof builds a configured
Dockerfile outside its context and checks that raw Bake still refuses the same ungranted file.
It uses no Project source, credentials or host Docker socket and does not qualify Factorybox.

For local browser access, install with `deploy/helm/factory/values.local.yaml` and your
cluster-reachable application image. Then run:

```sh
mise exec -- bun run factory:connect
```

This one foreground command reads the installed addresses and manages all three native Kubernetes
connections. It reconnects after a forwarding process exits, including Pod replacement, without
restarting Factory or replaying work. Use `--namespace`, `--release` and `--context` for a different
installation. Ctrl+C closes only its own local connections. No hosts-file edits, external wildcard
DNS or browser resolver flags are needed in Chromium-based browsers for the isolated
`*.runtime.localhost` IDE and App addresses. This is local development access, not a public Ingress
or an installer for Kubernetes.

## Conversations and shared editing

The Assistant's conversation selector retains personal Project and shared Ticket conversations.
New conversation keeps previous history and drafts. In Coding, starting fresh requires finished
work or confirmed Stop and uses the same Ticket Workspace. Ask about this Project opens
checkout-free research alongside implementation. Coding can also search and read authorized
Project sources itself, without switching agents. History selection never changes the shared
active Coding context.

Personal Project Chat uses Factory MCP for Project search, source reads and explicit Ticket
creation. Ask it to create a Ticket in Requirements or capture an Idea. The action saves a chat
receipt linked to the Ticket; creating it starts no Interview, implementation or runtime.
The existing permission and approval boundaries remain. See
[Factory MCP](docs/adr/0020-factory-actions-through-mcp.md).

Typing `/` opens eligible Skill suggestions. Selecting one inserts it into the draft without
sending a message or enabling guidance. Human and Assistant messages have Copy actions.
Tool activity groups consecutive calls, keeps active work and failures visible, and labels
shortened previews. File and recorded-diff actions open the IDE only when selected.

Editing status names the human writer or the Agent's commissioner. Another developer can request
editing; the holder can release it or approve a transfer. After five minutes without observed
edits, deliberate human takeover becomes available. Inactivity never releases authority by itself
or expires Agent work. Handoff stops previous commands and fences old source and branch writes.
Save before releasing: unsaved buffers remain with their developer and are not transferred.
See [the collaboration decision](docs/adr/0019-conversation-contexts-and-shared-editing.md).

## Personal Inbox and Ticket responsibility

Inbox collects your attention across authorized Projects. Needs you contains open Agent questions,
Requirements proposals, blocked work, review rechecks, editing requests and ready Delivery decisions.
Activity groups human discussions, mentions and responsibility notifications. The dock badge counts
open requests plus unread activity. Reading an open request does not complete it; its source
decision resolves it for everyone. Activity can be marked read, unread or archived. A new reply
reactivates its discussion. Project filtering does not change the global badge.
Terminal Project Input problems notify Project managers as activity; the Inbox does not invent
a per-event retry or approval that the Input workflow does not provide.

Tickets can name one optional human Responsible for coordinating their outcome. This is separate
from the Agent or human currently performing the work. Responsibility grants no permissions and
does not start, stop or transfer execution. Eligible responsible people receive their Ticket's
requests; otherwise the required role receives them. Personally addressed requests stay with their
addressee. Select an Inbox item to open its Ticket, question or review discussion before acting.

Creating a Ticket, contributing or commissioning work establishes following. The Responsible
person also follows automatically. Follow/Following lets each person override their own discussion
subscription. Type `@` in shared Ticket chat or feedback to select an active Project member.
Mentions reach that member even when they do not follow, but grant neither access nor approval.
See [human responsibility and the Inbox](docs/adr/0025-human-ticket-responsibility-and-inbox.md).

## Parallel Tickets and Delivery

Implement can commission a Ticket while its prerequisites are still being delivered. The saved
order shows what it is waiting for and can be cancelled. It starts automatically once prerequisites
are delivered, after checking the same approved scope and current authority again. Epics group
Tickets; explicit dependencies determine ordering, including across Epics. Factory does not
automatically choose more Backlog work.

Independent Tickets implement in their own existing Workspaces. Delivery integrates one candidate
at a time against the current default branch. A clean merge needs no inference; a conflict returns
to the existing implementer. Every new candidate receives fresh Verification and independent review.
Work awaiting a human lets independent Tickets proceed. An unconfirmed merge or failed Staging
Promotion pauses later Deliveries while the last healthy Preview stays available.

Project Settings → Inputs → Automatic Ticket Delivery lets a manager with development authority
explicitly delegate eligible application changes and tests, including features. Operational,
migration, dependency and access-policy changes still require human Delivery. The delegation is
revocable and never replaces an exact passing review or an open human Thread. See
[the integration and authority decision](docs/adr/0026-parallel-tickets-and-serialized-delivery.md).

## Work review and monitoring

Settings → Monitoring shows 28-day UTC trends for settled model operations, sampled review
outcomes, avoidable rework, known model costs and operation elapsed time. Completed operations
are not a quality score. Review charts show their denominator and unknown evidence; elapsed time
includes queueing and is not active model time. Existing monthly usage, compute, prices and limits
remain below the overview.

Retrospective learning is on by default. It reviews eligible failed work and a stable one-in-five
sample of completed work in batches after six selected cases or 24 hours. Build work with missing
or incomplete Verification evidence, non-successful Verification, skipped/retried checks or test/CI
changes is selected regardless of sampling. Selection is a review reason, not a defect verdict.
Successful Verification retains bounded native workflow jobs, steps and attempts for the exact
commit, plus test/CI change flags against its integration basis, in its existing compact observation.
These are not testcase counts or proof of coverage. Missing source observations stay unknown;
full logs remain in the forge. Browser suites use the diagnostic fixture, enforced by lint, so
structural Solid diagnostics cannot hide behind passing assertions.
The configured Planning model first checks fixed healthy, defect, false-alarm, missing-evidence,
false-green, scope-mismatch and lost/preserved-coverage cases. Calibration is bound to those exact
cases as well as the model and instructions. It reads bounded
retained evidence, never wakes a Sandbox for logs, and never runs because Settings opened.
Unknown or expired calls are retained without an automatic paid retry. Learning calls are separately
attributed in the usage journal. Project managers can pause shared learning; personal learning
cannot override a Project pause.

Private conversations and personal Skill content stay in their owner's learning context.
Developer-only evidence retains development access requirements. A proposal records source cases,
exact evidence references, its expected effect and a validation plan. Shared proposals can prepare
an unapproved improvement Ticket, including tests, CI scripts or repository instructions. The owner
must explicitly release the displayed proposal to create a shared Ticket from private work.
No source packet is shared with it. Preparing a Ticket grants no implementation or Delivery approval
and does not change the protected Factory Verification workflow.

When retained evidence identifies an editable exact revision, the reviewer can propose one
before/after text edit to Skill instructions/descriptions, a Wiki passage or an Input task.
Review exact edit shows the target scope and version. Apply requires current authority at the
owning scope and confirmation of that exact edit. Inherited Factory guidance is not copied into
Project defaults. Skills adopt the new version only for matching owning-scope choices; admitted
work and other explicit choices stay pinned. Wiki edits preserve writing outside the exact passage.
Input edits wait for admitted events and preserve sources, credentials, delegation and enabled state.
Private edits need explicit release before changing shared guidance or entering a shared request
Ticket. The private case packet is never included.

Applied changes retains the accepted edit and resulting revision. Undo creates another revision
only while the applied resource and affected choices are still exact; it never overwrites a newer
human edit. A reverted edit cannot be applied again through learning without reassessing the cause.
Check Knowledge against current sources rather than restoring a disproven fact. These are deliberate
human settings decisions, not automatic adoption or a benchmark result. Comparison-based automatic
application is separate from this explicit acceptance path.

Automatic Skill updates are off until an owner or Project manager saves scoped permission in
Monitoring. Permission covers future small instruction edits to enabled, plain Planning Skills
owned by that scope. Factory guidance, required Skills, packages, Build, Wiki, Inputs and repository
changes remain outside it. Private cases cannot publish shared guidance. Analysis stays default-on
without this write permission.

A candidate needs two observed method failures with complete retained tasks and source artifacts.
A healthy control must come from a later review, unseen when the edit was proposed. Factory runs
two isolated tool-free text replays under one frozen Planning model, then blinds their order for the
calibrated judge. Both failures must reproduce in the baseline and disappear in the candidate;
the healthy control must remain supported. An inconclusive, failed or uncertain comparison cannot
authorize adoption or an automatic paid retry. Each exact candidate gets one comparison.

Compared changes retains the exact tested instructions, tasks, actual responses, verdicts, model
and fixed rubric. Applied changes separately counts subsequent sampled uses of the exact adopted
revision and exposes the latest three cases with their evidence and verdicts. Those counts are
not causal proof. Repeated method failures on that revision can trigger one reverse comparison
against its predecessor. Only a demonstrated reverse win may create a protected rollback revision;
changed human writing or activation choices block it. Pause, permission changes and lost authority
fence new inference and publication. No comparison wakes a Sandbox or replays an external action.

Selected completed research retains at most three bounded excerpts of sources actually read,
within its existing private/development visibility. It does not retain a tool transcript or copy
external MCP responses into analytics. Truncation remains explicit and cannot prove an absence.

## Repository mirrors

Factory administrators configure native Forgejo push mirrors under Settings → Factory
administration → Repository mirrors. Select a Project, supply an existing private HTTPS Git
repository and its Git username/token, and explicitly confirm that the target may be overwritten.
Use a target-scoped write token and disable target CI/deployment automation. GitHub, GitLab.com
and Codeberg are allowed by default. `gitAllowedOrigins` adds exact public HTTPS hosts in Helm
for both Project imports and mirrors; local-network access stays disabled.

Forgejo owns credentials, mirror configuration, sync-on-push and the hourly fallback schedule.
Factory adds no sync daemon. Refresh status observes native state; Sync now synchronizes all
push mirrors of the selected Project. Configuration alone is not a successful transfer.
The displayed time is the last native attempt, accompanied by its success or failure, not a
claimed last-success time after a failed attempt. Removal stops future mirroring without
deleting the external repository. Add, remove and manual sync require recent administrator
authentication. Unconfirmed commands are observed rather than automatically repeated; after
checking Forgejo an administrator can explicitly keep the observed state and acknowledge uncertainty.
Factory retains command identity and outcomes, never the target credential in PostgreSQL or Zero.
In pinned Forgejo 17, HTTPS mirror credentials remain readable in the repository's Git
configuration on Forgejo's volume. They are not encrypted by Forgejo or held in OpenBao.
Keep that volume and its backups private; encryption at rest must come from the underlying
storage and backup configuration. A password field and redacted status do not provide that encryption.

Mirrors copy central Git branches, tags and their reachable history, including pushed unmerged
Changes. They do not capture unpushed Workspace work, Factory accounts, Tickets, approvals,
Project secrets or uploaded files. Force-pushes and ref deletion also propagate: this is an
external code copy, not an immutable versioned backup or a full Factory restore.
Recover the external repository using normal Git, then import it as a new Project in a normally
installed Factory and reconfigure access and environment. No old Factory database is required.
If the target server did not select a default branch automatically, select an existing mirrored
branch there before importing. Git mirroring does not copy repository settings.

`mise exec -- bun run test:native repository-mirrors.native` owns separate pinned Forgejo
instances. It proves native sync-on-push, an unmerged Change branch, tags, mirror removal
without deleting the target, and standalone clone/integrity checks after removing the source.
It does not provision or write a customer's GitHub/GitLab repository.

## Human attachments

Wiki and Ticket editors open file selection through `/image` and `/file`, without a separate
Add file button. They also accept pasted images/files and file drops.
Chats and review comments, Threads and replies have Add file and support paste/drop.
PNG, JPEG, WebP, PDF, DOCX, UTF-8 TXT and Markdown are supported. Pending uploads stay private.
Saving a Wiki/Ticket document or sending a shared Ticket message or feedback publishes its exact
file references. Personal Project chat and uncreated Ticket drafts remain private.
Upload and document saves do not start agent work. Sending an ordinary chat still commissions its
normal Agent Turn; saving feedback does not.

The Helm chart supplies one private Garage object store for original attachments, derived images,
QA recordings and annotation stills. Bucket creation and retained credentials are automatic.
The service is internal only; browsers and agents read files through authenticated Factory
routes, never public bucket URLs. `objectStorage.size` sets the persistent claim size, initially
16 GiB. Normal Kubernetes storage provisioning is the only storage prerequisite.
Extracted attachment text remains in PostgreSQL; it is not a second file store.

The defaults are 10 MiB per file and 20 MiB per message, configurable in environment bytes or
Helm values. Factory imposes no cumulative storage limit per Project or installation.
Original files, generated page images and extracted text remain accounted for. Actual capacity
belong to the installation's persistent storage; storage failures retain history and permit explicit retry.
Unassigned uploads expire after one
day. Private drafts retain their current file references; removal or Ticket publication releases
obsolete draft associations. Backups are outside this accounting.
Back up the object-store claim and Secret together with PostgreSQL and the other retained
installation data. This single-node deployment does not claim high availability or automatic backups.

Agents read actual images and rendered PDF pages through authenticated, task-bound tools.
Text is paged rather than silently cut off. PDF processing is limited to 200 pages, extracted text
to 1 MiB and derived image content to 100 MiB per file. Unsupported DOCX drawings or embedded
objects require an explicit PDF export instead of silently dropping content. Image processing
accepts up to 40 megapixels and provides a bounded visual copy while retaining the original.
Busy or unconfirmed uploads offer an explicit Retry file upload action, which reconciles the same
upload identity. File processing uses at most two conversion workers per Factory process.

Focused proofs use separate databases and object-store resources:

```sh
mise exec -- bun run test:controllers /attachments.test.ts /object-storage.test.ts
mise exec -- bun run test:native object-storage.native attachment-s3 attachment-browser attachment-factory-browser opencode-attachments
FACTORY_ATTACHMENT_MODEL_LIVE=1 mise exec -- bun run test:live attachment-model.live
```

The last command uses the configured Planning connection and incurs model usage. The native
storage proofs use digest-pinned Garage 2.3.0; they do not access or reset a retained installation.
The object-storage proof applies the actual chart-owned storage resources in a separately owned
Kubernetes Namespace. It checks bucket provisioning, private attachment and video reads, byte
ranges, Pod replacement, retained credentials and refusal to replace missing credentials.
The full-Factory browser proof captures desktop and phone layouts, long file names, saved feedback
and an oversized-file error against its own authenticated installation and private bucket.
Admission freezes file identities, hashes and human context; replacing a reference never
reconfigures already admitted work. Independent review retains the implementation's references.

## Project Releases

Project Settings → Releases publishes a deliberately named version of the current delivered,
healthy Staging commit. The last published version and Patch/Minor/Major suggestions help choose
the next version; a human confirms the exact version and commit. Source-only Projects need no
image or workflow. For image-and-chart publication, adopt the Project-owned
[release recipe](templates/release/README.md) through normal review and Delivery.

Factory runs one isolated native Forgejo publication job, confirms its results and retains
versioned source and artifact identities. An unconfirmed result is reconciled without blindly
starting another run. External access issues project-bound read credentials with explicit
rotation and revocation. It does not register consumers, store their production credentials
or test their availability. Production deployment and operation stay outside Factory.
See [the Release boundary](docs/adr/0023-independent-project-releases.md).

## Source development

The Greenfield database starts from one [complete baseline](packages/db/migrations/0001_baseline.sql).
It contains the current schema, constraints, Zero publication and installation singleton rows.
Repeated initialization leaves that baseline unchanged. Historical migration journals and partial
schemas are refused without modifying their data; this development baseline requires a fresh database.

The source-development environment uses macOS with OrbStack's Linux Docker daemon and Kubernetes
context `orbstack`. Install [mise](https://mise.jdx.dev/), enable that environment, then run:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run factory:up
```

Open [Factory](http://127.0.0.1:3000). The initial local administrator is `admin@factory.local` with
password `factory-local-password`; these are development defaults. Configure provider connections
in Settings. Optional environment bootstrap is described in [.env.example](.env.example); put real
credentials in the ignored `.env` file.

If a repository-creation response is lost, Factory observes that same setup automatically and
updates the open setup panel. Status recovery never repeats repository creation or import.
Known setup failures still require an explicit retry.

Registering an existing local Forgejo repository follows the same configuration inspection
and readiness flow as an import. Registration retains pending configuration before background
work starts; it does not start Project code or prepare images before confirmation.

Requirements can be written directly. New Ticket → Write requirements creates shared, editable
intent without calling a model or opening an Interview. Enter the specification and acceptance
criteria; Implement approves that exact saved revision and commissions Coding in one action.
An existing Idea has the same Write requirements action without starting AI.
Ask AI to clarify starts an optional Interview explicitly. Creating or moving Tickets, opening
their documents and reconnecting do not start clarification. An Interview proposal still needs
human confirmation, and neither path bypasses independent checks, review or Delivery approval.

Developers can choose **Plan product & tech** to clarify product behavior and then research a
technical design. **Confirm product spec** saves the Product Requirements and durably commissions
the technical continuation. **Plan technical design** works from complete saved requirements
without repeating the Product Interview. These are explicit model actions; reading and ordinary
saving remain model-free. A continuous Ticket document provides Product, Technical design,
optional Architecture and Validation chapters. Technical Designs and PlantUML diagrams retain
development-only access. Implement approves both exact revisions and rejects a changed source
commit. See [Ticket technical planning](docs/adr/0024-ticket-technical-planning.md).

Factory's Models settings show separate Planning & knowledge and Coding choices. Each has a
connection and model selector; OpenAI Coding has reasoning beside its model, with medium as the
minimum. Save & check adopts the Coding model and reasoning together only after a successful
access check. API keys are managed separately and encrypted in OpenBao. Before the first Build,
developers can open Ticket actions → Coding options to choose reasoning in the Coding chat before
commissioning the first Build. Opening or leaving those options starts no model work. The normal
Implement action still commissions work in one click with the configured defaults. Planning and
research chats, and contributor correction chats, have no model switcher. Existing Changes show developers their
fixed admitted value; changing defaults never reconfigures them. OpenAI Coding uses the native
Responses adapter.

Settings → Libraries → MCP connections manages remote read-only sources with illustrated landscape connection
cards and the same ownership and work-type choices as Skills. Start from a Sentry or Datadog suggestion, or add a public HTTPS
endpoint. Saving does not connect or enable it. Connect, review the exact read-only tools using
a suitably restricted provider account, then choose where to enable the connection. Factory-owned
connections also need an explicit Project grant. Sharing a personal definition proposes only
that version for manager review, never its credentials. OAuth material and bearer tokens stay in
OpenBao; Coding receives a turn-bound Factory facade. Reconnect creates a new authorization epoch,
and Disconnect blocks further lookups. Renew Project grants after reconnecting a Factory-owned
account. Provider-side token revocation or rotation remains separate.
Local MCP commands, stdio processes and external write tools are not supported.

Skills and MCP connections share thirty bundled cover illustrations, with portrait and landscape
crops. New custom entries receive a saved cover automatically. Open an entry and choose Change
cover to select another illustration, then Save cover. The entry's owner or an authorized manager
can change it. Cover changes do not publish Skill instructions, enable work or reconnect MCP.
Starter Skills retain their existing covers until deliberately changed. Provider suggestions keep
their provider artwork.
No image-model connection or image upload is required.

Project Settings → Inputs accepts feedback, monitoring alerts and other JSON requests through a
named private webhook. Save its task and select Connected sources from reviewed shared MCP
connections, or inherit shared Project defaults. Connect a service opens the independent MCP setup
and returns to the same draft. Creating an Input does not call a model; receiving a request does.
The Project Agent automatically clarifies it and prepares requirements. Explicitly selected sources
must be consulted. Missing context produces no Ticket and repeated deliveries coalesce.
Prepared Tickets still need human implementation approval. Their sources remain available in
authorized Build, but never independent review.

Automatic implementation is a separate advanced delegation, requiring Project management and
Developer access. Eligible application fixes use the existing Build, fresh Verification,
independent review and exact-commit Delivery path. Operational, configuration and dependency changes
require a human decision. Disable or key rotation fences pending automatic work; accepted merges
still finish recorded promotion and cleanup. Previously issued monitoring URLs remain valid.
See [Project Inputs](docs/adr/0018-project-inputs.md) and
[bounded Autofix](docs/adr/0016-delegated-monitoring-autofix.md).

Factory supplies OpenCode's configuration through its packaged read-only configuration directory
and admitted model settings. Home-directory and Project OpenCode configuration and compatibility
skills do not override that setup. Do not maintain a second `opencode.json` for Factory.
Coding uses native HTTP transport and automatic summary compaction with the selected model;
provider-native compaction is not enabled through the relay.
The packaged runtime policy augments OpenCode's native instructions rather than replacing its
tool guidance. Build reads the checkout's applicable `AGENTS.md` files explicitly. Required
non-manual Build Skills and human-invoked Skills load before inference; optional Skills remain
available on demand. Each Change retains its original eligible and required revisions through
corrections, even if defaults change later. Selected guidance also uses OpenCode's durable
instruction entries so context compaction cannot silently discard it. Each new turn replaces only
Factory's own instruction entries with its exact selection.
Build includes only matching, bounded Project Knowledge excerpts. Other pages remain available
through the existing Project search/read tools; an empty match does not mean the Project has no
Knowledge. Approved requirements, required guidance and admitted input remain intact.
An intended Session ID is not a resumable Coding session until OpenCode confirms its creation.
Failed first preparation retains source and offers an explicit Retry.
Build works toward the approved requirements and ends with an ordinary summary, without a required
JSON checklist. A normal native finish submits changed source for independent Verification,
not as proof of completion. Exact-commit checks and human Delivery approval remain separate.
Failed Verification supplies the retained implementer with exact job/attempt/step identities and
short sanitized output excerpts. The correction can read additional bounded pages through the
same scoped Factory tool facade, without forge credentials or arbitrary URLs. Cancelled, skipped,
setup-failed and undiagnosed runs do not commission code correction. Full logs stay in Forgejo;
the compact diagnosis is saved so recovery cannot silently change a correction request.
After successful checks, a fresh independent OpenCode Session reviews that exact candidate.
It keeps the Change's Coding model and reasoning, with no additional model selector. The reviewer
has only immutable Git reads, the existing restricted App browser and a bounded review-report tool.
Its frozen instructions identify the successful exact-commit Verification as Factory-observed CI
evidence. The reviewer still checks source, test relevance and actual App behavior independently.
It cannot edit, run shell commands or delegate to a writing agent. A native finish without an
accepted report remains incomplete. Passing checks alone no longer enables Delivery.
The normal path uses one reviewer. Only proposed blockers commission one fresh, focused
counter-investigation of the complete finding batch, using the same admitted model and permissions.
That checker confirms concrete defects, dismisses false alarms or leaves material uncertainty
incomplete. Decisions cite its own immutable source or App observations; a source-level proof can
suffice. Only confirmed blockers return to the retained implementation Session for targeted
correction. Neither reviewer can repair code. Cosmetic suggestions and unrelated old problems do
not expand scope.
The focused check preserves the original QA recording and chapters rather than replacing them.
Each changed commit needs new checks and a fresh review. After a correction, that review starts
with the earlier findings and the correction diff, follows affected callers and repeats affected
App cases instead of every old interaction. Every criterion still needs current-candidate evidence.
Immutable source search and revision-scoped read caching avoid repeatedly loading the repository.
An incomplete or failed review has an explicit Retry review action after active work
and Stop have settled. That creates a fresh attempt, never replays the old inference. A successful
review still requires deliberate human approval of the exact commit before Staging promotion,
unless an eligible monitoring fix has an active explicit Delivery delegation.
New independent reviews name concrete normal and relevant adverse cases before observing them.
Each case fixes whether it checks the App or immutable source. App cases require their own actual
App observation before they can finish as passed or failed. Source checks use their own candidate
read or diff and may cite Factory-confirmed exact-commit CI for executable checks. They cannot
replace normal and adverse App coverage for user-facing changes, and are labelled Source check
without an invented video position.
The QA & review panel shows expected versus observed scenario outcomes even without a recording.
When available, selectable chapters navigate each case in one real browser QA video, not duplicate
clips. Recording failure does not turn a successful App observation into a QA failure or replay
any action.

Human feedback can be an ordinary comment or a resolvable Thread. Open Threads block Delivery,
including Threads marked "Implemented, please recheck" by the agent. The author or an existing
authorized developer resolves them. Saving, replying and resolving start no inference.
Request revision commissions all open Threads that still need work in the retained coding
conversation. There are no per-comment checkboxes or separate Ticket correction composer.
Ordinary comments stay in the discussion. Already dispatched Threads are not silently sent again;
implemented Threads await human rechecking. Needs changes explicitly returns a reviewed Thread
to the next revision batch. Failed or stopped revision work can be explicitly requested again.
The Ticket leads with its QA video and scenario chapters, followed by shared feedback. Open Threads
come first, including agent-implemented Threads awaiting human recheck; resolved Threads are folded.
Add feedback also accepts a general comment without an image anchor.
The custom QA player has continuous playback, a seek bar, scenario boundaries, feedback markers,
chapter navigation and fullscreen. Seeking preserves play/pause, and the active chapter follows
the playhead. Comment pauses the video so a point can be selected; saved frames retain their
original timestamp. Discussions have one reply level; source details and resolved Threads fold.
Open Live Preview reuses the matching Factory workspace tab. Only ticket-bound Previews offer a
comment button. Hover or Tab selects an element, Enter confirms and Escape exits selection.
There is no screen-sharing prompt, extension or coordinate editor. A restricted App-side bridge
supplies the element anchor and an optional DOM-reconstructed context image from that human session.
The image may differ from browser pixels; rendering or image-storage failure does not block feedback.
The App keeps its script policy; when that blocks selection, general feedback remains available.
Preview anchors retain their Runtime Attempt basis and view identity and are not blindly projected
onto another page or edited state. Only the independent QA recording claims an exact clean candidate.

Independent QA browser runs always record automatically, without a Project-level switch. Media
uses the same private object store as attachments, with authenticated, non-cached reads. A newer complete recording removes the
previous video even when it has comments. Comments and their saved frames remain. The final video
expires thirty days after the Change is delivered or cancelled. Unattached frame uploads are
removed after one day.
After a confirmed Stop of an already submitted implementation, Resume checks continues its
Verification and independent review without calling the implementer again. It applies only to the
current submitted version and that exact Stop; unfinished source and editing takeover remain fenced.
Coding activity streams through authenticated Factory access, with history reconciliation after
reconnect and no repeated model request. New Build turns use native OpenCode MCP tools for the
restricted development browser, including inline screenshots. Already admitted CLI instructions
remain executable without rewriting their frozen input. Neither transport grants arbitrary MCP
registration, URLs, scripts or access to human browser sessions.
An unavailable runtime-status write does not terminate Factory or disconnect healthy compute.
Only the current authorized observation retries; newer observations supersede it, and revocation
cancels it. A terminating producer's final outcome remains observable after its connection closes.
These retries never create another Sandbox or resend an inference.
If the Connector confirms browser expiry or Factory confirms control-connection loss, the same active
Build can explicitly open a fresh browser after exact cleanup is confirmed. It cannot restore or reuse the old browser,
replay a UI action, bypass Stop, or reset the turn's browser-call limit. A fresh snapshot is required
before further actions.
Admitted corrections remain in the conversation even if source preparation fails before OpenCode
receives them. Retrying work requires a new explicit request; reconnecting never resends it.
Failed file access and editor services have separate Restart actions. Each confirms Stop before
starting another access epoch, without restarting Apps or Builds. Restarting the editor can lose
unsaved editor changes; restarting file access retains editor buffers.
Missing confirmed source resources are never recreated under their old access epoch. Explicit file
access Stop can retire a replaced Pod only after validating its full assignment and manifest against
the same recorded Namespace and volume. It never adopts that Pod's identity or removes source storage.
Temporary editor observation or connection loss rechecks the same recorded service automatically.
Interrupted source and editor observation workers also retry the same retained intent within
their existing unavailable-observation bounds, without a human wakeup or another access epoch.
An initial unavailable editor document reconnects without a manual reload. An already open editor
is never reloaded by that recovery, so its dirty buffers stay in place. Readiness changes do not
revoke its grant; Stop, failed resources, changed identity and lost authority still do.
Editor resources use a persisted random identity, separate from the account ID, so installations
sharing the emergency administrator ID cannot adopt each other's editor. Existing editor identities
remain unchanged until explicit Stop and restart.
Editor hostnames also include the local HTTP/HTTPS listener so browser cookies stay separate across
installations on different ports, even when the account and editor epoch match.

The local listener defaults to `0.0.0.0` so OrbStack-hosted runtimes can call Factory.
Set `FACTORY_HOST` explicitly to narrow that listener, noting that loopback-only access may prevent
runtime callbacks. `FACTORY_ADMIN_EMAIL` and `FACTORY_ADMIN_PASSWORD` are honored for bootstrap and
Forge setup. Set a private password before first startup if the listener is reachable by others.
Bootstrap never resets an existing account's password; later starts must use that account's
current credentials for Forge setup.
Disposable installations keep their own generated administrator identity and private password
instead of inheriting the normal installation's administrator overrides.

Startup provisions the local database, Forgejo, planning cache and encrypted OpenBao, reuses a
complete set of pinned runtime artifacts after checking their remote manifests or publishes them
once, applies migrations and builds Factory. Missing artifacts fail before replacing a running
Factory server; a valid digest file alone is not readiness. Cold artifact builds
and Sandbox preparation can take several minutes. Installation data and exact artifact references
live under the ignored `.factory/` directory.

Before replacing the running server or announcing readiness, startup checks the default Kubernetes
storage class with a fresh 8 GiB RWO claim. The pinned source image must write and read a marker as
the source-service UID, then its Pod, claim, backing volume and Namespace must be removed.
This checks usable storage, not just a reachable cluster or an existing volume. A failed check
keeps its own recorded identity for the next startup; it never resets Project storage.
`storage-readiness-diagnostic.json` in the installation state records compact claim, Pod and
provisioning-helper states, including observed exit codes when available. The last failed check
also remains in `storage-readiness-failure.json`, even after a successful retry. Neither file
contains raw logs, environment values or credentials. The explicit native proof is
`FACTORY_RUN_STORAGE_READINESS_PROOF=1 mise exec -- bun run test:live storage-readiness.live`.

```sh
mise exec -- bun run factory:status
mise exec -- bun run factory:restart
```

Restart adopts published pins for new runtime attempts and preserves existing intent and data.
Published defaults also supersede disposable-installation bootstrap pins, never an existing
Runtime Attempt's recorded image.
It starts stopped PostgreSQL and Forgejo services and waits for their health checks before running
migrations or replacing the server. A dependency failure leaves the existing server untouched.
It reuses the existing frontend bundle. After changing UI source, run `factory:up` again to rebuild
that bundle and restart the same installation without resetting its data.
Use [runtime artifact instructions](deploy/runtime-host/README.md) when changing runtime images.

### Run the existing installation's server on Linux

On macOS 27 with OrbStack 2.2.3, long-lived Pod connections through the Mac host alias can lose
responses. Keep Factory's server on the Linux side and use the Linux node's reachable IPv4 address
for runtime callbacks. This changes only the server process, not the installation, database,
Workspace storage, model settings or registered Forge identity.
Source initialization and runtime assignments share the same repository-transport check. Local
HTTP endpoints may use private or loopback IP literals as well as the local host aliases. Public
HTTP endpoints, credentials in URLs and executable clone protocols remain rejected.

After the initial artifact publication, build the application image and inspect the node address:

```sh
FACTORY_IMAGE=open-software-factory:local mise exec -- bun run factory:image
mise exec -- kubectl --context orbstack get node orbstack -o wide
```

Use the actual `INTERNAL-IP` from that output, rather than copying this example address:

```sh
FACTORY_SERVER_IMAGE=open-software-factory:local FACTORY_RUNTIME_HOST=192.168.139.2 mise exec -- bun run factory:restart
```

The native launcher still owns startup and Stop. It records the exact image/container identity
before creation, keeps credentials out of command arguments and reuses the selected image and
runtime host on later restarts. It mounts the configured OpenBao token and CA files read-only,
including a local CA stored outside installation state. Neither a static neighbour entry nor a
network repair loop is needed. For the Linux server, the launcher also binds the existing local
Forgejo port on that exact private node address so Sandbox Git operations can reach it. The
loopback binding and browser-facing Forgejo identity stay unchanged; PostgreSQL and Zero remain
loopback-only. Rebuild the image and explicitly select it to adopt source or UI changes. Setting
`FACTORY_SERVER_IMAGE=native` explicitly returns to a host process.

Compose supplies only the source-development data services. It is not another Factory installation
method. The application image starts the Kubernetes bootstrap and contains neither a Docker CLI
nor a workstation certificate generator. Install that image with the
[repository Helm chart](deploy/helm/factory/README.md).

## Repository layout

```text
apps/factory/               Web interface, HTTP server and Factory controllers
packages/                   Domain rules and concrete integration adapters
services/runtime-connector/ Go connector inside the approved runtime
deploy/                     Upstream compositions, runtime images and local manifests
scripts/                    Local operation, integration and runtime verification tools
templates/starter-app/      Maintained application scaffold for new Projects
test/                       Browser, integration and live proofs with owned fixtures
docs/README.md              Architecture, domain vocabulary and operating limits
docs/adr/                   Lasting architecture decisions
AGENTS.md                   Repository-specific coding-agent instructions
upstream.json               Exact upstream versions, digests and package integrities
mise.toml                   Local tool versions
```

Domain packages named `*-domain` express product rules without framework or vendor types.
Adapters such as `auth`, `forge`, `runtime-kubernetes` and `zero-*` isolate those dependencies.
`apps/factory` composes them. Deployment recipes belong under `deploy`; operational commands belong
under `scripts`. Templates and test fixtures are separate from the Factory application.

Generated logs, screenshots, test output, builds, caches and installation state stay in ignored
directories. New persistent test artifacts go under `.factory/test-results/`.

## Development and checks

Run commands through `mise exec --` to use the pinned tools. Keep dependencies exact and install
from committed lockfiles. `upstream.json` owns the upstream artifact pins; package manifests and
lockfiles own application dependencies.

For everyday work, use `factory:up` to prepare the source-development backend, `factory:dev`
for frontend development and `check` for the standard checks. `factory:connect` is only the
local browser connection to a Helm installation; it is not another server launcher.
It resolves and checks the exact pinned kubectl executable through mise instead of trusting
the inherited PATH. Restart this connection command after updating tool pins. That reconnects
the browser without restarting Factory or repeating model work.
Installed Factory lifecycle stays with Helm, including upgrades. Do not start the server directly
to bypass bootstrap, readiness or owned process cleanup.
The focused commands below remain available for diagnosing one area. Select a particular browser
test by passing its path to the appropriate lane, for example
`bun run test:browser:manual test/browser/runtime-recovery.spec.ts`; no per-file alias is needed.

The test and type-check launchers prepare separately locked test dependencies when the selected checks need
them. Editor adapter tests install the Theia composition without dependency lifecycle scripts and
compile the Factory extension. The scoped Starter authentication proof prepares the template's
locked dependencies. Unchanged inputs reuse the local test cache; focused checks that do not use
these components skip preparation. This first-run setup performs no model inference.
Integration lanes also build the client and Server Function handler before starting owned
Factory processes. Each lane uses its own build directory and removes it during cleanup;
parallel proofs do not replace each other's assets or the source-development `dist`.
Those handlers use the same application services as the installed Bun host.
The browser lanes share one pinned Bun entrypoint so owned suites can load Factory's Bun adapters.
Playwright prepares one separate production build for direct browser runs and removes it
afterward. A browser run nested in an integration proof reuses that proof's immutable build
without rebuilding or deleting it. Isolated component journeys belong to `test:browser`;
the controller lane does not launch duplicate browser-only wrappers.
Direct UI runs also own a temporary Factory, PostgreSQL and Zero cache, including a synthetic
Starter Project. They never adopt the source-development database. An explicit
`FACTORY_BROWSER_BASE_URL` keeps the caller's existing fixture and its supplied database/build;
native, paid and manual lanes retain their explicit installation requirements. Listing tests
starts no services. Cleanup removes only the directly owned resources.
Live UI inspection does not require a browser extension. If a browser update or its automation
connection prevents inspection, use native desktop controls in that same browser. Check the
rendered editor and Apps, not just service readiness. Do not disable browser security or install
another browser to turn an automation failure into a claimed product pass.
If an isolated frame's document remains pending with an automation debugger attached, detach that
debugger and inspect the same navigation natively before restarting Factory, the editor or compute.
Repeat a fresh first-open journey without Retry; a successful manual reload is not a product fix.
The owned desktop browser group shares one immutable build and one empty migrated PostgreSQL
daemon per invocation. Every journey still owns its database, application process and Zero cache.
Playwright's dependent teardown removes only that invocation's resources after the journeys finish.
Browser checks reject structural Solid diagnostics as well as page errors. The controller lane
also checks client-entry budgets, including deferred Settings code.

TypeScript's `noPropertyAccessFromIndexSignature` requires bracket access for index signatures.
The overlapping `useLiteralKeys` style rule is disabled rather than weakening that compiler check.
Production code checks missing values at their owning boundary or keeps a narrowed snapshot.
Tests use checked fixture values rather than unchecked non-null assertions.

Start the backend with `factory:up`, then use `factory:dev` and open the Vite URL it prints.
Development proxies authenticated API and planning-cache traffic to that backend without
allowing foreign browser origins. `FACTORY_DEV_BACKEND_URL` selects a different loopback backend
for an isolated installation. It does not start or reset that installation.
Keep its compiled Start entry available locally at `FACTORY_BUILD_DIRECTORY`, or the default
Factory build directory. The development proxy uses that entry's function identities to forward
Start's development references to the existing backend. It does not instantiate application
services in Vite or implement a second RPC encoder.

| Command | Purpose |
| --- | --- |
| `bun run factory:dev` | Vite frontend development against the local Factory server |
| `bun run factory:build` | Build the Start client, server handler and precompressed public assets |
| `bun run factory:image` | Build the local application image with the currently published runtime pins |
| `bun run factorybox:build REQUEST_JSON` | Build a local ARM64 or AMD64 worker candidate, check its image/executable and retain an unselected Factory profile |
| `bun run factory:connect` | Connect the browser to a local Helm installation and restore interrupted forwards |
| `bun run check:docs` | Validate documentation names, local links and anchors |
| `bun run typecheck` | Check all TypeScript projects and tests |
| `bun run test:unit` | Fast domain, adapter and operation tests, including pure `test/support` tests; no live models |
| `bun run test:controllers` | Owned PostgreSQL/controller checks; separate fixture databases on one migrated test daemon |
| `bun run test:native` | Explicit owned OpenCode, source, Forgejo and OpenBao adapter proofs |
| `bun run test:live` | Opt-in live proofs, still requiring each proof's environment flag |
| `bun run connector:check` | Host and digest-pinned Linux race tests, native privilege checks and vet |
| `bun run test:postgres` | Database integration checks |
| `bun run test:forgejo` | Forgejo integration checks |
| `bun run runtime:conformance` | Actual Factorybox/Kubernetes/Dev Container/Connector conformance |
| `bun run test:browser` | UI journeys; excludes native, paid and retained-installation restart tests |
| `bun run test:browser:native` | Explicit real IDE/Terminal/Preview/Delivery journeys |
| `bun run test:browser:paid` | Explicit real provider journeys; incurs model usage |
| `bun run test:browser:manual` | Retained-installation captures/restarts; run only when no admitted work is active |
| `bun run check` | Documentation, formatting, lint, types, units and Connector checks |
| `bun run check:integration` | Complete check plus PostgreSQL invariants and the owned controller lane |

Live proofs under `test/support` opt in through their documented environment flags. Some use real
model providers and incur usage. Test fixtures own separate databases, Projects and runtime
identities; their cleanup must preserve unrelated work. Run the affected checks for a change rather
than repeating every live journey after a documentation edit.
`test:postgres` always creates and migrates its own empty PostgreSQL daemon, including its probe
users, and removes only that owned daemon/network. It does not use `DATABASE_URL` or a pre-existing
development administrator.

Shared UI controls live in [controls.css](apps/factory/src/ui/controls.css), loaded by the
application stylesheet. The [control fixture](test/fixtures/ui-controls-surface.tsx) covers
native interaction, quiet/primary/destructive actions and field states without mounting
another feature for its styles. Run `mise exec -- bun run test:browser test/browser/ui-controls.spec.ts`
and the affected feature journeys after changing the shared controls. The
[product brief](apps/factory/PRODUCT.md#interface-consistency) records their visual contract.

The independent editor proof builds and uses separate local artifacts. It opens canonical source
without Project compute or model inference, switches retained buffers, verifies original-Workspace
saves and rejects stale saves. Its containers and volumes have exact cleanup ownership.
Pinned TextMate grammars provide syntax highlighting for source and configuration files without
compute. TypeScript/JavaScript and Python have a pinned project-language preset. In the editor
status bar, Start tools explicitly prepares compute if needed, then starts the language servers
in that exact Workspace's Dev Container. They use installed Project TypeScript and the actual
Python environment, including `VIRTUAL_ENV`, `.venv` and repository Pyright configuration.
Opening files never starts these processes. Other languages show Syntax highlighting rather
than claiming language support. The preset supplies completion, semantic diagnostics, hover and
Go to Definition; it does not supply general refactoring, formatting or arbitrary plugins.
Dependency definitions outside canonical source open as read-only documents bound to their
original Runtime Attempt. They are not copied into source or read from the editor host.

```sh
mise exec -- docker buildx build --load --file deploy/workspace-files/Dockerfile --tag factory-source:editor-proof .
mise exec -- docker buildx build --load --file deploy/runtime-host/Dockerfile --target developer-ide --tag factory-editor:editor-proof .
FACTORY_RUN_INDEPENDENT_EDITOR_PROOF=1 FACTORY_SOURCE_PROOF_IMAGE=factory-source:editor-proof FACTORY_EDITOR_PROOF_IMAGE=factory-editor:editor-proof mise exec -- bun --no-env-file test test/support/independent-editor.live.test.ts
```

The same owned editor proof can exercise actual TypeScript dependencies, a Python virtual
environment, semantic diagnostics, completion, dependency navigation and reconnect. Build
`runtime-host` as `factory-runtime:language-proof`, then build
`test/fixtures/language-tools/Dockerfile` as `factory-language-child:proof`, explicitly passing
`--build-arg FACTORY_LANGUAGE_TOOLS_IMAGE=factory-runtime:language-proof`. Add
`FACTORY_LANGUAGE_PROOF_IMAGE=factory-language-child:proof` to the proof command above. This
uses native Connector children and unchanged language servers in isolated containers, not models.
For the complete Factorybox/Dev Container path, set `FACTORY_RUNTIME_LANGUAGE_CONFORMANCE=1`
and an exact `FACTORY_RUNTIME_CONFORMANCE_IMAGE` registry digest when running
`bun run runtime:conformance`. These overrides affect only the owned proof, never retained pins.

The unassisted coding acceptance uses its own disposable installation and real model calls.
It needs the provider bootstrap variables described in `.env.example`. Settings-only connections
from another installation are not copied. Its two independent UI journeys create fresh Starter
Projects, write manual Requirements or explicitly request an AI Interview, and commission Build.

```sh
mise exec -- bun run factory:up --disposable coding-proof-example
FACTORY_CODING_COMPLETION_INSTALLATION=coding-proof-example mise exec -- bun run test:live coding-completion.live
mise exec -- bun run factory:reset --disposable coding-proof-example --confirm coding-proof-example
```

Each journey requires the coding Agent's browser inspection, independent exact-commit review and
passing Verification. It independently checks the real App, clicks Deliver deliberately and checks
the promoted Staging revision. A saved human Wiki note must survive the generated delivery update.
The harness does not edit generated source or repair infrastructure. Set
`FACTORY_CODING_COMPLETION_PATH=manual` or `interview` to run only one path.
Screenshots and results go under `.factory/test-results/coding-completion/`. A passing sample
is evidence for that task, not a guarantee that every model request will finish unaided.
Successful runs remove their owned source storage as well as execution resources. Failed runs
retain source for inspection; the reset guard refuses deletion until that exact retained Workspace
storage is explicitly cleaned up.

Browser image acquisition retries recognized transient Registry failures within the existing
three-minute startup window, before any browser or App action exists. Stop cancels that wait.
Authentication, certificate, digest and unknown failures still fail explicitly. A later authorized
Build or review may prepare the same frozen image again without restarting the Workspace;
neither path repeats inference or an App interaction.
The explicit native recovery proof uses a private TLS Registry and one uniquely labeled image,
fails its first real Docker pull, restores the Registry and confirms the same exact image:

```sh
FACTORY_RUN_BROWSER_IMAGE_RECOVERY_PROOF=1 mise exec -- bun --no-env-file test test/support/browser-image-recovery.live.test.ts
```

The Connector's opt-in `TestBrowserRuntimeManagerLive` checks the actual browser and App proxy
without model calls. Supply exact `FACTORY_BROWSER_PROOF_IMAGE` and
`FACTORY_BROWSER_PROOF_PARENT_IMAGE` references. Its Docker daemon must match the pinned parent;
a different host daemon is not the Factory execution environment.
Inside an admitted Linux parent, `FACTORY_BROWSER_PROOF_NATIVE_SELF=1` reuses the matching
prebuilt test executable and the parent's existing Docker CLI and Git, without another parent
image or a Go installation. Set `FACTORY_BROWSER_PROOF_DOCKER_VERSION` to the exact version in
`upstream.json`. `FACTORY_BROWSER_PROOF_STANDALONE=1` covers an image-only primary without a
Compose label. Both paths retain the App, source, lease, isolation, recording and cleanup checks.
This component proof does not update worker pins or replace the full Factory Delivery journey.

The smaller `opencode-sol.live` proof runs the exact published OpenCode process in an owned
fixture, implements and tests a small goal through Azure `gpt-6.1-sol` at medium reasoning,
and checks the result independently without a final JSON form. Set `FACTORY_OPENCODE_SOL_LIVE=1`
and explicitly configure `FACTORY_MODEL_BASE_URL`, `FACTORY_MODEL_API_KEY` and
`FACTORY_AGENT_MODEL_ID` before running `mise exec -- bun run test:live opencode-sol.live`.
Set `FACTORY_OPENCODE_SOL_REASONING=high` to prove a higher selected effort instead of the
default medium.
It keeps the real provider credential outside the fixture and removes its owned containers.

The independent reviewer calibration uses an explicitly configured Azure Coding connection at medium
reasoning. Set `FACTORY_REVIEW_MODEL_LIVE=1` and run
`mise exec -- bun run test:live candidate-review-model.live`. It executes a healthy control and two
seeded defects independently, then checks the fresh native reviewer's judgments. It also gives
fresh finding checkers a healthy false alarm and both real defects, requiring dismissal or confirmation.
This is a bounded calibration, not the final application journey.
`bun run test:controllers candidate-review` checks
exact-candidate Delivery, targeted correction, explicit retry, Stop and allowance behavior without
live models. `bun run test:native opencode-review-permissions` proves the pinned native tool boundary.

Wiki review has a separate Planning-model calibration. With the explicit Luna connection, set
`FACTORY_WIKI_QUALITY_LIVE=1` and run `bun run test:live wiki-quality.live`. It accepts an accurate
description of a source limitation and clearly marked improvement advice, while rejecting invented
cleanup and global-connection guarantees. It does not replace the full application journey.
With that same connection, set `FACTORY_WIKI_PLAN_COVERAGE_LIVE=1` and run
`bun run test:live wiki-plan-coverage.live`. The plan check accepts research intent before
investigation, rejects an empty plan that leaves essential guidance missing and accepts a
genuinely complete Wiki without changes. Page publication still requires its separate factual checks.

Exact-commit code research has its own paid proof. With the explicit Luna Planning connection,
set `FACTORY_CODE_RESEARCH_LIVE=1` and run `bun run test:live contextual-research.live`.
It checks native code discovery, inspected-file citations and visibility after a permission
downgrade. It is not part of the ordinary controller lane.

The worker's read-only storage admission check has a separate Linux proof. Set
`FACTORY_STORAGE_ADMISSION_LIVE=1` and `FACTORY_STORAGE_ADMISSION_IMAGE` to the exact pinned worker
image already available locally, then run `bun run test:live factorybox-storage-admission.live`.
It checks real insufficient capacity on an owned small filesystem, exact capacity boundaries and
foreign-storage refusal without Project source, network, native filesystem allocation or model
calls. This is not a full worker lifecycle or replacement qualification.

Retrospective work review has a separate configured Planning-model calibration. Set
`FACTORY_LEARNING_MODEL_LIVE=1` and run `mise exec -- bun run test:live learning-model`.
The default controller and browser lanes use isolated evidence and make no paid calls.

Monitoring diagnosis has a separate configured Planning-model proof. Set
`FACTORY_MONITORING_MODEL_LIVE=1` and run `mise exec -- bun run test:live monitoring-model.live`.
It reads owned synthetic incidents through the official MCP transport and exact local Git source,
then distinguishes an application defect, missing code and an operational alert. It records native
model usage. This bounded diagnosis proof does not claim end-to-end Build, review or Delivery.

Generic Input preparation has its own configured-model proof:

```sh
FACTORY_PROJECT_INPUT_LIVE=1 mise exec -- bun run test:live project-input.live
```

It reads two selected sources through the official MCP client, prepares one unapproved Ticket
with requirements, and checks that duplicate deliveries do not repeat inference. It starts no
Build or Delivery. `bun run test:browser test/browser/project-inputs-ui.spec.ts` exercises the real
settings components with controlled API responses on desktop and phone. The full-Factory
`monitoring-settings.spec.ts` additionally exercises authenticated commands and durable policies.

The full monitoring proof uses separate PostgreSQL, OpenBao and Forgejo resources, the published
runtime pins and configured Planning/Coding models:

```sh
FACTORY_RUN_MONITORING_AUTOFIX_PROOF=1 mise exec -- bun run test:live monitoring-autofix.live
```

Only the external monitoring provider is synthetic. The proof connects it with an encrypted bearer
token, reviews its exact tools and grants Project access. Duplicate alerts must create one Ticket
and one Change, then pass native Build, fresh Verification and independent review before delegated
Delivery advances `release`, the configured default branch. The unrelated `main` branch must stay
unchanged. The harness checks the promoted App's missing and known invoice responses without
editing source or approving Delivery after intake.
Failures retain exact owned identities under `.factory/test-results/monitoring/native/`.
`FACTORY_MONITORING_AUTOFIX_RESUME` accepts that run's `state.json` to observe its existing work.
It never commissions a replacement for a blocked or uncertain incident. Successful runs remove
their owned runtime storage, services and credentials.

Filter a controller or native lane by filename, for example `bun run test:controllers agent-read`.

Technical Planning has an owned, opt-in model proof:

```sh
FACTORY_TECHNICAL_PLANNING_LIVE=1 mise exec -- bun run test:live technical-planning.live
```

It exercises Product confirmation, exact-commit code reads and a rendered PlantUML diagram without
starting implementation. The configured Planning connection incurs ordinary model usage.
Use `--list` to inspect its selection. Ordinary unit/controller/native lanes discard inherited live
model flags and provider credentials, and do not load `.env` in the test runner or owned Factory
children. Native runtime
conformance and Forgejo checks remain explicit commands, not hidden steps in the default integration gate.
Runtime conformance uses an explicit admitted Factorybox profile and Registry trust. It owns a
separate namespace, worker and claims, never the shared Registry or retained installation.
`runtime:smoke:down` removes only completed labeled conformance namespaces with UID preconditions.
Failed native stores stay retained for diagnosis while their owned worker Pod is fenced to release RAM.

## Documentation

- [Architecture and domain reference](docs/README.md) explains ownership, runtime topology,
  terminology, decisions and verification limits.
- [Runtime artifacts](deploy/runtime-host/README.md) describes image publication and preparation.
- [Runtime fixture](test/fixtures/runtime-project/README.md) explains the conformance Project.
- [Artwork attribution](apps/factory/public/art/README.md) preserves bundled source and rights details.
- [AGENTS.md](AGENTS.md) contains only rules specific to work in this repository.

Maintained Markdown is limited to READMEs, AGENTS.md, ADRs and the
[UI product brief](apps/factory/PRODUCT.md). The product brief records durable users, workflows
and constraints for design work, not task plans or design specifications. Task plans and progress
belong in the task or issue. Lasting decisions belong in ADRs; current behavior belongs in code,
tests and the relevant README. Historical local reports and captures are preserved under
`.factory/archives/repository-cleanup-20261013/`.

Factory is licensed under [Apache-2.0](LICENSE). Bundled third-party assets retain their own notices.
