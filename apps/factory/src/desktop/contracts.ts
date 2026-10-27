import type {
  Bootstrap,
  RequirementProposal,
  RequirementRevision,
  Session,
  TechnicalDesignRevision,
  Ticket,
  TicketDocumentRevision,
} from "../api-contracts";
import type { createProjectPlanning } from "../projects/planning";

export type FactoryDesktopProps = Pick<
  Bootstrap,
  "uiPreference" | "modelRelayConfigured" | "forgeOrigins"
> & { session: Session };

export type DesktopProject = NonNullable<
  ReturnType<ReturnType<typeof createProjectPlanning>["projects"]["data"]>
>[number];

export interface TicketDetail {
  ticket: Ticket;
  revisions: RequirementRevision[];
  documentRevisions: TicketDocumentRevision[];
  proposal?: RequirementProposal | null;
  origin: { id: string; title: string } | null;
  followUps: Array<{ id: string; title: string }>;
  technicalDesigns?: TechnicalDesignRevision[] | undefined;
  technicalDesignPresent?: boolean | undefined;
  technicalPlanningPending?: boolean | undefined;
  implementationOrder?: import("../api-contracts").TicketDetail["implementationOrder"];
}

export type ReadTicketDetail = (ticketID?: string) => Promise<TicketDetail | undefined>;

export type DesktopMutation = <T>(
  operation: () => Promise<T>,
  contextIsCurrent?: () => boolean,
  key?: string,
) => Promise<{ ok: true; value: Awaited<T> } | { ok: false; value?: never }>;
