import { createEffect, Show } from "solid-js";
import { bindDialogKeyboard } from "./dialog-keyboard";
import { Icon } from "./icon";

export function ProjectRegistration(props: {
  pending: boolean;
  error: string;
  opener: HTMLElement | undefined;
  onSubmit(event: SubmitEvent): void;
  onClose(): void;
}) {
  let dialog: HTMLElement | undefined;
  createEffect(
    () => true,
    () => {
      if (dialog) return bindDialogKeyboard(dialog, props.onClose, props.opener);
    },
  );
  return (
    <div class="modal-backdrop">
      <section
        class="ticket-create-dialog project-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-registration-title"
        ref={dialog}
      >
        <WindowHeading
          eyebrow="New project"
          title="Connect a repository"
          titleID="project-registration-title"
          onClose={props.onClose}
        />
        <form class="project-form" onSubmit={props.onSubmit}>
          <Show when={props.error}>
            <p class="form-error" role="alert">
              {props.error}
            </p>
          </Show>
          <label for="project-name">Name</label>
          <input id="project-name" name="name" required />
          <label for="project-slug">Slug</label>
          <input id="project-slug" name="slug" pattern="[a-z](?:[a-z0-9]|-){1,62}" required />
          <label for="repository-url">Repository URL</label>
          <input id="repository-url" name="repositoryUrl" type="url" required />
          <details class="project-advanced">
            <summary>Advanced settings</summary>
            <div class="field-row">
              <label>
                Default branch
                <input name="defaultBranch" value="main" required />
              </label>
              <label>
                Dev Container
                <input name="devcontainerPath" value=".devcontainer/devcontainer.json" required />
              </label>
            </div>
          </details>
          <button type="submit" class="primary-button" disabled={props.pending}>
            Register Project
          </button>
        </form>
      </section>
    </div>
  );
}

export function DesktopEmpty(props: { onChoose(): void }) {
  return (
    <div class="desktop-empty">
      <p>Select or add a Project to open its delivery floor.</p>
      <button type="button" class="quiet-button" onClick={props.onChoose}>
        Choose project
      </button>
    </div>
  );
}

export function WindowHeading(props: {
  eyebrow: string;
  title: string;
  titleID?: string;
  description?: string;
  onClose?: () => void;
}) {
  return (
    <header class="window-heading">
      <div>
        <p>{props.eyebrow}</p>
        <h2 id={props.titleID}>{props.title}</h2>
        <Show when={props.description}>
          <span>{props.description}</span>
        </Show>
      </div>
      <Show when={props.onClose}>
        {(onClose) => (
          <button type="button" class="bare-icon" aria-label="Close workspace" onClick={onClose()}>
            <Icon name="close" />
          </button>
        )}
      </Show>
    </header>
  );
}

export { InboxWorkspace } from "./inbox/workspace";
