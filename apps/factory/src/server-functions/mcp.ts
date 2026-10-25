import { z } from "zod";
import type {
  mcpChoiceInput,
  mcpConnectInput,
  mcpReviewInput,
  mcpSaveInput,
} from "../../../../packages/conversation-domain/src/mcp-library";
import type { mcpGrantInput, mcpSharingInput } from "../mcp/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getMCPLibrary(projectID?: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().optional().parse(projectID);
    const context = factoryFunctionContext();
    return context.mcp.get(context.actorID, project);
  });
}
export async function saveMCPDefinition(input: z.input<typeof mcpSaveInput>) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.save(context.actorID, input);
  });
}
export async function saveMCPChoice(input: z.input<typeof mcpChoiceInput>) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.choose(context.actorID, input);
  });
}
export async function proposeMCPSharing(input: z.input<typeof mcpSharingInput>) {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.propose(context.actorID, input);
  });
}
export async function acceptMCPSharing(id: string) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.accept(context.actorID, identity);
  });
}
export async function connectMCP(id: string, input: z.input<typeof mcpConnectInput>) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.connect(context.actorID, identity, input);
  });
}
export async function reviewMCPAccess(id: string, input: z.input<typeof mcpReviewInput>) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.review(context.actorID, identity, input);
  });
}
export async function grantMCPProject(id: string, input: z.input<typeof mcpGrantInput>) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.grant(context.actorID, identity, input);
  });
}
export async function disconnectMCP(id: string) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.mcp.disconnect(context.actorID, identity);
  });
}
