import { getRequestEvent } from "@solidjs/web";
import type { createAccessService } from "../access/service";
import type { createWriterService } from "../access/writer-service";
import type { createAgentService } from "../agent/service";
import type { Bootstrap } from "../api-contracts";
import type { createAttachmentStore } from "../attachments/store";
import type { createBootstrapService } from "../bootstrap/service";
import type { createTicketService } from "../change/service";
import type { createDeliveryService } from "../delivery/service";
import type { createEnvironmentService } from "../environments/service";
import type { createInboxService } from "../inbox/service";
import type { createKnowledgeService } from "../knowledge/service";
import type { createLearningService } from "../learning/service";
import type { createMCPService } from "../mcp/service";
import type { createModelService } from "../models/service";
import type { createInputService } from "../monitoring/service";
import type { createConversationService } from "../project-agent/service";
import type { createProjectService } from "../projects/service";
import type { createReleaseController } from "../releases/controller";
import type { createReviewService } from "../review/service";
import type { createRuntimeService } from "../runtime/service";
import type { createSetupService } from "../setup/service";
import type { createSkillService } from "../skills/service";
import type { createUsageService } from "../usage/service";
import type { createWorkspaceService } from "../workspace/service";
import type { ServerResult } from "./result";

export type FactoryServices = {
  learning: ReturnType<typeof createLearningService>;
  inbox: ReturnType<typeof createInboxService>;
  releases: ReturnType<typeof createReleaseController>;
  usage: ReturnType<typeof createUsageService>;
  models: ReturnType<typeof createModelService>;
  environments: ReturnType<typeof createEnvironmentService>;
  access: ReturnType<typeof createAccessService>;
  bootstrap: ReturnType<typeof createBootstrapService>;
  setup: ReturnType<typeof createSetupService>;
  skills: ReturnType<typeof createSkillService>;
  mcp: ReturnType<typeof createMCPService>;
  inputs: ReturnType<typeof createInputService>;
  writer: ReturnType<typeof createWriterService>;
  review: ReturnType<typeof createReviewService>;
  attachments: Pick<
    ReturnType<typeof createAttachmentStore>,
    "usage" | "metadata" | "begin" | "retainDraft"
  >;
  workspaces: ReturnType<typeof createWorkspaceService>;
  knowledge: ReturnType<typeof createKnowledgeService>;
  tickets: ReturnType<typeof createTicketService>;
  projects: ReturnType<typeof createProjectService>;
  delivery: ReturnType<typeof createDeliveryService>;
  runtime: ReturnType<typeof createRuntimeService>;
  agent: ReturnType<typeof createAgentService>;
  conversations: ReturnType<typeof createConversationService>;
};

export type FactoryFunctionContext = FactoryServices & {
  actorID: string;
  signal: AbortSignal;
  assertSession(): Promise<void>;
  readBootstrap(): Promise<Bootstrap>;
  isFresh(): Promise<boolean>;
  beforeWrite(fresh: boolean): Promise<void>;
  run<T>(execute: () => Promise<T>): Promise<ServerResult<T>>;
};

export function factoryFunctionContext(): FactoryFunctionContext {
  const context = getRequestEvent()?.locals["factory"] as FactoryFunctionContext | undefined;
  if (!context) throw new Error("Missing authenticated Factory request context");
  return context;
}

export async function factoryFunction<T>(execute: () => Promise<T>): Promise<ServerResult<T>> {
  // The host owns error classification too. A compiled bundle must not create
  // another copy of an application's error classes and lose their identity.
  return factoryFunctionContext().run(execute);
}
