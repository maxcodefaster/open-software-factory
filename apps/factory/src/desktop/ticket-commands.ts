import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { z } from "zod";
import type { EpicProposal } from "../../../../packages/conversation-domain/src/epic-proposal";
import {
  type CodingReasoning,
  codingReasoningInput,
} from "../../../../packages/conversation-domain/src/model-settings";
import type { TechnicalDesignContent } from "../../../../packages/requirement-domain/src/technical-design";
import type { createAgentCommandIds } from "../agent-command-ids";
import type { Change, DeliveryView, Ticket } from "../api-contracts";
import type { createProjectPlanning } from "../projects/planning";
import { confirmEpicProposal } from "../server-functions/conversations";
import {
  approveDelivery as requestDeliveryApproval,
  resumeVerification,
  retryCandidateReview,
  retryStagingPromotion,
} from "../server-functions/delivery";
import { serverCall } from "../server-functions/result";
import {
  createTicketFollowUp,
  getTicketDetail,
  implementTicket as requestImplementation,
  restoreTicket,
  saveTicketDocument as saveTicket,
  saveTicketTechnicalDesign,
  trashTicket,
} from "../server-functions/tickets";
import type { TicketDraft } from "../ticket-workspace";
import type { WorkspaceTab } from "../workspace-tabs";
import type { DesktopMutation, ReadTicketDetail, TicketDetail } from "./contracts";

interface TicketCommandsDependencies {
  detail: Accessor<TicketDetail | undefined>;
  latestRevision: () =>
    | {
        id: string;
        ordinal: number;
        canonicalContent: string;
        contentDigest: string;
        createdAt?: string | undefined;
        approvalId?: string | undefined;
        approvedAt?: string | undefined;
        monitoringIncidentId?: string | undefined;
        author?: string | undefined;
        authorKind?: "human" | "ai" | undefined;
      }
    | undefined;
  mutate: DesktopMutation;
  agentCommandIds: ReturnType<typeof createAgentCommandIds>;
  acknowledgeCommand: (scope: string, ...commandIds: string[]) => void;
  refreshTicketDetail: ReadTicketDetail;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  refreshConversation: (
    projectID?: string | undefined,
    ticketID?: string | undefined,
  ) => Promise<void>;
  canDevelopProject: () => boolean;
  selectedProjectID: SourceAccessor<string | undefined>;
  setSelectedEpicID: ReturnType<typeof createProjectPlanning>["setSelectedEpicID"];
  closeWorkspaceTab: (tabID: string) => void;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  refreshServerState: () => Promise<void>;
  selectedTicketID: SourceAccessor<string | undefined>;
  setSelectedTicketID: Setter<string | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  ticketList: () => Ticket[];
  selectedChange: Accessor<Change | undefined>;
  implementationPreparation: SourceAccessor<
    | {
        projectID: string;
        ticketID: string;
        revisionID: string;
        reasoning: CodingReasoning | undefined;
        failure: string | undefined;
      }
    | undefined
  >;
  setError: Setter<string>;
  setImplementationPreparation: Setter<
    | {
        projectID: string;
        ticketID: string;
        revisionID: string;
        reasoning: CodingReasoning | undefined;
        failure: string | undefined;
      }
    | undefined
  >;
  preparingImplementation: () =>
    | {
        projectID: string;
        ticketID: string;
        revisionID: string;
        reasoning: CodingReasoning | undefined;
        failure: string | undefined;
      }
    | undefined;
  assistantTicketID: () => string | undefined;
  changeFor: (ticketID: string) =>
    | {
        id: string;
        projectId: string;
        ticketId: string;
        branchName: string;
        baseSha: string;
        state: string;
        branchState: string;
        requirementApprovalId?: string | undefined;
        version?: number | undefined;
        branchHeadSha?: string | undefined;
        runtimeAttemptId?: string | undefined;
        runtimeState?: string | undefined;
        verificationState?: string | undefined;
        buildTurnState?: string | undefined;
        buildTurnPurpose?: string | undefined;
        implementationState?: string | undefined;
        deliveryApprovedAt?: string | undefined;
        mergeState?: string | undefined;
        promotionState?: string | undefined;
        failure?: string | undefined;
      }
    | undefined;
  setCorrectionTarget: Setter<string | undefined>;
  setDelivery: Setter<DeliveryView | undefined>;
  refreshLifecycleState: () => Promise<void>;
  delivery: Accessor<DeliveryView | undefined>;
  agentCommandScope: (
    kind: string,
    identity?: string | null | undefined,
    projectID?: string | undefined,
  ) => string;
}

export function createTicketCommands(dependencies: TicketCommandsDependencies) {
  async function saveTicketDocument(input: TicketDraft) {
    const current = dependencies.detail();
    const revision = dependencies.latestRevision();
    if (!current) return undefined;
    const scope = `document:${current.ticket.id}`;
    const payload = {
      expectedVersion: input.expectedVersion ?? current.ticket.version,
      expectedDocumentId:
        input.expectedDocumentId === undefined
          ? (current.documentRevisions[0]?.id ?? null)
          : input.expectedDocumentId,
      requirementRevisionId:
        input.requirementRevisionId === undefined
          ? (revision?.id ?? null)
          : input.requirementRevisionId,
      title: input.title,
      description: input.description,
      requirement: input.requirement,
    };
    const result = await dependencies.mutate(async () => {
      const commandId = dependencies.agentCommandIds.forInput(scope, JSON.stringify(payload));
      const saved = await serverCall(
        saveTicket({ data: [current.ticket.id, { commandId, ...payload }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      // A competing read may supersede this refresh. The write's exact base
      // comes from its acknowledgement, never whichever projection arrives first.
      await dependencies.refreshTicketDetail(current.ticket.id).catch(() => undefined);
      return saved;
    });
    return result.ok ? result.value : undefined;
  }

  async function confirmRequirements(draft: TicketDraft) {
    const current = dependencies.detail();
    const proposal = current?.proposal;
    if (!current || !proposal) return undefined;
    const result = await dependencies.mutate(async () => {
      const payload = {
        expectedVersion: proposal.base.version,
        expectedDocumentId: proposal.base.documentId,
        requirementRevisionId: proposal.base.revisionId,
        proposalEntryId: proposal.id,
        title: draft.title,
        description: draft.description,
        requirement: draft.requirement,
      };
      const scope = `confirm:${current.ticket.id}`;
      const commandId = dependencies.agentCommandIds.forInput(scope, JSON.stringify(payload));
      const saved = await serverCall(
        saveTicket({ data: [current.ticket.id, { commandId, ...payload }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      await dependencies.refreshTicketDetail(current.ticket.id).catch(() => undefined);
      if (proposal.fullPlanning) {
        dependencies.setAgentOpen(true);
        await dependencies.refreshConversation();
      }
      return saved;
    });
    return result.ok ? result.value : undefined;
  }

  async function saveTechnicalDesign(revisionID: string, content: TechnicalDesignContent) {
    const current = dependencies.detail();
    if (!current || !dependencies.canDevelopProject()) return false;
    const result = await dependencies.mutate(async () => {
      const payload = { expectedRevisionId: revisionID, content };
      const scope = `technical-design:${current.ticket.id}`;
      const commandId = dependencies.agentCommandIds.forInput(scope, JSON.stringify(payload));
      await serverCall(
        saveTicketTechnicalDesign({ data: [current.ticket.id, { commandId, ...payload }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      await dependencies.refreshTicketDetail(current.ticket.id);
    });
    return result.ok;
  }

  async function confirmEpicWork(entryID: string, proposal: EpicProposal) {
    const projectID = dependencies.selectedProjectID();
    if (!projectID) return false;
    const result = await dependencies.mutate(async () => {
      const scope = `epic-confirm:${entryID}`;
      const commandId = dependencies.agentCommandIds.forInput(scope, JSON.stringify(proposal));
      const value = await serverCall(
        confirmEpicProposal({ data: [projectID, entryID, { commandId, proposal }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      if (dependencies.selectedProjectID() !== projectID) return;
      dependencies.setSelectedEpicID(value.epicId);
      dependencies.setAgentOpen(false);
      dependencies.closeWorkspaceTab(`epic-proposal:${entryID}`);
      const first = value.ticketIds[0];
      if (first) dependencies.selectTicket(first);
      await dependencies.refreshServerState();
    });
    return result.ok;
  }

  async function createFollowUp() {
    const current = dependencies.detail();
    const revision = dependencies.latestRevision();
    if (!current || !revision) return;
    const projectID = dependencies.selectedProjectID();
    const stillSelected = () =>
      dependencies.selectedProjectID() === projectID &&
      dependencies.selectedTicketID() === current.ticket.id;
    const scope = `follow-up:${current.ticket.id}`;
    const input = {
      requirementRevisionId: revision.id,
      expectedDocumentId: current.documentRevisions[0]?.id ?? null,
    };
    await dependencies.mutate(async () => {
      const commandId = dependencies.agentCommandIds.forInput(scope, JSON.stringify(input));
      const result = await serverCall(
        createTicketFollowUp({ data: [current.ticket.id, { commandId, ...input }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      if (!stillSelected()) return;
      await dependencies.refreshTicketDetail(current.ticket.id);
      const next = await serverCall(getTicketDetail({ data: [result.ticketId] }));
      if (!stillSelected()) return;
      dependencies.setSelectedTicketID(result.ticketId);
      dependencies.setDetail(next);
      dependencies.openWorkspaceTab({
        id: `ticket:${result.ticketId}`,
        view: "ticket",
        label: next.ticket.title,
        ticketID: result.ticketId,
      });
    });
  }

  async function ticketTrashCommand(ticketID: string, action: "trash" | "restore") {
    const ticket =
      dependencies.detail()?.ticket.id === ticketID
        ? dependencies.detail()?.ticket
        : dependencies.ticketList().find((item) => item.id === ticketID);
    if (action === "restore" && !ticket) return;
    await dependencies.mutate(async () => {
      if (action === "restore" && ticket)
        await serverCall(restoreTicket({ data: [ticketID, ticket.version] }));
      else await serverCall(trashTicket({ data: [ticketID] }));
      await dependencies.refreshServerState();
    });
  }

  function openCodingOptions(revisionID: string) {
    const projectID = dependencies.selectedProjectID();
    const ticket = dependencies.detail()?.ticket;
    if (!projectID || !ticket || !dependencies.canDevelopProject() || dependencies.selectedChange())
      return;
    const previous = dependencies.implementationPreparation();
    let reasoning =
      previous?.projectID === projectID &&
      previous.ticketID === ticket.id &&
      previous.revisionID === revisionID
        ? previous.reasoning
        : undefined;
    try {
      const saved = dependencies.agentCommandIds.latest(`implement:${ticket.id}`);
      if (saved) {
        const input = z
          .object({
            ticketID: z.literal(ticket.id),
            revisionID: z.literal(revisionID),
            codingReasoning: codingReasoningInput.optional(),
          })
          .safeParse(JSON.parse(saved.input));
        if (input.success) reasoning = input.data.codingReasoning;
      }
    } catch (cause) {
      dependencies.setError(
        cause instanceof Error ? cause.message : "Browser recovery is unavailable.",
      );
      return;
    }
    dependencies.setImplementationPreparation({
      projectID,
      ticketID: ticket.id,
      revisionID,
      reasoning,
      failure: undefined,
    });
    dependencies.setAgentOpen(true);
  }

  async function implementTicket(revisionID: string, codingReasoning?: CodingReasoning) {
    const projectID = dependencies.selectedProjectID();
    const ticket = dependencies.detail()?.ticket;
    if (!ticket || !projectID) return;
    const prepared = dependencies.preparingImplementation();
    const scope = `implement:${ticket.id}`;
    await dependencies.mutate(async () => {
      const technicalID = dependencies.detail()?.technicalDesigns?.[0]?.id;
      const options = {
        ...(codingReasoning ? { codingReasoning } : {}),
        ...(technicalID ? { technicalDesignRevisionId: technicalID } : {}),
      };
      const commandId = dependencies.agentCommandIds.forInput(
        scope,
        JSON.stringify({ ticketID: ticket.id, revisionID, ...options }),
      );
      try {
        await serverCall(
          requestImplementation({
            data: [ticket.id, { commandId, revisionId: revisionID, ...options }],
          }),
        );
      } catch (cause) {
        if (!prepared) throw cause;
        dependencies.setImplementationPreparation((current) =>
          current?.projectID === projectID &&
          current.ticketID === ticket.id &&
          current.revisionID === revisionID
            ? {
                ...current,
                failure:
                  cause instanceof Error ? cause.message : "Implementation response unavailable.",
              }
            : current,
        );
        return;
      }
      dependencies.acknowledgeCommand(scope, commandId);
      await dependencies.refreshServerState();
      if (
        prepared &&
        dependencies.implementationPreparation() === prepared &&
        dependencies.selectedProjectID() === projectID &&
        dependencies.selectedTicketID() === ticket.id &&
        dependencies.assistantTicketID() === ticket.id
      ) {
        dependencies.setImplementationPreparation(undefined);
        const change = dependencies.changeFor(ticket.id);
        if (change) dependencies.setCorrectionTarget(change.id);
      }
    });
  }

  async function approveDelivery(changeID: string) {
    await dependencies.mutate(async () => {
      const value = await serverCall(requestDeliveryApproval({ data: [changeID] }));
      if (dependencies.selectedChange()?.id === changeID) dependencies.setDelivery(value);
      await dependencies.refreshLifecycleState();
    });
  }

  async function retryReview(changeID: string) {
    const reviewId =
      dependencies.selectedChange()?.id === changeID
        ? dependencies.delivery()?.reviewId
        : undefined;
    if (!reviewId) return;
    const scope = dependencies.agentCommandScope("retry-review", changeID);
    await dependencies.mutate(async () => {
      const commandId = dependencies.agentCommandIds.forInput(
        scope,
        JSON.stringify({ changeID, reviewId }),
      );
      const value = await serverCall(
        retryCandidateReview({ data: [changeID, { commandId, reviewId }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      if (dependencies.selectedChange()?.id === changeID) dependencies.setDelivery(value);
      await dependencies.refreshLifecycleState();
    });
  }

  async function retryPromotion(changeID: string) {
    const promotionId =
      dependencies.selectedChange()?.id === changeID
        ? dependencies.delivery()?.promotionId
        : undefined;
    if (!promotionId) return;
    const scope = dependencies.agentCommandScope("retry-promotion", changeID);
    await dependencies.mutate(async () => {
      const commandId = dependencies.agentCommandIds.forInput(
        scope,
        JSON.stringify({ changeID, promotionId }),
      );
      const value = await serverCall(
        retryStagingPromotion({ data: [changeID, { commandId, promotionId }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      if (dependencies.selectedChange()?.id === changeID) dependencies.setDelivery(value);
      await dependencies.refreshLifecycleState();
    });
  }

  async function resumeChecks(changeID: string) {
    const target =
      dependencies.selectedChange()?.id === changeID ? dependencies.delivery() : undefined;
    const verificationId = target?.verificationId;
    const stopId = target?.checksStopId;
    if (!verificationId || !stopId) return;
    const scope = `checks-resume:${changeID}`;
    await dependencies.mutate(async () => {
      const input = { verificationId, stopId };
      const commandId = dependencies.agentCommandIds.forInput(scope, JSON.stringify(input));
      const value = await serverCall(
        resumeVerification({ data: [changeID, { commandId, ...input }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      if (dependencies.selectedChange()?.id === changeID) dependencies.setDelivery(value);
      await dependencies.refreshLifecycleState();
    });
  }

  return {
    saveTicketDocument,
    confirmRequirements,
    saveTechnicalDesign,
    confirmEpicWork,
    createFollowUp,
    ticketTrashCommand,
    openCodingOptions,
    implementTicket,
    approveDelivery,
    retryReview,
    retryPromotion,
    resumeChecks,
  };
}
