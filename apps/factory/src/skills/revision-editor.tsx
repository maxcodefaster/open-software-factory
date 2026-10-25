import { createPatch } from "diff";
import { createSignal, For, Show } from "solid-js";
import type {
  SkillLibraryEntry,
  SkillScope,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillContent,
  skillContentInput,
} from "../../../../packages/conversation-domain/src/skills";
import { serverCall } from "../server-functions/result";
import { saveSkill } from "../server-functions/skills";

export function SkillRevisionEditor(props: {
  content: SkillContent;
  entry?: SkillLibraryEntry | undefined;
  scope: SkillScope;
  projectId?: string | undefined;
  canManageProject: boolean;
  canManageSystem: boolean;
  warnings?: string[] | undefined;
  onSaved: (saved: { libraryId: string; revisionId: string; scope: SkillScope }) => void;
  onCancel: () => void;
  onDiscard?: (() => void) | undefined;
}) {
  const [draft, setDraft] = createSignal(structuredClone(props.content));
  const [scope, setScope] = createSignal<SkillScope>(props.entry?.scope ?? props.scope);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [reviewed, setReviewed] = createSignal(!props.warnings?.length);
  let pending:
    | {
        libraryId: string;
        revisionId: string;
        expectedRevision: number;
        scope: SkillScope;
        projectId?: string;
        content: SkillContent;
      }
    | undefined;
  const update = (patch: Partial<SkillContent>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    pending = undefined;
  };
  async function attach(list: FileList | null) {
    if (!list?.length) return;
    try {
      const files = [...(draft().files ?? [])];
      for (const file of list) {
        if (file.size > 700000) throw new Error("Each attachment must be smaller than 700 KB");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let body: string;
        let encoding: "utf8" | "base64" = "utf8";
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          body = btoa(binary);
          encoding = "base64";
        }
        const path = `assets/${file.name.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
        if (files.some((value) => value.path === path))
          throw new Error(`An attachment named ${file.name} already exists`);
        files.push({ path, body, encoding });
      }
      update({ files });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach files");
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || !reviewed()) return;
    const latest = props.entry?.revisions[0];
    const content = skillContentInput.safeParse({
      ...draft(),
      key: props.entry
        ? draft().key
        : draft()
            .name.toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 64) || "custom-skill",
    });
    if (!content.success) {
      setError(content.error.issues[0]?.message ?? "Check the skill");
      return;
    }
    pending ??= {
      libraryId: props.entry?.id ?? crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      expectedRevision: latest?.revision ?? 0,
      scope: scope(),
      ...(props.projectId ? { projectId: props.projectId } : {}),
      content: content.data,
    };
    setBusy(true);
    setError("");
    try {
      const saved = await serverCall(saveSkill(pending));
      props.onSaved({ ...saved, scope: scope() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save skill");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form class="skill-editor" aria-label="Skill editor" onSubmit={(event) => void save(event)}>
      <h3 tabindex="-1">{props.entry ? "Edit skill" : "New skill"}</h3>
      <label>
        Name
        <input
          name="skill-name"
          required
          maxlength={100}
          value={draft().name}
          disabled={busy()}
          onInput={(event) => {
            const name = event.currentTarget.value;
            const key = name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 64);
            update({ name, ...(!props.entry && key.length > 1 ? { key } : {}) });
          }}
        />
      </label>
      <label>
        When to use
        <textarea
          required
          rows={2}
          maxlength={500}
          value={draft().description}
          disabled={busy()}
          onInput={(event) => update({ description: event.currentTarget.value })}
        />
      </label>
      <label>
        Instructions
        <textarea
          required
          rows={9}
          maxlength={24000}
          value={draft().instructions}
          disabled={busy()}
          onInput={(event) => update({ instructions: event.currentTarget.value })}
        />
      </label>
      <label>
        Available to
        <select
          aria-label="Available to"
          value={scope()}
          disabled={busy() || Boolean(props.entry)}
          onChange={(event) => {
            setScope(event.currentTarget.value as SkillScope);
            pending = undefined;
          }}
        >
          <option value="personal">Only me</option>
          <Show when={props.canManageProject && props.projectId}>
            <option value="project">This Project</option>
          </Show>
          <Show when={props.canManageSystem}>
            <option value="system">Everyone in Factory</option>
          </Show>
        </select>
      </label>
      <p class="model-settings-note">
        Saving creates an exact version. Enable it for new work after saving. A personal version
        used in shared Project work becomes inspectable by collaborators.
      </p>
      <details>
        <summary>Files, source &amp; options</summary>
        <label>
          Invocation name
          <input
            value={draft().key}
            disabled={busy()}
            onInput={(event) => update({ key: event.currentTarget.value })}
          />
        </label>
        <Show when={props.entry?.revisions[0]}>
          {(saved) => (
            <details>
              <summary>Compare with saved version</summary>
              <pre>
                {createPatch(
                  draft().key,
                  JSON.stringify(saved().content, null, 2),
                  JSON.stringify(draft(), null, 2),
                ).slice(0, 50000)}
              </pre>
            </details>
          )}
        </Show>
        <fieldset class="skill-roles">
          <legend>Available in</legend>
          <For each={["planning", "build"] as const}>
            {(role) => (
              <label class="model-checkbox">
                <input
                  type="checkbox"
                  checked={draft().roles.includes(role)}
                  disabled={busy()}
                  onChange={(event) =>
                    update({
                      roles: event.currentTarget.checked
                        ? [...draft().roles, role]
                        : draft().roles.filter((value) => value !== role),
                    })
                  }
                />
                {role === "planning" ? "Investigate & Plan" : "Build"}
              </label>
            )}
          </For>
        </fieldset>
        <label class="model-checkbox">
          <input
            type="checkbox"
            checked={draft().manualOnly ?? false}
            onChange={(event) => update({ manualOnly: event.currentTarget.checked })}
          />
          Only load when I invoke /{draft().key}
        </label>
        <For each={draft().references} keyed={false}>
          {(file, index) => (
            <label>
              {file().path}
              <textarea
                rows={4}
                value={file().body}
                onInput={(event) => {
                  const body = event.currentTarget.value;
                  update({
                    references: draft().references.map((value, current) =>
                      current === index ? { ...value, body } : value,
                    ),
                  });
                }}
              />
            </label>
          )}
        </For>
        <button
          type="button"
          class="quiet-button"
          disabled={busy() || draft().references.length >= 8}
          onClick={() =>
            update({
              references: [
                ...draft().references,
                { path: `references/note-${draft().references.length + 1}.md`, body: "" },
              ],
            })
          }
        >
          Add reference
        </button>
        <label>
          Attach files
          <input
            type="file"
            multiple
            disabled={busy()}
            onChange={(event) => void attach(event.currentTarget.files)}
          />
        </label>
        <p>{draft().files?.length ?? 0} package files</p>
        <For each={draft().files}>
          {(file) => (
            <div class="skill-file">
              <code>{file.path}</code>
              <small>
                {file.encoding === "base64"
                  ? "Binary asset"
                  : file.executable
                    ? "Executable resource"
                    : "Text resource"}
              </small>
              <button
                type="button"
                class="quiet-button"
                disabled={busy()}
                onClick={() =>
                  update({ files: draft().files?.filter((value) => value.path !== file.path) })
                }
              >
                Remove {file.path}
              </button>
            </div>
          )}
        </For>
        <Show when={draft().origin}>
          {(origin) => (
            <p class="model-settings-note">
              Imported from{" "}
              <a href={origin().repository} target="_blank" rel="noopener noreferrer">
                {origin().repository}
              </a>
              , commit <code>{origin().commit}</code>. {origin().licence}.
            </p>
          )}
        </Show>
        <Show when={draft().review}>
          <p class="model-settings-note">{draft().review?.adaptations}</p>
        </Show>
        <Show when={draft().sourceSkill}>
          <details>
            <summary>Original SKILL.md</summary>
            <pre>{draft().sourceSkill}</pre>
          </details>
        </Show>
      </details>
      <Show when={props.warnings?.length}>
        <div class="skill-import-warnings">
          <For each={props.warnings}>{(warning) => <p>{warning}</p>}</For>
          <label class="model-checkbox">
            <input
              type="checkbox"
              checked={reviewed()}
              onChange={(event) => setReviewed(event.currentTarget.checked)}
            />
            I reviewed these compatibility and source details
          </label>
        </div>
      </Show>
      <p role="alert">{error()}</p>
      <footer class="model-settings-actions">
        <button type="button" class="quiet-button" disabled={busy()} onClick={props.onCancel}>
          Back to library
        </button>
        <Show when={props.onDiscard}>
          <button type="button" class="quiet-button" disabled={busy()} onClick={props.onDiscard}>
            Discard draft
          </button>
        </Show>
        <button type="submit" class="primary-button" disabled={busy() || !reviewed()}>
          {busy() ? "Saving…" : "Save skill"}
        </button>
      </footer>
    </form>
  );
}
