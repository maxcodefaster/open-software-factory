import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { Show, untrack } from "solid-js";
import type { BoardStage } from "../../../../packages/interface-domain/src/ticket-board";
import type { PrerequisiteView } from "../../../../packages/ticket-domain/src/dependency";
import type { Epic, Ticket } from "../api-contracts";
import type { EpicEdit } from "../epic-controls";
import type { createProjectPlanning } from "../projects/planning";
import { ticketReference } from "../projects/ticket-content";
import { SetupEmptyBoard } from "../setup/panel";
import { TicketBoardContents } from "../ticket-board";
import type { PersonalTicketDraft } from "../ticket-draft-workspace";
import { TicketQuickFind } from "../ticket-quick-find";
import { DesktopEmpty } from "../workspace-chrome";
import type { DesktopProject } from "./contracts";

export interface ProjectBoardModel {
  workspaceVisible: SourceAccessor<boolean>;
  agentOverlay: () => boolean;
  registrationOpen: SourceAccessor<boolean>;
  setupVisible: () => boolean;
  selectedProject: Accessor<DesktopProject | undefined>;
  setProjectMenuOpen: ReturnType<typeof createProjectPlanning>["setProjectMenuOpen"];
  narrowViewport: SourceAccessor<boolean>;
  historyTickets: () => Ticket[];
  boardHasMore: () => boolean;
  ticketLimit: ReturnType<typeof createProjectPlanning>["ticketLimit"];
  boardHistoryOpen: SourceAccessor<boolean>;
  setBoardHistoryOpen: Setter<boolean>;
  history: ReturnType<typeof createProjectPlanning>["history"];
  historyLimit: ReturnType<typeof createProjectPlanning>["historyLimit"];
  boardPageLoading: () => boolean;
  setHistoryLimit: ReturnType<typeof createProjectPlanning>["setHistoryLimit"];
  setTicketLimit: ReturnType<typeof createProjectPlanning>["setTicketLimit"];
  boardPageLabel: () => string;
  foundTickets: ReturnType<typeof createProjectPlanning>["foundTickets"];
  setFind: ReturnType<typeof createProjectPlanning>["setFind"];
  boardStatus: (ticket: Ticket) => string;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  pending: () => boolean;
  openTicketDraft: (proposed?: PersonalTicketDraft, stage?: "inbox" | "ready") => void;
  scopedTickets: () => Ticket[];
  epicList: () => {
    readonly id: string;
    readonly projectId: string;
    readonly parentId: string | null;
    readonly title: string;
    readonly description: string;
    readonly version: number;
    readonly createdBy: string;
    readonly createdAt: number;
    readonly updatedAt: number;
  }[];
  lane: (ticket: Ticket) => BoardStage | "history";
  selectedTicketID: SourceAccessor<string | undefined>;
  blockersFor: (ticketID: string) => PrerequisiteView[];
  selectedEpicID: ReturnType<typeof createProjectPlanning>["selectedEpicID"];
  setSelectedEpicID: ReturnType<typeof createProjectPlanning>["setSelectedEpicID"];
  saveEpic: (input: EpicEdit, current?: Epic) => Promise<boolean>;
  tickets: ReturnType<typeof createProjectPlanning>["tickets"];
}

export function ProjectBoard(props: { model: ProjectBoardModel }) {
  // The model identity is stable; its accessors retain live state.
  const model = untrack(() => props.model);
  return (
    <section
      class={model.workspaceVisible() ? "kanban-desktop obscured" : "kanban-desktop"}
      aria-label="Ticket board"
      inert={model.workspaceVisible() || model.agentOverlay() || model.registrationOpen()}
    >
      <Show
        when={!model.setupVisible() && model.selectedProject()}
        fallback={
          model.setupVisible() ? (
            <SetupEmptyBoard />
          ) : (
            <DesktopEmpty onChoose={() => model.setProjectMenuOpen(true)} />
          )
        }
      >
        <Show
          when={
            model.narrowViewport() ||
            model.historyTickets().length > 0 ||
            model.boardHasMore() ||
            model.ticketLimit() > 200
          }
        >
          <div class="board-toolbar">
            <Show when={model.historyTickets().length > 0}>
              <button
                type="button"
                class="board-history-button"
                aria-pressed={model.boardHistoryOpen() ? "true" : "false"}
                onClick={() => model.setBoardHistoryOpen((open) => !open)}
              >
                <span>{model.boardHistoryOpen() ? "Active work" : "History"}</span>
                <Show when={!model.boardHistoryOpen()}>
                  <span class="history-count">
                    {model.historyTickets().length}
                    {(model.history.data()?.length ?? 0) > model.historyLimit() ? "+" : ""}
                  </span>
                </Show>
              </button>
            </Show>
            <Show
              when={model.boardHistoryOpen() || model.boardHasMore() || model.ticketLimit() > 200}
            >
              <button
                type="button"
                class="board-history-button board-page-button"
                disabled={model.boardPageLoading() || !model.boardHasMore()}
                onClick={() =>
                  model.boardHistoryOpen()
                    ? model.setHistoryLimit((limit) => limit + 50)
                    : model.setTicketLimit((limit) => limit + 200)
                }
              >
                {model.boardPageLabel()}
              </button>
            </Show>
            <Show when={model.narrowViewport()}>
              <TicketQuickFind
                tickets={(model.foundTickets.data() as Ticket[] | undefined) ?? []}
                onQueryChange={model.setFind}
                loading={model.foundTickets.completeness() === "unknown"}
                failed={Boolean(model.foundTickets.error())}
                reference={ticketReference}
                status={model.boardStatus}
                onSelect={model.selectTicket}
                disabled={model.pending()}
              />
              <button
                type="button"
                class="new-ticket-button board-new-ticket"
                aria-label="New Ticket"
                onClick={() => model.openTicketDraft(undefined, "ready")}
              >
                New ticket
              </button>
            </Show>
          </div>
        </Show>
        <TicketBoardContents
          tickets={model.scopedTickets()}
          epics={model.epicList()}
          archivedTickets={props.model
            .scopedTickets()
            .filter((ticket) => model.lane(ticket) === "history")}
          historyOpen={model.boardHistoryOpen()}
          pending={model.pending()}
          selectedTicketID={model.selectedTicketID()}
          stage={model.lane}
          status={model.boardStatus}
          blockers={model.blockersFor}
          reference={ticketReference}
          onSelect={model.selectTicket}
          epicID={model.selectedEpicID()}
          onEpic={model.setSelectedEpicID}
          onSaveEpic={model.saveEpic}
          ticketsIncomplete={
            model.tickets.completeness() !== "complete" ||
            model.history.completeness() !== "complete" ||
            (model.tickets.data()?.length ?? 0) > model.ticketLimit() ||
            (model.history.data()?.length ?? 0) > model.historyLimit()
          }
          loadingMore={
            model.tickets.completeness() !== "complete" ||
            model.history.completeness() !== "complete"
          }
          onLoadMore={() => {
            model.setTicketLimit((limit) => limit + 200);
            model.setHistoryLimit((limit) => limit + 50);
          }}
        />
      </Show>
    </section>
  );
}
