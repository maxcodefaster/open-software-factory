import { createPatch } from "diff";
import { createEffect, createSignal, For, Show } from "solid-js";
import { z } from "zod";
import {
  resolveLibraryChoice,
  type SkillLibraryEntry,
  type SkillLibraryView,
  type SkillScope,
  skillLibraryView,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillContent,
  type SkillRevision,
  type SkillRole,
  skillContentInput,
  skillRevisionInput,
} from "../../../../packages/conversation-domain/src/skills";
import { apiRequest } from "../api-client";
import { SkillRevisionDetails } from "./revision-details";
import { SkillRevisionEditor } from "./revision-editor";
import "./library.css";

const resultInput = z.object({ content: skillContentInput, warnings: z.array(z.string()) });
const savedInput = z.object({ saved: z.boolean() });
export function SkillLibrary(props: {
  scope: SkillScope;
  projectId?: string | undefined;
  active?: boolean | undefined;
}) {
  const [view, setView] = createSignal<SkillLibraryView>();
  const [query, setQuery] = createSignal("");
  const [role, setRole] = createSignal<SkillRole>("planning");
  const [editing, setEditing] = createSignal<{
    content: SkillContent;
    entry?: SkillLibraryEntry;
    warnings?: string[];
  }>();
  const [inspected, setInspected] = createSignal<SkillRevision>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [repository, setRepository] = createSignal("");
  const [commit, setCommit] = createSignal("");
  const [path, setPath] = createSignal("");
  const [shareTarget, setShareTarget] = createSignal<"project" | "system">(
    props.projectId ? "project" : "system",
  );
  const suffix = () => (props.projectId ? `?project=${props.projectId}` : "");
  let sequence = 0;
  async function load() {
    const request = ++sequence;
    try {
      const next = await apiRequest(skillLibraryView, `/api/skills${suffix()}`);
      if (request === sequence) setView(next);
    } catch (cause) {
      if (request === sequence)
        setError(cause instanceof Error ? cause.message : "Could not load library");
    }
  }
  createEffect(
    () => [props.projectId, props.scope, props.active] as const,
    () => {
      if (props.active !== false) {
        void load();
      }
      return () => {
        sequence++;
      };
    },
  );
  const canEditScope = () =>
    props.scope === "personal" ||
    (props.scope === "system" ? view()?.canManageSystem : view()?.canManageProject);
  const entries = () =>
    view()?.entries.filter(
      (entry) =>
        (props.scope === "personal" ||
          entry.scope === "system" ||
          (props.scope === "project" && entry.scope === "project")) &&
        entry.revisions[0] &&
        `${entry.revisions[0].content.name} ${entry.revisions[0].content.description}`
          .toLowerCase()
          .includes(query().toLowerCase()),
    ) ?? [];
  const ownChoice = (entry: SkillLibraryEntry) =>
    view()?.choices.find(
      (choice) =>
        choice.libraryId === entry.id && choice.role === role() && choice.scope === props.scope,
    );
  const effective = (entry: SkillLibraryEntry) =>
    resolveLibraryChoice(
      (view()?.choices ?? [])
        .filter((choice) => props.scope === "personal" || choice.scope !== "personal")
        .filter((choice) => props.scope !== "system" || choice.scope === "system"),
      entry.id,
      role(),
    );
  const inheritedRequired = (entry: SkillLibraryEntry) =>
    resolveLibraryChoice(
      (view()?.choices ?? []).filter(
        (choice) =>
          choice.scope !== props.scope && (props.scope === "personal" || choice.scope === "system"),
      ),
      entry.id,
      role(),
    )?.state === "required";
  async function mutate(action: () => Promise<unknown>, message: string) {
    if (busy()) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await action();
      await load();
      setStatus(typeof result === "string" ? result : message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save skill choices");
    } finally {
      setBusy(false);
    }
  }
  function choose(
    entry: SkillLibraryEntry,
    state: "inherit" | "enable" | "disable" | "required",
    revisionId?: string,
  ) {
    void mutate(
      () =>
        apiRequest(savedInput, "/api/skills/choices", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            libraryId: entry.id,
            scope: props.scope,
            ...(props.projectId ? { projectId: props.projectId } : {}),
            role: role(),
            state,
            revisionId:
              revisionId ??
              ownChoice(entry)?.revisionId ??
              effective(entry)?.revisionId ??
              entry.revisions[0]?.id,
            expectedVersion: ownChoice(entry)?.version ?? 0,
          }),
        }),
      "Choice saved for new work",
    );
  }
  function checkSource(entry: SkillLibraryEntry) {
    void mutate(async () => {
      const revision = entry.revisions[0];
      if (!revision) return;
      const result = await apiRequest(
        z.discriminatedUnion("current", [
          z.object({ current: z.literal(true) }),
          resultInput.extend({ current: z.literal(false) }),
        ]),
        `/api/skills/revisions/${revision.id}/source-update${suffix()}`,
      );
      if (result.current) {
        return "The pinned source is current";
      }
      setEditing({
        entry,
        content: { ...result.content, key: revision.content.key, name: revision.content.name },
        warnings: [
          ...result.warnings,
          "A newer pinned source is available. Compare it with this saved version. Factory adaptations and your edits are not merged automatically.",
        ],
      });
    }, "Source check complete");
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length || busy()) return;
    setBusy(true);
    setError("");
    try {
      const selected = [...list];
      const root = selected.find((file) => file.name === "SKILL.md");
      if (!root) throw new Error("Choose SKILL.md or a directory containing it");
      const prefix = root.webkitRelativePath
        ? root.webkitRelativePath.slice(0, -"SKILL.md".length)
        : "";
      if (selected.length > 65 || selected.reduce((sum, file) => sum + file.size, 0) > 1_400_000)
        throw new Error("Package is too large");
      const files = [];
      for (const file of selected) {
        const relative = file.webkitRelativePath || file.name;
        if (prefix && !relative.startsWith(prefix))
          throw new Error("Select one complete skill directory");
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
        files.push({ path: relative.slice(prefix.length), body, encoding });
      }
      const preview = await apiRequest(resultInput, "/api/skills/import/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files }),
      });
      setEditing(preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview import");
    } finally {
      setBusy(false);
    }
  }
  async function importRepository(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      setEditing(
        await apiRequest(resultInput, "/api/skills/import/repository", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repository: repository(), commit: commit(), path: path() }),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview repository");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="model-settings-body skill-library">
      <Show
        when={editing()}
        fallback={
          <>
            <p class="model-settings-note">
              A shared library for this instance, with choices for each Project. Enabled skills load
              when relevant. Existing Changes keep their original versions. Personal versions used
              in shared Project work can be inspected by collaborators.
            </p>
            <div class="skill-library-toolbar">
              <label>
                Search skills
                <input
                  type="search"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
              <Show when={canEditScope()}>
                <button
                  type="button"
                  class="primary-button"
                  disabled={busy()}
                  onClick={() =>
                    setEditing({
                      content: {
                        key: "custom-skill",
                        name: "",
                        description: "",
                        instructions: "",
                        roles: ["planning", "build"],
                        references: [],
                      },
                    })
                  }
                >
                  New skill
                </button>
              </Show>
            </div>
            <Show when={canEditScope()}>
              <details class="skill-library-import">
                <summary>Import a skill</summary>
                <p>
                  Preview a SKILL.md or its complete directory before installing. Public GitHub
                  imports require an exact commit.
                </p>
                <label>
                  SKILL.md
                  <input
                    type="file"
                    accept=".md"
                    disabled={busy()}
                    onChange={(event) => void importFiles(event.currentTarget.files)}
                  />
                </label>
                <label>
                  Skill directory
                  <input
                    type="file"
                    multiple
                    {...{ webkitdirectory: "" }}
                    disabled={busy()}
                    onChange={(event) => void importFiles(event.currentTarget.files)}
                  />
                </label>
                <form onSubmit={(event) => void importRepository(event)}>
                  <label>
                    Repository URL
                    <input
                      required
                      type="url"
                      placeholder="https://github.com/owner/repository"
                      value={repository()}
                      onInput={(event) => setRepository(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Exact commit
                    <input
                      required
                      pattern="[a-f0-9]{40}"
                      value={commit()}
                      onInput={(event) => setCommit(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Skill path
                    <input
                      required
                      placeholder="skills/my-skill/SKILL.md"
                      value={path()}
                      onInput={(event) => setPath(event.currentTarget.value)}
                    />
                  </label>
                  <button class="quiet-button" type="submit" disabled={busy()}>
                    Preview import
                  </button>
                </form>
              </details>
            </Show>
            <div class="skill-library-role">
              <label>
                Choices for
                <select
                  value={role()}
                  onChange={(event) => setRole(event.currentTarget.value as SkillRole)}
                >
                  <option value="planning">Investigate &amp; Plan</option>
                  <option value="build">Build</option>
                </select>
              </label>
              <Show when={props.scope === "personal" && !props.projectId}>
                <p>
                  Select a Project to enable skills. Your personal library is available across
                  Projects.
                </p>
              </Show>
            </div>
            <For each={entries()}>
              {(entry) => {
                const latest = () => entry.revisions[0];
                const choice = () => effective(entry);
                const current = () =>
                  entry.revisions.find((revision) => revision.id === choice()?.revisionId);
                const locked = () => inheritedRequired(entry);
                const updateAvailable = () => current() && current()?.id !== latest()?.id;
                return (
                  <article class="skill-card" aria-label={latest()?.content.name}>
                    <div class="skill-card-heading">
                      <div>
                        <strong>{latest()?.content.name}</strong>
                        <p>{latest()?.content.description}</p>
                      </div>
                      <small>
                        {entry.scope === "personal"
                          ? "Only me"
                          : entry.scope === "project"
                            ? "Project"
                            : "Factory"}{" "}
                        · v{current()?.revision ?? latest()?.revision}
                      </small>
                    </div>
                    <div class="skill-library-controls">
                      <Show
                        when={(current() ?? latest())?.content.roles.includes(role())}
                        fallback={
                          <small>
                            {(current() ?? latest())?.content.roles.includes("build")
                              ? "Build only"
                              : "Investigate & Plan only"}
                          </small>
                        }
                      >
                        <label>
                          {locked()
                            ? `Required by ${choice()?.scope === "system" ? "Factory" : "Project"}`
                            : "Use in new work"}
                          <select
                            aria-label={`${latest()?.content.name} choice`}
                            disabled={
                              busy() ||
                              !canEditScope() ||
                              locked() ||
                              (props.scope !== "system" && !props.projectId)
                            }
                            value={ownChoice(entry)?.state ?? "inherit"}
                            onChange={(event) =>
                              choose(
                                entry,
                                event.currentTarget.value as
                                  | "inherit"
                                  | "enable"
                                  | "disable"
                                  | "required",
                              )
                            }
                          >
                            <option value="inherit">
                              Inherit
                              {choice()
                                ? ` (${choice()?.state === "disable" ? "off" : "on"})`
                                : " (off)"}
                            </option>
                            <option value="enable">Enable</option>
                            <option value="disable">Disable</option>
                            <Show when={props.scope !== "personal"}>
                              <option value="required">Required</option>
                            </Show>
                          </select>
                        </label>
                      </Show>
                      <small>
                        /{latest()?.content.key}
                        {latest()?.content.manualOnly ? " · Manual only" : ""}
                      </small>
                      <Show when={entry.editable && entry.scope === props.scope}>
                        <button
                          type="button"
                          class="quiet-button"
                          onClick={() => {
                            const revision = latest();
                            if (revision) setEditing({ content: revision.content, entry });
                          }}
                        >
                          Edit
                        </button>
                      </Show>
                      <Show when={entry.scope === "personal" && props.scope === "personal"}>
                        <label>
                          Share with
                          <select
                            aria-label={`${latest()?.content.name} sharing scope`}
                            value={shareTarget()}
                            onChange={(event) =>
                              setShareTarget(event.currentTarget.value as "project" | "system")
                            }
                          >
                            <Show when={props.projectId}>
                              <option value="project">Project</option>
                            </Show>
                            <option value="system">Factory</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          class="quiet-button"
                          disabled={busy() || (shareTarget() === "project" && !props.projectId)}
                          onClick={() =>
                            void mutate(
                              () =>
                                apiRequest(z.object({ id: z.uuid() }), "/api/skills/share", {
                                  method: "POST",
                                  headers: { "content-type": "application/json" },
                                  body: JSON.stringify({
                                    id: crypto.randomUUID(),
                                    revisionId: latest()?.id,
                                    target: shareTarget(),
                                    ...(shareTarget() === "project"
                                      ? { projectId: props.projectId }
                                      : {}),
                                  }),
                                }),
                              "Exact version proposed for sharing",
                            )
                          }
                        >
                          Propose sharing
                        </button>
                      </Show>
                    </div>
                    <Show when={updateAvailable()}>
                      <details class="skill-update">
                        <summary>Update available · v{latest()?.revision}</summary>
                        <p>Review the changed package, then adopt this version for new work.</p>
                        <pre>
                          {createPatch(
                            latest()?.content.key ?? "skill",
                            JSON.stringify(current()?.content, null, 2),
                            JSON.stringify(latest()?.content, null, 2),
                            `v${current()?.revision}`,
                            `v${latest()?.revision}`,
                          )}
                        </pre>
                        <button
                          type="button"
                          class="quiet-button"
                          disabled={
                            busy() ||
                            locked() ||
                            !canEditScope() ||
                            !latest()?.content.roles.includes(role())
                          }
                          onClick={() =>
                            choose(
                              entry,
                              ownChoice(entry)?.state === "required" ? "required" : "enable",
                              latest()?.id,
                            )
                          }
                        >
                          Use this version
                        </button>
                      </details>
                    </Show>
                    <Show when={current() ?? latest()}>
                      {(revision) => (
                        <SkillRevisionDetails
                          revision={revision()}
                          onCheckUpdate={
                            entry.editable && entry.scope === props.scope
                              ? () => checkSource(entry)
                              : undefined
                          }
                          busy={busy()}
                        />
                      )}
                    </Show>
                  </article>
                );
              }}
            </For>
            <Show when={view() && !entries().length}>
              <p>No matching skills.</p>
            </Show>
            <For each={view()?.proposals}>
              {(proposal) => (
                <article class="skill-card">
                  <strong>{proposal.name}</strong>
                  <p>
                    Exact version proposed for{" "}
                    {proposal.target === "system" ? "Factory" : "this Project"}.
                  </p>
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() =>
                      void mutate(async () => {
                        setInspected(
                          await apiRequest(
                            skillRevisionInput,
                            `/api/skills/revisions/${proposal.revisionId}${suffix()}`,
                          ),
                        );
                      }, "Proposal opened")
                    }
                  >
                    Inspect proposed version
                  </button>
                  <Show
                    when={
                      proposal.target === "system"
                        ? view()?.canManageSystem
                        : view()?.canManageProject
                    }
                  >
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={busy() || inspected()?.id !== proposal.revisionId}
                      onClick={() =>
                        void mutate(
                          () =>
                            apiRequest(
                              z.object({ libraryId: z.uuid() }),
                              `/api/skills/share/${proposal.id}/accept`,
                              { method: "POST" },
                            ),
                          "Version added to the shared library. Enable it for new work.",
                        )
                      }
                    >
                      Add to shared library
                    </button>
                  </Show>
                </article>
              )}
            </For>
            <Show when={view()?.sharedVersions.length}>
              <details>
                <summary>Versions used in shared work</summary>
                <p>
                  These exact personal versions were admitted to this Project. Their authors' other
                  versions remain private.
                </p>
                <For each={view()?.sharedVersions}>
                  {(revision) => (
                    <article class="skill-card">
                      <strong>
                        {revision.content.name} · v{revision.revision}
                      </strong>
                      <SkillRevisionDetails revision={revision} />
                    </article>
                  )}
                </For>
              </details>
            </Show>
            <Show when={inspected()}>
              {(revision) => <SkillRevisionDetails revision={revision()} />}
            </Show>
          </>
        }
      >
        {(editor) => (
          <SkillRevisionEditor
            content={editor().content}
            entry={editor().entry}
            warnings={editor().warnings}
            scope={props.scope}
            projectId={props.projectId}
            canManageProject={view()?.canManageProject ?? false}
            canManageSystem={view()?.canManageSystem ?? false}
            onCancel={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              setStatus("Skill saved. Choose where to enable it.");
              void load();
            }}
          />
        )}
      </Show>
      <p role="status">{busy() ? "Saving…" : status()}</p>
      <Show when={error()}>
        <p role="alert">{error()}</p>
        <button
          type="button"
          class="quiet-button"
          onClick={() => {
            setError("");
            void load();
          }}
        >
          Reload library
        </button>
      </Show>
    </div>
  );
}
