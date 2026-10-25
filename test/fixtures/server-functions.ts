import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { APIRequestContext, APIResponse, Page, Route } from "@playwright/test";
import { decodeResponse, serializeString } from "@solidjs/web/server-functions/client";
import { agentActivityStream } from "../../apps/factory/src/agent/activity-stream";
import {
  type AgentView,
  agentViewSchema,
  type Bootstrap,
  type ConversationStreamEvent,
  conversationViewSchema,
} from "../../apps/factory/src/api-contracts";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { streamConversation } from "../../apps/factory/src/conversation-stream";
import type {
  FactoryFunctionContext,
  FactoryServices,
} from "../../apps/factory/src/server-functions/context";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import { serverCall } from "../../apps/factory/src/server-functions/result";

const serviceFunctions = {
  runtime: {
    startPersonalWorkspace: "startPersonal",
    startTicketWorkspace: "startTicket",
    stopRuntimeAttempt: "stop",
    cancelChange: "cancelChange",
    getChanges: "changes",
    getRuntimeAttempts: "attempts",
    getProjectPreviews: "previews",
    ensureStaging: "ensureStaging",
  },
  agent: {
    getAgentView: "get",
    getAgentActivity: "activity",
    startCoding: "start",
    resumeCoding: "resume",
    stopCoding: "stop",
    checkCodingStop: "checkStop",
    newCodingConversation: "newConversation",
    sendCodingPrompt: "prompt",
    requestCodingChanges: "requestChanges",
  },
  conversations: {
    getConversation: "get",
    newProjectConversation: "newConversation",
    sendConversationMessage: "message",
    setConversationMode: "mode",
    answerConversationQuestion: "answer",
    confirmEpicProposal: "confirmEpic",
  },
  delivery: {
    getDelivery: "get",
    approveDelivery: "approve",
    retryCandidateReview: "retryReview",
    resumeVerification: "resumeChecks",
  },
  projects: {
    getProjects: "list",
    registerProject: "register",
  },
  tickets: {
    createRequirementRevision: "createRevision",
    approveRequirementRevision: "approveRevision",
    startTicketChange: "startChange",
    getTicketDetail: "detail",
    saveTicketDocument: "save",
    createTicketFollowUp: "followUp",
    trashTicket: "trash",
    restoreTicket: "restore",
    implementTicket: "implement",
  },
  knowledge: {
    getKnowledgeGeneration: "generation",
    generateKnowledge: "generate",
    saveKnowledgePage: "save",
    archiveKnowledgePage: "archive",
    restoreKnowledgePage: "restore",
    getKnowledgeSources: "sources",
    getKnowledgeHistory: "history",
    searchKnowledge: "search",
    getRepositoryDocuments: "documents",
    getRepositoryDocument: "document",
  },
  workspaces: {
    getWorkspaceSource: "getSource",
    ensureWorkspaceSource: "ensureSource",
    ensurePersonalSource: "ensurePersonalSource",
    ensureChangeSource: "ensureChangeSource",
    stopWorkspaceSource: "stopSource",
    getDeveloperIDE: "getEditor",
    ensureDeveloperIDE: "ensureEditor",
    stopDeveloperIDE: "stopEditor",
  },
  attachments: {
    getAttachmentUsage: "usage",
    getAttachmentMetadata: "metadata",
    beginAttachment: "begin",
    retainAttachmentDraft: "retainDraft",
  },
  writer: {
    getChangeWriterStatus: "status",
    observeChangeWriter: "observe",
    takeOverChangeEditing: "takeOver",
    requestChangeEditing: "request",
    approveChangeEditing: "approve",
    releaseChangeEditing: "release",
    takeOverIdleEditing: "takeIdle",
    recordChangeEditingActivity: "activity",
  },
  review: {
    getVisualReview: "get",
    createReviewFeedback: "create",
    updateReviewFeedback: "update",
    sendReviewRevision: "send",
  },
  mcp: {
    getMCPLibrary: "get",
    saveMCPDefinition: "save",
    saveMCPChoice: "choose",
    proposeMCPSharing: "propose",
    acceptMCPSharing: "accept",
    connectMCP: "connect",
    reviewMCPAccess: "review",
    grantMCPProject: "grant",
    disconnectMCP: "disconnect",
  },
  inputs: {
    getProjectInputs: "get",
    saveProjectInput: "save",
    disableProjectInput: "disable",
    rotateProjectInput: "rotate",
  },
  skills: {
    getSkillLibrary: "library",
    getSkillInvocations: "invocations",
    previewSkillImport: "previewImport",
    previewRepositorySkill: "previewRepository",
    saveSkill: "save",
    saveSkillChoice: "choose",
    proposeSkillSharing: "propose",
    acceptSkillSharing: "accept",
    getSkillRevision: "revision",
    checkSkillSourceUpdate: "sourceUpdate",
    getInheritedSkills: "inherited",
    saveProjectSkills: "saveProject",
    savePersonalSkills: "savePersonal",
    getSystemSkills: "system",
    publishSkill: "publish",
    saveSystemSkills: "saveSystem",
    setSkillPublication: "setPublication",
  },
  setup: {
    getSetupDraft: "draft",
    beginSetupDraft: "begin",
    saveSetupDraft: "save",
    createSetupProject: "create",
    checkSetupProject: "check",
    retrySetupProject: "retry",
    getSetupInspection: "inspection",
    startSetupInspection: "inspect",
    confirmSetupInspection: "confirm",
    stopSetupInspection: "stop",
    getSetupReadiness: "readiness",
    retrySetupTask: "retryTask",
  },
  bootstrap: {
    getBootstrap: "get",
    getModelAvailability: "modelAvailability",
  },
  usage: {
    getUsage: "get",
    getCurrentCompute: "compute",
    saveUsage: "set",
    getContractPrices: "rates",
    saveContractPrices: "setRate",
  },
  models: {
    getModelSettings: "get",
    saveModelSettings: "set",
    getProjectModels: "inherited",
    saveProjectModels: "setProject",
    savePersonalModels: "setPersonal",
    getModelConnections: "catalogue",
    getModelConnection: "connection",
    saveModelConnection: "saveConnection",
    adoptDeploymentModelConnection: "adoptDeployment",
    selectModelRole: "selectRole",
  },
  environments: {
    getEnvironment: "get",
    saveEnvironment: "save",
    discardEnvironmentSave: "discard",
  },
  releases: {
    getProjectReleases: "view",
    publishProjectRelease: "publish",
    reconcileProjectRelease: "reconcile",
    createReleaseAccess: "createAccess",
    rotateReleaseAccess: "rotateAccess",
    revokeReleaseAccess: "revokeAccess",
    endProjectPublication: "end",
  },
  access: {
    getSecurityPolicy: "policy",
    getAuthenticationState: "authentication",
    getSignOutDestination: "signOutDestination",
    endOwnSessions: "endOwnSessions",
    getAccounts: "users",
    createAccount: "createUser",
    setAccountAccess: "setAccountAccess",
    endAccountSessions: "endAccountSessions",
    getProjectMembers: "members",
    saveProjectMember: "setMember",
    removeProjectMember: "removeMember",
    getIdentityConfiguration: "identityConfiguration",
    saveIdentityConfiguration: "saveIdentity",
    activateIdentityConfiguration: "activateIdentity",
  },
} as const;

type ServiceDoubles = { [K in keyof FactoryServices]?: Partial<FactoryServices[K]> };
type Functions = typeof import("../../apps/factory/src/server-functions/releases") &
  typeof import("../../apps/factory/src/server-functions/models") &
  typeof import("../../apps/factory/src/server-functions/runtime") &
  typeof import("../../apps/factory/src/server-functions/agent") &
  typeof import("../../apps/factory/src/server-functions/conversations") &
  typeof import("../../apps/factory/src/server-functions/tickets") &
  typeof import("../../apps/factory/src/server-functions/projects") &
  typeof import("../../apps/factory/src/server-functions/delivery") &
  typeof import("../../apps/factory/src/server-functions/knowledge") &
  typeof import("../../apps/factory/src/server-functions/workspaces") &
  typeof import("../../apps/factory/src/server-functions/attachments") &
  typeof import("../../apps/factory/src/server-functions/writer") &
  typeof import("../../apps/factory/src/server-functions/review") &
  typeof import("../../apps/factory/src/server-functions/mcp") &
  typeof import("../../apps/factory/src/server-functions/inputs") &
  typeof import("../../apps/factory/src/server-functions/skills") &
  typeof import("../../apps/factory/src/server-functions/setup") &
  typeof import("../../apps/factory/src/server-functions/bootstrap") &
  typeof import("../../apps/factory/src/server-functions/access") &
  typeof import("../../apps/factory/src/server-functions/environments") &
  typeof import("../../apps/factory/src/server-functions/usage");
type FunctionName = keyof Functions;
type BufferedFunctionName = Exclude<FunctionName, "getAgentActivity" | "sendConversationMessage">;
type FunctionResult<N extends FunctionName> = Awaited<ReturnType<Functions[N]>>;

// Standalone component builds have another Vite root and function hash. They
// still dispatch the same named function through the real production handler.
export async function compiledFactoryEndpoint(
  options: Omit<Parameters<typeof createServerFunctionEndpoint>[0], "handle" | "publicFunctionIDs">,
) {
  const directory = factoryBuildDirectory();
  const entry: typeof import("../../apps/factory/src/server-functions/entry") = await import(
    pathToFileURL(resolve(directory, "server/entry.js")).href
  );
  const manifest = JSON.parse(
    await readFile(resolve(directory, "client/.vite/solid-server-functions.json"), "utf8"),
  );
  const endpoint = createServerFunctionEndpoint({
    ...options,
    handle: entry.handleServerFunctionRequest,
    publicFunctionIDs: entry.publicFunctionIDs,
  });
  return (request: Request) => {
    const target = new URL(request.url);
    const name = target.pathname
      .split("/")
      .at(-1)
      ?.replace(/-[^-]+$/, "");
    const found = manifest.functions.find((item: { name: string }) => item.name === name);
    if (found) target.pathname = `/_server/data/${found.id}`;
    return endpoint(new Request(target, request));
  };
}

// UI fixtures use the actual compiled functions and wire encoder, injecting
// only service doubles. Unspecified functions go to the real owned server.
export async function mockFactoryFunctions(
  page: Page,
  services: ServiceDoubles,
  dropResponse?: (name: string) => boolean,
) {
  const entryURL = pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href;
  const entry: typeof import("../../apps/factory/src/server-functions/entry") = await import(
    entryURL
  );
  const manifest = JSON.parse(
    await readFile(
      resolve(factoryBuildDirectory(), "client/.vite/solid-server-functions.json"),
      "utf8",
    ),
  );
  const names = Object.entries(serviceFunctions).flatMap(([service, functions]) =>
    Object.entries(functions).flatMap(([name, method]) => {
      const double = services[service as keyof FactoryServices];
      return double && method in double ? [name] : [];
    }),
  );
  let network: ReturnType<typeof Bun.serve> | undefined;
  let networkOrigin: string | undefined;
  let networkOpening: Promise<ReturnType<typeof Bun.serve>> | undefined;
  page.once("close", () => {
    void network?.stop(true);
  });
  async function createStreamingEndpoint(origin: string) {
    if (network) {
      if (networkOrigin !== origin) throw new Error("Owned stream fixture changed browser origin");
      return network;
    }
    networkOrigin = origin;
    const endpoint = await compiledFactoryEndpoint({
      origin,
      services: services as FactoryServices,
      session: async () => ({ user: { id: "owned-browser-fixture" } }),
      maintenance: async () => false,
      requireFresh: async () => {},
    });
    network = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 180,
      async fetch(request) {
        const cors = {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-private-network": "true",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers":
            "content-type, x-server-function-format, x-server-function-id",
        };
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        const name = new URL(request.url).pathname
          .split("/")
          .at(-1)
          ?.replace(/-[^-]+$/, "");
        if (!name || !names.includes(name))
          return new Response(null, { status: 404, headers: cors });
        const response = await endpoint(request);
        // This controlled failure is after the named service has admitted its
        // work, not a second dispatch or a JSON/SSE compatibility encoder.
        if (dropResponse?.(name)) {
          await response.body?.cancel().catch(() => {});
          return new Response(null, { status: 502, headers: cors });
        }
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(cors)) headers.set(key, value);
        return new Response(response.body, { status: response.status, headers });
      },
    });
    if (page.isClosed()) await network.stop(true);
    return network;
  }
  function streamingEndpoint(origin: string) {
    if (networkOrigin && networkOrigin !== origin)
      throw new Error("Owned stream fixture changed browser origin");
    networkOrigin = origin;
    if (network) return Promise.resolve(network);
    networkOpening ??= createStreamingEndpoint(origin);
    return networkOpening;
  }
  const handler = async (route: Route) => {
    const name = new URL(route.request().url()).pathname
      .split("/")
      .at(-1)
      ?.replace(/-[^-]+$/, "");
    if (!name || !names.includes(name)) return route.fallback();
    // Isolated Vite fixtures use another root and therefore another function
    // hash. Resolve the same named function in this proof's compiled manifest.
    const compiled = manifest.functions.find((item: { name: string }) => item.name === name);
    if (!compiled) throw new Error(`Compiled fixture function is missing: ${name}`);
    const input = route.request();
    if (name === "getAgentActivity" || name === "sendConversationMessage") {
      // Playwright fulfilment buffers a body. Use a real native streaming
      // listener so provisional text, cancellation and reconnect remain real.
      const origin = new URL(input.url()).origin;
      const server = await streamingEndpoint(origin);
      const headers = await input.allHeaders();
      delete headers["host"];
      // DevTools URL overrides can otherwise taint Origin on the cross-port
      // hop. Preserve the authenticated native invocation's original origin.
      return route.continue({
        url: new URL(new URL(input.url()).pathname, server.url).href,
        headers: { ...headers, origin },
      });
    }
    const endpoint = createServerFunctionEndpoint({
      origin: new URL(input.url()).origin,
      services: services as FactoryServices,
      session: async () => ({ user: { id: "owned-browser-fixture" } }),
      maintenance: async () => false,
      requireFresh: async () => {},
      handle: entry.handleServerFunctionRequest,
      publicFunctionIDs: entry.publicFunctionIDs,
    });
    const body = input.postDataBuffer();
    const target = new URL(input.url());
    target.pathname = `/_server/data/${compiled.id}`;
    const response = await endpoint(
      new Request(target, {
        method: input.method(),
        headers: input.headers(),
        body: body ? new Uint8Array(body).buffer : null,
      }),
    );
    if (dropResponse?.(name)) return route.abort("failed");
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  };
  await page.route("**/_server/**", handler);
  return async () => {
    await page.unroute("**/_server/**", handler);
    await network?.stop(true);
  };
}

// Explicit controlled observations for components with scripted lifecycle
// state. The actual compiled function and production native stream encoder
// still run; no old HTTP route or hand-written SSE frame is involved.
export function agentActivityFixture(
  read: (userID: string, changeID: string, history?: boolean) => Promise<AgentView>,
): FactoryServices["agent"]["activity"] {
  return async (userID, changeID, signal, currentSession) =>
    agentActivityStream({
      signal,
      authorize: currentSession,
      read: () => read(userID, changeID, true),
      subscribe: async () => () => {},
      reconcileMS: 250,
      coalesceMS: 0,
    });
}

export function mockAgentView(
  page: Page,
  changeID: string,
  read: (changeID: string, history: boolean) => unknown | Promise<unknown>,
  options: { activity?: boolean; history?: boolean } = {},
) {
  const get: FactoryServices["agent"]["get"] = async (_actor, id, history = true) => {
    if (id !== changeID || (options.history !== undefined && history !== options.history))
      return serverCall(browserFunction(page, "getAgentView", [id, history]));
    return agentViewSchema.parse(await read(id, history));
  };
  return mockFactoryFunctions(page, {
    agent: { get, ...(options.activity ? { activity: agentActivityFixture(get) } : {}) },
  });
}

export function completedConversation(value: unknown): ReadableStream<ConversationStreamEvent> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "complete", conversation: conversationViewSchema.parse(value) });
      controller.close();
    },
  });
}

export function conversationCommand(
  base: string,
  projectID: string,
  input: Parameters<Functions["sendConversationMessage"]>[1],
  headers: HeadersInit = {},
  signal?: AbortSignal,
) {
  return streamConversation(
    (wire) =>
      serverCall(
        callFactoryFunction(base, "sendConversationMessage", [projectID, input], headers, wire),
      ),
    { signal },
    () => {},
  );
}

export async function browserConversation(
  page: Page,
  projectID: string,
  input: Parameters<Functions["sendConversationMessage"]>[1],
) {
  const base = new URL(page.url()).origin;
  const cookie = (await page.context().cookies(base))
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  return conversationCommand(base, projectID, input, { cookie });
}

export function mockUsageFunctions(
  page: Page,
  usage: FactoryFunctionContext["usage"],
  dropResponse?: () => boolean,
) {
  return mockFactoryFunctions(page, { usage }, dropResponse);
}

export function mockBootstrap(page: Page, transform: (value: Bootstrap) => Bootstrap) {
  return mockFactoryFunctions(page, {
    bootstrap: {
      async get() {
        return transform(await serverCall(browserFunction(page, "getBootstrap", [])));
      },
      async modelAvailability() {
        return transform(await serverCall(browserFunction(page, "getBootstrap", [])))
          .modelRelayConfigured;
      },
    },
  });
}

export async function browserBootstrap(page: Page) {
  const value = await serverCall(browserFunction(page, "getBootstrap", []));
  if (!value.session) throw new Error("Owned browser fixture requires an authenticated session");
  return { ...value, session: value.session };
}

export async function authenticatedBootstrap(base: string, headers: HeadersInit) {
  const value = await serverCall(callFactoryFunction(base, "getBootstrap", [], headers));
  if (!value.session) throw new Error("Owned Factory fixture requires an authenticated session");
  return { ...value, session: value.session };
}

// Use the compiler's manifest and native argument serializer in non-browser
// controller/live lanes too. IDs and the wire representation are not fixtures.
export async function factoryFunctionRequest(
  base: string,
  name: string,
  args: unknown[],
  headers: HeadersInit = {},
  signal?: AbortSignal,
) {
  const manifest = await Bun.file(
    resolve(factoryBuildDirectory(), "client/.vite/solid-server-functions.json"),
  ).json();
  const entry = manifest.functions.find((value: { name: string }) => value.name === name);
  if (!entry) throw new Error(`Compiled Factory function is missing: ${name}`);
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "text/plain");
  requestHeaders.set("x-server-function-format", "0");
  if (!requestHeaders.has("origin")) requestHeaders.set("origin", base);
  return new Request(`${base}/_server/data/${entry.id}`, {
    method: "POST",
    headers: requestHeaders,
    body: await serializeString(args),
    ...(signal ? { signal } : {}),
  });
}

export async function callFactoryFunction<N extends FunctionName>(
  base: string,
  name: N,
  args: Parameters<Functions[N]>,
  headers: HeadersInit = {},
  signal?: AbortSignal,
): Promise<FunctionResult<N>> {
  const result = await decodeResponse<FunctionResult<N>>(
    await fetch(await factoryFunctionRequest(base, name, args, headers, signal)),
  );
  if (result === undefined) throw new Error(`Factory function returned no result: ${name}`);
  return result as FunctionResult<N>;
}

export function browserFunction<N extends BufferedFunctionName>(
  page: Page,
  name: N,
  args: Parameters<Functions[N]>,
): Promise<FunctionResult<N>> {
  return requestFunction(page.request, name, args, new URL(page.url()).origin);
}

export async function requestFunction<N extends BufferedFunctionName>(
  client: APIRequestContext,
  name: N,
  args: Parameters<Functions[N]>,
  base = process.env["FACTORY_BROWSER_BASE_URL"] ?? "http://127.0.0.1:3000",
): Promise<FunctionResult<N>> {
  const request = await factoryFunctionRequest(base, name, args);
  const response = await client
    .fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      data: await request.text(),
    })
    .catch(() => {
      // Playwright transport errors include the complete request headers.
      // Retain the unconfirmed outcome without publishing session credentials.
      throw new Error(`Factory function response is unconfirmed: ${name}`);
    });
  return decodeBrowserFunction<FunctionResult<N>>(response);
}

export async function decodeBrowserFunction<T>(
  response: Pick<APIResponse, "body" | "status" | "headers">,
): Promise<T> {
  const result = await decodeResponse<T>(
    new Response(new Uint8Array(await response.body()).buffer, {
      status: response.status(),
      headers: response.headers(),
    }),
  );
  if (result === undefined) throw new Error("Factory function returned no result");
  return result as T;
}
