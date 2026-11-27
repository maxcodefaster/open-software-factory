import type { Session } from "../access/contracts";
import type { Bootstrap } from "../bootstrap/contracts";
import type {
  RequirementProposal,
  RequirementRevision,
  TechnicalDesignRevision,
  Ticket,
  TicketDocumentRevision,
} from "../change/contracts";
import type { ProjectSummary } from "../projects/contracts";

export type FactoryDesktopProps = Pick<
  Bootstrap,
  "uiPreference" | "modelRelayConfigured" | "forgeOrigins"
> & { session: Session };

export type DesktopProject = ProjectSummary;

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
  implementationOrder?: import("../change/contracts").TicketDetail["implementationOrder"];
}

export type ReadTicketDetail = (ticketID?: string) => Promise<TicketDetail | undefined>;

export type DesktopMutation = <T>(
  operation: () => Promise<T>,
  contextIsCurrent?: () => boolean,
  key?: string,
) => Promise<{ ok: true; value: Awaited<T> } | { ok: false; value?: never }>;
