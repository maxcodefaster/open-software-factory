import type { z } from "zod";
import type { MCPLibraryView } from "#conversation-domain/mcp-library";
import {
  defaultInputInstructions,
  type monitoringChange,
  type monitoringSave,
  type monitoringView,
} from "#conversation-domain/monitoring";

export type MonitoringView = z.infer<typeof monitoringView>;
export type MonitoringHook = MonitoringView["hooks"][number];
export type MonitoringDraft = {
  projectId: string;
  projectName: string;
  input: z.infer<typeof monitoringSave>;
};
export type MonitoringOperation = {
  projectId: string;
  projectName: string;
  notice: string;
} & (
  | { action: "save"; input: z.output<typeof monitoringSave> }
  | { action: "disable" | "rotate"; id: string; input: z.output<typeof monitoringChange> }
);

export type MonitoringScreen =
  | { kind: "list"; rotatingHook?: MonitoringHook }
  | {
      kind: "edit";
      draft: MonitoringDraft;
      confirmedBasis: string;
      sourcePickerOpen: boolean;
    }
  | {
      kind: "secret";
      projectId: string;
      url: string;
      rotated: boolean;
      revealed: boolean;
    };

export type MonitoringCommandState =
  | { kind: "idle"; notice?: string }
  | { kind: "running"; operation: MonitoringOperation }
  | { kind: "failed"; message: string; retryable?: MonitoringOperation };

export const incidentStateLabel: Record<MonitoringView["incidents"][number]["state"], string> = {
  queued: "Queued",
  diagnosing: "Preparing requirements",
  prepared: "Ticket prepared",
  "insufficient-context": "More context needed",
  "not-application-defect": "No application fix",
  implementing: "Fix in progress",
  delivered: "Delivered",
  blocked: "Needs attention",
  uncertain: "Outcome unknown",
};

export const payloadExample = JSON.stringify(
  {
    id: "request-42",
    title: "Make invoice exports easier to find",
    description: "People cannot find the export action from the invoice list.",
    context: { source: "Product feedback" },
  },
  null,
  2,
);

export const formatMonitoringTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function createMonitoringDraft(
  project: { id: string; name: string },
  hook?: MonitoringHook,
  connectionId?: string,
): MonitoringDraft {
  return {
    projectId: project.id,
    projectName: project.name,
    input: {
      commandId: crypto.randomUUID(),
      id: hook?.id ?? crypto.randomUUID(),
      expectedVersion: hook?.version ?? 0,
      name: hook?.name ?? "",
      instructions: hook?.instructions ?? defaultInputInstructions,
      connectionIds: [
        ...new Set([...(hook?.connectionIds ?? []), ...(connectionId ? [connectionId] : [])]),
      ],
      enabled: true,
      delegation: hook?.delegation ?? "prepare-ticket",
    },
  };
}

export function monitoringSaveNotice(expectedVersion: number, wasEnabled: boolean): string {
  return expectedVersion > 0 && !wasEnabled
    ? "Input enabled for new requests. Earlier work is not resumed."
    : "Input enabled for new requests.";
}

export function resolveMonitoringSourceName(
  entries: MCPLibraryView["entries"],
  id: string,
): string {
  const source = entries.find((entry) => entry.id === id);
  return (
    source?.revisions.find((revision) => revision.id === source.connection?.revisionId)?.content
      .name ??
    source?.revisions[0]?.content.name ??
    "Unavailable source"
  );
}
