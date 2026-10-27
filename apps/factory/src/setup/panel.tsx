import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  type ProjectSetupFields,
  type ProjectSetupView,
  projectSetupFields,
} from "../../../../packages/project-domain/src/setup";
import { Icon } from "../icon";
import { serverCall } from "../server-functions/result";
import {
  beginSetupDraft,
  checkSetupProject,
  createSetupProject,
  getSetupDraft,
  retrySetupProject,
  saveSetupDraft,
} from "../server-functions/setup";
import "./setup.css";
import { SetupInspection } from "./inspection-panel";
import { SetupReadiness } from "./readiness-panel";

export function createProjectSetupInteraction(userID: string, openPanel: () => void) {
  const [draft, setDraft] = createSignal<ProjectSetupView>();
  const [visible, setVisible] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  const visibilityKey = `project-setup:${userID}:visible`;
  let navigation = 0;
  function show(value: boolean) {
    setVisible(value);
    try {
      sessionStorage.setItem(visibilityKey, String(value));
    } catch {
      /* Server draft remains retained. */
    }
    if (value) openPanel();
  }
  async function action(work: () => Promise<ProjectSetupView | null>) {
    if (pending()) return;
    setPending(true);
    setError("");
    const admittedNavigation = navigation;
    try {
      const value = await work();
      if (value && navigation === admittedNavigation) setDraft(value);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Setup is unavailable. Your draft is retained.",
      );
    } finally {
      setPending(false);
    }
  }
  createEffect(
    () => undefined,
    () => {
      const loadedNavigation = navigation;
      void serverCall(getSetupDraft({ data: [] }))
        .then((value) => {
          if (loadedNavigation !== navigation) return;
          if (value) setDraft(value);
          try {
            if (value && sessionStorage.getItem(visibilityKey) === "true") show(true);
          } catch {
            /* Navigation remains usable. */
          }
        })
        .catch(() => {
          /* Opening setup exposes a retryable error. */
        });
    },
  );
  createEffect(
    () => [visible(), draft()?.id, draft()?.state] as const,
    ([shown, setupID, state]) => {
      if (!shown || !setupID || !["creating", "checking"].includes(state ?? "")) return;
      const admittedNavigation = navigation;
      const abort = new AbortController();
      let disposed = false;
      let timer: ReturnType<typeof setTimeout>;
      const observe = async () => {
        try {
          const value = await serverCall(getSetupDraft({ ...{ signal: abort.signal }, data: [] }));
          if (
            !disposed &&
            navigation === admittedNavigation &&
            draft()?.id === setupID &&
            value?.id === setupID
          )
            setDraft(value);
        } catch {
          // Status reads neither repeat creation nor discard the retained draft.
        } finally {
          if (!disposed) timer = setTimeout(() => void observe(), 2_000);
        }
      };
      timer = setTimeout(() => void observe(), 2_000);
      return () => {
        disposed = true;
        clearTimeout(timer);
        abort.abort();
      };
    },
  );
  async function open() {
    show(true);
    if (pending()) return;
    navigation++;
    commandID = undefined;
    await action(() => serverCall(beginSetupDraft({ data: [] })));
  }
  async function save(fields: ProjectSetupFields, setupID: string) {
    const value = draft();
    if (!value || value.id !== setupID || value.state !== "draft")
      throw new Error("This setup has changed. Your draft is retained locally.");
    const next = await serverCall(
      saveSetupDraft({ data: [{ id: value.id, version: value.version, ...fields }] }),
    );
    if (draft()?.id === next.id) setDraft(next);
  }
  let commandID: string | undefined;
  async function create(token: string | undefined) {
    const value = draft();
    if (!value) return;
    const submittedCommandID = value.commandID ?? commandID ?? crypto.randomUUID();
    commandID = submittedCommandID;
    await action(() =>
      serverCall(
        createSetupProject({
          data: [
            {
              id: value.id,
              version: value.version,
              commandID: submittedCommandID,
              ...(token ? { importToken: token } : {}),
            },
          ],
        }),
      ),
    );
  }
  async function check() {
    const value = draft();
    if (value)
      await action(() =>
        serverCall(
          value.state === "failed"
            ? retrySetupProject({ data: [value.id] })
            : checkSetupProject({ data: [value.id] }),
        ),
      );
  }
  return {
    draft,
    visible,
    pending,
    error,
    setError,
    open,
    save,
    create,
    check,
    show,
    draftStorageKey: `project-setup:${userID}:draft`,
  };
}

export function ProjectSetupPanel(props: {
  setup: ReturnType<typeof createProjectSetupInteraction>;
  onSettings(): void;
  onProject(projectID: string): void;
}) {
  // The controller outlives this panel. Cleanup must not read a <Show> accessor
  // after navigation has removed the panel that supplied it.
  const setup = props.setup;
  const [fields, setFields] = createSignal<ProjectSetupFields>({
    name: "",
    slug: "",
    kind: "starter",
    sourceURL: "",
  });
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(true);
  let tokenInput: HTMLInputElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saveChain = Promise.resolve();
  let loadedDraftID: string | undefined;
  createEffect(
    () => props.setup.draft()?.id,
    () => {
      const draft = props.setup.draft();
      if (draft) {
        if (loadedDraftID === draft.id) return;
        loadedDraftID = draft.id;
        const serverFields = projectSetupFields.parse({
          name: draft.name,
          slug: draft.slug,
          kind: draft.kind,
          sourceURL: draft.sourceURL,
        });
        setFields(serverFields);
        setSaved(true);
        try {
          const retained = JSON.parse(localStorage.getItem(props.setup.draftStorageKey) ?? "null");
          const parsed = projectSetupFields.safeParse(retained?.fields);
          if (draft.state === "draft" && retained?.id === draft.id && parsed.success) {
            setFields(parsed.data);
            setSaved(JSON.stringify(parsed.data) === JSON.stringify(serverFields));
            if (
              retained.version !== draft.version &&
              JSON.stringify(retained.baseFields) !== JSON.stringify(serverFields) &&
              JSON.stringify(parsed.data) !== JSON.stringify(serverFields)
            )
              props.setup.setError(
                "This setup was edited elsewhere. Your local draft is retained; review it before creating the project.",
              );
          }
        } catch {
          /* Server draft remains available. */
        }
      }
    },
  );
  function flush() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const value = fields();
    const target = setup.draft();
    if (!target) return saveChain;
    if (saved()) return saveChain;
    setSaving(true);
    saveChain = saveChain
      .then(() => setup.save(value, target.id))
      .then(() => {
        if (setup.draft()?.id === target.id && JSON.stringify(value) === JSON.stringify(fields())) {
          setSaved(true);
          try {
            localStorage.removeItem(setup.draftStorageKey);
          } catch {
            /* Optional local storage. */
          }
        } else remember();
      })
      .catch((error: unknown) => {
        setup.setError(error instanceof Error ? error.message : "Draft could not be saved.");
      })
      .finally(() => {
        setSaving(false);
      });
    return saveChain;
  }
  function update(change: Partial<ProjectSetupFields>) {
    if (props.setup.pending()) return;
    const next = { ...fields(), ...change };
    setFields(next);
    setSaved(false);
    remember(next);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 500);
  }
  function remember(value = fields()) {
    const draft = setup.draft();
    if (draft?.state !== "draft") return;
    // Persist only validated nonsecret fields, never the token DOM input or a
    // pasted URL containing credentials. Partial URLs are not retained.
    const parsed = projectSetupFields.safeParse(value);
    if (!parsed.success) return;
    try {
      localStorage.setItem(
        setup.draftStorageKey,
        JSON.stringify({
          id: draft.id,
          version: draft.version,
          baseFields: {
            name: draft.name,
            slug: draft.slug,
            kind: draft.kind,
            sourceURL: draft.sourceURL,
          },
          fields: parsed.data,
        }),
      );
    } catch {
      /* Autosave still uses the server draft. */
    }
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer);
    void flush();
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await flush();
    if (!saved()) return;
    await props.setup.create(tokenInput?.value || undefined);
    if (props.setup.draft()?.commandID && tokenInput) tokenInput.value = "";
  }
  return (
    <section class="project-setup-panel" aria-label="Project setup">
      <div class="setup-introduction">
        <h2>
          {props.setup.draft()?.state === "created"
            ? props.setup.draft()?.name
            : "Create a project"}
        </h2>
        <Show when={props.setup.draft()?.state !== "created"}>
          <p>Start from a ready-to-use app or bring your existing Git history into Factory.</p>
        </Show>
      </div>
      <Show when={props.setup.error()}>
        <p class="form-error" role="alert">
          {props.setup.error()}
        </p>
      </Show>
      <Show when={props.setup.draft()} fallback={<p role="status">Opening your setup…</p>}>
        {(draft) => (
          <>
            <Show when={draft().state === "draft"}>
              <form class="setup-form" onSubmit={submit}>
                <fieldset
                  class="setup-choice"
                  aria-label="Project source"
                  disabled={props.setup.pending()}
                >
                  <For
                    each={[
                      {
                        kind: "starter" as const,
                        label: "Starter",
                        detail: "Solid · PostgreSQL · authentication",
                      },
                      {
                        kind: "import" as const,
                        label: "Import Git",
                        detail: "Complete history, one-time transfer",
                      },
                    ]}
                  >
                    {(choice) => (
                      <button
                        type="button"
                        aria-pressed={fields().kind === choice.kind ? "true" : "false"}
                        onClick={() => update({ kind: choice.kind })}
                      >
                        <strong>{choice.label}</strong>
                        <span>{choice.detail}</span>
                      </button>
                    )}
                  </For>
                </fieldset>
                <label>
                  Project name
                  <input
                    disabled={props.setup.pending()}
                    required
                    maxlength={200}
                    value={fields().name}
                    onInput={(event) => {
                      const name = event.currentTarget.value;
                      const prior = fields();
                      update({
                        name,
                        ...(!prior.slug ||
                        prior.slug ===
                          prior.name
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, "-")
                            .replace(/^-|-$/g, "")
                          ? {
                              slug: name
                                .toLowerCase()
                                .replace(/[^a-z0-9]+/g, "-")
                                .replace(/^-|-$/g, "")
                                .slice(0, 63),
                            }
                          : {}),
                      });
                    }}
                  />
                </label>
                <label>
                  Repository name
                  <input
                    disabled={props.setup.pending()}
                    required
                    pattern="[a-z][a-z0-9-]{1,62}"
                    value={fields().slug}
                    onInput={(event) => update({ slug: event.currentTarget.value })}
                  />
                </label>
                <Show when={fields().kind === "import"}>
                  <label>
                    Git URL
                    <input
                      disabled={props.setup.pending()}
                      required
                      type="url"
                      placeholder="https://github.com/team/project.git"
                      value={fields().sourceURL}
                      onInput={(event) => update({ sourceURL: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    Access token{" "}
                    <span class="setup-optional">optional for private repositories</span>
                    <input
                      type="password"
                      autocomplete="off"
                      ref={tokenInput}
                      disabled={props.setup.pending()}
                    />
                  </label>
                  <p class="setup-note">
                    The original repository is not synchronized. The temporary token is protected
                    and removed after import.
                  </p>
                </Show>
                <Show when={fields().kind === "starter"}>
                  <p class="setup-note">
                    A working sign-up, login and empty protected home. No demo features to remove.
                  </p>
                </Show>
                <div class="setup-submit">
                  <span role="status">
                    {saving() ? "Saving draft…" : saved() ? "Draft retained" : "Unsaved changes"}
                  </span>
                  <button
                    class="primary-button"
                    type="submit"
                    disabled={props.setup.pending() || saving()}
                  >
                    {fields().kind === "starter" ? "Create project" : "Import project"}
                  </button>
                </div>
              </form>
            </Show>
            <Show when={draft().state !== "draft"}>
              <div class="setup-progress" aria-live="polite">
                <Show when={draft().state !== "created"}>
                  <strong>
                    {draft().state === "creating"
                      ? "Creating your repository…"
                      : "Repository setup"}
                  </strong>
                </Show>
                <Show when={draft().failure}>
                  <p>{draft().failure}</p>
                </Show>
                <Show when={draft().state === "created" && draft().projectID}>
                  {(id) => (
                    <>
                      <Show when={draft().kind === "import"}>
                        <SetupInspection
                          projectID={id()}
                          storageKey={`${props.setup.draftStorageKey}:answers:${id()}`}
                        />
                      </Show>
                      <SetupReadiness projectID={id()} />
                    </>
                  )}
                </Show>
                <Show when={draft().state !== "created"}>
                  <button
                    class="quiet-button"
                    type="button"
                    disabled={props.setup.pending()}
                    onClick={() => void props.setup.check()}
                  >
                    {draft().state === "failed" ? "Retry setup" : "Check setup"}
                  </button>
                </Show>
                <Show when={draft().projectID}>
                  {(id) => (
                    <button
                      class="quiet-button"
                      type="button"
                      onClick={() => props.onProject(id())}
                    >
                      Open project
                    </button>
                  )}
                </Show>
              </div>
            </Show>
            <button
              class="setup-settings-link"
              type="button"
              onClick={() => {
                void flush();
                props.onSettings();
              }}
            >
              <Icon name="settings" /> Models and protected settings
            </button>
          </>
        )}
      </Show>
    </section>
  );
}

export function SetupEmptyBoard() {
  return (
    <section class="setup-empty-board" aria-label="Empty project board">
      <For each={["Ideas", "Requirements", "Implementation", "Review"]}>
        {(label) => (
          <section>
            <h2>{label}</h2>
          </section>
        )}
      </For>
    </section>
  );
}
