import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { inboxReceiptInput, responsibilityInput } from "../inbox/contracts";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getInbox = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(() => {
      const context = factoryFunctionContext();
      return context.inbox.list(context.actorID);
    });
  });

export const getAttentionPeople = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(() => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      return context.inbox.people(context.actorID, id);
    });
  });

export const getTicketAttention = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string]) => args)
  .handler(async ({ data: [ticketID] }) => {
    return factoryFunction(() => {
      const id = z.uuid().parse(ticketID),
        context = factoryFunctionContext();
      return context.inbox.ticket(context.actorID, id);
    });
  });

export const setTicketResponsibility = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, input: z.input<typeof responsibilityInput>]) => args)
  .handler(async ({ data: [ticketID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        value = responsibilityInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.inbox.responsibility(context.actorID, id, value);
    });
  });

export const setTicketFollowing = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, following: boolean]) => args)
  .handler(async ({ data: [ticketID, following] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        value = z.boolean().parse(following),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.inbox.follow(context.actorID, id, value);
    });
  });

export const markInboxItem = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof inboxReceiptInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const value = inboxReceiptInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.inbox.receipt(context.actorID, value);
    });
  });
