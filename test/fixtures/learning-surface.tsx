import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { LearningDashboard } from "../../apps/factory/src/learning/dashboard";
import { learningFixture } from "./learning";
import { learningHistoryFixture } from "./learning-history";
import { comparisonExample, comparisonBefore, comparisonAfter } from "./learning-comparison";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import { fixtureValue } from "./value";

function Surface() {
  const query = new URLSearchParams(location.search);
  const initial = query.has("flow")
    ? learningHistoryFixture()
    : learningFixture(query.has("empty"));
  if (query.has("no-change") || query.has("calibration")) initial.proposals = [];
  if (query.has("calibration"))
    fixtureValue(initial.reviews[0], "initial.reviews[0]").kind = "calibration";
  if (query.has("paused")) initial.enabled = false;
  if (query.has("missing-revision")) initial.applications = [];
  if (query.has("long") && initial.applications[0]) {
    initial.applications[0].title =
      "Inspect the complete retained repository configuration before repeating a clarification question about a hostname already documented in the source and its environment-specific overrides";
  }
  if (query.has("uncertain") && initial.comparisons[0]) {
    initial.comparisons[0].state = "uncertain";
    initial.comparisons[0].result = null;
    initial.comparisons[0].reason = "The comparison result was not confirmed. No automatic retry.";
  }
  if (query.has("many")) {
    initial.reviews.push(
      ...[20, 21, 22].map((day) => ({
        ...fixtureValue(initial.reviews[0], "initial.reviews[0]"),
        id: `10000000-0000-4000-8000-${String(100 + day).padStart(12, "0")}`,
        createdAt: `2026-10-${day}T09:00:00Z`,
        completedAt: `2026-10-${day}T09:00:15Z`,
      })),
    );
  }
  if (query.has("readonly")) initial.canManage = false;
  if (query.has("private")) {
    initial.scope = "personal";
    initial.proposals = initial.proposals.map((item) => ({ ...item, private: true }));
  }
  if (query.has("comparison")) {
    const example = comparisonExample(fixtureValue(initial.projectId, "initial.projectId"), {
      target: {
        kind: "skill",
        id: "10000000-0000-4000-8000-000000000010",
        revisionId: "10000000-0000-4000-8000-000000000011",
        version: 1,
        field: "instructions",
      },
      before: comparisonBefore,
      after: comparisonAfter,
    });
    // Stable capture identities. This is labeled synthetic, never a live result.
    example.cases.forEach((item, index) => {
      item.id = `synthetic:task:${index + 1}`;
    });
    initial.automaticSkills = true;
    initial.comparisons = [
      {
        id: "10000000-0000-4000-8000-000000000014",
        proposalId: fixtureValue(initial.proposals[0], "initial.proposals[0]").id,
        phase: "adopt",
        title: example.content.title,
        state: "completed",
        reason: null,
        modelId: "Synthetic model",
        rubric: "planning-text-replay/v1",
        createdAt: "2026-10-26T10:00:00Z",
        candidateFirst: false,
        baselineTarget: example.content.edit.target,
        before: comparisonBefore,
        after: comparisonAfter,
        evidence: example.cases,
        responses: [false, true].map((candidate) => ({
          answers: example.cases.map((item, index) => ({
            caseId: item.id,
            body: `MAX_RETRIES is ${fixtureValue([3, 7, 11][index], "[3, 7, 11][index]") + (!candidate && index < 2 ? 2 : 0)}. Source artifact:${index}.`,
          })),
        })),
        result: {
          passed: true,
          decision: "applied",
          cases: [0, 1].flatMap((arm) =>
            example.cases.map((_, index) => ({
              caseId: `replay:${arm}:${index}`,
              fulfillment: arm === 0 && index < 2 ? ("problem" as const) : ("supported" as const),
              verification: "supported",
              rework: "unknown",
              explanation: "Synthetic response compared to the exact source value.",
              evidenceIds: [`artifact:${index}`, `response:${arm}:${index}`],
            })),
          ),
        },
      },
    ];
  }
  if (query.has("edit")) {
    const proposal = fixtureValue(initial.proposals[0], "initial.proposals[0]");
    proposal.content.title = "Read source before asking for a hostname";
    proposal.content.target = "skill";
    proposal.content.change =
      "Replace the hostname-first instruction with source inspection before clarification.";
    proposal.content.expectedEffect =
      "Avoid unnecessary questions when the repository already names the hostname.";
    proposal.content.validation =
      "Compare a task with a documented hostname and one where the source genuinely leaves it unknown.";
    proposal.content.edit = {
      target: {
        kind: "skill",
        id: "10000000-0000-4000-8000-000000000010",
        revisionId: "10000000-0000-4000-8000-000000000011",
        version: 1,
        field: "instructions",
      },
      before: "Ask for a hostname before looking at repository sources.",
      after: "Inspect repository sources before asking for a hostname.",
    };
    proposal.editDigest = "f".repeat(64);
    proposal.targetLabel = "Source-backed research";
    proposal.canApply = !query.has("readonly") && !query.has("blocked");
    proposal.targetScope = query.has("blocked")
      ? "system"
      : query.has("personal-target")
        ? "personal"
        : "project";
    proposal.requiresPrivateRelease = proposal.private && proposal.targetScope !== "personal";
    proposal.applyBlockedReason = proposal.canApply
      ? null
      : "The owning Factory administrator must apply this edit.";
  }
  const [view, setView] = createSignal(initial);
  const [action, setAction] = createSignal("");
  return (
    <main class="learning-fixture" aria-label="Synthetic Factory monitoring fixture">
      <header>
        <h1>Monitoring</h1>
        <span>Billing · Synthetic fixture</span>
      </header>
      <LearningDashboard
        view={view()}
        onToggle={() => {
          setView((value) => ({ ...value, enabled: !value.enabled }));
          setAction("Learning setting saved");
        }}
        onAutomaticToggle={() => {
          setView((value) => ({ ...value, automaticSkills: !value.automaticSkills }));
          setAction("Automatic Skill permission saved");
        }}
        busy={query.has("busy")}
        onDecide={(id, decision, releasePrivate) => {
          if (decision === "apply") {
            const proposal = fixtureValue(
              view().proposals.find((item) => item.id === id),
              "view().proposals.find((item) => item.id === id)",
            );
            setAction(
              releasePrivate ? "Exact private edit applied with release" : "Exact edit applied",
            );
            setView((value) => ({
              ...value,
              proposals: value.proposals.map((item) =>
                item.id === id ? { ...item, state: "applied" } : item,
              ),
              applications: [
                {
                  id: "10000000-0000-4000-8000-000000000012",
                  proposalId: id,
                  title: proposal.content.title,
                  target: fixtureValue(proposal.content.edit, "proposal.content.edit").target,
                  edit: fixtureValue(proposal.content.edit, "proposal.content.edit"),
                  appliedRevisionId: "10000000-0000-4000-8000-000000000013",
                  appliedVersion: 2,
                  createdAt: "2026-10-26T10:00:00Z",
                  revertedAt: null,
                  state: "applied",
                  canRevert: true,
                  targetLabel: proposal.targetLabel,
                  targetScope: proposal.targetScope,
                  automatic: false,
                  automaticRecovery: false,
                  subsequent: {
                    sampled: 1,
                    reviewed: 1,
                    problems: 0,
                    cases: [
                      {
                        source: {
                          id: "synthetic:later:1",
                          projectId: fixtureValue(value.projectId, "value.projectId"),
                          ownerId: null,
                          developerOnly: false,
                          activity: "research",
                          outcome: "completed",
                          settledAt: "2026-10-26T10:30:00Z",
                          evidence: [
                            {
                              id: "later:task",
                              kind: "task",
                              body: "Report the documented hostname.",
                              truncated: false,
                            },
                            {
                              id: "later:source",
                              kind: "artifact",
                              body: "The retained configuration names api.example.invalid as the hostname.",
                              truncated: false,
                            },
                            {
                              id: "later:answer",
                              kind: "outcome",
                              body: "The answer used the documented hostname without asking again.",
                              truncated: false,
                            },
                          ],
                          targets: [
                            {
                              target: {
                                ...fixtureValue(proposal.content.edit, "proposal.content.edit")
                                  .target,
                                revisionId: "10000000-0000-4000-8000-000000000013",
                                version: 2,
                              },
                              text: fixtureValue(proposal.content.edit, "proposal.content.edit")
                                .after,
                              evidenceId: "later:source",
                              truncated: false,
                            },
                          ],
                        },
                        reviewId: "10000000-0000-4000-8000-000000000015",
                        verdict: {
                          caseId: "synthetic:later:1",
                          fulfillment: "supported",
                          rework: "necessary",
                          verification: "supported",
                          explanation:
                            "This sampled answer matches its retained source. It is one observation, not causal proof.",
                          evidenceIds: ["later:source", "later:answer"],
                        },
                      },
                    ],
                  },
                },
                ...value.applications,
              ],
            }));
            return;
          }
          setAction(
            decision === "dismiss"
              ? "Proposal dismissed"
              : releasePrivate
                ? "Explicit private proposal released as Ticket"
                : "Improvement Ticket created",
          );
          setView((value) => ({
            ...value,
            proposals: value.proposals.map((item) =>
              item.id !== id
                ? item
                : {
                    ...item,
                    state: decision === "dismiss" ? "dismissed" : "ticket-created",
                    ticketId:
                      decision === "dismiss" ? null : "10000000-0000-4000-8000-000000000005",
                  },
            ),
          }));
        }}
        onRollback={(id) => {
          setAction("Edit reverted as another revision");
          setView((value) => ({
            ...value,
            applications: value.applications.map((item) =>
              item.id === id
                ? { ...item, state: "reverted", revertedAt: "2026-10-26T11:00:00Z" }
                : item,
            ),
          }));
        }}
        onOpenTicket={() => setAction("Ticket opened")}
      />
      {query.has("refresh") && (
        <button
          type="button"
          onClick={() =>
            setView(view().reviews.length ? learningFixture(true) : learningHistoryFixture())
          }
        >
          Replace synthetic history
        </button>
      )}
      <output aria-label="Fixture action">{action()}</output>
    </main>
  );
}
render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
