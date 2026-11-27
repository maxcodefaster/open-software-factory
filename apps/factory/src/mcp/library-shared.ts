import type { LibraryCover } from "#conversation-domain/library-covers";
import type { MCPDefinition, MCPLibraryView, MCPRole } from "#conversation-domain/mcp-library";
import { libraryCoverURL } from "../library-covers/catalog";

export type MCPScope = "personal" | "project" | "system";
export type MCPEntry = MCPLibraryView["entries"][number];
export type MCPDraft = {
  content: MCPDefinition;
  scope: MCPScope;
  projectId?: string;
  projectName?: string;
  entry?: MCPEntry;
};
export type MCPMonitoringSetup = {
  id: string;
  projectId: string;
  projectName: string;
};

export const cover = (provider: string, selected?: LibraryCover | null) =>
  selected
    ? libraryCoverURL(selected.key, "mcp")
    : `/art/mcp/${provider === "sentry" || provider === "datadog" ? provider : "custom"}.webp`;

export const endpointHost = (endpoint: string | undefined) =>
  endpoint ? new URL(endpoint).host : "";

export const scopeLabel = (scope: MCPScope) =>
  scope === "personal" ? "Personal" : scope === "project" ? "Project" : "Factory";

export const roleLabel = (role: MCPRole) => (role === "planning" ? "Investigate & Plan" : "Build");

export const stateLabel = (state: string | undefined) =>
  ({
    disconnected: "Not connected",
    authorizing: "Finish authorization",
    review: "Review read-only access",
    ready: "Connected",
    reconnect: "Reconnect required",
    revoked: "Disconnected",
  })[state ?? "disconnected"] ?? "Not connected";
