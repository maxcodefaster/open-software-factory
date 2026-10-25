import { createSignal, Show } from "solid-js";
import type { SkillContent } from "../../../../packages/conversation-domain/src/skills";
import { serverCall } from "../server-functions/result";
import { previewSkillImport, previewRepositorySkill } from "../server-functions/skills";

export function SkillImportPanel(props: {
  onPreview: (preview: { content: SkillContent; warnings: string[] }) => void;
  onCancel: () => void;
}) {
  const [source, setSource] = createSignal("file");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [repository, setRepository] = createSignal("");
  const [commit, setCommit] = createSignal("");
  const [path, setPath] = createSignal("");
  async function preview(action: () => Promise<{ content: SkillContent; warnings: string[] }>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      props.onPreview(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview this package");
    } finally {
      setBusy(false);
    }
  }
  async function files(list: FileList | null) {
    if (!list?.length) return;
    await preview(async () => {
      const selected = [...list];
      const root = selected.find((file) => file.name === "SKILL.md");
      if (!root) throw new Error("Choose SKILL.md or a directory containing it");
      const prefix = root.webkitRelativePath
        ? root.webkitRelativePath.slice(0, -"SKILL.md".length)
        : "";
      if (selected.length > 65 || selected.reduce((sum, file) => sum + file.size, 0) > 1_400_000)
        throw new Error("Package is too large. Choose at most 65 files totaling 1.4 MB.");
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
      return serverCall(previewSkillImport({ files }));
    });
  }
  return (
    <section class="skill-import-panel" aria-label="Import a skill">
      <header>
        <h3 tabindex="-1">Import a skill</h3>
        <p>
          Bring your own instructions and resources. Preview the package before saving a private
          copy. Importing never enables or shares it.
        </p>
      </header>
      <label>
        Import source
        <select
          value={source()}
          disabled={busy()}
          onChange={(event) => {
            setSource(event.currentTarget.value);
            setError("");
          }}
        >
          <option value="file">SKILL.md file</option>
          <option value="directory">Skill directory</option>
          <option value="repository">Public GitHub repository</option>
        </select>
      </label>
      <Show when={source() === "file"}>
        <label>
          SKILL.md
          <input
            type="file"
            accept=".md"
            disabled={busy()}
            onChange={(event) => void files(event.currentTarget.files)}
          />
        </label>
      </Show>
      <Show when={source() === "directory"}>
        <p>Choose one complete directory containing SKILL.md and its referenced resources.</p>
        <label>
          Skill directory
          <input
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            disabled={busy()}
            onChange={(event) => void files(event.currentTarget.files)}
          />
        </label>
      </Show>
      <Show when={source() === "repository"}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void preview(() =>
              serverCall(
                previewRepositorySkill({
                  repository: repository(),
                  commit: commit(),
                  path: path(),
                }),
              ),
            );
          }}
        >
          <p>Public GitHub imports require an exact commit, not a moving branch or tag.</p>
          <label>
            Repository URL
            <input
              required
              type="url"
              placeholder="https://github.com/owner/repository"
              disabled={busy()}
              value={repository()}
              onInput={(event) => setRepository(event.currentTarget.value)}
            />
          </label>
          <label>
            Exact commit
            <input
              required
              pattern="[a-f0-9]{40}"
              placeholder="40-character commit SHA"
              disabled={busy()}
              value={commit()}
              onInput={(event) => setCommit(event.currentTarget.value)}
            />
          </label>
          <label>
            Skill path
            <input
              required
              placeholder="skills/my-skill/SKILL.md"
              disabled={busy()}
              value={path()}
              onInput={(event) => setPath(event.currentTarget.value)}
            />
          </label>
          <button class="primary-button" type="submit" disabled={busy()}>
            Preview import
          </button>
        </form>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <p role="status">{busy() ? "Preparing preview…" : ""}</p>
      <button type="button" class="quiet-button" disabled={busy()} onClick={props.onCancel}>
        Back to library
      </button>
    </section>
  );
}
