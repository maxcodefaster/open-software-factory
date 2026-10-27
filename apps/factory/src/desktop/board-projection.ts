import type { Accessor, SourceAccessor } from "solid-js";
import { createMemo } from "solid-js";
import {
  type BoardStage,
  ticketBoardStage,
  ticketBoardStatus,
} from "../../../../packages/interface-domain/src/ticket-board";
import {
  dependencyWouldCycle,
  type PrerequisiteView,
  prerequisiteIsDelivered,
} from "../../../../packages/ticket-domain/src/dependency";
import type { Change, RuntimeAttempt, Ticket } from "../api-contracts";
import type { createProjectPlanning } from "../projects/planning";
import type { TicketDetail } from "./contracts";

interface BoardProjectionDependencies {
  changes: Accessor<Change[]>;
  dependencies: ReturnType<typeof createProjectPlanning>["dependencies"];
  attempts: Accessor<RuntimeAttempt[]>;
  projects: ReturnType<typeof createProjectPlanning>["projects"];
  selectedProjectID: SourceAccessor<string | undefined>;
  projectSearchQuery: SourceAccessor<string>;
  tickets: ReturnType<typeof createProjectPlanning>["tickets"];
  ticketLimit: ReturnType<typeof createProjectPlanning>["ticketLimit"];
  history: ReturnType<typeof createProjectPlanning>["history"];
  historyLimit: ReturnType<typeof createProjectPlanning>["historyLimit"];
  prerequisiteTickets: ReturnType<typeof createProjectPlanning>["prerequisiteTickets"];
  foundTickets: ReturnType<typeof createProjectPlanning>["foundTickets"];
  trashTickets: ReturnType<typeof createProjectPlanning>["tickets"];
  detail: Accessor<TicketDetail | undefined>;
  epics: ReturnType<typeof createProjectPlanning>["epics"];
  boardHistoryOpen: SourceAccessor<boolean>;
}

export function createBoardProjection(dependencies: BoardProjectionDependencies) {
  const changesByTicket = createMemo(
    () => new Map(dependencies.changes().map((change) => [change.ticketId, change])),
  );

  function changeFor(ticketID: string) {
    return changesByTicket().get(ticketID);
  }

  const prerequisitesByTicket = createMemo(() => {
    const byId = new Map(ticketList().map((ticket) => [ticket.id, ticket]));
    const result = new Map<string, PrerequisiteView[]>();
    for (const edge of dependencies.dependencies.data() ?? []) {
      const ticket = byId.get(edge.prerequisiteId);
      if (!ticket) continue;
      const change = changeFor(ticket.id);
      const prerequisite = {
        id: ticket.id,
        title: ticket.title,
        state: ticket.state,
        delivered: prerequisiteIsDelivered({
          ticketState: ticket.state,
          changeState: change?.state,
          verificationState: change?.verificationState,
          mergeState: change?.mergeState,
          promotionState: change?.promotionState,
        }),
      };
      result.set(edge.ticketId, [...(result.get(edge.ticketId) ?? []), prerequisite]);
    }
    return result;
  });

  function prerequisitesFor(ticketID: string) {
    return prerequisitesByTicket().get(ticketID) ?? [];
  }

  function blockersFor(ticketID: string) {
    return prerequisitesFor(ticketID).filter((prerequisite) => !prerequisite.delivered);
  }

  function dependencyCandidates(ticketID: string) {
    const edges = dependencies.dependencies.data() ?? [];
    const linked = new Set(prerequisitesFor(ticketID).map((prerequisite) => prerequisite.id));
    return ticketList()
      .filter(
        (ticket) =>
          ticket.id !== ticketID &&
          !linked.has(ticket.id) &&
          !dependencyWouldCycle(edges, ticketID, ticket.id),
      )
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  function stagingRuntimeFor(projectID: string) {
    return dependencies
      .attempts()
      .find(
        (attempt) =>
          attempt.projectId === projectID &&
          attempt.runtimeKind === "staging" &&
          attempt.currentStaging === true &&
          !["stopped", "failed"].includes(attempt.state),
      );
  }

  function lane(ticket: Ticket): BoardStage | "history" {
    const change = changeFor(ticket.id);
    return ticketBoardStage({
      ticketState: ticket.state,
      changeState: change?.state,
      verificationState: change?.verificationState,
      buildTurnState: change?.buildTurnState,
      buildTurnPurpose: change?.buildTurnPurpose,
      implementationState: change?.implementationState,
    });
  }

  function boardStatus(ticket: Ticket) {
    const change = changeFor(ticket.id);
    return ticketBoardStatus({
      ticketState: ticket.state,
      changeState: change?.state,
      verificationState: change?.verificationState,
      buildTurnState: change?.buildTurnState,
      buildTurnPurpose: change?.buildTurnPurpose,
      implementationState: change?.implementationState,
    });
  }

  const selectedProject = () =>
    dependencies.projects
      .data()
      ?.find((project) => project.id === dependencies.selectedProjectID());

  const filteredProjects = () => {
    const list = dependencies.projects.data() ?? [];
    const query = dependencies.projectSearchQuery().trim().toLocaleLowerCase();
    if (!query) return list;
    return list.filter((project) =>
      `${project.name} ${project.slug}`.toLocaleLowerCase().includes(query),
    );
  };

  const activeTickets = () =>
    (dependencies.tickets.data() as Ticket[] | undefined)?.slice(0, dependencies.ticketLimit()) ??
    [];

  const retainedTickets = () =>
    (dependencies.history.data() as Ticket[] | undefined)?.slice(0, dependencies.historyLimit()) ??
    [];

  const ticketList = () => {
    const selected = dependencies.detail()?.ticket;
    return [
      ...new Map(
        [
          ...activeTickets(),
          ...retainedTickets(),
          ...((dependencies.prerequisiteTickets.data() as Ticket[] | undefined) ?? []),
          ...((dependencies.foundTickets.data() as Ticket[] | undefined) ?? []),
          ...((dependencies.trashTickets.data() as Ticket[] | undefined) ?? []),
          ...(selected ? [selected] : []),
        ].map((ticket) => [ticket.id, ticket]),
      ).values(),
    ];
  };

  const epicList = () => dependencies.epics.data() ?? [];

  const scopedTickets = () => {
    return [...activeTickets(), ...retainedTickets()];
  };

  const historyTickets = () => scopedTickets().filter((ticket) => lane(ticket) === "history");

  const boardHasMore = () =>
    dependencies.boardHistoryOpen()
      ? (dependencies.history.data()?.length ?? 0) > dependencies.historyLimit()
      : (dependencies.tickets.data()?.length ?? 0) > dependencies.ticketLimit();

  const boardPageLoading = () =>
    (dependencies.boardHistoryOpen()
      ? dependencies.history
      : dependencies.tickets
    ).completeness() !== "complete";

  const boardPageLabel = () => {
    const kind = dependencies.boardHistoryOpen() ? "completed" : "active";
    if (boardPageLoading()) return `Loading ${kind} Tickets…`;
    return boardHasMore() ? `Show more ${kind} Tickets` : `All ${kind} Tickets shown`;
  };

  return {
    selectedProject,
    ticketList,
    changeFor,
    stagingRuntimeFor,
    epicList,
    prerequisitesFor,
    dependencyCandidates,
    blockersFor,
    historyTickets,
    boardHasMore,
    boardPageLoading,
    boardPageLabel,
    boardStatus,
    scopedTickets,
    lane,
    filteredProjects,
  };
}
