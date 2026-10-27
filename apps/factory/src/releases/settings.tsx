import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import {
  type ReleaseSettingsView,
  releaseVersion,
} from "../../../../packages/project-domain/src/release";
import { FreshAuthentication } from "../access/fresh-authentication";
import { APIRequestError } from "../api-client";
import {
  createReleaseAccess,
  endProjectPublication,
  getProjectReleases,
  publishProjectRelease,
  reconcileProjectRelease,
  revokeReleaseAccess,
  rotateReleaseAccess,
} from "../server-functions/releases";
import { serverCall } from "../server-functions/result";
import { CopyButton, Feedback } from "../ui/feedback";
import { observeFactoryRead } from "../zero/reads";
import "./settings.css";

type Release = ReleaseSettingsView["releases"][number];
const stateLabels: Record<Release["state"], string> = {
  pending: "Queued",
  dispatching: "Starting",
  running: "Building artifacts",
  checking: "Checking artifacts",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  uncertain: "Outcome unconfirmed",
};
const status = (release: Release) =>
  `${release.endedAt ? "Ended · " : ""}${stateLabels[release.state]}`;
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function focusDecision(trigger: HTMLElement) {
  const entry = trigger.closest("li");
  queueMicrotask(() => {
    const decision = entry?.querySelector<HTMLElement>(".release-confirmation");
    decision?.querySelector<HTMLElement>("h4")?.focus();
    decision?.scrollIntoView({ block: "nearest" });
  });
}

function Reference(props: { value: string; label: string }) {
  return (
    <div class="release-reference-row">
      <code class="release-reference">{props.value}</code>
      <CopyButton
        value={props.value}
        label="Copy"
        accessibleLabel={`Copy ${props.label}`}
        class="quiet-button"
      />
    </div>
  );
}

export function ReleaseSettings(props: { projectID: string; active: boolean }) {
  const [view, setView] = createSignal<ReleaseSettingsView>();
  const [panel, setPanel] = createSignal<"versions" | "access">("versions");
  const [version, setVersion] = createSignal("");
  const [notes, setNotes] = createSignal("");
  const [name, setName] = createSignal("");
  const [scope, setScope] = createSignal<"git" | "packages">("git");
  const [error, setError] = createSignal("");
  const [loadError, setLoadError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [confirmation, setConfirmation] = createSignal<{
    version: string;
    commitSHA: string;
    notes: string;
    commandID: string;
  }>();
  const [credential, setCredential] = createSignal<{ username: string; token: string | null }>();
  const [reveal, setReveal] = createSignal(false);
  const [revokeID, setRevokeID] = createSignal<string>();
  const [rotateID, setRotateID] = createSignal<string>();
  const [endID, setEndID] = createSignal<string>();
  let confirmationHeading: HTMLHeadingElement | undefined;
  let versionInput: HTMLInputElement | undefined;
  let credentialHeading: HTMLHeadingElement | undefined;
  let alive = true;
  let generation = 0;
  let readSequence = 0;
  let shownProject = "";
  let accessCommand: { commandID: string; name: string; scope: "git" | "packages" } | undefined;
  let rotationCommand: { id: string; commandID: string } | undefined;
  let observed = false;
  async function load(projectID = props.projectID, signal?: AbortSignal) {
    const current = generation;
    const sequence = ++readSequence;
    try {
      const value = await serverCall(
        getProjectReleases({ data: [projectID], ...(signal ? { signal } : {}) }),
      );
      if (!alive || current !== generation || sequence !== readSequence || signal?.aborted) return;
      setView(value);
      setLoadError("");
    } catch {
      if (alive && current === generation && sequence === readSequence)
        setLoadError("Could not refresh releases. Refresh to try again.");
    }
  }
  async function action(execute: (current: () => boolean) => Promise<void>) {
    if (busy()) return;
    const epoch = generation;
    const current = () => alive && epoch === generation;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await execute(current);
      if (current()) await load();
    } catch (cause) {
      if (current())
        setError(
          cause instanceof APIRequestError
            ? cause.message
            : "Release command outcome is unconfirmed. Refresh before trying again.",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  createEffect(
    () => [props.projectID, props.active] as const,
    ([projectID, active]) => {
      generation++;
      alive = true;
      setBusy(false);
      setCredential(undefined);
      setReveal(false);
      setConfirmation(undefined);
      setRotateID(undefined);
      setRevokeID(undefined);
      setEndID(undefined);
      accessCommand = undefined;
      rotationCommand = undefined;
      if (shownProject !== projectID) {
        shownProject = projectID;
        setPanel("versions");
        setView(undefined);
        setVersion("");
        setNotes("");
        setName("");
        setError("");
        setLoadError("");
        setNotice("");
      }
      if (!active) return;
      if (!observed) void load(projectID);
      return () => {
        alive = false;
        generation++;
      };
    },
  );
  observed = observeFactoryRead(
    () =>
      props.active !== false
        ? { projectId: props.projectID, resourceId: props.projectID, scope: "releases" }
        : null,
    (signal) =>
      load(
        untrack(() => props.projectID),
        signal,
      ),
  );
  createEffect(confirmation, (value) => {
    if (value) confirmationHeading?.focus();
  });
  createEffect(credential, (value) => {
    if (value) credentialHeading?.focus();
  });
  const activePublication = () =>
    view()?.releases.some((item) => !item.endedAt && !["published", "failed"].includes(item.state));
  const versionError = () =>
    version() && !releaseVersion.safeParse(version()).success
      ? "Use a stable version such as 1.4.0, without a v prefix."
      : view()?.releases.some((item) => item.version === version())
        ? "This version is already reserved. Choose a new version."
        : "";
  const canReview = () =>
    view()?.canPublish &&
    view()?.candidateSHA &&
    !loadError() &&
    !view()?.configurationError &&
    (!view()?.contract || view()?.configured) &&
    !activePublication() &&
    version() &&
    !versionError();
  const choosePanel = (value: "versions" | "access") => {
    setPanel(value);
    setError("");
    setNotice("");
  };
  return (
    <section
      class="release-settings"
      aria-label="Project releases"
      aria-busy={busy() ? "true" : "false"}
    >
      <p class="release-note">
        Publish versioned source and artifacts. Deployment and operation stay with your external
        systems.
      </p>
      <div class="release-toolbar">
        <Show when={view()?.canManageAccess}>
          <nav class="release-tabs" aria-label="Release sections">
            <button
              type="button"
              aria-pressed={panel() === "versions" ? "true" : "false"}
              onClick={() => choosePanel("versions")}
            >
              Versions
            </button>
            <button
              type="button"
              aria-pressed={panel() === "access" ? "true" : "false"}
              onClick={() => choosePanel("access")}
            >
              External access
            </button>
          </nav>
        </Show>
        <button
          type="button"
          class="quiet-button"
          disabled={busy()}
          onClick={() => void action(async () => {})}
        >
          Refresh releases
        </button>
      </div>
      <Show when={loadError()}>
        <p role="alert" class="release-error">
          {loadError()} {view() ? "Showing the last confirmed data." : ""}
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="release-error">
          {error()}
        </p>
      </Show>
      <Show when={notice()}>
        <Feedback state="success" message={notice()} />
      </Show>
      <Show
        when={view()}
        fallback={
          <p role="status">
            {loadError() ? "Release details are unavailable." : "Loading releases…"}
          </p>
        }
      >
        {(data) => (
          <>
            <Show when={panel() === "versions" || !data().canManageAccess}>
              <section aria-labelledby="release-current-heading">
                <div class="release-section-heading">
                  <h3 id="release-current-heading">Publish a version</h3>
                  <p class="release-note">
                    Last published <strong>{data().lastVersion ?? "No releases yet"}</strong>
                  </p>
                </div>
                <dl class="release-facts">
                  <dt>From Staging</dt>
                  <dd>
                    <Show
                      when={data().candidateSHA}
                      fallback={
                        <p>No delivered commit with a healthy Staging Preview is available.</p>
                      }
                    >
                      {(sha) => <Reference value={sha()} label="delivered commit" />}
                    </Show>
                  </dd>
                  <dt>Publishes</dt>
                  <dd>
                    <Show
                      when={data().contract}
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
                <Show when={data().configurationError}>
                  <p role="alert" class="release-error">
                    {data().configurationError} Fix the release configuration through a reviewed
                    Change.
                  </p>
                </Show>
                <Show when={data().contract && !data().configured}>
                  <p>
                    Artifact publication needs the Forgejo administrator and encrypted credential
                    store to be configured.
                  </p>
                </Show>
                <Show
                  when={data().canPublish}
                  fallback={<p>Developer access is required to publish.</p>}
                >
                  <Show when={!confirmation()}>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const commitSHA = data().candidateSHA;
                        if (untrack(canReview) && commitSHA)
                          setConfirmation({
                            version: version(),
                            commitSHA,
                            notes: notes(),
                            commandID: crypto.randomUUID(),
                          });
                      }}
                    >
                      <fieldset class="release-fields" disabled={busy()}>
                        <div class="release-version-choice">
                          <label>
                            Version
                            <input
                              ref={versionInput}
                              value={version()}
                              onInput={(event) => setVersion(event.currentTarget.value)}
                              placeholder={data().suggestions.patch}
                              required
                              autocomplete="off"
                              spellcheck={false}
                              aria-invalid={versionError() ? "true" : undefined}
                              aria-describedby={
                                versionError() ? "release-version-error" : undefined
                              }
                              pattern={
                                "(0|[1-9][0-9]{0,7})\\.(0|[1-9][0-9]{0,7})\\.(0|[1-9][0-9]{0,7})"
                              }
                            />
                          </label>
                          <fieldset class="release-bumps" aria-label="Suggested version bumps">
                            <For each={["patch", "minor", "major"] as const}>
                              {(kind) => (
                                <button
                                  type="button"
                                  class="quiet-button"
                                  aria-pressed={
                                    version() === data().suggestions[kind] ? "true" : "false"
                                  }
                                  onClick={() => setVersion(data().suggestions[kind])}
                                >
                                  {kind.charAt(0).toUpperCase() + kind.slice(1)}{" "}
                                  {data().suggestions[kind]}
                                </button>
                              )}
                            </For>
                          </fieldset>
                        </div>
                        <Show when={versionError()}>
                          <p id="release-version-error" class="release-error">
                            {versionError()}
                          </p>
                        </Show>
                        <label>
                          <span>
                            Release notes <span class="release-note">Optional</span>
                          </span>
                          <textarea
                            value={notes()}
                            maxlength={10_000}
                            rows={3}
                            onInput={(event) => setNotes(event.currentTarget.value)}
                          />
                        </label>
                        <Show when={activePublication()}>
                          <p>
                            A publication needs attention in Release history before another can
                            start.
                          </p>
                        </Show>
                      </fieldset>
                      <button
                        type="submit"
                        class="primary-button"
                        disabled={busy() || !canReview()}
                      >
                        Review publication
                      </button>
                    </form>
                  </Show>
                  <Show when={confirmation()}>
                    {(confirmed) => (
                      <section class="release-confirmation" aria-label="Confirm publication">
                        <h4 ref={confirmationHeading} tabindex="-1">
                          Publish {confirmed().version}?
                        </h4>
                        <dl class="release-facts">
                          <dt>Exact commit</dt>
                          <dd>
                            <Reference value={confirmed().commitSHA} label="release commit" />
                          </dd>
                          <dt>Release notes</dt>
                          <dd class="release-notes">{confirmed().notes || "No release notes."}</dd>
                        </dl>
                        <p>
                          External systems may automatically deploy this version. Factory does not
                          wait for them and cannot roll their changes back.
                        </p>
                        <div class="release-actions">
                          <button
                            type="button"
                            class="primary-button"
                            disabled={busy()}
                            onClick={() =>
                              void action(async (current) => {
                                await serverCall(
                                  publishProjectRelease({ data: [props.projectID, confirmed()] }),
                                );
                                if (!current()) return;
                                setConfirmation(undefined);
                                setVersion("");
                                setNotes("");
                                setNotice(
                                  "Publication requested. Check Release history for its outcome.",
                                );
                              })
                            }
                          >
                            {busy()
                              ? "Requesting publication…"
                              : `Publish version ${confirmed().version}`}
                          </button>
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={busy()}
                            onClick={() => {
                              setConfirmation(undefined);
                              queueMicrotask(() => versionInput?.focus());
                            }}
                          >
                            Edit version
                          </button>
                        </div>
                      </section>
                    )}
                  </Show>
                </Show>
              </section>
              <section aria-labelledby="release-history-heading">
                <h3 id="release-history-heading">Release history</h3>
                <Show
                  when={data().releases.length}
                  fallback={
                    <p class="release-note">
                      No publications yet. Your first version will appear here.
                    </p>
                  }
                >
                  <ul class="release-list">
                    <For each={data().releases} keyed={(release) => release.id}>
                      {(release) => (
                        <li>
                          <details>
                            <summary>
                              <strong>{release().version}</strong>
                              <span class="release-state" data-state={release().state}>
                                {status(release())}
                              </span>
                              <time datetime={release().publishedAt ?? release().createdAt}>
                                {dateLabel(release().publishedAt ?? release().createdAt)}
                              </time>
                            </summary>
                            <div class="release-history-detail">
                              <Reference
                                value={release().commitSHA}
                                label={`${release().version} commit`}
                              />
                              <p class="release-notes">{release().notes || "No release notes."}</p>
                              <Show when={release().failure}>
                                <p class="release-error">{release().failure}</p>
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
                                    <Reference
                                      value={
                                        artifact.kind === "file"
                                          ? `${data().registryURL}/api/packages/${data().packageOwner}/generic/${artifact.name}/${release().version}/${artifact.filename}`
                                          : `${data().registryURL.replace(/^https?:\/\//, "")}/${data().packageOwner}/${artifact.name}@${artifact.digest}`
                                      }
                                      label={`${artifact.name} reference`}
                                    />
                                    <Show when={artifact.kind === "file"}>
                                      <Reference
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
                                    data().canPublish
                                  }
                                >
                                  <button
                                    type="button"
                                    class="quiet-button"
                                    disabled={busy()}
                                    onClick={() =>
                                      void action(async (current) => {
                                        await serverCall(
                                          reconcileProjectRelease({
                                            data: [props.projectID, release().id],
                                          }),
                                        );
                                        if (current())
                                          setNotice("Outcome checked. No new run was started.");
                                      })
                                    }
                                  >
                                    Check outcome
                                  </button>
                                  <button
                                    type="button"
                                    class="danger-button"
                                    disabled={busy()}
                                    onClick={(event) => {
                                      setEndID(release().id);
                                      focusDecision(event.currentTarget);
                                    }}
                                  >
                                    End attempt
                                  </button>
                                </Show>
                              </div>
                              <Show when={endID() === release().id}>
                                <section
                                  class="release-confirmation"
                                  aria-label="End publication attempt"
                                >
                                  <h4 tabindex="-1">End this attempt?</h4>
                                  <p>
                                    Write access will be revoked and its Sandbox stopped. Existing
                                    publications and external deployments are not rolled back. Use a
                                    new version for another build.
                                  </p>
                                  <div class="release-actions">
                                    <button
                                      type="button"
                                      class="danger-button"
                                      disabled={busy()}
                                      onClick={() =>
                                        void action(async (current) => {
                                          await serverCall(
                                            endProjectPublication({
                                              data: [props.projectID, release().id],
                                            }),
                                          );
                                          if (current()) setEndID(undefined);
                                        })
                                      }
                                    >
                                      Confirm end attempt
                                    </button>
                                    <button
                                      type="button"
                                      class="quiet-button"
                                      disabled={busy()}
                                      onClick={() => setEndID(undefined)}
                                    >
                                      Keep attempt
                                    </button>
                                  </div>
                                </section>
                              </Show>
                            </div>
                          </details>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </Show>
            <Show when={panel() === "access" && data().canManageAccess}>
              <section aria-labelledby="release-access-heading">
                <h3 id="release-access-heading">External access</h3>
                <p>
                  Give an external system read-only access to this Project. Use separate credentials
                  for each consumer. Factory does not check its connection or deployment.
                </p>
                <dl class="release-facts">
                  <dt>Repository</dt>
                  <dd>
                    <Reference value={data().repositoryURL} label="repository URL" />
                  </dd>
                  <dt>Registry</dt>
                  <dd>
                    <Reference
                      value={`${data().registryURL}/${data().packageOwner}`}
                      label="registry URL"
                    />
                  </dd>
                </dl>
                <FreshAuthentication active={props.active} />
                <Show when={!data().configured}>
                  <p>
                    Machine access requires the configured Forgejo administrator and encrypted
                    credential store.
                  </p>
                </Show>
                <Show when={credential()}>
                  {(value) => (
                    <section class="release-confirmation" aria-label="New machine credential">
                      <h4 ref={credentialHeading} tabindex="-1">
                        Save this credential now
                      </h4>
                      <p>
                        This token is shown only once. Put it in the consumer's secret store, not a
                        chat or committed configuration.
                      </p>
                      <div class="release-credential-field">
                        <label>
                          Username
                          <input
                            readonly
                            value={value().username}
                            autocomplete="off"
                            spellcheck={false}
                          />
                        </label>
                        <CopyButton
                          value={value().username}
                          label="Copy"
                          accessibleLabel="Copy username"
                          class="quiet-button"
                        />
                      </div>
                      <Show
                        when={value().token}
                        fallback={
                          <p>
                            The token cannot be shown again. Rotate this access to obtain a new
                            credential.
                          </p>
                        }
                      >
                        {(token) => (
                          <div class="release-credential-field">
                            <label>
                              Access token
                              <input
                                readonly
                                type={reveal() ? "text" : "password"}
                                value={token()}
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </label>
                            <div class="release-actions">
                              <button
                                type="button"
                                class="quiet-button"
                                aria-pressed={reveal() ? "true" : "false"}
                                onClick={() => setReveal(!reveal())}
                              >
                                {reveal() ? "Hide token" : "Show token"}
                              </button>
                              <CopyButton
                                value={token()}
                                label="Copy"
                                accessibleLabel="Copy access token"
                                class="quiet-button"
                              />
                            </div>
                          </div>
                        )}
                      </Show>
                      <p class="release-note">
                        Chart reads and runtime image pulls need credentials in their respective
                        systems. The operator configures both.
                      </p>
                      <button
                        type="button"
                        class="quiet-button"
                        onClick={() => setCredential(undefined)}
                      >
                        Dismiss credential
                      </button>
                    </section>
                  )}
                </Show>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async (current) => {
                      setCredential(undefined);
                      setReveal(false);
                      if (accessCommand?.name !== name() || accessCommand?.scope !== scope())
                        accessCommand = {
                          commandID: crypto.randomUUID(),
                          name: name(),
                          scope: scope(),
                        };
                      const result = await serverCall(
                        createReleaseAccess({ data: [props.projectID, accessCommand] }),
                      );
                      if (!current()) return;
                      accessCommand = undefined;
                      setCredential(result);
                      setName("");
                    });
                  }}
                >
                  <fieldset class="release-fields" disabled={busy() || !data().configured}>
                    <div class="release-access-fields">
                      <label>
                        Access name
                        <input
                          value={name()}
                          onInput={(event) => setName(event.currentTarget.value)}
                          maxlength={100}
                          required
                          placeholder="Production image reader"
                        />
                      </label>
                      <label>
                        Read scope
                        <select
                          value={scope()}
                          onChange={(event) =>
                            setScope(event.currentTarget.value as "git" | "packages")
                          }
                        >
                          <option value="git">Project repository</option>
                          <option value="packages">Project packages</option>
                        </select>
                      </label>
                    </div>
                    <p class="release-note">
                      {scope() === "git"
                        ? "Reads this Project's source, including all branches and history."
                        : "Reads all packages in this Project's private registry namespace."}
                    </p>
                  </fieldset>
                  <button
                    type="submit"
                    class="primary-button"
                    disabled={busy() || !data().configured || !name().trim()}
                  >
                    Create read access
                  </button>
                </form>
              </section>
              <section aria-labelledby="release-readers-heading">
                <h3 id="release-readers-heading">Read credentials</h3>
                <Show
                  when={data().access.length}
                  fallback={
                    <p class="release-note">
                      No external access yet. Create a credential when a consumer needs it.
                    </p>
                  }
                >
                  <ul class="release-list">
                    <For each={data().access} keyed={(grant) => grant.id}>
                      {(grant) => (
                        <li class="release-grant">
                          <div class="release-section-heading">
                            <div>
                              <strong>{grant().name}</strong>
                              <p class="release-note">
                                {grant().scope === "git" ? "Repository read" : "Package read"} ·{" "}
                                {grant().state}
                              </p>
                            </div>
                            <Show when={grant().state !== "revoked"}>
                              <div class="release-actions">
                                <button
                                  type="button"
                                  class="quiet-button"
                                  aria-label={`Rotate ${grant().name}`}
                                  disabled={busy()}
                                  onClick={(event) => {
                                    setRotateID(grant().id);
                                    setRevokeID(undefined);
                                    focusDecision(event.currentTarget);
                                  }}
                                >
                                  Rotate
                                </button>
                                <button
                                  type="button"
                                  class="danger-button"
                                  aria-label={`Revoke ${grant().name}`}
                                  disabled={busy()}
                                  onClick={(event) => {
                                    setRevokeID(grant().id);
                                    setRotateID(undefined);
                                    focusDecision(event.currentTarget);
                                  }}
                                >
                                  Revoke
                                </button>
                              </div>
                            </Show>
                          </div>
                          <Show when={rotateID() === grant().id}>
                            <section
                              class="release-confirmation"
                              aria-label="Rotate read credential"
                            >
                              <h4 tabindex="-1">Rotate {grant().name}?</h4>
                              <p>
                                The old credential stops working immediately. External systems
                                cannot fetch new content until you install the replacement. Already
                                downloaded content remains available.
                              </p>
                              <div class="release-actions">
                                <button
                                  type="button"
                                  class="danger-button"
                                  disabled={busy()}
                                  onClick={() =>
                                    void action(async (current) => {
                                      setCredential(undefined);
                                      setReveal(false);
                                      if (rotationCommand?.id !== grant().id)
                                        rotationCommand = {
                                          id: grant().id,
                                          commandID: crypto.randomUUID(),
                                        };
                                      const result = await serverCall(
                                        rotateReleaseAccess({
                                          data: [
                                            props.projectID,
                                            grant().id,
                                            rotationCommand.commandID,
                                          ],
                                        }),
                                      );
                                      if (!current()) return;
                                      rotationCommand = undefined;
                                      setCredential(result);
                                      setRotateID(undefined);
                                      setNotice(
                                        "Old access revoked. Install the replacement credential in the consumer.",
                                      );
                                    })
                                  }
                                >
                                  Confirm rotation
                                </button>
                                <button
                                  type="button"
                                  class="quiet-button"
                                  disabled={busy()}
                                  onClick={() => setRotateID(undefined)}
                                >
                                  Keep credential
                                </button>
                              </div>
                            </section>
                          </Show>
                          <Show when={revokeID() === grant().id}>
                            <section
                              class="release-confirmation"
                              aria-label="Revoke read credential"
                            >
                              <h4 tabindex="-1">Revoke {grant().name}?</h4>
                              <p>
                                External systems using this credential will no longer be able to
                                fetch source or artifacts. Already downloaded content cannot be
                                recalled.
                              </p>
                              <div class="release-actions">
                                <button
                                  type="button"
                                  class="danger-button"
                                  disabled={busy()}
                                  onClick={() =>
                                    void action(async (current) => {
                                      await serverCall(
                                        revokeReleaseAccess({
                                          data: [props.projectID, grant().id],
                                        }),
                                      );
                                      if (!current()) return;
                                      setRevokeID(undefined);
                                      setNotice(
                                        "Read access revoked. Already downloaded content cannot be recalled.",
                                      );
                                    })
                                  }
                                >
                                  Confirm revocation
                                </button>
                                <button
                                  type="button"
                                  class="quiet-button"
                                  disabled={busy()}
                                  onClick={() => setRevokeID(undefined)}
                                >
                                  Keep access
                                </button>
                              </div>
                            </section>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
