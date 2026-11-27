import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { withoutRepeatedTitle } from "#knowledge-domain/document-merge";
import { MarkdownReader } from "../editor/markdown-reader";
import { Icon } from "../icon";
import { VersionHistory } from "../tickets/version-history";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import type { KnowledgePage, KnowledgePageOutline, KnowledgeRevision } from "./contracts";
import { repositoryLink } from "./source-link";

const revisionTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function WorkspaceHistoricalRevision(props: {
  revision: KnowledgeRevision;
  selectedPage?: KnowledgePage | undefined;
  pages: KnowledgePageOutline[];
  canDevelop: boolean;
  repositoryURL: string;
  restoring: boolean;
  dirty: boolean;
  restoreError: string;
  leading: JSX.Element;
  onNavigate(href: string): boolean;
  onRestore(revision: KnowledgeRevision): void;
}) {
  return (
    <article
      class="knowledge-document historical-document"
      aria-label="Selected knowledge revision"
    >
      <header class="knowledge-heading workspace-heading">
        <div class="knowledge-title-row workspace-heading-title">
          <Icon name={props.selectedPage?.icon ?? "knowledge"} />
          <h2>{props.revision.title}</h2>
        </div>
        <WorkspaceActionBar label="Wiki revision actions" leading={props.leading}>
          <Show
            when={
              props.canDevelop &&
              props.revision.kind === "generated" &&
              props.revision.sourceCommitSha &&
              repositoryLink(props.repositoryURL, props.revision.sourceCommitSha ?? "")
            }
          >
            {(href) => (
              <a class="workspace-action" href={href()} target="_blank" rel="noopener noreferrer">
                View source change
              </a>
            )}
          </Show>
          <Show
            when={
              props.revision.kind !== "proposed" &&
              props.revision.id !== props.selectedPage?.currentRevisionId
            }
          >
            <button
              type="button"
              class="workspace-action"
              data-primary="true"
              disabled={props.restoring || props.dirty}
              onClick={() => props.onRestore(props.revision)}
            >
              Restore this version
            </button>
          </Show>
        </WorkspaceActionBar>
        <small class="workspace-heading-meta">
          {props.revision.kind === "human" ? (props.revision.author ?? "Human edit") : "AI update"}{" "}
          · {revisionTime.format(new Date(props.revision.createdAt))}
        </small>
      </header>
      <MarkdownReader
        class="knowledge-article markdown-body"
        label="Historical page"
        scopeKey={props.revision.id}
        onNavigate={props.onNavigate}
        wikiPages={props.pages.filter((page) => page.state === "active")}
        value={withoutRepeatedTitle(props.revision.body, props.revision.title)}
      />
      <Show when={props.restoreError}>
        <p role="alert">{props.restoreError}</p>
      </Show>
    </article>
  );
}

export function WorkspaceVersionHistoryPanel(props: {
  revisions: KnowledgeRevision[];
  selectedPage?: KnowledgePage | undefined;
  selectedID?: string | undefined;
  loading: boolean;
  error: string;
  opener?: HTMLButtonElement | undefined;
  onSelect(id: string): void;
  onClose(): void;
}) {
  return (
    <div class="knowledge-version-panel">
      <Show when={props.error}>
        <p role="alert">{props.error}</p>
      </Show>
      <VersionHistory
        label="Wiki history"
        selectedID={props.selectedID}
        loading={props.loading}
        versions={props.revisions.map((revision) => ({
          id: revision.id,
          label:
            revision.id === props.selectedPage?.currentRevisionId
              ? "Current version"
              : revision.title,
          author: revision.kind === "human" ? (revision.author ?? "Human edit") : "AI",
          createdAt: revision.createdAt,
          state:
            revision.kind === "proposed"
              ? "Proposed"
              : revision.kind === "human"
                ? "Human edit"
                : "AI update",
        }))}
        onSelect={props.onSelect}
        onClose={props.onClose}
        opener={props.opener}
      />
    </div>
  );
}
