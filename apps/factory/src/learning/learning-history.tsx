import { For, Show } from "solid-js";
import type { LearningView } from "#conversation-domain/learning";

function AppliedImprovements(props: {
  view: LearningView;
  busy?: boolean | undefined;
  onRollback?: ((id: string, revisionId: string) => void) | undefined;
}) {
  return (
    <Show when={props.view.applications.length}>
      <section class="work-applied" aria-label="Applied improvements">
        <h4>Applied changes</h4>
        <p class="work-note">
          Publication is recorded separately from impact. No measured improvement is claimed here.
        </p>
        <ol class="work-proposals">
          <For each={props.view.applications}>
            {(application) => (
              <li tabindex="-1" id={`work-application-${application.id}`} class="work-application">
                <div class="work-proposal-heading">
                  <h4>{application.title}</h4>
                  <span>{application.state === "reverted" ? "Reverted" : "Applied"}</span>
                </div>
                <p class="work-note">
                  {application.targetScope === "system"
                    ? "Factory"
                    : application.targetScope === "personal"
                      ? "Personal"
                      : application.targetScope === "project"
                        ? "Project"
                        : "Exact"}{" "}
                  {application.target.kind} · {application.targetLabel ?? "Resource"} · version{" "}
                  {application.appliedVersion} · {new Date(application.createdAt).toLocaleString()}
                </p>
                <code>{application.target.id}</code>
                <p class="work-note">
                  {application.automatic
                    ? "Adopted under saved permission after a matched text replay."
                    : "Applied by an explicit human decision."}
                  {application.automaticRecovery
                    ? " Reverted after a matched recovery comparison."
                    : ""}
                </p>
                <p class="work-note">
                  Later use · {application.subsequent.sampled} sampled cases ·{" "}
                  {application.subsequent.reviewed} reviewed · {application.subsequent.problems}{" "}
                  with problems. These observations are not causal proof of improvement.
                </p>
                <Show when={application.subsequent.cases.length}>
                  <details class="work-later-uses">
                    <summary>
                      Inspect latest sampled uses · {application.subsequent.cases.length} of{" "}
                      {application.subsequent.sampled}
                    </summary>
                    <p class="work-note">
                      These cases record exact revision <code>{application.appliedRevisionId}</code>
                      .
                    </p>
                    <For each={application.subsequent.cases}>
                      {(use) => (
                        <details class="work-evidence-case">
                          <summary>
                            {use.source.activity} · {use.verdict?.fulfillment ?? "Not reviewed"} ·{" "}
                            <code>{use.source.id}</code>
                          </summary>
                          <p>{use.verdict?.explanation ?? "No settled review verdict yet."}</p>
                          <Show when={use.reviewId}>
                            <p class="work-note">
                              Review <code>{use.reviewId}</code>
                            </p>
                          </Show>
                          <For each={use.source.evidence}>
                            {(source) => (
                              <details>
                                <summary>
                                  {source.kind} · {source.id}
                                  {source.truncated ? " · excerpt" : ""}
                                </summary>
                                <pre>{source.body}</pre>
                              </details>
                            )}
                          </For>
                        </details>
                      )}
                    </For>
                  </details>
                </Show>
                <details>
                  <summary>Accepted edit & revision</summary>
                  <code>{application.appliedRevisionId}</code>
                  <div class="work-edit-passages">
                    <section aria-label="Previous passage">
                      <h5>Before</h5>
                      <pre>{application.edit.before}</pre>
                    </section>
                    <section aria-label="Accepted passage">
                      <h5>After</h5>
                      <pre>{application.edit.after}</pre>
                    </section>
                  </div>
                </details>
                <Show when={application.state === "applied" && application.canRevert}>
                  <Show when={application.target.kind === "knowledge"}>
                    <p class="work-note">
                      Check the previous text against current sources before restoring Knowledge. Do
                      not restore a disproven fact.
                    </p>
                  </Show>
                  <button
                    type="button"
                    class="text-button"
                    disabled={props.busy}
                    onClick={() =>
                      props.onRollback?.(application.id, application.appliedRevisionId)
                    }
                  >
                    Undo this edit
                  </button>
                  <small>
                    Creates another revision. Newer human writing or choices block Undo.
                  </small>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
}

function ComparedChanges(props: { view: LearningView }) {
  return (
    <Show when={props.view.comparisons.length}>
      <details class="work-comparisons">
        <summary>Compared changes · {props.view.comparisons.length}</summary>
        <p class="work-note">
          Matched, tool-free text replays under one fixed model and rubric. This checks the observed
          instruction problem, not end-to-end Factory quality or live tool behavior.
        </p>
        <For each={props.view.comparisons}>
          {(comparison) => (
            <details class="work-review" id={`work-comparison-${comparison.id}`}>
              <summary>
                {comparison.title} · {comparison.phase === "recover" ? "Recovery" : "Adoption"} ·{" "}
                {comparison.result?.decision ?? comparison.state}
              </summary>
              <p class="work-note">
                {comparison.modelId} · {comparison.rubric} ·{" "}
                {new Date(comparison.createdAt).toLocaleString()}
              </p>
              <Show when={comparison.reason}>
                <p>{comparison.reason}</p>
              </Show>
              <details class="work-edit-preview">
                <summary>Compared instruction & exact revision</summary>
                <p class="work-note">
                  {props.view.scope === "personal" ? "Personal" : "Project"} Skill{" "}
                  <code>{comparison.baselineTarget.id}</code> · baseline version{" "}
                  {comparison.baselineTarget.version}
                </p>
                <code>{comparison.baselineTarget.revisionId}</code>
                <div class="work-edit-passages">
                  <section>
                    <h5>Baseline instruction</h5>
                    <pre>{comparison.before}</pre>
                  </section>
                  <section>
                    <h5>Candidate instruction</h5>
                    <pre>{comparison.after}</pre>
                  </section>
                </div>
              </details>
              <For each={comparison.evidence}>
                {(item, index) => (
                  <details class="work-evidence-case">
                    <summary>
                      Task {index() + 1} · <code>{item.id}</code>
                    </summary>
                    <For
                      each={item.evidence.filter(
                        (source) => source.kind === "task" || source.kind === "artifact",
                      )}
                    >
                      {(source) => (
                        <details>
                          <summary>
                            {source.kind} · {source.id}
                          </summary>
                          <pre>{source.body}</pre>
                        </details>
                      )}
                    </For>
                    <For each={comparison.responses}>
                      {(arm, armIndex) => {
                        const verdict = () =>
                          comparison.result?.cases.find(
                            (grade) => grade.caseId === `replay:${armIndex()}:${index()}`,
                          );
                        return (
                          <section>
                            <h5>
                              {(armIndex() === 0) === comparison.candidateFirst
                                ? "Candidate"
                                : "Baseline"}{" "}
                              response
                            </h5>
                            <pre>
                              {arm.answers.find((answer) => answer.caseId === item.id)?.body}
                            </pre>
                            <p>
                              {verdict()?.fulfillment ?? "Not judged"} · {verdict()?.explanation}
                            </p>
                          </section>
                        );
                      }}
                    </For>
                  </details>
                )}
              </For>
            </details>
          )}
        </For>
      </details>
    </Show>
  );
}

function CreatedTickets(props: {
  view: LearningView;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
}) {
  return (
    <Show when={props.view.proposals.some((proposal) => proposal.state === "ticket-created")}>
      <ul class="work-created-tickets">
        <For each={props.view.proposals.filter((proposal) => proposal.ticketId)}>
          {(proposal) => (
            <li>
              <button
                type="button"
                class="text-button"
                onClick={() => {
                  const projectID = props.view.projectId;
                  if (proposal.ticketId && projectID)
                    props.onOpenTicket?.(proposal.ticketId, projectID);
                }}
              >
                {proposal.content.title}
              </button>
              <span>Ticket created · approval still required</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function ReviewHistory(props: { view: LearningView }) {
  return (
    <details class="work-review-history">
      <summary>
        Review history & evidence <span>{props.view.reviews.length}</span>
      </summary>
      <Show
        when={props.view.reviews.length}
        fallback={
          <p class="work-note">
            No review yet. Selected work waits for six cases, 24 hours or Review now.
          </p>
        }
      >
        <For each={props.view.reviews}>
          {(review) => (
            <details class="work-review" id={`work-review-${review.id}`}>
              <summary>
                <span>
                  {review.kind === "calibration"
                    ? "Judge calibration"
                    : `${review.cases.length} work ${review.cases.length === 1 ? "case" : "cases"}`}
                </span>
                <span>
                  {review.kind === "calibration" && review.state === "completed"
                    ? review.calibrated
                      ? "Passed"
                      : "Not calibrated"
                    : review.state}
                </span>
              </summary>
              <p class="work-note">
                {review.modelId} · {review.rubric} · {new Date(review.createdAt).toLocaleString()}
              </p>
              <Show when={review.reason}>
                <p role="status">{review.reason}</p>
              </Show>
              <For each={review.result?.cases ?? []}>
                {(result) => (
                  <div class="work-case-result">
                    <p>
                      <strong>
                        {result.fulfillment === "supported"
                          ? "Supported"
                          : result.fulfillment === "problem"
                            ? "Problem"
                            : "Insufficient evidence"}
                      </strong>{" "}
                      · {result.explanation}
                    </p>
                    <p class="work-note">
                      {result.verification === "supported"
                        ? "Verification supported"
                        : result.verification === "problem"
                          ? "Verification problem"
                          : "Verification not established"}
                    </p>
                    <code>{result.caseId}</code>
                  </div>
                )}
              </For>
              <details>
                <summary>Admitted evidence packet</summary>
                <For each={review.cases}>
                  {(item, caseIndex) => (
                    <section
                      class="work-evidence-case"
                      tabindex="-1"
                      id={`work-case-${review.id}-${caseIndex()}`}
                    >
                      <h4>
                        {item.activity} · {item.outcome}
                      </h4>
                      <code>{item.id}</code>
                      <For each={item.evidence}>
                        {(evidence, evidenceIndex) => (
                          <details
                            tabindex="-1"
                            id={`work-evidence-${review.id}-${caseIndex()}-${evidenceIndex()}`}
                          >
                            <summary>
                              {evidence.kind} · {evidence.id}
                              {evidence.truncated ? " · shortened" : ""}
                            </summary>
                            <pre>{evidence.body}</pre>
                          </details>
                        )}
                      </For>
                    </section>
                  )}
                </For>
              </details>
            </details>
          )}
        </For>
      </Show>
    </details>
  );
}

export function LearningHistory(props: {
  view: LearningView;
  busy?: boolean | undefined;
  onRollback?: ((id: string, revisionId: string) => void) | undefined;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
}) {
  return (
    <>
      <AppliedImprovements view={props.view} busy={props.busy} onRollback={props.onRollback} />
      <ComparedChanges view={props.view} />
      <CreatedTickets view={props.view} onOpenTicket={props.onOpenTicket} />
      <ReviewHistory view={props.view} />
    </>
  );
}
