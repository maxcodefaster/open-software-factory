import { z } from "zod";
import { knowledgeEditInput } from "../../../../packages/knowledge-domain/src/knowledge";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getKnowledgeGeneration(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    return context.knowledge.generation(context.actorID, id);
  });
}
export async function generateKnowledge(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.knowledge.generate(context.actorID, id);
  });
}
export async function saveKnowledgePage(pageID: string, input: z.input<typeof knowledgeEditInput>) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(pageID),
      value = knowledgeEditInput.parse(input),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.knowledge.save(context.actorID, id, value);
  });
}
export async function archiveKnowledgePage(pageID: string, expectedVersion: number) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(pageID),
      version = z.number().int().positive().parse(expectedVersion),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.knowledge.archive(context.actorID, id, version);
  });
}
export async function restoreKnowledgePage(
  pageID: string,
  revisionID: string,
  expectedVersion: number,
) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(pageID),
      revision = z.uuid().parse(revisionID),
      version = z.number().int().positive().parse(expectedVersion),
      context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.knowledge.restore(context.actorID, id, revision, version);
  });
}
export async function getKnowledgeSources(pageID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(pageID),
      context = factoryFunctionContext();
    return context.knowledge.sources(context.actorID, id);
  });
}
export async function getKnowledgeHistory(pageID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(pageID),
      context = factoryFunctionContext();
    return context.knowledge.history(context.actorID, id);
  });
}
export async function searchKnowledge(projectID: string, query: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      text = z.string().parse(query),
      context = factoryFunctionContext();
    return context.knowledge.search(context.actorID, id, text);
  });
}
export async function getRepositoryDocuments(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      context = factoryFunctionContext();
    return context.knowledge.documents(context.actorID, id);
  });
}
export async function getRepositoryDocument(projectID: string, path: string) {
  "use server";
  return factoryFunction(async () => {
    const id = z.uuid().parse(projectID),
      value = z.string().min(1).parse(path),
      context = factoryFunctionContext();
    return context.knowledge.document(context.actorID, id, value);
  });
}
