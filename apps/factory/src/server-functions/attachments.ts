import { z } from "zod";
import { attachmentInput } from "../../../../packages/conversation-domain/src/attachments";
import { retainAttachmentDraftInput } from "../attachments/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getAttachmentUsage(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    return context.attachments.usage(project, context.actorID);
  });
}

export async function getAttachmentMetadata(attachmentID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(attachmentID),
      context = factoryFunctionContext();
    return context.attachments.metadata(context.actorID, id);
  });
}

export async function beginAttachment(input: z.input<typeof attachmentInput>) {
  "use server";
  return factoryFunction(async () => {
    const value = attachmentInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.attachments.begin(context.actorID, value);
  });
}

export async function retainAttachmentDraft(
  projectID: string,
  draftID: string,
  input: z.input<typeof retainAttachmentDraftInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID),
      draft = z.uuid().parse(draftID),
      value = retainAttachmentDraftInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.attachments.retainDraft(context.actorID, project, draft, value);
  });
}
