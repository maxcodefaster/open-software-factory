import { type Accessor, For, Match, Show, Switch } from "solid-js";
import type { TechnicalDesignRevision } from "../change/contracts";
import { Icon } from "../icon";
import { type ReviewActions, ReviewPanel } from "../review/panel";
import { RequirementDocument } from "./requirement-document";
import { TicketDependencies } from "./ticket-dependencies";
import { TechnicalDesignSections } from "./ticket-planning";
import { resolveTicketSaveError } from "./ticket-section-state";
import type { TicketDraftController } from "./ticket-workspace-draft";
import { RichTextSurface } from "./ticket-workspace-slash";
import {
  parseRequirement,
  type RequirementRevisionView,
  type RichTextHandlerOptions,
  type RichTextHandlers,
  type TicketWorkspaceProps,
} from "./ticket-workspace-types";
import { VersionHistory } from "./version-history";

export { TicketDocumentHeader } from "./ticket-document-header";

export function TicketHistoricalDocument(props: {
  revision: RequirementRevisionView | undefined;
  fallbackTitle: string;
  versions: readonly RequirementRevisionView[];
}) {
  return (
    <Show when={props.revision}>
      {(revision) => (
        <RequirementDocument
          title={revision().title ?? props.fallbackTitle}
          description={revision().description}
          content={parseRequirement(revision())}
          ordinal={props.versions.length - props.versions.indexOf(revision())}
        />
      )}
    </Show>
  );
}

export function TicketSaveErrorBanner(props: { draft: TicketDraftController }) {
  const visibleError = () => {
    const state = resolveTicketSaveError({
      editorError: props.draft.editorError(),
      conflict: props.draft.conflict(),
      saving: props.draft.saving(),
      hasChanges: props.draft.hasChanges(),
      hasProposal: Boolean(props.draft.proposal()),
      title: props.draft.title(),
    });
    return state.kind === "hidden" ? undefined : state;
  };
  return (
    <Show when={visibleError()}>
      {(state) => (
        <div class="ticket-save-error" role="alert">
          <p class="inline-error">{state().message}</p>
          <div class="control-actions">
            <Switch>
              <Match when={state().kind === "conflict"}>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={props.draft.saving()}
                  onClick={props.draft.useSavedVersion}
                >
                  Discard my changes
                </button>
                <button
                  type="button"
                  class="primary-button"
                  disabled={props.draft.saving()}
                  onClick={props.draft.keepMyDraft}
                >
                  Save my version as a new revision
                </button>
              </Match>
              <Match when={state().kind === "retryable"}>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={props.draft.saving()}
                  onClick={() => void props.draft.saveChanges()}
                >
                  Retry save
                </button>
              </Match>
            </Switch>
          </div>
        </div>
      )}
    </Show>
  );
}

export function TicketReviewSection(props: {
  workspace: TicketWorkspaceProps;
  onThreadCount: (count: number) => void;
  onActions: (read: Accessor<ReviewActions | undefined> | undefined) => void;
}) {
  return (
    <Show
      when={
        props.workspace.change && props.workspace.userID
          ? { change: props.workspace.change, userID: props.workspace.userID }
          : undefined
      }
    >
      {(context) => (
        <section
          id="ticket-review"
          class="ticket-chapter"
          aria-label="Implementation review"
          tabindex="-1"
        >
          <h2 class="sr-only">Implementation review</h2>
          <ReviewPanel
            projectID={props.workspace.projectID}
            feedbackID={props.workspace.feedbackID}
            changeID={context().change.id}
            userID={context().userID}
            canDevelop={props.workspace.canDevelop}
            readOnly={["delivering", "delivered", "cancelled"].includes(context().change.state)}
            active={props.workspace.active}
            onThreadCount={props.onThreadCount}
            onActions={props.onActions}
            onOpenPreview={props.workspace.onOpenPreview}
          />
        </section>
      )}
    </Show>
  );
}

function SpecificationBlockList(props: {
  heading: string;
  listClass: string;
  itemClass: string;
  markerClass?: string | undefined;
  numbered?: boolean | undefined;
  ticketID: string;
  field: "acceptance" | "non-goal";
  labelPrefix: string;
  placeholder: string;
  addLabel: string;
  editable: boolean;
  items: ReadonlyArray<{ value: () => string; setValue: (value: string) => void }>;
  richTextHandlers: (options: RichTextHandlerOptions) => RichTextHandlers;
  onRegister: (index: number) => (element: HTMLElement) => void;
  onAdd: () => number;
}) {
  const populatedCount = () => props.items.filter((item) => item.value().trim().length > 0).length;
  const elements = new Map<number, HTMLElement>();
  let pendingFocusIndex: number | undefined;
  const registerElement = (index: number) => {
    const notify = props.onRegister(index);
    return (element: HTMLElement) => {
      elements.set(index, element);
      notify(element);
      if (pendingFocusIndex === index) {
        pendingFocusIndex = undefined;
        queueMicrotask(() => element.focus());
      }
    };
  };
  const handleAdd = () => {
    const nextIndex = props.onAdd();
    pendingFocusIndex = nextIndex;
    queueMicrotask(() => {
      const target = elements.get(nextIndex);
      if (target && pendingFocusIndex === nextIndex) {
        pendingFocusIndex = undefined;
        target.focus();
      }
    });
  };
  return (
    <div class="specification-block">
      <div class="specification-block-heading">
        <h3>{props.heading}</h3>
        <Show when={populatedCount() > 0}>
          <span class="specification-block-count" aria-hidden="true">
            {populatedCount()}
          </span>
        </Show>
      </div>
      <div class={`${props.listClass} specification-block-list`}>
        <For each={props.items}>
          {(item, index) => (
            <div class={`specification-list-item ${props.itemClass}`}>
              <span class={props.markerClass} aria-hidden="true">
                {props.numbered ? index() + 1 : "·"}
              </span>
              <RichTextSurface
                attachmentScopeKey={`ticket:${props.ticketID}:${props.field}:${index()}`}
                value={item.value()}
                label={`${props.labelPrefix} ${index() + 1}`}
                field={props.field}
                editable={props.editable}
                placeholder={props.placeholder}
                class="specification-rich-text markdown-body"
                onElement={registerElement(index())}
                {...props.richTextHandlers({
                  slash: true,
                  update: item.setValue,
                })}
              />
            </div>
          )}
        </For>
      </div>
      <Show when={props.editable}>
        <button type="button" class="workspace-action specification-add-button" onClick={handleAdd}>
          <Icon name="plus" />
          <span>{props.addLabel}</span>
        </button>
      </Show>
    </div>
  );
}

export function TicketSpecificationSection(props: {
  workspace: TicketWorkspaceProps;
  draft: TicketDraftController;
  canEditSpecification: boolean;
  specificationVisible: boolean;
  richTextHandlers: (options: RichTextHandlerOptions) => RichTextHandlers;
  onRegisterAcceptance: (index: number) => (element: HTMLElement) => void;
  onRegisterNonGoal: (index: number) => (element: HTMLElement) => void;
}) {
  return (
    <section
      id="ticket-product"
      tabindex="-1"
      class={`ticket-requirements ticket-chapter${props.workspace.change ? " is-review-context" : ""}`}
      aria-label="Ticket requirements"
    >
      <div class="ticket-chapter-heading">
        <h2>Product</h2>
      </div>
      <div class="ticket-requirements-intro">
        <RichTextSurface
          attachmentScopeKey={`ticket:${props.workspace.current.ticket.id}:summary`}
          value={props.draft.separateSummary() ? props.draft.summary() : props.draft.description()}
          label={props.draft.separateSummary() ? "Specification summary" : "Ticket description"}
          field="summary"
          editable={props.canEditSpecification}
          placeholder="Describe the intended product change. Type / for blocks."
          class="ticket-inline-description ticket-specification-summary markdown-body"
          {...props.richTextHandlers({
            slash: true,
            update: (value) => {
              if (!props.draft.separateSummary()) props.draft.setDescription(value);
              props.draft.setSummary(value);
            },
          })}
        />
      </div>

      <TicketDependencies
        prerequisites={props.workspace.dependencies.prerequisites}
        pending={props.workspace.pending || Boolean(props.workspace.dependencies.pending)}
        onOpen={props.workspace.dependencies.onOpen}
        onRemove={props.workspace.dependencies.onRemove}
      />

      <Show when={props.specificationVisible}>
        <section class="spec-section revision-section" aria-label="Specification">
          <div
            class={`specification-document ${props.canEditSpecification ? "editable" : "locked"}`}
          >
            <SpecificationBlockList
              heading="Acceptance criteria"
              listClass="criteria-list"
              itemClass="acceptance-item"
              markerClass="requirement-marker"
              numbered={true}
              ticketID={props.workspace.current.ticket.id}
              field="acceptance"
              labelPrefix="Acceptance criterion"
              placeholder="Add a verifiable outcome"
              addLabel="Add criterion"
              editable={props.canEditSpecification}
              items={props.draft.acceptance()}
              richTextHandlers={props.richTextHandlers}
              onRegister={props.onRegisterAcceptance}
              onAdd={props.draft.appendAcceptance}
            />
            <Show
              when={
                props.draft.nonGoals().some((block) => block.value().trim()) ||
                props.canEditSpecification
              }
            >
              <SpecificationBlockList
                heading="Out of scope"
                listClass="plain-list"
                itemClass="non-goal-item"
                ticketID={props.workspace.current.ticket.id}
                field="non-goal"
                labelPrefix="Non-goal"
                placeholder="Add an explicit exclusion"
                addLabel="Add exclusion"
                editable={props.canEditSpecification}
                items={props.draft.nonGoals()}
                richTextHandlers={props.richTextHandlers}
                onRegister={props.onRegisterNonGoal}
                onAdd={props.draft.appendNonGoal}
              />
            </Show>
          </div>
        </section>
      </Show>
    </section>
  );
}

export function TicketTechnicalSection(props: {
  workspace: TicketWorkspaceProps;
  show: boolean;
  technical: TechnicalDesignRevision | undefined;
  onEditing: (read: () => boolean) => void;
}) {
  return (
    <Show when={props.show}>
      <Show when={props.technical}>
        {(revision) => (
          <TechnicalDesignSections
            revision={revision()}
            productRevisionID={props.workspace.latestRevision?.id}
            editable={!props.workspace.change && !props.workspace.latestRevision?.approvalId}
            storageKey={`${props.workspace.storageKey}:technical`}
            busy={props.workspace.pending || Boolean(props.workspace.planningBusy)}
            onPlan={props.workspace.onTechnicalPlanning}
            onSave={props.workspace.onSaveTechnicalDesign}
            onEditing={props.onEditing}
          />
        )}
      </Show>
      <Show
        when={!props.workspace.planningBusy && props.workspace.current.technicalPlanningPending}
      >
        <p role="status">
          Technical Planning is not complete. Continue in the Assistant or explicitly replan.
        </p>
      </Show>
    </Show>
  );
}

export function TicketVersionHistoryDrawer(props: {
  open: boolean;
  documentElement: () => HTMLElement | undefined;
  selectedID: string | undefined;
  versions: readonly RequirementRevisionView[];
  currentRevisionID: string | undefined;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Show when={props.open}>
      <VersionHistory
        opener={
          props
            .documentElement()
            ?.querySelector<HTMLButtonElement>('button[aria-label="Ticket actions"]') ?? undefined
        }
        label="Specification history"
        selectedID={props.selectedID}
        versions={props.versions.map((revision) => ({
          id: revision.id,
          label: `Version ${props.versions.length - props.versions.indexOf(revision)}`,
          author: revision.author ?? undefined,
          createdAt: revision.createdAt,
          state: `${revision.id === props.currentRevisionID ? "Current · " : "Earlier · "}${revision.approvalId ? "Implementation scope" : revision.authorKind === "ai" ? "AI elaboration" : "Human edit"}`,
        }))}
        onSelect={props.onSelect}
        onClose={props.onClose}
      />
    </Show>
  );
}
