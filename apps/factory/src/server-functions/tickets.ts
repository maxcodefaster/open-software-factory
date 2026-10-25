import { z } from "zod";
import { implementationInput } from "../../../../packages/change-domain/src/implementation";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/content";
import {
  ticketDocumentInput,
  ticketFollowUpInput,
} from "../../../../packages/requirement-domain/src/document";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function createRequirementRevision(
  ticketID: string,
  input: z.input<typeof requirementContentInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      value = requirementContentInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.createRevision(context.actorID, id, value);
  });
}
export async function approveRequirementRevision(ticketID: string, revisionID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      revision = z.uuid().parse(revisionID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.approveRevision(context.actorID, id, revision);
  });
}
export async function startTicketChange(ticketID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.startChange(context.actorID, id);
  });
}

export async function getTicketDetail(ticketID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      context = factoryFunctionContext();
    return context.tickets.detail(context.actorID, id);
  });
}
export async function saveTicketDocument(
  ticketID: string,
  input: z.input<typeof ticketDocumentInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      value = ticketDocumentInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.save(context.actorID, id, value);
  });
}
export async function createTicketFollowUp(
  ticketID: string,
  input: z.input<typeof ticketFollowUpInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      value = ticketFollowUpInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.followUp(context.actorID, id, value);
  });
}
export async function trashTicket(ticketID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.trash(context.actorID, id);
  });
}
export async function restoreTicket(ticketID: string, expectedVersion: number) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      version = z.number().int().positive().parse(expectedVersion),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.restore(context.actorID, id, version);
  });
}
export async function implementTicket(
  ticketID: string,
  input: z.input<typeof implementationInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(ticketID),
      value = implementationInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.tickets.implement(context.actorID, id, value);
  });
}
