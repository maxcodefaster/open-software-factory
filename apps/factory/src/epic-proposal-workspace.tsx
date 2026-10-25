import { createSignal, For, Show } from "solid-js";
import {
  epicProposalInput,
  type EpicProposal,
} from "../../../packages/conversation-domain/src/epic-proposal";
import { MarkdownEditor } from "./markdown-editor";
import { WorkspaceActionBar } from "./ui/workspace-actions";

export function EpicProposalWorkspace(props: {
  id: string;
  initial: EpicProposal;
  storageKey: string;
  pending: boolean;
  onConfirm(proposal: EpicProposal): Promise<boolean>;
}) {
  let initial = props.initial;
  try {
    const saved = epicProposalInput.safeParse(
      JSON.parse(localStorage.getItem(props.storageKey) ?? "null"),
    );
    if (saved.success) initial = saved.data;
  } catch {
    /* Keep the server proposal. */
  }
  const [proposal, setProposal] = createSignal(initial);
  const [error, setError] = createSignal("");
  function update(value: EpicProposal) {
    setProposal(value);
    try {
      localStorage.setItem(props.storageKey, JSON.stringify(value));
    } catch {
      /* The open draft remains editable. */
    }
  }
  function member(key: string, patch: Partial<EpicProposal["members"][number]>) {
    update({
      ...proposal(),
      members: proposal().members.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    });
  }
  async function confirm() {
    const parsed = epicProposalInput.safeParse(proposal());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Review the proposed work");
      return;
    }
    setError("");
    if (await props.onConfirm(parsed.data)) {
      try {
        localStorage.removeItem(props.storageKey);
      } catch {
        /* Confirmation is already persisted. */
      }
    }
  }
  return (
    <section class="ticket-workspace epic-proposal-workspace" aria-label="Proposed Epic">
      <div class="ticket-document">
        <header class="ticket-status-row workspace-heading">
          <textarea
            class="ticket-draft-title workspace-heading-title"
            rows={1}
            aria-label="Epic title"
            value={proposal().epic.title}
            onInput={(event) =>
              update({
                ...proposal(),
                epic: { ...proposal().epic, title: event.currentTarget.value },
              })
            }
          />
          <WorkspaceActionBar label="Epic actions" class="ticket-header-actions">
            <button
              type="button"
              class="workspace-action"
              data-primary="true"
              disabled={props.pending}
              onClick={() => void confirm()}
            >
              Confirm work
            </button>
          </WorkspaceActionBar>
          <span class="ticket-status-context workspace-heading-meta">Proposed work</span>
        </header>
        <MarkdownEditor
          label="Epic outcome"
          value={proposal().epic.description}
          onChange={(description) =>
            update({ ...proposal(), epic: { ...proposal().epic, description } })
          }
        />
        <div class="epic-proposal-members">
          <For each={proposal().members} keyed={(item) => item.key}>
            {(item, index) => (
              <section class="epic-proposal-member">
                <header>
                  <span>{index() + 1}</span>
                  <Show when={item().existingTicketId}>
                    <small>Existing Ticket · content retained</small>
                  </Show>
                </header>
                <textarea
                  class="ticket-inline-title"
                  rows={1}
                  aria-label={`Member ${index() + 1} title`}
                  readonly={Boolean(item().existingTicketId)}
                  value={item().title}
                  onInput={(event) => member(item().key, { title: event.currentTarget.value })}
                />
                <Show
                  when={!item().existingTicketId}
                  fallback={<p class="muted">{item().description}</p>}
                >
                  <MarkdownEditor
                    label={`Member ${index() + 1} description`}
                    value={item().description}
                    onChange={(description) => member(item().key, { description })}
                  />
                  <MarkdownEditor
                    label={`Member ${index() + 1} outcome`}
                    value={item().requirement.summary}
                    onChange={(summary) =>
                      member(item().key, { requirement: { ...item().requirement, summary } })
                    }
                  />
                  <h4>Acceptance criteria</h4>
                  <For each={item().requirement.acceptanceCriteria.map((_, i) => i)}>
                    {(criterionIndex) => (
                      <div class="specification-list-item">
                        <span class="requirement-marker">·</span>
                        <textarea
                          class="specification-rich-text"
                          rows={1}
                          aria-label={`Member ${index() + 1} criterion ${criterionIndex + 1}`}
                          value={item().requirement.acceptanceCriteria[criterionIndex] ?? ""}
                          onInput={(event) =>
                            member(item().key, {
                              requirement: {
                                ...item().requirement,
                                acceptanceCriteria: item().requirement.acceptanceCriteria.map(
                                  (value, i) =>
                                    i === criterionIndex ? event.currentTarget.value : value,
                                ),
                              },
                            })
                          }
                        />
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={item().dependsOn.length}>
                  <p class="epic-dependencies">
                    After{" "}
                    {item()
                      .dependsOn.map(
                        (key) =>
                          proposal().members.find((candidate) => candidate.key === key)?.title ??
                          key,
                      )
                      .join(", ")}
                  </p>
                </Show>
                <details>
                  <summary>Dependencies</summary>
                  <For
                    each={proposal().members.filter((candidate) => candidate.key !== item().key)}
                    keyed={(candidate) => candidate.key}
                  >
                    {(candidate) => (
                      <label class="epic-dependency-choice">
                        <input
                          type="checkbox"
                          checked={item().dependsOn.includes(candidate().key)}
                          onChange={(event) =>
                            member(item().key, {
                              dependsOn: event.currentTarget.checked
                                ? [...item().dependsOn, candidate().key]
                                : item().dependsOn.filter((key) => key !== candidate().key),
                            })
                          }
                        />
                        {candidate().title}
                      </label>
                    )}
                  </For>
                </details>
              </section>
            )}
          </For>
        </div>
        <Show when={error()}>
          <p class="inline-error" role="alert">
            {error()}
          </p>
        </Show>
      </div>
    </section>
  );
}
