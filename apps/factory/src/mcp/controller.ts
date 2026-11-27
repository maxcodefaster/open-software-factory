import type { MCPRole } from "#conversation-domain/mcp-library";
import type { DatabaseTransaction } from "#db/client";
import {
  admitMCPTurnIn,
  disconnectMCPConnection,
  grantMCPConnection,
  listMCPTurnAssignments,
  reviewMCPConnection,
} from "./controller-admission";
import { acceptMCPShare, chooseMCPDefault, proposeMCPShare } from "./controller-choices";
import { saveMCPLibraryCover, saveMCPLibraryEntry, viewMCPLibraryIn } from "./controller-library";
import {
  authorizeIn,
  connectionIn,
  type MCPDatabase,
  revisionIn,
  usableIn,
} from "./controller-types";

export { canonicalMCPJSON, type MCPConnection, mcpDigest } from "./controller-types";

export function createMCPLibrary(database: MCPDatabase) {
  return {
    authorizeIn,
    connectionIn,
    revisionIn,
    usableIn,
    viewIn: viewMCPLibraryIn,
    view: (userId: string, projectId?: string) =>
      database.client.begin((sql) => viewMCPLibraryIn(sql, userId, projectId)),
    save: (value: unknown, userId: string) => saveMCPLibraryEntry(database, value, userId),
    cover: (value: unknown, userId: string) => saveMCPLibraryCover(database, value, userId),
    choose: (value: unknown, userId: string) => chooseMCPDefault(database, value, userId),
    propose: (
      id: string,
      revisionId: string,
      target: "project" | "system",
      projectId: string | undefined,
      userId: string,
    ) => proposeMCPShare(database, id, revisionId, target, projectId, userId),
    accept: (id: string, userId: string) => acceptMCPShare(database, id, userId),
    review: (
      id: string,
      userId: string,
      version: number,
      selected: Array<{ name: string; digest: string }>,
    ) => reviewMCPConnection(database, id, userId, version, selected),
    grant: (
      id: string,
      projectId: string,
      userId: string,
      enabled: boolean,
      expectedVersion: number,
    ) => grantMCPConnection(database, id, projectId, userId, enabled, expectedVersion),
    disconnect: (id: string, userId: string) => disconnectMCPConnection(database, id, userId),
    admitIn: (
      sql: DatabaseTransaction,
      turnId: string,
      projectId: string,
      userId: string,
      role: MCPRole,
      personal = true,
    ) => admitMCPTurnIn(sql, turnId, projectId, userId, role, personal),
    assignments: (turnId: string) => listMCPTurnAssignments(database, turnId),
  };
}
