import type { createDatabase } from "../../../../packages/db/src/client";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import {
  candidateReviewPermissions,
  candidateReviewResultInput,
} from "../../../../packages/conversation-domain/src/candidate-review";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectAuthorityIn } from "../access/controller";
import type { createChangeWriterController } from "../access/writer-controller";
import { CommandError } from "../command-error";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { runtimeRepositoryCloneURL } from "../runtime/endpoints";
import { type RuntimeHub, RuntimeParentOperationError } from "../runtime/hub";
import type { RuntimeAttemptView } from "../runtime/types";
import { nativeSkillManifestInput, observedNativeSkillIds } from "../skills/native";
import { codingAllowanceDenial } from "../usage/opencode";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import type { createBuildBrowserController } from "./browser-controller";
import { createChangeAdmission } from "./change-admission";
import { createReviewAdmission } from "./review-admission";
import { createChangeAgentTransport } from "./change-transport";
import { createAgentCommitTransport } from "./commit-transport";
import {
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  ensureOpenCodeMessageBoundary,
  isOpenCodeObservationTransportError,
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
  syncOpenCodeInputGuidance,
} from "./opencode-client";
import { observeOpenCodeUsage } from "./opencode-usage";
import { createActivityWake, createOpenCodeEvents } from "./opencode-events";
import { connectOpenCodeBrowser } from "./opencode-browser";
import { createChangeAgentStop } from "./stop";
import { waitForBuildSandbox } from "./runtime-readiness";
import { readTurnObservation } from "./turn-observation";
import {
  assessBuildCompletion,
  buildCompletionText,
  type BuildCompletionContract,
} from "./build-completion";
import {
  type AgentTurnRecord,
  type AgentTurnTransaction,
  createAgentTurnStore,
} from "./turn-store";

type Database = ReturnType<typeof createDatabase>;
type RuntimeController = {
  startPersisted(changeID: string, userID: string): Promise<RuntimeAttemptView | null>;
};
type AgentRow = {
  changeID: string;
  projectID: string;
  ticketID: string;
  ticketTitle: string;
  branchName: string;
  baseSHA: string;
  runtimeAttemptID: string;
  runtimeState: string;
  state: "starting" | "working" | "waiting" | "stopped" | "failed" | "committed";
  sessionID: string | null;
  sessionConfirmed: boolean;
  implementationSessionID: string | null;
  implementationSessionConfirmed: boolean;
  activeInboxID: string | null;
  lastError: string | null;
  activeTurnID: string | null;
  stopPending: boolean;
  stopID: string | null;
};

const workspaceDirectory = "/workspace/project";

type TurnMessage = {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly completed?: number;
  readonly finish?: string;
  readonly error?: unknown;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
};

export function classifyAgentTurn(
  messages: readonly TurnMessage[],
  activeMessageID: string | null,
  sessionRunning: boolean,
  completionContract?: BuildCompletionContract,
) {
  if (!activeMessageID) return { state: "pending" as const };
  const userIndex = messages.findIndex(
    (message) => message.type === "user" && message.id === activeMessageID,
  );
  if (userIndex < 0 || sessionRunning) return { state: "pending" as const };
  // The pinned API returns newest-first messages. Only the interval after this
  // exact input belongs to it; timestamps can tie and are not causal identity.
  const interval = messages.slice(0, userIndex);
  if (interval.some((message) => message.type === "user")) return { state: "pending" as const };
  const assistant = interval.find((message) => message.type === "assistant");
  if (!assistant?.completed) return { state: "pending" as const };
  if (assistant.error || assistant.finish === "error") {
    return { state: "failed" as const, error: assistant.error };
  }
  if (assistant.finish === "stop") {
    const completion = assessBuildCompletion(
      completionContract,
      assistant.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? "",
    );
    return completion.ready
      ? {
          state: "succeeded" as const,
          ...(completion.summary ? { summary: completion.summary } : {}),
        }
      : { state: "failed" as const, error: completion.error };
  }
  if (["length", "content-filter", "unknown"].includes(assistant.finish ?? "")) {
    return {
      state: "failed" as const,
      error: `OpenCode stopped with ${assistant.finish}`,
    };
  }
  return { state: "pending" as const };
}

function opencode(hub: RuntimeHub, attemptID: string) {
  return createOpenCodeClient((request, path) => hub.request(attemptID, "agent", request, path));
}

function bounded(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function readableError(value: unknown) {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    if ("message" in value && typeof value.message === "string") return value.message;
    if ("data" in value && value.data && typeof value.data === "object") {
      if ("message" in value.data && typeof value.data.message === "string") {
        return value.data.message;
      }
    }
  }
  return typeof value === "string" ? value : "OpenCode run failed";
}

async function awaitConfiguredModel(
  client: ReturnType<typeof opencode>,
  modelID: string,
  authorized: () => Promise<boolean>,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await authorized()))
      throw new CommandError(
        "conflict",
        "Implementation startup was stopped or its authority changed",
      );
    try {
      await client.server.info({ signal: AbortSignal.timeout(2_000) });
      if (!(await authorized()))
        throw new CommandError("conflict", "Build authority changed during startup");
      const models = await client.model.list(
        { location: { directory: workspaceDirectory } },
        { signal: AbortSignal.timeout(2_000) },
      );
      if (models.data.some((model) => model.providerID === "factory" && model.id === modelID))
        return;
    } catch (cause) {
      if (cause instanceof CommandError) throw cause;
      // Only read-only readiness probes retry. No Session or prompt has been dispatched.
    }
    await Bun.sleep(500);
  }
  throw new Error(
    "OpenCode and the configured Factory model did not become ready. The IDE remains available.",
  );
}

type ActivityStatus = "pending" | "streaming" | "running" | "completed" | "error";

function activityStatus(value: string): ActivityStatus | undefined {
  switch (value) {
    case "pending":
    case "streaming":
    case "running":
    case "completed":
    case "error":
      return value;
    default:
      return undefined;
  }
}

type ProjectToolState = {
  status: string;
  input?: unknown | undefined;
  content?: ReadonlyArray<{ type: string; text?: string | undefined }> | undefined;
  metadata?: Record<string, unknown> | undefined;
};

type ProjectMessageContent = {
  id?: string | undefined;
  type: string;
  text?: string | undefined;
  name?: string | undefined;
  state?: ProjectToolState | undefined;
  time?: { created: number; completed?: number; ran?: number } | undefined;
};

type ProjectMessage = {
  id: string;
  type: string;
  time: { created: number; completed?: number; ran?: number };
  text?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  content?: ReadonlyArray<ProjectMessageContent> | undefined;
  status?: string | undefined;
  exit?: number | string | undefined;
  output?: { output?: string | undefined } | undefined;
  command?: string | undefined;
};

function isProjectMessage(value: unknown): value is ProjectMessage {
  if (!value || typeof value !== "object") return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if (!("type" in value) || typeof value.type !== "string") return false;
  if (!("time" in value) || !value.time || typeof value.time !== "object") return false;
  if (!("created" in value.time) || typeof value.time.created !== "number") return false;
  return !("content" in value) || value.content === undefined || Array.isArray(value.content);
}

export type AgentProjectedMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  at: number;
  activity?: {
    name: string;
    status: ActivityStatus;
    detail?: string;
  };
};

function objectString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function toolSummary(name: string, input: unknown) {
  const path = objectString(input, "path") ?? objectString(input, "file");
  const command = objectString(input, "command");
  const query = objectString(input, "query") ?? objectString(input, "pattern");
  if (["write", "edit", "apply_patch"].includes(name) && path) return `Updated ${path}`;
  if (name === "read" && path) return `Read ${path}`;
  if (["bash", "shell"].includes(name) && command) return command;
  if (["grep", "glob", "search"].includes(name) && query) return `Searched for ${query}`;
  return name.replaceAll("_", " ");
}

function toolDetail(state: {
  status: string;
  content?: ReadonlyArray<{ type: string; text?: string | undefined }> | undefined;
  error?: unknown | undefined;
}) {
  const output = state.content
    ?.filter((item) => item.type === "text" && item.text?.trim())
    .map((item) => item.text?.trim())
    .join("\n");
  if (output) return bounded(output, 4_000);
  if (state.status === "error" && state.error) return bounded(readableError(state.error), 1_000);
  return null;
}

function isFactoryBootstrapMessage(message: { text: string; metadata?: Record<string, unknown> }) {
  return (
    message.metadata?.["factoryBootstrap"] === true ||
    (message.text.startsWith("Implement the approved ticket: ") &&
      message.text.includes("\nApproved specification:\n") &&
      message.text.endsWith(
        "Do not commit or push; the Factory does that after you finish successfully.",
      ))
  );
}

export function projectMessages(
  messages: unknown,
  admittedInputs?: ReadonlyMap<string, string | null>,
) {
  if (!messages || typeof messages !== "object" || !("data" in messages)) return [];
  if (!Array.isArray(messages.data)) return [];
  return messages.data
    .filter(isProjectMessage)
    .slice(0, 100)
    .reverse()
    .flatMap<AgentProjectedMessage>((message) => {
      if (message.type === "user") {
        if (typeof message.text !== "string") return [];
        const admittedText = admittedInputs?.get(message.id);
        if (admittedText === null) return [];
        if (
          admittedText === undefined &&
          isFactoryBootstrapMessage({
            text: message.text,
            ...(message.metadata ? { metadata: message.metadata } : {}),
          })
        ) {
          return [];
        }
        return [
          {
            id: message.id,
            role: "user",
            text: bounded(admittedText ?? message.text, 8_000),
            at: message.time.created,
          },
        ];
      }
      if (message.type === "assistant") {
        let textOrdinal = 0;
        let toolOrdinal = 0;
        return (message.content ?? []).flatMap<AgentProjectedMessage>((content) => {
          const ordinal =
            content.type === "text" ? textOrdinal++ : content.type === "tool" ? toolOrdinal++ : 0;
          if (content.type === "text" && content.text?.trim()) {
            return [
              {
                id: `${message.id}:text:${ordinal}`,
                role: "assistant",
                text: bounded(buildCompletionText(content.text), 8_000),
                at: message.time.created,
              },
            ];
          }
          if (content.type === "tool" && content.name && content.state && content.time) {
            const status = activityStatus(content.state.status);
            if (!status) return [];
            const browserPrefix = "factory_browser_browser_";
            const browserAction = content.name.startsWith(browserPrefix)
              ? content.name.slice(browserPrefix.length)
              : undefined;
            const input = status === "streaming" ? null : content.state.input;
            const detail = toolDetail(content.state);
            return [
              {
                id: `${message.id}:tool:${content.id ?? ordinal}`,
                role: "tool",
                text: bounded(toolSummary(browserAction ?? content.name, input), 500),
                at: content.time.created,
                activity: {
                  name: browserAction ? "browser" : content.name,
                  status,
                  ...(detail ? { detail } : {}),
                },
              },
            ];
          }
          return [];
        });
      }
      if (message.type === "shell") {
        if (!message.command) return [];
        const status: ActivityStatus =
          message.status === "running"
            ? "running"
            : message.status === "exited" && message.exit === 0
              ? "completed"
              : "error";
        const detail = message.output?.output?.trim();
        return [
          {
            id: message.id,
            role: "tool",
            text: bounded(message.command, 500),
            at: message.time.created,
            activity: {
              name: "shell",
              status,
              ...(detail ? { detail: bounded(detail, 4_000) } : {}),
            },
          },
        ];
      }
      return [];
    });
}

export function createAgentController(
  database: Database,
  hub: RuntimeHub,
  runtime: RuntimeController,
  browser?: ReturnType<typeof createBuildBrowserController>,
  writers?: Pick<ReturnType<typeof createChangeWriterController>, "prepareAgent">,
) {
  const monitors = new Set<string>();
  const observationController = new AbortController();
  const nativeEvents = createOpenCodeEvents((attemptID) => opencode(hub, attemptID));
  const activityListeners = new Map<
    string,
    Set<{
      notify(): void;
      attemptID?: string;
      detach?: () => void;
    }>
  >();
  function notifyActivity(changeID?: string) {
    for (const [id, listeners] of activityListeners)
      if (!changeID || id === changeID) for (const listener of listeners) listener.notify();
  }
  function bindActivity(changeID: string, attemptID?: string) {
    if (closed) return;
    for (const listener of activityListeners.get(changeID) ?? []) {
      if (listener.attemptID === attemptID) continue;
      const detach = attemptID ? nativeEvents.subscribe(attemptID, listener.notify) : undefined;
      listener.detach?.();
      if (attemptID) listener.attemptID = attemptID;
      else delete listener.attemptID;
      if (detach) listener.detach = detach;
      else delete listener.detach;
    }
  }
  const starters = new Set<string>();
  const recovering = new Set<string>();
  const committing = new Map<string, Promise<void>>();
  const turns = createAgentTurnStore(database);
  async function recordNativeSkillLoads(
    turnID: string,
    ownerToken: string,
    promptID: string | null,
    messages: readonly unknown[],
  ) {
    if (!promptID) return;
    const intent = await admission.intent(turnID);
    if (intent.skillLoading !== "native") return;
    const [turn] = await database.client<
      Array<{ ids: string[] }>
    >`SELECT ARRAY(SELECT jsonb_array_elements_text(authority->'skillRevisionIds')) AS ids FROM factory.agent_turn WHERE id = ${turnID}`;
    const loaded = observedNativeSkillIds(messages, promptID, turn?.ids ?? []);
    if (loaded.length)
      await turns.validateExecution(turnID, ownerToken, async (sql) => {
        for (const id of loaded)
          await sql`INSERT INTO factory.agent_turn_skill(turn_id, revision_id) VALUES (${turnID}, ${id}) ON CONFLICT DO NOTHING`;
      });
  }
  const usageJournal = createRecordedOpenCodeUsage(database);
  const modelSettings = createModelSettingsController(database);
  const modelConnections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    process.env["FACTORY_AUTH_SECRET"] ?? "local-development-secret-change-before-production",
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [],
  );
  const admission = createChangeAdmission(
    database,
    (sql, context) => modelSettings.resolve("build", sql, context),
    (sql) => modelConnections.reference("build", sql),
  );
  const stop = createChangeAgentStop(database, hub);
  const admitReview = createReviewAdmission(database);
  const commitTransport = createAgentCommitTransport(database, hub);
  const background = new Set<Promise<void>>();
  let closed = false;

  function run(work: Promise<void>) {
    background.add(work);
    void work
      .catch(() => {})
      .finally(() => {
        background.delete(work);
        notifyActivity();
      });
  }

  async function row(changeID: string) {
    const rows = await database.client<AgentRow[]>`
      SELECT change.id AS "changeID", change.project_id AS "projectID",
        change.ticket_id AS "ticketID", ticket.title AS "ticketTitle",
        change.branch_name AS "branchName", change.base_sha AS "baseSHA",
        session.runtime_attempt_id AS "runtimeAttemptID", attempt.state AS "runtimeState",
        session.state, session.opencode_session_id AS "sessionID",
        session.native_session_confirmed_at IS NOT NULL AS "sessionConfirmed",
        COALESCE(session.implementation_session_id,session.opencode_session_id) AS "implementationSessionID",
        COALESCE(session.implementation_session_confirmed_at,session.native_session_confirmed_at) IS NOT NULL AS "implementationSessionConfirmed",
        session.active_inbox_id AS "activeInboxID", session.last_error AS "lastError",
        session.active_turn_id AS "activeTurnID", session.stop_pending AS "stopPending",
        session.stop_id AS "stopID"
      FROM factory.change_agent_session session
      JOIN factory.change change ON change.id = session.change_id
      JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.runtime_attempt attempt ON attempt.id = session.runtime_attempt_id
      WHERE session.change_id = ${changeID}
    `;
    return rows[0] ?? null;
  }

  async function confirmNativeSession(
    changeID: string,
    turnID: string,
    attemptID: string,
    sessionID: string,
  ) {
    const confirmed = await database.client`
      UPDATE factory.change_agent_session
      SET native_session_confirmed_at = COALESCE(native_session_confirmed_at, now()),
        implementation_session_confirmed_at = CASE WHEN implementation_session_id = ${sessionID}
          THEN COALESCE(implementation_session_confirmed_at, now()) ELSE implementation_session_confirmed_at END
      WHERE change_id = ${changeID} AND active_turn_id = ${turnID}
        AND runtime_attempt_id = ${attemptID} AND opencode_session_id = ${sessionID}
        AND state <> 'stopped' AND NOT stop_pending
    `;
    if (confirmed.count !== 1)
      throw new CommandError(
        "conflict",
        "Native Session confirmation no longer matches this Build",
      );
  }

  async function currentChange(changeID: string) {
    const rows = await database.client<
      Array<{
        changeID: string;
        runtimeAttemptID: string | null;
        runtimeState: string | null;
        changeState: string;
      }>
    >`
      SELECT change.id AS "changeID", change.runtime_attempt_id AS "runtimeAttemptID",
        attempt.state AS "runtimeState", change.state AS "changeState"
      FROM factory.change change
      LEFT JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id
      WHERE change.id = ${changeID}
    `;
    const change = rows[0];
    if (!change) throw new CommandError("not-found", "Change not found");
    if (!["active", "starting"].includes(change.changeState)) {
      if (
        change.changeState === "failed" &&
        ["failed", "stopped", "cleanup-failed"].includes(change.runtimeState ?? "")
      )
        throw new CommandError(
          "unavailable",
          "The implementation Workspace failed to start. Source is retained. Retry implementation from this Ticket.",
        );
      throw new CommandError("conflict", "Change is not active");
    }
    return change;
  }

  async function awaitReadyChange(changeID: string, turnID: string, attemptID: string) {
    return waitForBuildSandbox(
      attemptID,
      async () => {
        const session = await row(changeID);
        const change = await currentChange(changeID);
        return {
          active:
            session?.state === "starting" &&
            session.activeTurnID === turnID &&
            !session.stopPending,
          runtimeAttemptID: change.runtimeAttemptID,
          runtimeState: change.runtimeState,
        };
      },
      () => closed,
    );
  }

  async function execute(turnID: string) {
    if (closed || starters.has(turnID)) return;
    starters.add(turnID);
    let owned: AgentTurnRecord | null = null;
    let renew: ReturnType<typeof setInterval> | undefined;
    let dispatched = false;
    try {
      // Branch creation is independently recovered. A recorded bootstrap waits
      // for that outcome without claiming a lease or dispatching any inference.
      const [branch] = await database.client<Array<{ state: string }>>`SELECT change.state
        FROM factory.agent_turn turn JOIN factory.change change ON change.id = turn.change_id
        WHERE turn.id = ${turnID}`;
      if (branch?.state === "branch-pending") return;
      owned = await turns.claimPending(turnID);
      if (!owned?.ownerToken || owned.authority.mode !== "build" || !("changeId" in owned.command))
        return;
      const ownerToken = owned.ownerToken;
      const userID = owned.command.createdBy;
      const skillRevisionIDs = owned.authority.skillRevisionIds;
      const changeID = owned.command.changeId;
      const intent = await admission.intent(turnID);
      renew = setInterval(() => {
        void renewExecution(turnID, ownerToken).catch(() => {});
      }, 10_000);
      if (!writers)
        throw new CommandError("unavailable", "Change writer enforcement is not configured");
      if (!(await writers.prepareAgent(changeID, turnID))) {
        await turns.releasePending(turnID, ownerToken);
        return;
      }
      if (!(await turns.validateExecution(turnID, ownerToken)))
        throw new CommandError("conflict", "Build authority changed before runtime startup");
      let current = await currentChange(changeID);
      if (intent.attemptID && intent.attemptID !== current.runtimeAttemptID) {
        throw new Error("The recorded runtime generation changed before Build dispatch");
      }
      if (!current.runtimeAttemptID || current.runtimeState !== "ready") {
        await runtime.startPersisted(changeID, userID);
        current = await currentChange(changeID);
      }
      if (!current.runtimeAttemptID) throw new Error("Ticket Sandbox was not created");
      const attemptID = current.runtimeAttemptID;
      const prepared = await database.client.begin(async (sql) => {
        const active = await sql<Array<{ id: string }>>`SELECT id FROM factory.agent_turn
          WHERE id = ${turnID} AND state = 'pending' AND owner_token = ${ownerToken}
            AND owner_expires_at > clock_timestamp() FOR UPDATE`;
        if (!active[0]) return false;
        await sql`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id = ${attemptID}
          WHERE turn_id = ${turnID} AND runtime_attempt_id IS NULL`;
        await sql`INSERT INTO factory.change_agent_session(
          change_id, runtime_attempt_id, opencode_session_id, state, created_by, active_turn_id,
          implementation_session_id
        ) VALUES (${changeID}, ${attemptID}, ${intent.sessionID}, 'starting', ${userID}, ${turnID},
          ${owned?.authority.mode === "build" && owned.authority.review ? null : intent.sessionID})
        ON CONFLICT (change_id) DO UPDATE SET runtime_attempt_id = EXCLUDED.runtime_attempt_id,
          implementation_session_id = COALESCE(EXCLUDED.implementation_session_id,
            factory.change_agent_session.implementation_session_id,factory.change_agent_session.opencode_session_id),
          implementation_session_confirmed_at = COALESCE(factory.change_agent_session.implementation_session_confirmed_at,
            CASE WHEN factory.change_agent_session.implementation_session_id IS NULL THEN factory.change_agent_session.native_session_confirmed_at END),
          native_session_confirmed_at = CASE
            WHEN factory.change_agent_session.opencode_session_id IS NOT DISTINCT FROM EXCLUDED.opencode_session_id
              THEN factory.change_agent_session.native_session_confirmed_at END,
          opencode_session_id = EXCLUDED.opencode_session_id, state = 'starting', active_turn_id = EXCLUDED.active_turn_id,
          active_inbox_id = NULL, last_error = NULL, updated_at = now()`;
        return true;
      });
      if (!prepared) return;
      if (
        (
          await database.client`SELECT attempt_id FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`
        ).length
      ) {
        await turns.releasePending(turnID, ownerToken);
        return;
      }
      const change = await awaitReadyChange(changeID, turnID, attemptID);
      const client = createOpenCodeClient(
        createChangeAgentTransport(database, hub, change.runtimeAttemptID, turnID, ownerToken),
      );
      await awaitConfiguredModel(client, owned.authority.modelId, () =>
        closed ? Promise.resolve(false) : turns.validateExecution(turnID, ownerToken),
      );
      if (intent.skillLoading === "native") {
        const manifest = nativeSkillManifestInput.parse(intent.skillManifest);
        if (manifest.files.length > 0)
          await hub.parentOperation(
            attemptID,
            {
              operationId: `${attemptID}-skills-${manifest.digest}`,
              action: "skills-install",
              data: JSON.stringify(manifest),
            },
            async (send) => {
              if (
                !(await turns.validateExecution(turnID, ownerToken, async () => {
                  send();
                }))
              )
                throw new CommandError(
                  "conflict",
                  "Build authority changed before skill installation",
                );
            },
          );
        const expected = skillRevisionIDs.map((id) => `factory-${id}`).sort();
        let ready = false;
        for (let probe = 0; probe < 40; probe++) {
          const observed = (
            await client.skill.list({ location: { directory: workspaceDirectory } })
          ).data
            .filter((item) => !item.path.startsWith("/builtin/"))
            .map((item) => item.id)
            .sort();
          if (JSON.stringify(observed) === JSON.stringify(expected)) {
            ready = true;
            break;
          }
          await Bun.sleep(250);
        }
        if (!ready) throw new Error("Native skills do not match the exact admitted packages");
      }
      if (!(await turns.beginDispatch(turnID, ownerToken))) {
        if (
          (
            await database.client`SELECT turn_id FROM factory.coding_pause WHERE turn_id=${turnID} AND resumed_by_turn_id IS NULL`
          ).length
        )
          return;
        throw new CommandError("conflict", "Build authority changed before dispatch");
      }
      dispatched = true;
      const session = intent.bootstrap
        ? await client.session.create({
            id: intent.sessionID,
            title: intent.title,
            location: { directory: workspaceDirectory },
            model: { providerID: "factory", id: owned.authority.modelId },
            permissions: owned.authority.review
              ? candidateReviewPermissions
              : [
                  { action: "*", resource: "*", effect: "allow" },
                  ...(intent.skillLoading === "native"
                    ? [
                        { action: "skill", resource: "*", effect: "deny" as const },
                        ...skillRevisionIDs.map((id) => ({
                          action: "skill",
                          resource: `factory-${id}`,
                          effect: "allow" as const,
                        })),
                      ]
                    : []),
                ],
          })
        : await client.session.get({ sessionID: intent.sessionID });
      if (
        session.id !== intent.sessionID ||
        session.location.directory !== workspaceDirectory ||
        session.model?.providerID !== "factory" ||
        session.model.id !== owned.authority.modelId
      ) {
        throw new Error("The retained OpenCode session does not match its recorded configuration");
      }
      await confirmNativeSession(changeID, turnID, attemptID, intent.sessionID);
      if (!(await turns.validateExecution(turnID, ownerToken)))
        throw new CommandError("conflict", "Build authority changed before prompt submission");
      await ensureOpenCodeMessageBoundary(client, intent.sessionID);
      await usageJournal.prepare(turnID, client, intent.sessionID);
      if (intent.skillLoading === "native") await syncOpenCodeInputGuidance(client, intent);
      if (owned.authority.review)
        await client.session.instructions.entry.put({
          sessionID: intent.sessionID,
          key: "factory-review-policy",
          value: intent.text,
        });
      const browserGrant = await browser?.prepare(turnID, ownerToken);
      if (intent.browserTransport === "mcp" && browserGrant)
        await connectOpenCodeBrowser(
          client,
          browserGrant.runtimeEndpoint,
          browserGrant.runtimeBearer,
        );
      const inbox = await promptRecordedOpenCodeInput(client, intent, true);
      if (inbox.id !== intent.promptID)
        throw new Error("OpenCode returned another prompt identity");
      const running = await turns.markRunning(turnID, ownerToken, async (sql) => {
        for (const revisionID of intent.skillLoading === "eager" ? skillRevisionIDs : []) {
          await sql`INSERT INTO factory.agent_turn_skill(turn_id, revision_id)
            VALUES (${turnID}, ${revisionID}) ON CONFLICT DO NOTHING`;
        }
        const rows = await sql<Array<{ id: string }>>`UPDATE factory.change_agent_session
          SET state = 'working', active_inbox_id = ${intent.promptID}, last_error = NULL, updated_at = now()
          WHERE change_id = ${changeID} AND state = 'starting' AND active_turn_id = ${turnID}
          RETURNING change_id AS id`;
        if (!rows[0])
          throw new CommandError("conflict", "Build ownership changed before recording dispatch");
        if (owned?.authority.mode === "build" && owned.authority.review)
          await sql`UPDATE factory.candidate_review SET state='running'
            WHERE id=${owned.authority.review.reviewId} AND turn_id=${turnID} AND state='pending'`;
      });
      if (!running) {
        // The accepted prompt may still be running, or Stop may already have
        // released this Session to another turn. Only settle our owned record;
        // a late response must never interrupt the Session's newer work.
        throw new CommandError("conflict", "Build authority changed after prompt acceptance");
      }
      // monitor owns renewal until this exact turn settles.
      await monitor(changeID, userID, owned.id, ownerToken);
    } catch (cause) {
      if (closed) return;
      if (owned?.ownerToken && "changeId" in owned.command) {
        const summary = bounded(readableError(cause), 2_000);
        const changed = dispatched
          ? await turns.settle(turnID, owned.ownerToken, "uncertain", summary)
          : await turns.failPending(turnID, owned.ownerToken, summary);
        if (changed)
          await database.client`UPDATE factory.change_agent_session SET state = 'failed',
          last_error = ${dispatched ? `Execution outcome uncertain. Stop or resolve this turn before new Build work. ${summary}` : summary},
          updated_at = now() WHERE active_turn_id = ${turnID} AND state IN ('starting', 'working')`;
      }
    } finally {
      if (renew) clearInterval(renew);
      await browser?.closeTurn(turnID);
      starters.delete(turnID);
    }
  }

  async function recoverExternal(turnID: string) {
    if (closed || recovering.has(turnID) || monitors.has(turnID) || starters.has(turnID)) return;
    recovering.add(turnID);
    let owned: AgentTurnRecord | null = null;
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      // A restarted Factory may arrive before the dead process's lease expires.
      // Wait for that lease, never infer process death merely from startup.
      for (let observation = 0; observation < 60 && !closed; observation += 1) {
        const current = await turns.get(turnID);
        if (!current || !["dispatching", "running", "uncertain"].includes(current.state)) return;
        owned = await turns.claimExternalRecovery(turnID);
        if (owned) break;
        await Bun.sleep(1_000);
      }
      if (!owned?.ownerToken || owned.authority.mode !== "build" || !("changeId" in owned.command))
        return;
      const ownerToken = owned.ownerToken;
      const changeID = owned.command.changeId;
      const intent = await admission.intent(turnID);
      renewal = setInterval(() => {
        void renewExecution(turnID, ownerToken).catch(() => {});
      }, 10_000);
      if (!writers)
        throw new CommandError("unavailable", "Change writer enforcement is not configured");
      if (!(await writers.prepareAgent(changeID, turnID)))
        throw new CommandError(
          "conflict",
          "Previous Workspace commands have not stopped during execution recovery",
        );
      const skillRevisionIDs = owned.authority.skillRevisionIds;
      let queueWakeRequested = false;
      while (!closed) {
        if (!(await turns.renew(turnID, ownerToken))) {
          throw new CommandError("conflict", "Build authority changed before external recovery");
        }
        if (!(await turns.validateExecution(turnID, ownerToken)))
          throw new CommandError("conflict", "Build authority changed before external recovery");
        const session = await row(changeID);
        const current = await currentChange(changeID);
        if (
          !session ||
          session.activeTurnID !== turnID ||
          session.state === "stopped" ||
          session.sessionID !== intent.sessionID ||
          !intent.attemptID ||
          session.runtimeAttemptID !== intent.attemptID ||
          current.runtimeAttemptID !== intent.attemptID
        )
          throw new Error(
            "Recorded OpenCode work no longer owns this session and runtime generation",
          );
        if (["failed", "stopped", "cleanup-failed"].includes(current.runtimeState ?? ""))
          throw new Error("Recorded OpenCode runtime is no longer running");
        if (current.runtimeState !== "ready" || !hub.connected(intent.attemptID)) {
          await Bun.sleep(1_000);
          continue;
        }
        const client = createOpenCodeClient(
          createChangeAgentTransport(database, hub, intent.attemptID, turnID, ownerToken),
        );
        let work: Awaited<ReturnType<typeof observeOpenCodeWork>>;
        let messages: Awaited<ReturnType<typeof readOpenCodeInputMessages>>;
        try {
          const retained = await client.session.get(
            { sessionID: intent.sessionID },
            { signal: AbortSignal.any([observationController.signal, AbortSignal.timeout(5_000)]) },
          );
          if (
            retained.id !== intent.sessionID ||
            retained.location.directory !== workspaceDirectory ||
            retained.model?.providerID !== "factory" ||
            retained.model.id !== owned.authority.modelId
          )
            throw new Error("Recovered OpenCode session does not match its recorded configuration");
          if (intent.skillLoading === "native") await syncOpenCodeInputGuidance(client, intent);
          if (owned.authority.review)
            await client.session.instructions.entry.put({
              sessionID: intent.sessionID,
              key: "factory-review-policy",
              value: intent.text,
            });
          await usageJournal.drain(turnID, client, intent.sessionID);
          [work, messages] = await Promise.all([
            observeOpenCodeWork(client, intent.sessionID),
            readOpenCodeInputMessages(
              client,
              intent.sessionID,
              intent.promptID,
              AbortSignal.any([observationController.signal, AbortSignal.timeout(5_000)]),
            ),
          ]);
        } catch (cause) {
          if (!isOpenCodeObservationTransportError(cause)) throw cause;
          // These reads and exact idempotent guidance bindings may repeat,
          // never inference. Recheck Stop, ownership and runtime next time.
          await Bun.sleep(1_000);
          continue;
        }
        await confirmNativeSession(changeID, turnID, intent.attemptID, intent.sessionID);
        const browserGrant = await browser?.prepare(turnID, ownerToken);
        if (intent.browserTransport === "mcp" && browserGrant)
          await connectOpenCodeBrowser(
            client,
            browserGrant.runtimeEndpoint,
            browserGrant.runtimeBearer,
          );
        await recordNativeSkillLoads(turnID, ownerToken, intent.promptID, messages.data);
        const input = messages.data.find(
          (message) => message.type === "user" && message.id === intent.promptID,
        );
        if (!input) {
          // The exact deterministic admission may still be queued, or dispatch
          // may have stopped before admission. This endpoint can admit missing
          // input, so revalidate execution rather than treating it as a read.
          if (!(await turns.validateExecution(turnID, ownerToken)))
            throw new CommandError("conflict", "Build authority changed before queue admission");
          await ensureOpenCodeMessageBoundary(client, intent.sessionID);
          await usageJournal.prepare(turnID, client, intent.sessionID);
          const admitted = await promptRecordedOpenCodeInput(client, intent, false);
          if (admitted.state === "queued" && !queueWakeRequested) {
            const latest = await currentChange(changeID);
            const latestSession = await row(changeID);
            if (
              latest.runtimeAttemptID !== intent.attemptID ||
              latest.runtimeState !== "ready" ||
              latestSession?.activeTurnID !== turnID ||
              latestSession.sessionID !== intent.sessionID ||
              latestSession.state === "stopped" ||
              !hub.connected(intent.attemptID) ||
              !(await turns.validateExecution(turnID, ownerToken))
            )
              throw new CommandError("conflict", "Build authority changed before queue wake");
            // Pinned wake drains pending input only. It is not the explicit
            // Session resume that can force another provider attempt. Reusing
            // the exact ID also cannot add a second input if promotion races us.
            await promptRecordedOpenCodeInput(client, intent, true);
            queueWakeRequested = true;
            continue;
          }
          // Promotion and message observation can race. Never wake a promoted
          // incomplete input; observe its exact history on the next iteration.
          await Bun.sleep(1_000);
          continue;
        }
        if (input.type !== "user" || input.text !== intent.text)
          throw new Error(
            "The recorded OpenCode input is not identifiable in message history; no execution was repeated",
          );
        if (
          !(await turns.validateExecution(turnID, ownerToken, async (sql) => {
            for (const revisionID of intent.skillLoading === "eager" ? skillRevisionIDs : []) {
              await sql`INSERT INTO factory.agent_turn_skill(turn_id, revision_id)
              VALUES (${turnID}, ${revisionID}) ON CONFLICT DO NOTHING`;
            }
          }))
        )
          throw new CommandError(
            "conflict",
            "Build authority changed before recording loaded Skills",
          );
        const outcome = classifyAgentTurn(
          messages.data.map((message) => ({
            id: message.id,
            type: message.type,
            created: message.time.created,
            ...(message.type === "assistant"
              ? {
                  completed: message.time.completed,
                  finish: message.finish,
                  error: message.error,
                }
              : {}),
          })),
          intent.promptID,
          work.running,
        );
        if (outcome.state === "pending" && !work.running)
          throw new Error(
            "Recorded OpenCode input is retained, but no running or completed outcome can be established; no inference was repeated",
          );
        const restored = await database.client<Array<{ id: string }>>`
          UPDATE factory.change_agent_session SET state = 'working', active_inbox_id = ${intent.promptID},
            last_error = NULL, updated_at = now()
          WHERE change_id = ${changeID} AND active_turn_id = ${turnID} AND state <> 'stopped'
            AND runtime_attempt_id = ${intent.attemptID} AND opencode_session_id = ${intent.sessionID}
            AND EXISTS(SELECT 1 FROM factory.agent_turn WHERE id = ${turnID} AND state = 'running'
              AND owner_token = ${ownerToken} AND owner_expires_at > clock_timestamp()) RETURNING change_id AS id`;
        if (!restored[0]) return;
        await monitor(changeID, owned.command.createdBy, turnID, ownerToken);
        return;
      }
    } catch (cause) {
      if (closed) return;
      if (owned?.ownerToken && "changeId" in owned.command) {
        const summary = bounded(readableError(cause), 2_000);
        if (await turns.settle(turnID, owned.ownerToken, "uncertain", summary)) {
          await database.client`UPDATE factory.change_agent_session SET state = 'failed',
            last_error = ${summary}, updated_at = now()
            WHERE change_id = ${owned.command.changeId} AND active_turn_id = ${turnID}
              AND state <> 'stopped' AND EXISTS(SELECT 1 FROM factory.agent_turn
                WHERE id = ${turnID} AND state = 'uncertain')`;
        }
      }
    } finally {
      if (renewal) clearInterval(renewal);
      await browser?.closeTurn(turnID);
      recovering.delete(turnID);
    }
  }

  async function reconcileCommit(operationID: string, recovering = false) {
    if (closed) return;
    const existing = committing.get(operationID);
    if (existing) return existing;
    const work = performCommit(operationID, recovering).finally(() => {
      if (committing.get(operationID) === work) committing.delete(operationID);
    });
    committing.set(operationID, work);
    await work;
  }

  async function recoverRuntimeCommits(attemptID: string) {
    if (closed) return;
    const operations = await database.client<Array<{ id: string }>>`
      SELECT operation.id FROM factory.change_commit_operation operation
      JOIN factory.runtime_attempt original ON original.id = operation.runtime_attempt_id
      JOIN factory.change change ON change.id = operation.change_id
      JOIN factory.runtime_attempt current ON current.id = change.runtime_attempt_id
      WHERE operation.source = 'agent' AND operation.state NOT IN ('succeeded', 'failed')
        AND (original.id = ${attemptID} OR current.id = ${attemptID} AND current.state = 'ready'
          AND operation.state = 'commit-intended' AND original.state IN ('stopped', 'failed')
          AND original.workspace_id IS NOT NULL AND current.workspace_id = original.workspace_id)
      ORDER BY operation.created_at`;
    for (const operation of operations) {
      const previous = committing.get(operation.id);
      if (previous) await previous;
      if (closed) return;
      await reconcileCommit(operation.id, true);
    }
  }

  async function performCommit(operationID: string, recovering: boolean) {
    if (closed) return;
    const operations = await database.client<
      Array<{
        id: string;
        changeID: string;
        attemptID: string;
        branchName: string;
        expectedParentSHA: string;
        commitSHA: string | null;
        commitMessage: string;
        state: string;
        lastError: string | null;
        repositoryURL: string;
      }>
    >`
      SELECT operation.id, operation.change_id AS "changeID", operation.runtime_attempt_id AS "attemptID",
        operation.branch_name AS "branchName", operation.expected_parent_sha AS "expectedParentSHA",
        operation.commit_sha AS "commitSHA", operation.commit_message AS "commitMessage", operation.state, operation.last_error AS "lastError",
        project.repository_url AS "repositoryURL"
      FROM factory.change_commit_operation operation
      JOIN factory.change change ON change.id=operation.change_id
      JOIN factory.project project ON project.id=change.project_id WHERE operation.id = ${operationID}
    `;
    const operation = operations[0];
    if (!operation || ["succeeded", "failed"].includes(operation.state)) return;
    try {
      let commitSHA = operation.commitSHA;
      if (operation.state === "commit-intended") {
        const payload = {
          operationId: operation.id,
          expectedSha: operation.expectedParentSHA,
          commitMessage: operation.commitMessage,
          authorName: "Open Software Factory",
          authorEmail: "factory@localhost",
        };
        const result = recovering
          ? await commitTransport.observeRetainedCheckout(operation.attemptID, {
              ...payload,
              action: "git-observe-commit",
            })
          : await commitTransport(operation.attemptID, {
              ...payload,
              action: "git-prepare-commit",
            });
        if (!result.commitSHA) throw new Error("Runtime returned no commit identity");
        commitSHA = result.commitSHA;
        await database.client`
          UPDATE factory.change_commit_operation
          SET state = 'push-intended', commit_sha = ${commitSHA}, updated_at = now()
          WHERE id = ${operation.id} AND state = 'commit-intended'
        `;
      }
      if (!commitSHA) throw new Error("Commit identity is missing");
      const pushed = await commitTransport(operation.attemptID, {
        operationId: operation.id,
        action: "git-push",
        branch: operation.branchName,
        expectedSha: operation.expectedParentSHA,
        commitSha: commitSHA,
        repositoryURL: operation.repositoryURL.startsWith("file://")
          ? operation.repositoryURL
          : runtimeRepositoryCloneURL(operation.repositoryURL),
        username:
          process.env["FACTORY_FORGEJO_USERNAME"] ??
          process.env["FACTORY_FORGEJO_OWNER"] ??
          "factory",
        password: process.env["FACTORY_FORGEJO_TOKEN"] ?? "",
      });
      if (pushed.remoteSHA !== commitSHA) throw new Error("Remote commit was not confirmed");
      await turns.observeCommit(operation.id, async (transaction, current) => {
        const recorded = await transaction<Array<{ id: string }>>`
          UPDATE factory.change_commit_operation
          SET state = 'succeeded', observed_remote_sha = ${commitSHA}, completed_at = now(),
            updated_at = now(), last_error = NULL
          WHERE id = ${operation.id} AND state IN ('committed', 'push-intended')
          RETURNING id
        `;
        if (!recorded[0] || !current) return;
        await transaction`
          UPDATE factory.change_agent_session
          SET state = 'committed', active_inbox_id = NULL, last_error = NULL, updated_at = now()
          WHERE change_id = ${operation.changeID}
            AND state = 'waiting' AND active_turn_id = ${operation.id}
            AND runtime_attempt_id = ${operation.attemptID} AND NOT stop_pending
            AND EXISTS(SELECT 1 FROM factory.change WHERE id = ${operation.changeID}
              AND runtime_attempt_id = ${operation.attemptID})
            AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
              WHERE intent.turn_id = ${operation.id} AND intent.runtime_attempt_id = ${operation.attemptID}
                AND intent.session_id = factory.change_agent_session.opencode_session_id)
        `;
      });
    } catch (cause) {
      const emptyCheckout =
        cause instanceof RuntimeParentOperationError &&
        operation.state === "commit-intended" &&
        !recovering &&
        cause.action === "git-prepare-commit" &&
        cause.message === "workspace has no changes to commit" &&
        operation.lastError === null;
      const absentPreparedCommit =
        cause instanceof RuntimeParentOperationError &&
        operation.state === "commit-intended" &&
        recovering &&
        cause.action === "git-observe-commit" &&
        cause.message ===
          "the exact prepared commit was not found; current files were not committed";
      if (emptyCheckout || absentPreparedCommit) {
        const diagnostic = emptyCheckout
          ? "This turn produced no source changes. No new commit was submitted; the current request still needs review."
          : "Prepared commit was not found. Files were left untouched; review the checkout before starting a new Build turn.";
        await turns.observeCommit(operation.id, async (transaction) => {
          const recorded = await transaction<Array<{ id: string }>>`
            UPDATE factory.change_commit_operation SET state = 'failed',
              last_error = ${diagnostic}, completed_at = now(), updated_at = now()
            WHERE id = ${operation.id} AND state = 'commit-intended' AND commit_sha IS NULL RETURNING id`;
          if (!recorded[0]) return;
          await transaction`
            UPDATE factory.change_agent_session SET state = ${absentPreparedCommit ? "failed" : "waiting"}::factory.change_agent_state,
              last_error = ${diagnostic}, active_inbox_id = NULL, updated_at = now()
            WHERE change_id = ${operation.changeID} AND state = 'waiting' AND active_turn_id = ${operation.id}
              AND runtime_attempt_id = ${operation.attemptID} AND NOT stop_pending
              AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent WHERE intent.turn_id = ${operation.id}
                AND intent.runtime_attempt_id = ${operation.attemptID} AND intent.session_id = factory.change_agent_session.opencode_session_id)`;
        });
        return;
      }
      // Only an authority rejection proves this frame did not execute. Transport,
      // Connector and persistence errors can follow a successful commit or push.
      // A prior unresolved outcome also survives a later authority rejection.
      const rejected = cause instanceof CommandError && !recovering;
      const detail = readableError(cause);
      await turns.observeCommit(operation.id, async (transaction) => {
        const recorded = await transaction<Array<{ id: string; state: string }>>`
          UPDATE factory.change_commit_operation
          SET state = CASE WHEN ${rejected} AND last_error IS NULL THEN 'failed'::factory.change_commit_state ELSE state END,
            last_error = CASE WHEN ${rejected} AND last_error IS NULL THEN ${bounded(detail, 4_000)}
              ELSE ${bounded(`Commit outcome not confirmed. New Build waits for recovery. ${detail}`, 4_000)} END,
            completed_at = CASE WHEN ${rejected} AND last_error IS NULL THEN now() ELSE NULL END,
            updated_at = now()
          WHERE id = ${operation.id} AND state NOT IN ('succeeded', 'failed')
          RETURNING id, state
        `;
        if (!recorded[0]) return;
        await transaction`
          UPDATE factory.change_agent_session
          SET state = CASE WHEN ${recorded[0].state === "failed"} THEN 'failed'::factory.change_agent_state ELSE state END,
            last_error = (SELECT last_error FROM factory.change_commit_operation WHERE id = ${operation.id}), updated_at = now()
          WHERE change_id = ${operation.changeID}
            AND state = 'waiting' AND active_turn_id = ${operation.id}
            AND runtime_attempt_id = ${operation.attemptID} AND NOT stop_pending
            AND EXISTS(SELECT 1 FROM factory.change WHERE id = ${operation.changeID}
              AND runtime_attempt_id = ${operation.attemptID})
            AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
              WHERE intent.turn_id = ${operation.id} AND intent.runtime_attempt_id = ${operation.attemptID}
                AND intent.session_id = factory.change_agent_session.opencode_session_id)
        `;
      });
    }
  }

  async function recordCommit(
    sql: AgentTurnTransaction,
    active: AgentRow,
    userID: string,
    turnID: string,
  ) {
    const allowed = await sql<
      Array<{ conversationID: string | null }>
    >`SELECT turn.conversation_id AS "conversationID"
      FROM factory.agent_turn turn JOIN factory.change change ON change.id = turn.change_id
      JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
      WHERE turn.id = ${turnID} AND change.state IN ('starting', 'active')
        AND ticket.trashed_at IS NULL
        AND approval.requirement_revision_id = (SELECT id FROM factory.requirement_revision
          WHERE ticket_id = ticket.id ORDER BY ordinal DESC LIMIT 1)
      FOR UPDATE OF change, ticket`;
    if (!allowed[0]) throw new CommandError("conflict", "Build approval changed before committing");
    if (allowed[0].conversationID) {
      const modes = await sql<Array<{ mode: string }>>`SELECT mode FROM factory.ticket_conversation
        WHERE id = ${allowed[0].conversationID} FOR UPDATE`;
      if (modes[0]?.mode !== "build")
        throw new CommandError("conflict", "Build mode changed before committing");
    }
    const changeID = active.changeID;
    const operationID = turnID;
    const created = await sql<Array<{ id: string }>>`
      INSERT INTO factory.change_commit_operation(
        id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
        commit_message, idempotency_key, state, created_by
      )
      SELECT ${operationID}, change.id, ${active.runtimeAttemptID},
        COALESCE(MAX(previous.sequence), 0) + 1, change.branch_name,
        COALESCE(
          (SELECT observed_remote_sha FROM factory.change_commit_operation latest
            WHERE latest.change_id = change.id AND latest.state = 'succeeded'
            ORDER BY latest.sequence DESC LIMIT 1),
          change.base_sha
        ),
        ${active.ticketTitle}, ${`change-commit:${changeID}:${operationID}`},
        'commit-intended', ${userID}
      FROM factory.change change
      LEFT JOIN factory.change_commit_operation previous ON previous.change_id = change.id
      WHERE change.id = ${changeID}
        AND EXISTS (SELECT 1 FROM factory.change_agent_session session
          WHERE session.change_id = change.id AND session.state = 'waiting' AND session.active_turn_id = ${turnID})
        AND NOT EXISTS (
          SELECT 1 FROM factory.change_commit_operation pending
          WHERE pending.change_id = change.id AND pending.state NOT IN ('succeeded', 'failed')
        )
      GROUP BY change.id
      RETURNING id
    `;
    if (!created[0])
      throw new CommandError("conflict", "Build commit intent no longer owns this session");
    return created[0].id;
  }

  async function renewExecution(turnID: string, ownerToken: string) {
    const renewed = await turns.renew(turnID, ownerToken);
    if (renewed) await browser?.renewTurn(turnID, ownerToken);
    return renewed;
  }

  async function monitor(changeID: string, userID: string, turnID: string, ownerToken: string) {
    if (closed || monitors.has(turnID)) return;
    monitors.add(turnID);
    let inactiveObservations = 0;
    const wake = createActivityWake(observationController.signal);
    let detach: (() => void) | undefined;
    try {
      const intent = await admission.intent(turnID);
      const initial = await row(changeID);
      if (!initial?.sessionID) return;
      const client = opencode(hub, initial.runtimeAttemptID);
      detach = nativeEvents.subscribe(initial.runtimeAttemptID, (type) => {
        // Token deltas update the panel, not durable usage/settlement reads.
        if (!type.endsWith(".delta") && type !== "session.tool.progress") wake.notify();
      });
      while (!closed) {
        const revision = wake.revision();
        const session = await row(changeID);
        if (!session || !session.sessionID || session.activeTurnID !== turnID) return;
        if (session.state === "stopped") {
          run(reconcileStop(changeID));
          return;
        }
        if (session.state !== "working") return;
        if (!(await renewExecution(turnID, ownerToken))) {
          const current = await turns.get(turnID);
          // A completed Stop or another owner is not a new Stop request. Actual
          // revoked execution is fenced before asking the engine to settle.
          if (current?.ownerToken === ownerToken && current.state === "running") {
            await stop.persist(changeID);
            run(reconcileStop(changeID));
          }
          return;
        }
        const latestSession = await row(changeID);
        if (latestSession?.state !== "working" || latestSession.activeTurnID !== turnID) return;
        if (["failed", "stopped", "cleanup-failed"].includes(session.runtimeState)) {
          throw new Error("The Ticket Workspace stopped during implementation");
        }
        if (!hub.connected(session.runtimeAttemptID) || session.runtimeState !== "ready") {
          await Bun.sleep(1_000);
          continue;
        }
        try {
          if (session.runtimeAttemptID !== initial.runtimeAttemptID) return;
          const work = await observeOpenCodeWork(client, session.sessionID);
          const [, messages] = await Promise.all([
            usageJournal.drain(turnID, client, session.sessionID, work.sessionIDs),
            readOpenCodeInputMessages(
              client,
              session.sessionID,
              intent.promptID,
              AbortSignal.any([observationController.signal, AbortSignal.timeout(5_000)]),
            ),
          ]);
          await recordNativeSkillLoads(turnID, ownerToken, session.activeInboxID, messages.data);
          const outcome = classifyAgentTurn(
            messages.data.map((message) => ({
              id: message.id,
              type: message.type,
              created: message.time.created,
              ...(message.type === "assistant"
                ? {
                    completed: message.time.completed,
                    finish: message.finish,
                    error: message.error,
                    content: message.content,
                  }
                : {}),
            })),
            session.activeInboxID,
            work.running,
            {
              prompt: intent.text,
              criteria: intent.criteria,
              ...(intent.submissionPolicy === "native" ? { policy: "native" as const } : {}),
            },
          );
          // History can observe a terminal outcome after the earlier log watermark.
          // Drain again before settlement so the last paid step cannot be missed.
          if (outcome.state === "failed" || outcome.state === "succeeded")
            await usageJournal.drain(turnID, client, session.sessionID);
          if (outcome.state === "failed") {
            const pause =
              await database.client`SELECT turn_id FROM factory.coding_pause WHERE turn_id=${turnID} AND resumed_by_turn_id IS NULL`;
            await usageJournal.settle(
              turnID,
              "failed",
              Boolean(pause.length) && readableError(outcome.error).includes(codingAllowanceDenial),
            );
            const summary = pause.length
              ? "Coding paused at its allowance. Existing code is retained. Resume explicitly after reset or an allowance increase."
              : bounded(readableError(outcome.error), 2_000);
            await turns.settle(turnID, ownerToken, "failed", summary);
            await database.client`UPDATE factory.change_agent_session SET state = 'failed',
              last_error = ${summary}, updated_at = now()
              WHERE change_id = ${changeID} AND state = 'working' AND active_turn_id = ${turnID}
                AND active_inbox_id = ${session.activeInboxID}
                AND EXISTS(SELECT 1 FROM factory.agent_turn WHERE id = ${turnID} AND state = 'failed')`;
            return;
          }
          if (outcome.state === "succeeded") {
            await usageJournal.settle(turnID, "completed");
            const reviewTurn = await turns.get(turnID);
            if (reviewTurn?.authority.mode === "build" && reviewTurn.authority.review) {
              const reviewID = reviewTurn.authority.review.reviewId;
              const [review] = await database.client<{ result: unknown }[]>`
                SELECT result FROM factory.candidate_review WHERE id=${reviewID} AND turn_id=${turnID}`;
              const parsed = candidateReviewResultInput.safeParse(review?.result);
              const result = parsed.success ? parsed.data : null;
              const summary =
                result?.summary ??
                "Independent review ended without an accepted report. This candidate remains unverified.";
              const settled = await turns.settle(
                turnID,
                ownerToken,
                "completed",
                bounded(summary, 2_000),
                async (sql) => {
                  await sql`UPDATE factory.candidate_review SET state=${result?.verdict ?? "incomplete"},completed_at=now()
                  WHERE id=${reviewID} AND turn_id=${turnID} AND state IN ('pending','running')`;
                  await sql`UPDATE factory.change_agent_session SET state='committed',active_inbox_id=NULL,
                  last_error=NULL,updated_at=now() WHERE change_id=${changeID} AND active_turn_id=${turnID}
                    AND state='working' AND active_inbox_id=${session.activeInboxID}`;
                },
              );
              if (!settled)
                throw new CommandError("conflict", "Review no longer owns this exact candidate");
              notifyActivity(changeID);
              return;
            }
            const settled = await turns.settle(
              turnID,
              ownerToken,
              "completed",
              outcome.summary
                ? bounded(`Agent reports ready for Verification: ${outcome.summary}`, 2_000)
                : "OpenCode ended this Build turn. Changed source is submitted for independent Verification, not approved for Delivery.",
              async (sql) => {
                const accepted = await sql<
                  Array<{ id: string }>
                >`UPDATE factory.change_agent_session SET state = 'waiting',
                active_inbox_id = NULL, updated_at = now()
                WHERE change_id = ${changeID} AND state = 'working' AND active_turn_id = ${turnID}
                  AND active_inbox_id = ${session.activeInboxID} RETURNING change_id AS id`;
                if (!accepted[0])
                  throw new CommandError("conflict", "Build outcome no longer owns this session");
                await recordCommit(sql, session, userID, turnID);
              },
            );
            if (!settled)
              throw new CommandError(
                "conflict",
                "Build outcome no longer owns its current authority",
              );
            notifyActivity(changeID);
            await reconcileCommit(turnID);
            return;
          }
          // A single active/history pair can straddle upstream promotion or
          // completion. A second inactive observation, one interval later,
          // cannot justify renewing a stranded turn indefinitely. Keep the
          // result uncertain and require explicit recovery, never paid replay.
          inactiveObservations = work.running ? 0 : inactiveObservations + 1;
          if (inactiveObservations >= 2)
            throw new Error(
              "OpenCode has no active execution or terminal outcome for the recorded input; recovery requires an explicit decision",
            );
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : "OpenCode status failed";
          // These are read-only observations of the recorded execution. Losing
          // one response is not a lost prompt receipt and must not fence a live
          // turn. Renewal and Stop checks still run before the next observation.
          if (
            hub.connected(session.runtimeAttemptID) &&
            !isOpenCodeObservationTransportError(cause) &&
            !error.includes("timed out")
          )
            throw cause;
        }
        if (inactiveObservations) await Bun.sleep(1_000);
        else await wake.wait(revision, 15_000);
        if (!closed) await Bun.sleep(100);
      }
    } finally {
      detach?.();
      wake.dispose();
      await browser?.closeTurn(turnID);
      monitors.delete(turnID);
      notifyActivity(changeID);
    }
  }

  const stopping = new Set<string>();
  async function reconcileStop(changeID: string) {
    if (closed) return;
    const target = await row(changeID);
    if (closed || !target?.stopPending || !target.stopID || stopping.has(target.stopID)) return;
    stopping.add(target.stopID);
    try {
      for (let observation = 0; observation < 5 && !closed; observation += 1) {
        const session = observation === 0 ? target : await row(changeID);
        if (!session?.stopPending || session.stopID !== target.stopID) return;
        try {
          if (await stop.confirm(changeID, target.stopID)) return;
        } catch {
          /* Keep admission blocked until persisted Stop is confirmed. */
        }
        if (observation < 4 && !closed) await Bun.sleep(1_000);
      }
      if (!closed)
        await stop.recordUnconfirmed(changeID, {
          stopID: target.stopID,
          attemptID: target.runtimeAttemptID,
          sessionID: target.sessionID,
        });
    } finally {
      stopping.delete(target.stopID);
    }
  }

  return {
    // Stop observing and join owned work before its database/transport is
    // disposed. Durable intent remains recoverable; this does not issue Stop.
    async shutdown() {
      closed = true;
      observationController.abort();
      await nativeEvents.shutdown();
      while (background.size) await Promise.allSettled([...background]);
      await browser?.recover();
    },
    subscribeActivity(changeID: string, notify: () => void) {
      if (closed) return () => {};
      const listeners = activityListeners.get(changeID) ?? new Set();
      const listener: {
        notify(): void;
        attemptID?: string;
        detach?: () => void;
      } = { notify };
      listeners.add(listener);
      activityListeners.set(changeID, listeners);
      return () => {
        listener.detach?.();
        listeners.delete(listener);
        if (!listeners.size) activityListeners.delete(changeID);
      };
    },
    runtimeActivityChanged() {
      notifyActivity();
    },
    async recover() {
      if (closed) return;
      // Failure settlement and its Session projection can lose their connection
      // independently. Restore only the exact failed Turn's diagnostic state;
      // this neither executes work nor resolves uncertain external outcomes.
      await database.client`
        UPDATE factory.change_agent_session session
        SET state = 'failed', last_error = turn.outcome_summary, updated_at = now()
        FROM factory.agent_turn turn, factory.change_agent_turn_intent intent,
          factory.change change
        WHERE session.active_turn_id = turn.id AND turn.state = 'failed'
          AND session.state IN ('starting', 'working') AND NOT session.stop_pending
          AND turn.change_id = session.change_id AND change.id = session.change_id
          AND change.state IN ('starting', 'active')
          AND intent.turn_id = turn.id AND intent.change_id = session.change_id
          AND intent.session_id = session.opencode_session_id
          AND intent.runtime_attempt_id = session.runtime_attempt_id
          AND change.runtime_attempt_id = session.runtime_attempt_id
          AND (session.state = 'starting' AND session.active_inbox_id IS NULL
            OR session.state = 'working' AND session.active_inbox_id = intent.prompt_id)
      `;
      const operations = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.change_commit_operation
        WHERE source = 'agent' AND state NOT IN ('succeeded', 'failed') ORDER BY created_at
      `;
      for (const operation of operations) run(reconcileCommit(operation.id, true));
      const external = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.agent_turn
        WHERE change_id IS NOT NULL AND state IN ('dispatching', 'running', 'uncertain') ORDER BY created_at`;
      for (const turn of external) run(recoverExternal(turn.id));
      const pending = await database.client<Array<{ id: string }>>`SELECT id FROM factory.agent_turn
        WHERE change_id IS NOT NULL AND state = 'pending' ORDER BY created_at`;
      for (const turn of pending) run(execute(turn.id));
      const stopped = await database.client<
        Array<{ changeID: string }>
      >`SELECT change_id AS "changeID"
        FROM factory.change_agent_session WHERE stop_pending`;
      for (const session of stopped) run(reconcileStop(session.changeID));
    },

    // Startup runs before the Connector listener exists. Its first read may fail;
    // readiness resumes only recorded commit work, never an inference request.
    recoverRuntimeCommits(attemptID: string) {
      const work = recoverRuntimeCommits(attemptID);
      run(work);
      return work;
    },

    async dispatchRuntimePending(attemptID: string) {
      const pending = await database.client<
        Array<{ id: string }>
      >`SELECT turn.id FROM factory.agent_turn turn
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
        WHERE intent.runtime_attempt_id=${attemptID} AND turn.state='pending'`;
      for (const turn of pending) run(execute(turn.id));
    },

    async dispatchReadyPending() {
      const pending = await database.client<
        Array<{ id: string }>
      >`SELECT turn.id FROM factory.agent_turn turn
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
        WHERE turn.state='pending' AND (
          attempt.state='ready'
          OR (intent.runtime_attempt_id IS NULL AND EXISTS(
            SELECT 1 FROM factory.change_writer writer
            JOIN factory.runtime_attempt previous ON previous.id=writer.fence_attempt_id
            WHERE writer.change_id=turn.change_id AND writer.turn_id=turn.id
              AND writer.state='agent-preparing' AND writer.fence_required
              AND previous.state='stopped'
          )))
          AND (turn.owner_token IS NULL OR turn.owner_expires_at<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM factory.coding_pause WHERE turn_id=turn.id AND resumed_by_turn_id IS NULL)
        ORDER BY turn.created_at LIMIT 16`;
      for (const turn of pending) run(execute(turn.id));
    },

    async start(
      changeID: string,
      userID: string,
      commandId: string,
      codingReasoning?: CodingReasoning,
    ) {
      if (closed) throw new Error("Agent controller is closed");
      const accepted = await admission.admit(changeID, userID, {
        kind: "change-start",
        commandId,
        ...(codingReasoning ? { codingReasoning } : {}),
      });
      if (!accepted.replayed) run(execute(accepted.turn.id));
      return this.get(changeID, accepted.turn.id);
    },
    async resume(changeID: string, userID: string, commandID: string, pausedTurnID: string) {
      const [pendingResume] = await database.client<
        Array<{
          state: string;
          review: boolean;
          attemptID: string;
          sessionID: string;
          promptID: string;
        }>
      >`
        SELECT turn.state,(turn.authority ? 'review') AS review,intent.runtime_attempt_id AS "attemptID",intent.session_id AS "sessionID",intent.prompt_id AS "promptID"
        FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
        JOIN factory.coding_pause pause ON pause.turn_id=turn.id
        WHERE turn.id=${pausedTurnID} AND turn.change_id=${changeID} AND pause.resumed_by_turn_id IS NULL`;
      const [project] = await database.client<
        Array<{ id: string }>
      >`SELECT project_id AS id FROM factory.change WHERE id=${changeID}`;
      if (!project) throw new CommandError("not-found", "Change not found");
      await database.client.begin((sql) => projectAuthorityIn(sql, userID, project.id));
      if (pendingResume?.state === "failed" && pendingResume.review)
        throw new CommandError(
          "conflict",
          "Retry the independent review after resolving its Coding allowance. A review cannot resume as implementation.",
        );
      if (
        pendingResume?.state === "failed" &&
        !(await confirmSettledOpenCodeInput(
          opencode(hub, pendingResume.attemptID),
          pendingResume.sessionID,
          pendingResume.promptID,
        ))
      )
        throw new CommandError(
          "conflict",
          "Wait for the previous model call and queued input to finish before resuming",
        );
      const turnID = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`coding-resume:${commandID}`}))`;
        const input = { changeID, pausedTurnID };
        const [old] = await sql<
          Array<{
            actor_id: string;
            input: { changeID: string; pausedTurnID: string };
            result: { turnID: string };
          }>
        >`
          SELECT actor_id,input,result FROM factory.execution_policy_command WHERE command_id=${commandID}`;
        const [project] = await sql<
          Array<{ id: string }>
        >`SELECT project_id AS id FROM factory.change WHERE id=${changeID}`;
        if (!project) throw new CommandError("not-found", "Change not found");
        if (old) {
          await projectAuthorityIn(sql, userID, project.id);
          if (
            old.actor_id !== userID ||
            old.input.changeID !== changeID ||
            old.input.pausedTurnID !== pausedTurnID
          )
            throw new CommandError("conflict", "Resume command changed input");
          return old.result.turnID;
        }
        await sql`SELECT id FROM factory.agent_turn WHERE id=${pausedTurnID} FOR UPDATE`;
        await lockChangeWriterIn(sql, changeID);
        await projectAuthorityIn(sql, userID, project.id);
        const [paused] = await sql<
          Array<{ state: string }>
        >`SELECT turn.state FROM factory.coding_pause pause JOIN factory.agent_turn turn ON turn.id=pause.turn_id
          WHERE pause.turn_id=${pausedTurnID} AND turn.change_id=${changeID} AND pause.resumed_by_turn_id IS NULL FOR UPDATE OF pause,turn`;
        if (!paused) throw new CommandError("conflict", "This Coding pause is no longer current");
        let next: string;
        if (paused.state === "pending") next = await turns.resumePendingIn(sql, pausedTurnID);
        else if (paused.state === "failed") {
          const accepted = await admission.admitIn(sql, changeID, userID, {
            kind: "change-prompt",
            commandId: commandID,
            resume: true,
            text: "Continue the already commissioned implementation from the retained checkout. Factory paused the previous turn at its Coding allowance. Preserve existing changes, complete the remaining work and run the repository checks. Do not commit or push; Factory handles that after successful completion.",
          });
          next = accepted.turn.id;
        } else
          throw new CommandError(
            "conflict",
            "Wait for the current model call to finish before resuming",
          );
        await sql`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
          VALUES(${commandID},${`coding-resume:${changeID}`},${userID},${JSON.stringify(input)}::jsonb,${JSON.stringify({ turnID: next })}::jsonb)`;
        return next;
      });
      run(execute(turnID));
      return this.get(changeID, turnID);
    },

    admitStartIn(
      sql: AgentTurnTransaction,
      changeID: string,
      userID: string,
      commandId: string,
      codingReasoning?: CodingReasoning,
    ) {
      return admission.admitIn(sql, changeID, userID, {
        kind: "change-start",
        commandId,
        ...(codingReasoning ? { codingReasoning } : {}),
      });
    },

    async dispatchPending(changeID: string) {
      const pending = await database.client<
        Array<{ id: string }>
      >`SELECT turn.id FROM factory.agent_turn turn
        JOIN factory.change change ON change.id = turn.change_id
        WHERE change.id = ${changeID} AND change.state IN ('starting', 'active') AND turn.state = 'pending'`;
      for (const turn of pending) run(execute(turn.id));
    },

    async prompt(
      changeID: string,
      text: string,
      userID: string,
      commandId: string,
      repair = false,
    ) {
      if (closed) throw new Error("Agent controller is closed");
      const accepted = await admission.admit(changeID, userID, {
        kind: repair ? "change-repair" : "change-prompt",
        commandId,
        text,
      });
      if (!accepted.replayed) run(execute(accepted.turn.id));
      return this.get(changeID, accepted.turn.id);
    },

    async review(changeID: string, reviewID: string, userID: string) {
      if (closed) throw new Error("Agent controller is closed");
      const accepted = await admitReview(changeID, reviewID, userID);
      if (!accepted.replayed) run(execute(accepted.turn.id));
      return this.get(changeID, accepted.turn.id);
    },

    async stop(changeID: string) {
      await stop.persist(changeID);
      notifyActivity(changeID);
      await browser?.closeChange(changeID);
      try {
        if (!(await stop.confirm(changeID))) run(reconcileStop(changeID));
      } catch {
        run(reconcileStop(changeID));
      }
      return this.get(changeID);
    },

    async recheckStop(changeID: string, stopID: string) {
      if (closed) throw new Error("Agent controller is closed");
      const target = await row(changeID);
      if (!target?.stopPending) return this.get(changeID);
      if (target.stopID !== stopID)
        throw new CommandError(
          "conflict",
          "Stop changed. Refresh its status before checking confirmation.",
        );
      let confirmed = false;
      try {
        confirmed = await stop.confirm(changeID, stopID, "observe");
      } catch {
        // A failed read leaves Stop pending, with no mutation or paid replay.
      }
      if (!confirmed)
        await stop.recordUnconfirmed(changeID, {
          stopID,
          attemptID: target.runtimeAttemptID,
          sessionID: target.sessionID,
        });
      return this.get(changeID);
    },

    async get(changeID: string, turnID?: string, history = true) {
      const [waiting] = await database.client<
        Array<{ reason: string }>
      >`SELECT waiting.reason FROM factory.runtime_compute_wait waiting
        JOIN factory.change change ON change.runtime_attempt_id=waiting.attempt_id WHERE change.id=${changeID}`;
      const turn = await readTurnObservation(database, { changeID, ...(turnID ? { turnID } : {}) });
      const intents = history
        ? await database.client<
            Array<{
              turnID: string;
              commandID: string;
              sessionID: string;
              promptID: string;
              bootstrap: boolean;
              text: string | null;
              at: number;
            }>
          >`SELECT intent.turn_id AS "turnID", turn.command_id AS "commandID", intent.session_id AS "sessionID",
              intent.prompt_id AS "promptID", intent.bootstrap, turn.input->>'text' AS text,
              EXTRACT(EPOCH FROM turn.created_at)::float8 * 1000 AS at
            FROM factory.change_agent_turn_intent intent
            JOIN factory.agent_turn turn ON turn.id = intent.turn_id
            WHERE intent.change_id = ${changeID}
            ORDER BY intent.created_at DESC, intent.turn_id DESC LIMIT 100`
        : [];
      const admittedMessages = intents.toReversed().flatMap((intent) =>
        !intent.bootstrap && intent.text !== null
          ? [
              {
                id: intent.promptID,
                commandId: intent.commandID,
                role: "user" as const,
                text: bounded(intent.text, 8_000),
                at: intent.at,
              },
            ]
          : [],
      );
      const [codingPause] = await database.client<Array<{ reason: string; turnID: string }>>`
        SELECT pause.reason,pause.turn_id AS "turnID" FROM factory.coding_pause pause
        JOIN factory.agent_turn turn ON turn.id=pause.turn_id WHERE turn.change_id=${changeID}
        AND pause.resumed_by_turn_id IS NULL AND turn.state IN ('pending','dispatching','running','failed')
        AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=${changeID} AND (stop_pending OR state='stopped'))
        ORDER BY pause.created_at DESC LIMIT 1`;
      const session = await row(changeID);
      if (!session) {
        bindActivity(changeID);
        return {
          state:
            turn?.state === "stopped"
              ? "stopped"
              : turn?.state === "failed" || turn?.state === "uncertain"
                ? "failed"
                : turn
                  ? "starting"
                  : "idle",
          turn,
          lastError: turn?.summary ?? null,
          commitOperation: undefined,
          messages: [],
          ...(admittedMessages.length ? { admittedMessages } : {}),
          messagesAvailable: true,
          sessionAvailable: false,
          runtimeConnected: false,
          stopPending: false,
          stopId: null,
          codingPause: codingPause ?? null,
          computeWait: waiting?.reason ?? null,
        };
      }
      let messages: ReturnType<typeof projectMessages> = [];
      let messagesAvailable = false;
      let activityAttemptID = session.runtimeAttemptID;
      let activityRuntimeState = session.runtimeState;
      if (session.sessionID && ["failed", "stopped"].includes(session.runtimeState)) {
        const [retained] = await database.client<Array<{ id: string; state: string }>>`
          SELECT current.id, current.state FROM factory.change change
          JOIN factory.runtime_attempt current ON current.id = change.runtime_attempt_id
          JOIN factory.runtime_attempt original ON original.id = ${session.runtimeAttemptID}
          WHERE change.id = ${changeID} AND change.state IN ('starting', 'active')
            AND current.change_id = change.id AND original.change_id = change.id
            AND current.workspace_id = original.workspace_id AND current.workspace_id IS NOT NULL
            AND current.generation > original.generation AND current.state = 'ready'`;
        if (retained) {
          activityAttemptID = retained.id;
          activityRuntimeState = retained.state;
        }
      }
      if (session.sessionConfirmed && session.sessionID && activityRuntimeState === "ready")
        bindActivity(changeID, activityAttemptID);
      else bindActivity(changeID);
      if (
        history &&
        session.sessionConfirmed &&
        session.sessionID &&
        activityRuntimeState === "ready"
      ) {
        try {
          const client = opencode(hub, activityAttemptID);
          const page = await client.message.list(
            { sessionID: session.sessionID, limit: 100 },
            { signal: AbortSignal.timeout(2_000) },
          );
          const sessionIntents = intents.filter((intent) => intent.sessionID === session.sessionID);
          messages = projectMessages(
            page,
            new Map(
              sessionIntents.map((intent) => [
                intent.promptID,
                intent.bootstrap ? null : intent.text,
              ]),
            ),
          );
          if (
            session.implementationSessionConfirmed &&
            session.implementationSessionID &&
            session.implementationSessionID !== session.sessionID
          ) {
            const implementationPage = await client.message
              .list(
                { sessionID: session.implementationSessionID, limit: 100 },
                { signal: AbortSignal.timeout(2_000) },
              )
              .catch(() => null);
            if (implementationPage)
              messages = [
                ...projectMessages(
                  implementationPage,
                  new Map(
                    intents
                      .filter((intent) => intent.sessionID === session.implementationSessionID)
                      .map((intent) => [intent.promptID, intent.bootstrap ? null : intent.text]),
                  ),
                ),
                ...messages,
              ].sort((a, b) => a.at - b.at);
          }
          if (turn) {
            const intent = sessionIntents.find((intent) => intent.turnID === turn.id);
            if (intent) turn.usage = observeOpenCodeUsage(page.data, intent.promptID);
          }
          messagesAvailable = true;
        } catch {
          // Unavailable live activity must not block persisted completion or Stop state.
        }
      }
      const operations = await database.client<Array<{ commitSHA: string | null }>>`
        SELECT commit_sha AS "commitSHA" FROM factory.change_commit_operation
        WHERE change_id = ${changeID} AND state = 'succeeded'
        ORDER BY sequence DESC LIMIT 1
      `;
      const failed = turn?.state === "uncertain" || turn?.state === "failed";
      const pendingCommits = await database.client<
        Array<{
          id: string;
          state: "commit-intended" | "committed" | "push-intended";
          lastError: string | null;
        }>
      >`SELECT id, state, last_error AS "lastError" FROM factory.change_commit_operation
        WHERE change_id = ${changeID} AND source = 'agent'
          AND state IN ('commit-intended', 'committed', 'push-intended') LIMIT 1`;
      return {
        codingPause: codingPause ?? null,
        computeWait: waiting?.reason ?? null,
        state:
          session.state === "stopped"
            ? "stopped"
            : failed
              ? "failed"
              : turn?.state === "pending" || turn?.state === "dispatching"
                ? "starting"
                : session.state,
        turn,
        runtimeState: activityRuntimeState,
        lastError:
          turn?.state === "uncertain"
            ? `Execution outcome uncertain. Stop or resolve this turn before new Build work. ${turn.summary ?? ""}`
            : failed
              ? (turn?.summary ?? session.lastError)
              : turn?.state === "pending" && turn.id !== session.activeTurnID
                ? null
                : session.lastError,
        commitSHA: operations[0]?.commitSHA ?? null,
        ...(pendingCommits[0] ? { commitOperation: pendingCommits[0] } : {}),
        messages,
        ...(admittedMessages.length ? { admittedMessages } : {}),
        messagesAvailable,
        sessionAvailable: Boolean(
          session.implementationSessionID && session.implementationSessionConfirmed,
        ),
        runtimeConnected: hub.connected(activityAttemptID),
        stopPending: session.stopPending,
        stopId: session.stopPending ? session.stopID : null,
      };
    },
  };
}
