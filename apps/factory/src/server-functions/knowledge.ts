import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { knowledgeEditInput } from "../../../../packages/knowledge-domain/src/knowledge";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getKnowledgeGeneration = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      return context.knowledge.generation(context.actorID, id);
    });
  });
export const generateKnowledge = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.knowledge.generate(context.actorID, id);
    });
  });
export const saveKnowledgePage = createServerFn({ method: "POST" })
  .validator((args: [pageID: string, input: z.input<typeof knowledgeEditInput>]) => args)
  .handler(async ({ data: [pageID, input] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(pageID),
        value = knowledgeEditInput.parse(input),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.knowledge.save(context.actorID, id, value);
    });
  });
export const archiveKnowledgePage = createServerFn({ method: "POST" })
  .validator((args: [pageID: string, expectedVersion: number]) => args)
  .handler(async ({ data: [pageID, expectedVersion] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(pageID),
        version = z.number().int().positive().parse(expectedVersion),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.knowledge.archive(context.actorID, id, version);
    });
  });
export const restoreKnowledgePage = createServerFn({ method: "POST" })
  .validator((args: [pageID: string, revisionID: string, expectedVersion: number]) => args)
  .handler(async ({ data: [pageID, revisionID, expectedVersion] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(pageID),
        revision = z.uuid().parse(revisionID),
        version = z.number().int().positive().parse(expectedVersion),
        context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.knowledge.restore(context.actorID, id, revision, version);
    });
  });
export const getKnowledgeSources = createServerFn({ method: "POST" })
  .validator((args: [pageID: string]) => args)
  .handler(async ({ data: [pageID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(pageID),
        context = factoryFunctionContext();
      return context.knowledge.sources(context.actorID, id);
    });
  });
export const getKnowledgeHistory = createServerFn({ method: "POST" })
  .validator((args: [pageID: string]) => args)
  .handler(async ({ data: [pageID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(pageID),
        context = factoryFunctionContext();
      return context.knowledge.history(context.actorID, id);
    });
  });
export const searchKnowledge = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, query: string]) => args)
  .handler(async ({ data: [projectID, query] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        text = z.string().parse(query),
        context = factoryFunctionContext();
      return context.knowledge.search(context.actorID, id, text);
    });
  });
export const getRepositoryDocuments = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        context = factoryFunctionContext();
      return context.knowledge.documents(context.actorID, id);
    });
  });
export const getRepositoryDocument = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, path: string]) => args)
  .handler(async ({ data: [projectID, path] }) => {
    return factoryFunction(async () => {
      const id = z.uuid().parse(projectID),
        value = z.string().min(1).parse(path),
        context = factoryFunctionContext();
      return context.knowledge.document(context.actorID, id, value);
    });
  });
