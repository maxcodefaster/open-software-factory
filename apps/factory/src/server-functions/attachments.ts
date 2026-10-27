import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { attachmentInput } from "../../../../packages/conversation-domain/src/attachments";
import { retainAttachmentDraftInput } from "../attachments/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getAttachmentUsage = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      return context.attachments.usage(project, context.actorID);
    });
  });

export const getAttachmentMetadata = createServerFn({ method: "POST" })
  .validator((args: [attachmentID: string]) => args)
  .handler(async ({ data: [attachmentID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(attachmentID),
        context = factoryFunctionContext();
      return context.attachments.metadata(context.actorID, id);
    });
  });

export const beginAttachment = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof attachmentInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const value = attachmentInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.attachments.begin(context.actorID, value);
    });
  });

export const retainAttachmentDraft = createServerFn({ method: "POST" })
  .validator(
    (
      args: [projectID: string, draftID: string, input: z.input<typeof retainAttachmentDraftInput>],
    ) => args,
  )
  .handler(async ({ data: [projectID, draftID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID),
        draft = z.uuid().parse(draftID),
        value = retainAttachmentDraftInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.attachments.retainDraft(context.actorID, project, draft, value);
    });
  });
