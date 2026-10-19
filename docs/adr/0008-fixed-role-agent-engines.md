# Fixed engines for Project and Change work

Factory owns the product lifecycle and one Ticket Conversation. Mastra executes checkout-free
Investigate and Plan turns; OpenCode 2 executes Build turns in the approved Ticket Workspace.
Keeping engine assignment fixed makes authority and recovery specific to each execution boundary,
while models, role instructions, and Skills can be configured without a second orchestration layer.

Use the pinned engines' native provider/model adapters, catalogue metadata, bounded tool loops,
structured outputs, streaming, usage and error types rather than copying their mechanisms into
Factory. Factory owns secure credentials, endpoint policy, admitted configuration, permissions,
external-operation recovery and immutable human decisions. Capability metadata does not prove
account access or quota; bounded model probes and provider-reported headers do. No automatic
fallback changes an admitted model or paid request. OpenCode receives only a Build-bound Factory
capability; native provider traffic passes through the authorized relay without protocol conversion.

New OpenAI Build admissions freeze a reasoning effort of at least medium and use the pinned
native Responses adapter. The administrator sets the default beside the Coding model; a person
may select another allowed effort in chat before the first Build. Model and reasoning defaults
are adopted together only after the exact access probe succeeds. Probe intent retains the
requested effort, and changed command replays cannot silently adopt another value.
The chat shows the fixed admitted value after work starts rather than offering an ineffective
runtime override. The relay rejects a different effort or
transport rather than rewriting the request. Admin changes apply to new Changes and probes,
not running work or retained historical configurations. Other providers retain their concrete
native adapters and options. A successful access probe proves a real native tool call, not
just that an account can list a deployment.

Run the exact published OpenCode server with native durable event persistence enabled. The CLI
does not expose this setting and its sequence-only log cannot recover usage after interruption.
Retain the upstream server, native assets and lockfile unchanged rather than forking OpenCode or
copying transcripts into analytics; Factory consumes the log through the pinned v2 client.

Skills belong to an instance library with personal, Project and Factory ownership. Product
Contributors can author private guidance; Project managers and administrators can publish exact
shared copies. Sharing proposals and work admissions expose only the specific immutable revision,
never the author's other private versions. Personal choices remain per Project. Each library
identity has its own Inherit, Enable or Disable choice; required inherited revisions are locked.
Untouched identities receive later defaults, while revision updates require explicit adoption.

Use native discovery and on-demand loading in both engines. Project admission retains required
versus optional revision choices. Applicable required rules, explicitly invoked Skills and the
assigned Interview Skill load through native Mastra APIs before inference. Manual-only Skills
still require human invocation. References preload up to a shared 8 KiB; larger references stay
on demand. Observations distinguish actual loads from eligibility. Checkout-free work receives readable
references through Mastra's inline skills and cannot execute package scripts. Execution-dependent
packages are Build-only. Build intent retains the exact manifest and slash-invocation attachments
before installation. The privileged Runtime Connector parent installs verified packages outside
the source checkout, seals them for the development user and refuses a different set for that
runtime. OpenCode's ambient global and Project discovery are disabled; its session permissions
permit only admitted skill identities. Upstream built-in skills remain installed and are denied
by these session rules. Native observations record actual loads rather than every eligible skill.

Historical Build intent keeps its recorded eager prompt and exact versions. New Changes use native
packages. A script may run only with the existing Sandbox tools and permissions; installation and
skill selection add no authority. The Sandbox remains the security boundary, including any root
access deliberately allowed by its approved development configuration.
