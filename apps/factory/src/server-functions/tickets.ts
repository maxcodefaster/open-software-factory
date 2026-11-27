import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { implementationInput } from "#change-domain/implementation";
import { ticketDocumentInput, ticketFollowUpInput } from "#requirement-domain/document";
import { saveTechnicalDesignInput } from "#requirement-domain/technical-design";
import { factoryFunction, factoryFunctionContext } from "./context";
import { registerSharedReads } from "./shared-reads";

export const cancelTicketImplementation = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, commandID: string]) => args)
  .handler(async ({ data: [ticketID, commandID] }) =>
    factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      await context.tickets.cancelImplementation(
        context.actorID,
        z.uuid().parse(ticketID),
        z.uuid().parse(commandID),
      );
    }),
  );

export const saveTicketTechnicalDesign = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, input: z.input<typeof saveTechnicalDesignInput>]) => args)
  .handler(async ({ data: [ticketID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        value = saveTechnicalDesignInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.tickets.saveTechnicalDesign(context.actorID, id, value);
    });
  });

export const getTicketDetail = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string]) => args)
  .handler(async ({ data: [ticketID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        context = factoryFunctionContext();
      return context.tickets.detail(context.actorID, id);
    });
  });
export const saveTicketDocument = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, input: z.input<typeof ticketDocumentInput>]) => args)
  .handler(async ({ data: [ticketID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        value = ticketDocumentInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.tickets.save(context.actorID, id, value);
    });
  });
export const createTicketFollowUp = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, input: z.input<typeof ticketFollowUpInput>]) => args)
  .handler(async ({ data: [ticketID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        value = ticketFollowUpInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.tickets.followUp(context.actorID, id, value);
    });
  });
export const trashTicket = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string]) => args)
  .handler(async ({ data: [ticketID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.tickets.trash(context.actorID, id);
    });
  });
export const restoreTicket = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, expectedVersion: number]) => args)
  .handler(async ({ data: [ticketID, expectedVersion] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        version = z.number().int().positive().parse(expectedVersion),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.tickets.restore(context.actorID, id, version);
    });
  });
export const implementTicket = createServerFn({ method: "POST" })
  .validator((args: [ticketID: string, input: z.input<typeof implementationInput>]) => args)
  .handler(async ({ data: [ticketID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(ticketID),
        value = implementationInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.tickets.implement(context.actorID, id, value);
    });
  });

registerSharedReads(getTicketDetail);
