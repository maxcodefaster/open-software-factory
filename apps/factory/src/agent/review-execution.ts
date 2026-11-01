import { createHash } from "node:crypto";
import type { z } from "zod";
import type { reviewExecutionArgumentsInput } from "../../../../packages/conversation-domain/src/candidate-review";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  environmentManifest,
  environmentMetadata,
} from "../../../../packages/project-domain/src/environment";
import type { EnvironmentSecrets } from "../environments/openbao";
import type { RuntimeHub } from "../runtime/hub";
import { createOpenCodeClient, listOpenCodeSessionTree } from "./opencode-client";

type Database = ReturnType<typeof createDatabase>;
type Scope = { id: string; changeID: string; commitSHA: string; attemptID: string };
export type ExecutionRead = z.output<typeof reviewExecutionArgumentsInput>;
const sensitiveName =
  /password|secret|token|authorization|cookie|credential|(?:^|_)key(?:$|_)|private.?key|api.?key|subscription.?key|access.?key/i;
const limits =
  "Factory receipts and retained, runtime-owned native history, not an exhaustive external-network, tamper-proof or out-of-band write audit. Native outputs, reasoning and prompts are withheld. Redacted, missing or truncated inputs remain unknown. Receipts do not replace immutable-source or actual App checks.";

// Redact the complete value before pagination, including a secret crossing a
// returned chunk boundary. Do not copy native tool outputs or reasoning.
export function sanitizeExecutionInput(value: unknown, secrets: readonly string[]) {
  const protectedValues = [...new Set(secrets.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  let redacted = false;
  let omitted = false;
  let nodes = 0;
  const mask = () => {
    redacted = true;
    return "<REDACTED>";
  };
  const text = (input: string) => {
    let result = input;
    for (const secret of protectedValues)
      result = result
        .split("<REDACTED>")
        .map((part) => (part.includes(secret) ? part.split(secret).join(mask()) : part))
        .join("<REDACTED>");
    result = result
      .replace(
        /\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{10,})\b/g,
        mask,
      )
      .replace(/\b(?:Bearer|Basic)\s+[^\s"'\\]+/gi, mask)
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_, prefix: string) => `${prefix}${mask()}@`)
      .replace(
        /([A-Za-z0-9_-]*(?:password|secret|token|credential|api[_-]?key|subscription[_-]?key|authorization|cookie)[A-Za-z0-9_-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,&]+)/gi,
        (_, prefix: string) => `${prefix}${mask()}`,
      );
    return result;
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 12 || ++nodes > 10_000) {
      omitted = true;
      return "[oversized or nested input omitted]";
    }
    if (typeof item === "string") return text(item);
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (Array.isArray(item)) return item.map((value) => visit(value, depth + 1));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, value]) => [
          text(key),
          sensitiveName.test(key) ? mask() : visit(value, depth + 1),
        ]),
      );
    omitted = true;
    return "[unsupported input omitted]";
  };
  const result = JSON.stringify(visit(value, 0));
  return { text: result, redacted, omitted };
}

export function executionInputChunk(value: string, offset: number, size: number) {
  const bytes = Buffer.from(value);
  let start = Math.min(offset, bytes.length);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  let end = Math.min(start + size, bytes.length);
  while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    input: bytes.subarray(start, end).toString(),
    inputStartsAt: start,
    inputTruncated: end < bytes.length,
    nextInputOffset: end < bytes.length ? end : null,
  };
}

export function projectExecutionActions(
  page: unknown,
  secrets: readonly string[],
  through = Number.POSITIVE_INFINITY,
) {
  if (!page || typeof page !== "object" || !("data" in page) || !Array.isArray(page.data))
    throw new Error("Native action history is unavailable");
  const actions: Array<{
    messageID: string;
    partID: string;
    tool: string;
    state: string;
    inputSHA256: string;
    input: string;
    redacted: boolean;
    inputOmitted: boolean;
  }> = [];
  let unclassified = 0;
  let laterActions = 0;
  for (const message of page.data) {
    if (!message || typeof message !== "object" || message.type !== "assistant") continue;
    if (typeof message.id !== "string" || !Array.isArray(message.content)) {
      unclassified++;
      continue;
    }
    for (const part of message.content) {
      if (!part || typeof part !== "object" || part.type !== "tool") continue;
      if (
        typeof part.name !== "string" ||
        typeof part.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,160}$/.test(part.name) ||
        !part.state ||
        typeof part.state !== "object" ||
        !("input" in part.state)
      ) {
        unclassified++;
        continue;
      }
      if (Number.isFinite(through)) {
        const time = part.time;
        if (
          !time ||
          typeof time.created !== "number" ||
          typeof time.completed !== "number" ||
          !Number.isFinite(time.created) ||
          !Number.isFinite(time.completed)
        ) {
          unclassified++;
          continue;
        }
        if (time.created > through || time.completed > through) {
          laterActions++;
          continue;
        }
      }
      const input = part.state.input ?? null;
      const typedInput = /(?:^|_)browser_(?:fill|type)$/.test(part.name);
      // Patches are independently available at the immutable candidate. Avoid
      // repeating source bodies or leaking newly written values into the audit.
      const projected = typedInput
        ? { typedValueWithheld: true }
        : part.name === "patch"
          ? {
              paths:
                typeof input?.patchText === "string"
                  ? [
                      ...input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
                    ].map((match) => match[1])
                  : [],
              bodyWithheld: true,
            }
          : input;
      const safe = sanitizeExecutionInput(projected, secrets);
      actions.push({
        messageID: message.id,
        partID: part.id,
        tool: part.name,
        state: ["completed", "error", "running", "pending"].includes(part.state.status)
          ? part.state.status
          : "unknown",
        inputSHA256: createHash("sha256").update(safe.text).digest("hex"),
        input: safe.text,
        redacted: safe.redacted,
        inputOmitted: safe.omitted || typedInput,
      });
    }
  }
  const cursor = "cursor" in page ? page.cursor : null;
  return {
    actions,
    unclassified,
    laterActions,
    nextCursor:
      cursor && typeof cursor === "object" && "next" in cursor && typeof cursor.next === "string"
        ? cursor.next
        : null,
  };
}

export function createReviewExecutionReader(
  database: Database,
  hub?: Pick<RuntimeHub, "request">,
  secrets?: EnvironmentSecrets,
) {
  return async (scope: Scope, input: ExecutionRead) => {
    const [candidate] = await database.client<
      { completedAt: string; workspaceID: string | null }[]
    >`
      SELECT operation.completed_at::text AS "completedAt",attempt.workspace_id AS "workspaceID"
      FROM factory.change_commit_operation operation
      JOIN factory.runtime_attempt attempt ON attempt.id=${scope.attemptID}
      WHERE operation.change_id=${scope.changeID} AND operation.commit_sha=${scope.commitSHA}
        AND operation.state='succeeded' ORDER BY operation.sequence DESC LIMIT 1`;
    if (!candidate) throw new Error("Exact candidate execution receipts are unavailable");
    if (input.section === "receipts") {
      const commits = await database.client`
        SELECT id,sequence,state,commit_sha AS commit,expected_parent_sha AS "expectedParent",
          observed_remote_sha AS "observedRemote",runtime_attempt_id AS "runtimeID",
          source,completed_at AS "completedAt"
        FROM factory.change_commit_operation WHERE change_id=${scope.changeID}
          AND created_at<=${candidate.completedAt}::timestamptz ORDER BY sequence
        LIMIT 33 OFFSET ${input.offset}`;
      return {
        candidate: scope.commitSHA,
        commits: commits.slice(0, 32),
        nextOffset: commits.length > 32 ? input.offset + 32 : null,
        limits,
      };
    }
    if (!hub || !candidate.workspaceID)
      return {
        candidate: scope.commitSHA,
        unavailable: "Native action reader is unavailable",
        limits,
      };
    const roots = await database.client<
      {
        sessionID: string;
        workspaceID: string | null;
        key: string | null;
        frozenID: string | null;
        fingerprint: string | null;
        commandID: string | null;
        manifest: unknown;
      }[]
    >`SELECT DISTINCT intent.session_id AS "sessionID",original.workspace_id AS "workspaceID",
        environment.secret_key AS key,environment.runtime_attempt_id AS "frozenID",
        write.fingerprint,write.command_id AS "commandID",write.manifest
      FROM factory.change_agent_turn_intent intent
      JOIN factory.agent_turn turn ON turn.id=intent.turn_id
      LEFT JOIN factory.runtime_attempt original ON original.id=intent.runtime_attempt_id
      LEFT JOIN factory.runtime_environment_intent environment ON environment.runtime_attempt_id=intent.runtime_attempt_id
      LEFT JOIN factory.environment_write write ON write.secret_key=environment.secret_key AND write.state='committed'
      WHERE intent.change_id=${scope.changeID} AND NOT (turn.authority ? 'review')
        AND turn.created_at<=${candidate.completedAt}::timestamptz ORDER BY intent.session_id`;
    if (!roots.length || roots.some((root) => root.workspaceID !== candidate.workspaceID))
      return {
        candidate: scope.commitSHA,
        unavailable: "Implementation history has an uninspectable Workspace identity",
        limits,
      };
    const hidden: string[] = [];
    for (const key of roots) {
      if (!key.frozenID)
        return {
          candidate: scope.commitSHA,
          unavailable: "Historical environment identity is unavailable",
          limits,
        };
      if (!key.key) continue;
      const stored = await secrets?.read(key.key);
      if (
        !stored ||
        stored.commandID !== key.commandID ||
        stored.fingerprint !== key.fingerprint ||
        JSON.stringify(environmentManifest.parse(environmentMetadata(stored.bundle))) !==
          JSON.stringify(environmentManifest.parse(key.manifest))
      )
        return {
          candidate: scope.commitSHA,
          unavailable: "Historical input redaction is unavailable",
          limits,
        };
      hidden.push(
        ...stored.bundle.variables.map((variable) => variable.value),
        ...stored.bundle.registries.map((registry) => registry.password),
      );
    }
    const client = createOpenCodeClient((request, path) =>
      hub.request(scope.attemptID, "agent", request, path),
    );
    const sessions: string[] = [];
    for (const root of new Set(roots.map((root) => root.sessionID)))
      for (const sessionID of await listOpenCodeSessionTree(client, root))
        if (!sessions.includes(sessionID)) sessions.push(sessionID);
    const session = sessions[input.session];
    if (!session) throw new Error("Choose a recorded implementation Session index");
    const page = await client.message.list(
      {
        sessionID: session,
        limit: 20,
        ...(input.cursor ? { cursor: input.cursor } : { order: "asc" as const }),
      },
      { signal: AbortSignal.timeout(5_000) },
    );
    const through = Date.parse(candidate.completedAt);
    if (!Number.isFinite(through)) throw new Error("Candidate execution time is unavailable");
    const projected = projectExecutionActions(page, hidden, through);
    if (input.action !== undefined && !projected.actions[input.action])
      throw new Error("Choose an action from this native page");
    if (input.offset > projected.actions.length)
      throw new Error("Action offset is outside this native page");
    const selected =
      input.action === undefined
        ? projected.actions.slice(input.offset, input.offset + 12)
        : projected.actions.slice(input.action, input.action + 1);
    return {
      candidate: scope.commitSHA,
      through: candidate.completedAt,
      sessionIndex: input.session,
      sessionID: session,
      totalSessions: sessions.length,
      actions: selected.map((action) => {
        const start = input.action === undefined ? 0 : input.inputOffset;
        const size = input.action === undefined ? 1_024 : 8_000;
        return {
          ...action,
          ...executionInputChunk(action.input, start, size),
        };
      }),
      actionsInPage: projected.actions.length,
      nextOffset:
        input.action === undefined && input.offset + 12 < projected.actions.length
          ? input.offset + 12
          : null,
      nextCursor: projected.nextCursor,
      unclassified: projected.unclassified,
      laterActions: projected.laterActions,
      limits,
    };
  };
}
