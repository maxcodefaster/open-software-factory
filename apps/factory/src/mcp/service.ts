import type { z } from "zod";
import {
  mcpChoiceInput,
  mcpConnectInput,
  mcpLibraryView,
  mcpReviewInput,
  mcpSaveInput,
} from "../../../../packages/conversation-domain/src/mcp-library";
import { CommandError } from "../command-error";
import { mcpGrantInput, mcpSharingInput } from "./commands";
import type { createMCPConnections } from "./connections";

function command<T>(input: unknown, schema: z.ZodType<T>): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new CommandError("invalid", "Invalid MCP command");
  }
  if (new TextEncoder().encode(serialized).byteLength > 128_000)
    throw new CommandError("conflict", "MCP command is too large");
  return schema.parse(input);
}

export function createMCPService(
  connections: Pick<ReturnType<typeof createMCPConnections>, "library" | "connect">,
) {
  const library = connections.library;
  return {
    async get(userID: string, projectID?: string) {
      // Project grants and private ownership stay in the existing controller.
      // Validate the projection before native serialization, including SQL arrays.
      return mcpLibraryView.parse(await library.view(userID, projectID));
    },
    save(userID: string, input: z.input<typeof mcpSaveInput>) {
      return library.save(command(input, mcpSaveInput), userID);
    },
    choose(userID: string, input: z.input<typeof mcpChoiceInput>) {
      return library.choose(command(input, mcpChoiceInput), userID);
    },
    propose(userID: string, input: z.input<typeof mcpSharingInput>) {
      const value = command(input, mcpSharingInput);
      return library.propose(value.id, value.revisionId, value.target, value.projectId, userID);
    },
    accept(userID: string, id: string) {
      return library.accept(id, userID);
    },
    connect(userID: string, id: string, input: z.input<typeof mcpConnectInput>) {
      // An admitted credential exchange is not owned by a browser request.
      return connections.connect(id, userID, command(input, mcpConnectInput));
    },
    review(userID: string, id: string, input: z.input<typeof mcpReviewInput>) {
      const value = command(input, mcpReviewInput);
      return library.review(id, userID, value.expectedVersion, value.tools);
    },
    grant(userID: string, id: string, input: z.input<typeof mcpGrantInput>) {
      const value = command(input, mcpGrantInput);
      return library.grant(id, value.projectId, userID, value.enabled, value.expectedVersion);
    },
    disconnect(userID: string, id: string) {
      return library.disconnect(id, userID);
    },
  };
}
