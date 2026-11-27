import { type Accessor, For, Show } from "solid-js";
import type { ReleaseSettingsView } from "#project-domain/release";
import { plainErrorMessage } from "../command-error";
import { EndAttemptConfirmation, PublishConfirmation, ReleaseReference } from "./settings-dialogs";
import type { ReleaseSettingsState } from "./settings-state";
import {
  focusDecision,
  type ReleaseDialog,
  releaseDateLabel,
  releaseStatus,
} from "./settings-types";

export function ReleasePublishPanel(props: {
  data: Accessor<ReleaseSettingsView>;
  state: ReleaseSettingsState;
}) {
  let versionInput: HTMLInputElement | undefined;
  const confirmPublish = (): Extract<ReleaseDialog, { kind: "confirm-publish" }> | undefined => {
    const current = props.state.dialog();
    return current.kind === "confirm-publish" ? current : undefined;
  };
  const isEnding = (releaseID: string) => {
    const current = props.state.dialog();
    return current.kind === "confirm-end" && current.releaseID === releaseID;
  };

  return (
    <>
      <section aria-labelledby="release-current-heading">
        <div class="release-section-heading">
          <h3 id="release-current-heading">Publish a version</h3>
          <p class="release-note">
            Last published <strong>{props.data().lastVersion ?? "No releases yet"}</strong>
          </p>
        </div>
        <dl class="release-facts">
          <dt>From Staging</dt>
          <dd>
            <Show
              when={props.data().candidateSHA}
              fallback={<p>No delivered commit with a healthy Staging Preview is available.</p>}
            >
              {(sha) => <ReleaseReference value={sha()} label="delivered commit" />}
            </Show>
          </dd>
          <dt>Publishes</dt>
          <dd>
            <Show
              when={props.data().contract}
              fallback={<span>Source only. No application image is required.</span>}
            >
              {(contract) => (
                <span>
                  Source
                  <For each={contract().images}>
                    {(image) => (
                      <>
                        {" "}
                        · Image <code>{image}</code>
                      </>
                    )}
                  </For>
                  <Show when={contract().chart}>
                    {" "}
                    · Helm chart <code>{contract().chart}</code>
                  </Show>
                  <For each={contract().files}>
                    {(file) => (
                      <>
                        {" "}
                        · File <code>{file.filename}</code>
                      </>
                    )}
                  </For>
                </span>
              )}
            </Show>
          </dd>
        </dl>
        <Show when={props.data().configurationError}>
          <p role="alert" class="release-error">
            {props.data().configurationError} Fix the release configuration through a reviewed
            Change.
          </p>
        </Show>
        <Show when={props.data().contract && !props.data().configured}>
          <p>
            Artifact publication needs the Forgejo administrator and encrypted credential store to
            be configured.
          </p>
        </Show>
        <Show
          when={props.data().canPublish}
          fallback={<p>Developer access is required to publish.</p>}
        >
          <Show when={!confirmPublish()}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const commitSHA = props.data().candidateSHA;
                if (commitSHA) props.state.reviewPublication(commitSHA);
              }}
            >
              <fieldset class="release-fields" disabled={props.state.busy()}>
                <div class="release-version-choice">
                  <label>
                    Version
                    <input
                      ref={versionInput}
                      value={props.state.version()}
                      onInput={(event) => props.state.setVersion(event.currentTarget.value)}
                      placeholder={props.data().suggestions.patch}
                      required
                      autocomplete="off"
                      spellcheck={false}
                      aria-invalid={props.state.versionError() ? "true" : undefined}
                      aria-describedby={
                        props.state.versionError() ? "release-version-error" : undefined
                      }
                      pattern={"(0|[1-9][0-9]{0,7})\\.(0|[1-9][0-9]{0,7})\\.(0|[1-9][0-9]{0,7})"}
                    />
                  </label>
                  <fieldset class="release-bumps" aria-label="Suggested version bumps">
                    <For each={["patch", "minor", "major"] as const}>
                      {(kind) => (
                        <button
                          type="button"
                          class="quiet-button"
                          aria-pressed={
                            props.state.version() === props.data().suggestions[kind]
                              ? "true"
                              : "false"
                          }
                          onClick={() => props.state.setVersion(props.data().suggestions[kind])}
                        >
                          {kind.charAt(0).toUpperCase() + kind.slice(1)}{" "}
                          {props.data().suggestions[kind]}
                        </button>
                      )}
                    </For>
                  </fieldset>
                </div>
                <Show when={props.state.versionError()}>
                  <p id="release-version-error" class="release-error">
                    {props.state.versionError()}
                  </p>
                </Show>
                <label>
                  <span>
                    Release notes <span class="release-note">Optional</span>
                  </span>
                  <textarea
                    value={props.state.notes()}
                    maxlength={10_000}
                    rows={3}
                    onInput={(event) => props.state.setNotes(event.currentTarget.value)}
                  />
                </label>
                <Show when={props.state.activePublication()}>
                  <p>A publication needs attention in Release history before another can start.</p>
                </Show>
              </fieldset>
              <Show when={props.state.versionHint()}>
                <p id="release-version-hint" class="release-note">
                  Enter or choose a version to review the publication.
                </p>
              </Show>
              <button
                type="submit"
                class="primary-button"
                disabled={props.state.busy() || !props.state.canReview()}
                aria-describedby={props.state.versionHint() ? "release-version-hint" : undefined}
              >
                Review publication
              </button>
            </form>
          </Show>
          <Show when={confirmPublish()}>
            {(confirmed) => (
              <PublishConfirmation
                confirmation={confirmed}
                busy={props.state.busy}
                onConfirm={(pending) => props.state.confirmPublish(pending)}
                onEdit={() => {
                  props.state.setDialog({ kind: "none" });
                  queueMicrotask(() => versionInput?.focus());
                }}
              />
            )}
          </Show>
        </Show>
      </section>
      <section aria-labelledby="release-history-heading">
        <h3 id="release-history-heading">Release history</h3>
        <Show
          when={props.data().releases.length}
          fallback={
            <p class="release-note">No publications yet. Your first version will appear here.</p>
          }
        >
          <ul class="release-list">
            <For each={props.data().releases} keyed={(release) => release.id}>
              {(release) => (
                <li>
                  <details>
                    <summary>
                      <strong>{release().version}</strong>
                      <span class="release-state" data-state={release().state}>
                        {releaseStatus(release())}
                      </span>
                      <time datetime={release().publishedAt ?? release().createdAt}>
                        {releaseDateLabel(release().publishedAt ?? release().createdAt)}
                      </time>
                    </summary>
                    <div class="release-history-detail">
                      <ReleaseReference
                        value={release().commitSHA}
                        label={`${release().version} commit`}
                      />
                      <p class="release-notes">{release().notes || "No release notes."}</p>
                      <Show when={release().failure}>
                        <p class="release-error">{plainErrorMessage(release().failure ?? "")}</p>
                      </Show>
                      <For each={release().artifacts}>
                        {(artifact) => (
                          <div class="release-artifact">
                            <strong>
                              {artifact.kind === "chart"
                                ? "Helm chart"
                                : artifact.kind === "image"
                                  ? "Image"
                                  : "File"}{" "}
                              · {artifact.name}
                            </strong>
                            <ReleaseReference
                              value={
                                artifact.kind === "file"
                                  ? `${props.data().registryURL}/api/packages/${props.data().packageOwner}/generic/${artifact.name}/${release().version}/${artifact.filename}`
                                  : `${props.data().registryURL.replace(/^https?:\/\//, "")}/${props.data().packageOwner}/${artifact.name}@${artifact.digest}`
                              }
                              label={`${artifact.name} reference`}
                            />
                            <Show when={artifact.kind === "file"}>
                              <ReleaseReference
                                value={artifact.digest}
                                label={`${artifact.name} checksum`}
                              />
                            </Show>
                          </div>
                        )}
                      </For>
                      <div class="release-actions">
                        <Show when={release().releaseURL}>
                          {(url) => (
                            <a href={url()} target="_blank" rel="noreferrer">
                              Open Forgejo release
                            </a>
                          )}
                        </Show>
                        <Show when={release().runURL}>
                          {(url) => (
                            <a href={url()} target="_blank" rel="noreferrer">
                              Open Forgejo run
                            </a>
                          )}
                        </Show>
                        <Show
                          when={
                            release().state !== "published" &&
                            !release().endedAt &&
                            props.data().canPublish
                          }
                        >
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={props.state.busy()}
                            onClick={() => props.state.reconcileRelease(release().id)}
                          >
                            Check outcome
                          </button>
                          <button
                            type="button"
                            class="danger-button"
                            disabled={props.state.busy()}
                            onClick={(event) => {
                              props.state.setDialog({
                                kind: "confirm-end",
                                releaseID: release().id,
                              });
                              focusDecision(event.currentTarget);
                            }}
                          >
                            End attempt
                          </button>
                        </Show>
                      </div>
                      <Show when={isEnding(release().id)}>
                        <EndAttemptConfirmation
                          busy={props.state.busy}
                          onConfirm={() => props.state.confirmEndAttempt(release().id)}
                          onCancel={() => props.state.setDialog({ kind: "none" })}
                        />
                      </Show>
                    </div>
                  </details>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </>
  );
}
