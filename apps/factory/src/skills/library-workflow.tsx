import { Show } from "solid-js";
import type { SkillScope } from "#conversation-domain/skill-library";
import { SkillImportPanel } from "./import-panel";
import type { SkillEditorDraft } from "./library-state";
import { SkillRevisionEditor } from "./revision-editor";

export function SkillLibraryWorkflowScreens(props: {
  editorOpen: boolean;
  importing: boolean;
  draft: SkillEditorDraft | undefined;
  projectId: string | undefined;
  canManageProject: boolean;
  canManageSystem: boolean;
  onCancelEditor: () => void;
  onDiscardDraft: () => void;
  onSaved: (saved: { libraryId: string; revisionId: string; scope: SkillScope }) => void;
  onCancelImport: () => void;
  onImportPreview: (preview: SkillEditorDraft) => void;
}) {
  return (
    <>
      <div class="skill-editor-screen" hidden={!props.editorOpen}>
        <Show keyed when={props.draft}>
          {(editor) => (
            <SkillRevisionEditor
              content={editor.content}
              entry={editor.entry}
              warnings={editor.warnings}
              scope="personal"
              projectId={props.projectId}
              canManageProject={props.canManageProject}
              canManageSystem={props.canManageSystem}
              onCancel={props.onCancelEditor}
              onDiscard={props.onDiscardDraft}
              onSaved={props.onSaved}
            />
          )}
        </Show>
      </div>
      <div class="skill-editor-screen" hidden={!props.importing}>
        <SkillImportPanel onCancel={props.onCancelImport} onPreview={props.onImportPreview} />
      </div>
    </>
  );
}

export function SkillLibraryFeedback(props: {
  statusText: string;
  error: string;
  disabled: boolean;
  onReload: () => void;
}) {
  return (
    <>
      <p role="status" class="skill-library-status">
        {props.statusText}
      </p>
      <Show when={props.error}>
        <div class="skill-library-error">
          <p role="alert">{props.error}</p>
          <button
            type="button"
            class="quiet-button"
            disabled={props.disabled}
            onClick={props.onReload}
          >
            Reload library
          </button>
        </div>
      </Show>
    </>
  );
}
