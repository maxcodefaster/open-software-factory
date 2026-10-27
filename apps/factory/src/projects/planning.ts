import { type Accessor, createEffect, createSignal } from "solid-js";
import { zeroQueries } from "../../../../packages/zero-schema/src";
import { useZeroPreload, useZeroQuery } from "../../../../packages/zero-solid/src";

export function createProjectPlanning(projectID: Accessor<string | undefined>) {
  const projects = useZeroQuery(() => zeroQueries.projects.list());
  const memberships = useZeroQuery(() => zeroQueries.memberships.list());
  const [ticketLimit, setTicketLimit] = createSignal(200);
  const [historyLimit, setHistoryLimit] = createSignal(50);
  const [trashLimit, setTrashLimit] = createSignal(50);
  const [find, setFind] = createSignal({ open: false, query: "" });
  const [preloadProjectID, setPreloadProjectID] = createSignal<string>();
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);
  const [selectedEpicID, setSelectedEpicID] = createSignal("");
  const tickets = useZeroQuery(() => {
    const projectId = projectID();
    return projectId ? zeroQueries.tickets.active({ projectId, limit: ticketLimit() + 1 }) : null;
  });
  const history = useZeroQuery(() => {
    const projectId = projectID();
    return projectId ? zeroQueries.tickets.history({ projectId, limit: historyLimit() + 1 }) : null;
  });
  const prerequisiteTickets = useZeroQuery(() => {
    const projectId = projectID();
    return projectId ? zeroQueries.tickets.prerequisites({ projectId }) : null;
  });
  const foundTickets = useZeroQuery(
    () => {
      const projectId = projectID();
      return projectId && find().open
        ? zeroQueries.tickets.find({ projectId, text: find().query })
        : null;
    },
    { ttl: "none" },
  );
  useZeroPreload(
    () => {
      const projectId = projectMenuOpen() ? preloadProjectID() : undefined;
      return projectId && projectId !== projectID()
        ? zeroQueries.tickets.active({ projectId, limit: 201 })
        : null;
    },
    { ttl: "30s" },
  );
  const epics = useZeroQuery(() => {
    const projectId = projectID();
    return projectId ? zeroQueries.epics.list({ projectId }) : null;
  });
  const dependencies = useZeroQuery(() => {
    const projectId = projectID();
    return projectId ? zeroQueries.dependencies.list({ projectId }) : null;
  });
  createEffect(projectID, () => {
    setSelectedEpicID("");
    setTicketLimit(200);
    setHistoryLimit(50);
    setTrashLimit(50);
    setFind({ open: false, query: "" });
  });
  return {
    projects,
    memberships,
    tickets,
    history,
    prerequisiteTickets,
    foundTickets,
    epics,
    dependencies,
    ticketLimit,
    setTicketLimit,
    historyLimit,
    setHistoryLimit,
    trashLimit,
    setTrashLimit,
    setFind,
    setPreloadProjectID,
    projectMenuOpen,
    setProjectMenuOpen,
    selectedEpicID,
    setSelectedEpicID,
  };
}
