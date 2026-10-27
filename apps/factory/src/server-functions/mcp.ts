import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import type { libraryCoverInput } from "../../../../packages/conversation-domain/src/library-covers";
import type {
  mcpChoiceInput,
  mcpConnectInput,
  mcpReviewInput,
  mcpSaveInput,
} from "../../../../packages/conversation-domain/src/mcp-library";
import type { mcpGrantInput, mcpSharingInput } from "../mcp/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getMCPLibrary = createServerFn({
  method: "POST",
  strict: { input: false, output: false },
})
  .validator((args: [projectID?: string | undefined]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().optional().parse(projectID);
      const context = factoryFunctionContext();
      return context.mcp.get(context.actorID, project);
    });
  });
export const saveMCPDefinition = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof mcpSaveInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.save(context.actorID, input);
    });
  });
export const saveMCPCover = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof libraryCoverInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.cover(context.actorID, input);
    });
  });
export const saveMCPChoice = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof mcpChoiceInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.choose(context.actorID, input);
    });
  });
export const proposeMCPSharing = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof mcpSharingInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.propose(context.actorID, input);
    });
  });
export const acceptMCPSharing = createServerFn({ method: "POST" })
  .validator((args: [id: string]) => args)
  .handler(async ({ data: [id] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.accept(context.actorID, identity);
    });
  });
export const connectMCP = createServerFn({ method: "POST" })
  .validator((args: [id: string, input: z.input<typeof mcpConnectInput>]) => args)
  .handler(async ({ data: [id, input] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.connect(context.actorID, identity, input);
    });
  });
export const reviewMCPAccess = createServerFn({ method: "POST" })
  .validator((args: [id: string, input: z.input<typeof mcpReviewInput>]) => args)
  .handler(async ({ data: [id, input] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.review(context.actorID, identity, input);
    });
  });
export const grantMCPProject = createServerFn({ method: "POST" })
  .validator((args: [id: string, input: z.input<typeof mcpGrantInput>]) => args)
  .handler(async ({ data: [id, input] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.grant(context.actorID, identity, input);
    });
  });
export const disconnectMCP = createServerFn({ method: "POST" })
  .validator((args: [id: string]) => args)
  .handler(async ({ data: [id] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.mcp.disconnect(context.actorID, identity);
    });
  });
