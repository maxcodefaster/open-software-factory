import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { type FactoryZeroContext, type FactoryZeroSchema, zeroMutators } from "#zero-schema";
import type { useZero } from "#zero-solid";
import type { PersonalTicketDraft, Ticket, TicketDraft } from "../change/contracts";
import { readPersonalTicketDraft } from "../change/drafts";
import type { Epic } from "../projects/contracts";
import type { EpicEdit } from "../tickets/epic-controls";
import type { createWorkspaceState } from "../workspace/state";
import type { WorkspaceTab } from "../workspace-tabs";
import type { DesktopMutation, ReadTicketDetail, TicketDetail } from "./contracts";

interface ProjectCommandsDependencies {
  mutate: DesktopMutation;
  zero: ReturnType<typeof useZero<FactoryZeroSchema, undefined, FactoryZeroContext>>;
  selectedProjectID: SourceAccessor<string | undefined>;
  commitZeroMutation: (operation: Promise<unknown>) => Promise<void>;
  setSelectedEpicID: Setter<string>;
  error: SourceAccessor<string>;
  detail: Accessor<TicketDetail | undefined>;
  refreshTicketDetail: ReadTicketDetail;
  personalDrafts: Map<
    string,
    {
      id: string;
      title: string;
      description: string;
      stage?: "inbox" | "ready" | undefined;
      attachmentSequence?: number | undefined;
    }
  >;
  personalDraftKey: () => string;
  ticketDrafts: Map<string, TicketDraft>;
  setSelectedTicketID: Setter<string | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  userID: string;
  workspaces: Pick<ReturnType<typeof createWorkspaceState>, "current" | "update" | "close">;
  workspaceVisible: SourceAccessor<boolean>;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
}

export function createProjectCommands(dependencies: ProjectCommandsDependencies) {
  async function saveEpic(input: EpicEdit, current?: Epic) {
    const client = dependencies.zero();
    const projectId = dependencies.selectedProjectID();
    if (!client || !projectId) return false;
    const id = current?.id ?? crypto.randomUUID();
    const result = await dependencies.mutate(async () => {
      await dependencies.commitZeroMutation(
        client.mutate(
          current
            ? zeroMutators.epics.update({
                projectId,
                epicId: id,
                expectedVersion: current.version,
                ...input,
              })
            : zeroMutators.epics.create({ projectId, id, ...input }),
        ).server,
      );
      if (dependencies.selectedProjectID() === projectId) dependencies.setSelectedEpicID(id);
    });
    if (!result.ok)
      throw new Error(
        dependencies.error() ||
          "Epic could not be saved. Check Project access and refresh before retrying.",
      );
    return true;
  }

  async function assignTicketEpic(epicId: string | null) {
    const client = dependencies.zero();
    const current = dependencies.detail()?.ticket;
    if (!client || !current) return;
    await dependencies.mutate(async () => {
      await dependencies.commitZeroMutation(
        client.mutate(
          zeroMutators.tickets.assignEpic({
            projectId: current.projectId,
            ticketId: current.id,
            expectedVersion: current.version,
            epicId,
          }),
        ).server,
      );
      await dependencies.refreshTicketDetail(current.id);
    });
  }

  async function editDependency(kind: "add" | "remove", prerequisiteId: string) {
    const client = dependencies.zero();
    const current = dependencies.detail()?.ticket;
    if (!client || !current) return false;
    const result = await dependencies.mutate(async () => {
      await dependencies.commitZeroMutation(
        client.mutate(
          zeroMutators.dependencies[kind]({
            projectId: current.projectId,
            ticketId: current.id,
            prerequisiteId,
            expectedVersion: current.version,
          }),
        ).server,
      );
      await dependencies.refreshTicketDetail(current.id);
    });
    return result.ok;
  }

  function openTicketDraft(proposed?: PersonalTicketDraft, stage?: "inbox" | "ready") {
    const projectID = dependencies.selectedProjectID();
    if (!projectID) return;
    const retained =
      dependencies.personalDrafts.get(projectID) ??
      readPersonalTicketDraft(dependencies.personalDraftKey());
    const previous =
      retained.title.trim() || retained.description.trim() ? retained : (proposed ?? retained);
    const draft = stage ? { ...previous, stage } : previous;
    dependencies.personalDrafts.set(projectID, draft);
    if (proposed || stage) {
      try {
        localStorage.setItem(dependencies.personalDraftKey(), JSON.stringify(draft));
      } catch {
        /* Memory retains the proposed draft. */
      }
    }
    dependencies.setSelectedTicketID(undefined);
    dependencies.setDetail(undefined);
    dependencies.openWorkspaceTab({
      id: `ticket-draft:${projectID}`,
      view: "ticket-draft",
      label: draft.title || "New ticket",
    });
  }

  async function publishTicketDraft(
    draft: PersonalTicketDraft,
    state: "inbox" | "ready",
    projectID: string,
  ) {
    const client = dependencies.zero();
    if (!projectID || !client) return false;
    const ownedDraft = dependencies.personalDrafts.get(projectID);
    if (!ownedDraft || ownedDraft.id !== draft.id) return false;
    const draftTabID = `ticket-draft:${projectID}`;
    const result = await dependencies.mutate(async () => {
      await dependencies.commitZeroMutation(
        client.mutate(
          zeroMutators.tickets.create({
            id: draft.id,
            projectId: projectID,
            title: draft.title,
            description: draft.description,
            state,
          }),
        ).server,
      );
      // Completion belongs to the submitting Project, even after navigation.
      // A replacement stays personal. Later edits to this same Ticket become
      // an ordinary saved-Ticket draft, never a second create with its ID.
      const retained = dependencies.personalDrafts.get(projectID);
      if (!retained || retained.id !== draft.id) return;
      if (
        (retained.title.trim() !== draft.title || retained.description !== draft.description) &&
        !dependencies.ticketDrafts.has(draft.id)
      ) {
        const editing: TicketDraft = {
          title: retained.title,
          description: retained.description,
          requirement: {
            summary: retained.description,
            acceptanceCriteria: [],
            nonGoals: [],
          },
          expectedVersion: 1,
          expectedDocumentId: null,
          requirementRevisionId: null,
        };
        dependencies.ticketDrafts.set(draft.id, editing);
        try {
          localStorage.setItem(
            `ticket-edit:${dependencies.userID}:${draft.id}`,
            JSON.stringify(editing),
          );
        } catch {
          /* Memory retains later edits for the created Ticket. */
        }
      }
      const activate =
        dependencies.selectedProjectID() === projectID &&
        dependencies.workspaceVisible() &&
        dependencies.workspaces.current()?.activeTabID === draftTabID;
      dependencies.personalDrafts.delete(projectID);
      try {
        localStorage.removeItem(`ticket-draft:${dependencies.userID}:${projectID}`);
      } catch {
        /* Created work is authoritative even without browser storage. */
      }
      // Keep the original tab identity while converting the retained result.
      dependencies.workspaces.update(
        { id: draftTabID, view: "ticket", ticketID: draft.id, label: draft.title },
        projectID,
      );
      if (!activate) return;
      dependencies.workspaces.close(draftTabID);
      dependencies.selectTicket(draft.id);
      await dependencies.refreshTicketDetail(draft.id);
    });
    return result.ok;
  }

  async function moveTicket(ticket: Ticket, state: "inbox" | "ready") {
    const client = dependencies.zero();
    if (!client) return false;
    const result = await dependencies.mutate(async () => {
      await dependencies.commitZeroMutation(
        client.mutate(
          zeroMutators.tickets.move({
            projectId: ticket.projectId,
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            state,
          }),
        ).server,
      );
      await dependencies.refreshTicketDetail(ticket.id);
    });
    return result.ok;
  }

  return {
    saveEpic,
    assignTicketEpic,
    editDependency,
    openTicketDraft,
    publishTicketDraft,
    moveTicket,
  };
}
