import type { Accessor, Setter, SourceAccessor } from "solid-js";
import {
  type FactoryZeroContext,
  type FactoryZeroSchema,
  zeroMutators,
} from "../../../../packages/zero-schema/src";
import type { useZero } from "../../../../packages/zero-solid/src";
import type { Epic, Ticket } from "../api-contracts";
import type { EpicEdit } from "../epic-controls";
import type { createProjectPlanning } from "../projects/planning";
import { registerProject } from "../server-functions/projects";
import { serverCall } from "../server-functions/result";
import { type PersonalTicketDraft, readPersonalTicketDraft } from "../ticket-draft-workspace";
import type { createWorkspaceState } from "../workspace/state";
import type { WorkspaceTab } from "../workspace-tabs";
import type {
  DesktopMutation,
  FactoryDesktopProps,
  ReadTicketDetail,
  TicketDetail,
} from "./contracts";

interface ProjectCommandsDependencies {
  mutate: DesktopMutation;
  setSelectedProjectID: Setter<string | undefined>;
  setProjectMenuOpen: ReturnType<typeof createProjectPlanning>["setProjectMenuOpen"];
  setRegistrationOpen: Setter<boolean>;
  zero: ReturnType<typeof useZero<FactoryZeroSchema, undefined, FactoryZeroContext>>;
  selectedProjectID: SourceAccessor<string | undefined>;
  commitZeroMutation: (operation: Promise<unknown>) => Promise<void>;
  setSelectedEpicID: ReturnType<typeof createProjectPlanning>["setSelectedEpicID"];
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
  setSelectedTicketID: Setter<string | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  props: FactoryDesktopProps;
  workspaces: ReturnType<typeof createWorkspaceState>;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
}

export function createProjectCommands(dependencies: ProjectCommandsDependencies) {
  async function register(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    await dependencies.mutate(async () => {
      const project = await serverCall(
        registerProject({
          data: [
            {
              name: String(data.get("name") ?? ""),
              slug: String(data.get("slug") ?? ""),
              repositoryUrl: String(data.get("repositoryUrl") ?? ""),
              defaultBranch: String(data.get("defaultBranch") ?? ""),
              devcontainerPath: String(data.get("devcontainerPath") ?? ""),
            },
          ],
        }),
      );
      dependencies.setSelectedProjectID(project.id);
      dependencies.setProjectMenuOpen(false);
      dependencies.setRegistrationOpen(false);
      form.reset();
    });
  }

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

  async function publishTicketDraft(draft: PersonalTicketDraft, state: "inbox" | "ready") {
    const projectID = dependencies.selectedProjectID();
    const client = dependencies.zero();
    if (!projectID || !client) return false;
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
      dependencies.personalDrafts.delete(projectID);
      try {
        localStorage.removeItem(`ticket-draft:${dependencies.props.session.user.id}:${projectID}`);
      } catch {
        /* Created work is authoritative even without browser storage. */
      }
      dependencies.workspaces.close(`ticket-draft:${projectID}`);
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
    register,
    saveEpic,
    assignTicketEpic,
    editDependency,
    openTicketDraft,
    publishTicketDraft,
    moveTicket,
  };
}
