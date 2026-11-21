import { createHmac } from "node:crypto";
import { and, desc, eq, inArray, notInArray, sql as query } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  authUser,
  workspaceCommand,
  workspaceTerminalOperation,
} from "../../../../packages/db/src/schema";
import {
  type WorkspaceCommandInput,
  type WorkspaceCommandRead,
  workspaceCommandInput,
  workspaceCommandRead,
} from "../../../../packages/workspace-domain/src/commands";
import { workspaceAuthorityIn, workspaceWriteAuthorityIn } from "../access/api";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { type createRuntimeController } from "../runtime/api";
import { type RuntimeHub } from "../runtime/transport-api";
import { createWorkspaceComputeAccess } from "./compute-api";

const nativeView = z.object({
  id: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(["starting", "running", "exited", "cancelled", "failed"]),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  stdoutFrom: z.number().int().nonnegative(),
  stderrFrom: z.number().int().nonnegative(),
  stdoutNext: z.number().int().nonnegative(),
  stderrNext: z.number().int().nonnegative(),
  outputLost: z.boolean(),
});
type NativeView = z.infer<typeof nativeView>;
const commandOutcome = z.object({
  pid: z.number().int().positive().nullable().default(null),
  startedAt: z.string().datetime({ offset: true }).nullable().default(null),
  completedAt: z.string().datetime({ offset: true }).nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  summary: z.string().max(512).nullable().default(null),
});
type CommandRow = {
  id: string;
  workspaceID: string;
  attemptID: string;
  actorID: string;
  digest: string;
  state: string;
  attempted: boolean;
  result: unknown;
  kind: "shell" | "terminal";
};
const terminalStates: Array<(typeof workspaceCommand.$inferSelect)["state"]> = [
  "exited",
  "cancelled",
  "failed",
  "interrupted",
];
const commandFields = {
  id: workspaceCommand.id,
  workspaceID: workspaceCommand.workspaceId,
  attemptID: workspaceCommand.runtimeAttemptId,
  actorID: workspaceCommand.actorId,
  digest: workspaceCommand.inputDigest,
  state: workspaceCommand.state,
  attempted: query<boolean>`${workspaceCommand.dispatchAttemptedAt} IS NOT NULL`,
  result: workspaceCommand.result,
  kind: workspaceCommand.kind,
};
const terminal = (state: string) => terminalStates.some((value) => value === state);

export function createWorkspaceCommands(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  runtime: Pick<ReturnType<typeof createRuntimeController>, "start" | "startPersisted" | "get">,
  signingKey: string,
) {
  const observations = new Set<Promise<unknown>>();
  const starts = new Set<Promise<unknown>>();
  let closing = false;
  const ready = createWorkspaceComputeAccess(database, hub, runtime, () => closing);
  async function row(id: string) {
    const [record] = await database.db
      .select(commandFields)
      .from(workspaceCommand)
      .where(eq(workspaceCommand.id, id));
    if (!record) throw new CommandError("not-found", "Command not found");
    return record;
  }
  function view(record: CommandRow) {
    return {
      commandID: record.id,
      workspaceID: record.workspaceID,
      attemptID: record.attemptID,
      actorID: record.actorID,
      state: record.state,
      kind: record.kind,
      ...commandOutcome.parse(record.result),
    };
  }
  async function observe(attemptID: string, value: NativeView) {
    const result = {
      pid: value.pid ?? null,
      startedAt: value.startedAt ?? null,
      completedAt: value.completedAt ?? null,
      exitCode: value.exitCode ?? null,
      summary:
        value.state === "failed"
          ? "The shell could not start."
          : value.state === "exited" && value.exitCode !== 0
            ? `Command exited with code ${value.exitCode}.`
            : null,
    };
    // A late start acknowledgement must not overwrite an already observed final outcome.
    await database.db
      .update(workspaceCommand)
      .set({ state: value.state, result, updatedAt: query`now()` })
      .where(
        and(
          eq(workspaceCommand.id, value.id),
          eq(workspaceCommand.runtimeAttemptId, attemptID),
          eq(workspaceCommand.inputDigest, value.digest),
          notInArray(workspaceCommand.state, terminalStates),
        ),
      );
  }
  const unsubscribe = hub.onCommandState((attemptID, data) => {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = nativeView.safeParse(value);
    if (!parsed.success) return;
    const pending = observe(attemptID, parsed.data).catch(
      reportFailure("Command outcome observation failed"),
    );
    observations.add(pending);
    void pending.finally(() => observations.delete(pending));
  });
  async function authorized(userID: string, record: CommandRow, write = false) {
    return database.client.begin((sql) =>
      workspaceAuthorityIn(sql, record.workspaceID, userID, write),
    );
  }
  async function call(
    userID: string,
    record: CommandRow,
    action: string,
    data: unknown,
    write: boolean,
    output = false,
  ) {
    if (write && closing) throw new CommandError("unavailable", "Factory is stopping");
    const response = await hub.childRequest(
      record.attemptID,
      {
        operationId: crypto.randomUUID(),
        action,
        data: JSON.stringify(data),
      },
      async (send) => {
        await database.client.begin(async (sql) => {
          if (write) await workspaceWriteAuthorityIn(sql, record.workspaceID, userID);
          else await workspaceAuthorityIn(sql, record.workspaceID, userID, output);
          send();
        });
      },
    );
    if (!response) throw new CommandError("unavailable", "Native command outcome is unconfirmed");
    const result = nativeView.parse(JSON.parse(response));
    if (result.id !== record.id || result.digest !== record.digest)
      throw new CommandError(
        "unavailable",
        "Native command identity differs from its retained intent",
      );
    await observe(record.attemptID, result);
    return result;
  }
  return {
    async list(userID: string, workspaceID: string, offset = 0, limit = 50) {
      z.uuid().parse(workspaceID);
      z.number().int().nonnegative().max(100000).parse(offset);
      z.number().int().positive().max(100).parse(limit);
      await database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, userID));
      const rows = await database.db
        .select({
          ...commandFields,
          actorName: query<string>`left(${authUser.name},160)`,
          createdAt: query<string>`${workspaceCommand.createdAt}::text`,
        })
        .from(workspaceCommand)
        .innerJoin(authUser, eq(authUser.id, workspaceCommand.actorId))
        .where(eq(workspaceCommand.workspaceId, workspaceID))
        .orderBy(desc(workspaceCommand.createdAt), desc(workspaceCommand.id))
        .offset(offset)
        .limit(limit + 1);
      return {
        commands: rows.slice(0, limit).map((row) => ({
          ...view(row),
          actorName: row.actorName,
          createdAt: z.coerce.date().parse(row.createdAt).toISOString(),
        })),
        nextOffset: rows.length > limit ? offset + limit : null,
        observation: "retained",
      };
    },
    async start(
      userID: string,
      value: WorkspaceCommandInput,
      kind: "shell" | "terminal" = "shell",
    ) {
      if (closing) throw new CommandError("unavailable", "Factory is stopping");
      const pending = (async () => {
        const input = workspaceCommandInput.parse(value);
        const definition = {
          kind,
          workspaceID: input.workspaceID,
          command: input.command,
          cwd: input.cwd ?? "",
          env: Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right)),
        };
        const encoded = JSON.stringify(definition);
        if (Buffer.byteLength(encoded) > 256 << 10)
          throw new CommandError("invalid", "Command input is too large");
        const digest = createHmac("sha256", signingKey).update(encoded).digest("hex");
        await database.client.begin((sql) =>
          workspaceWriteAuthorityIn(sql, input.workspaceID, userID),
        );
        const [previous] = await database.db
          .select({ id: workspaceCommand.id })
          .from(workspaceCommand)
          .where(eq(workspaceCommand.id, input.requestID));
        const attemptID = previous
          ? (await row(input.requestID)).attemptID
          : await ready(input.workspaceID, userID);
        const claimed = await database.client.begin(async (sql) => {
          await workspaceWriteAuthorityIn(sql, input.workspaceID, userID);
          const db = drizzleTransaction(sql);
          await db
            .insert(workspaceCommand)
            .values({
              id: input.requestID,
              workspaceId: input.workspaceID,
              runtimeAttemptId: attemptID,
              actorId: userID,
              inputDigest: digest,
              kind,
            })
            .onConflictDoNothing({ target: workspaceCommand.id });
          const [current] = await db
            .select(commandFields)
            .from(workspaceCommand)
            .where(eq(workspaceCommand.id, input.requestID))
            .for("update");
          if (
            !current ||
            current.digest !== digest ||
            current.actorID !== userID ||
            current.workspaceID !== input.workspaceID
          )
            throw new CommandError(
              "conflict",
              "This command identity already records different input or ownership",
            );
          if (current.attempted || terminal(current.state)) return false;
          await db
            .update(workspaceCommand)
            .set({
              state: "dispatching",
              dispatchAttemptedAt: query`now()`,
              updatedAt: query`now()`,
            })
            .where(eq(workspaceCommand.id, input.requestID));
          return true;
        });
        const record = await row(input.requestID);
        if (!claimed) {
          await authorized(userID, record);
          return view(record);
        }
        try {
          await call(
            userID,
            record,
            kind === "terminal" ? "pty-open" : "command-start",
            {
              id: record.id,
              digest,
              command: input.command,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              env: input.env,
            },
            true,
          );
        } catch {
          // Persisted dispatch forbids automatic replay, including after a lost transport response.
          await database.db
            .update(workspaceCommand)
            .set({ state: "uncertain", updatedAt: query`now()` })
            .where(
              and(
                eq(workspaceCommand.id, record.id),
                inArray(workspaceCommand.state, ["start-intended", "dispatching", "starting"]),
              ),
            );
        }
        await authorized(userID, record);
        return view(await row(record.id));
      })();
      starts.add(pending);
      try {
        return await pending;
      } finally {
        starts.delete(pending);
      }
    },
    async status(userID: string, commandID: string) {
      const record = await row(z.uuid().parse(commandID));
      await authorized(userID, record);
      let observed = false;
      if (!terminal(record.state) && hub.connected(record.attemptID)) {
        try {
          await call(
            userID,
            record,
            record.kind === "terminal" ? "pty-read" : "command-read",
            { id: record.id },
            false,
          );
          observed = true;
        } catch (cause) {
          if (cause instanceof CommandError && ["forbidden", "not-found"].includes(cause.code))
            throw cause;
        }
      } else if (!terminal(record.state)) {
        const attempt = await runtime.get(record.attemptID);
        if (attempt?.state === "stopped")
          await database.db
            .update(workspaceCommand)
            .set({ state: "interrupted", updatedAt: query`now()` })
            .where(
              and(
                eq(workspaceCommand.id, record.id),
                notInArray(workspaceCommand.state, terminalStates),
              ),
            );
      }
      await authorized(userID, record);
      return { ...view(await row(record.id)), observation: observed ? "current" : "retained" };
    },
    async read(userID: string, value: WorkspaceCommandRead, expectedKind?: "shell" | "terminal") {
      const input = workspaceCommandRead.parse(value);
      const record = await row(input.commandID);
      if (expectedKind && record.kind !== expectedKind)
        throw new CommandError("not-found", "Execution handle has another kind");
      await authorized(userID, record, true);
      if (!hub.connected(record.attemptID)) {
        const attempt = await runtime.get(record.attemptID);
        if (attempt && ["paused", "resuming", "starting"].includes(attempt.state))
          await ready(record.workspaceID, userID, false, record.attemptID);
      }
      if (!hub.connected(record.attemptID))
        return { ...view(record), stdout: "", stderr: "", outputAvailable: false };
      const result = await call(
        userID,
        record,
        record.kind === "terminal" ? "pty-read" : "command-read",
        { id: record.id, stdout: input.stdout, stderr: input.stderr },
        false,
        true,
      );
      await authorized(userID, record, true);
      return {
        ...view(await row(record.id)),
        stdout: Buffer.from(result.stdout ?? "", "base64").toString("utf8"),
        stderr: Buffer.from(result.stderr ?? "", "base64").toString("utf8"),
        stdoutFrom: result.stdoutFrom,
        stderrFrom: result.stderrFrom,
        stdoutNext: result.stdoutNext,
        stderrNext: result.stderrNext,
        outputLost: result.outputLost,
        outputAvailable: true,
      };
    },
    async cancel(userID: string, commandID: string, expectedKind?: "shell" | "terminal") {
      const record = await row(z.uuid().parse(commandID));
      if (expectedKind && record.kind !== expectedKind)
        throw new CommandError("not-found", "Execution handle has another kind");
      await authorized(userID, record, true);
      if (terminal(record.state)) return view(record);
      await call(
        userID,
        record,
        record.kind === "terminal" ? "pty-close" : "command-cancel",
        { id: record.id },
        true,
      );
      await authorized(userID, record);
      return view(await row(record.id));
    },
    async terminalOperation(
      userID: string,
      value: {
        requestID: string;
        terminalID: string;
        action: "input" | "resize";
        input?: string;
        columns?: number;
        rows?: number;
      },
    ) {
      const input = z
        .strictObject({
          requestID: z.uuid(),
          terminalID: z.uuid(),
          action: z.enum(["input", "resize"]),
          input: z.string().max(8192).optional(),
          columns: z.number().int().min(2).max(500).optional(),
          rows: z.number().int().min(1).max(500).optional(),
        })
        .parse(value);
      if (
        input.action === "input"
          ? input.input === undefined
          : input.columns === undefined || input.rows === undefined
      )
        throw new CommandError("invalid", "Terminal operation needs input or dimensions");
      if (input.input && Buffer.byteLength(input.input) > 8192)
        throw new CommandError("invalid", "Terminal input is too large");
      const record = await row(input.terminalID);
      if (record.kind !== "terminal") throw new CommandError("not-found", "Terminal not found");
      await authorized(userID, record, true);
      const digest = createHmac("sha256", signingKey).update(JSON.stringify(input)).digest("hex");
      const previous = await database.client.begin(async (sql) => {
        await workspaceWriteAuthorityIn(sql, record.workspaceID, userID);
        const db = drizzleTransaction(sql);
        const [created] = await db
          .insert(workspaceTerminalOperation)
          .values({
            id: input.requestID,
            commandId: record.id,
            actorId: userID,
            action: input.action,
            inputDigest: digest,
          })
          .onConflictDoNothing({ target: workspaceTerminalOperation.id })
          .returning({ id: workspaceTerminalOperation.id });
        if (created) return undefined;
        const [existing] = await db
          .select({
            commandID: workspaceTerminalOperation.commandId,
            actorID: workspaceTerminalOperation.actorId,
            action: workspaceTerminalOperation.action,
            digest: workspaceTerminalOperation.inputDigest,
            result: workspaceTerminalOperation.result,
          })
          .from(workspaceTerminalOperation)
          .where(eq(workspaceTerminalOperation.id, input.requestID));
        if (
          !existing ||
          existing.commandID !== record.id ||
          existing.actorID !== userID ||
          existing.digest !== digest ||
          existing.action !== input.action
        )
          throw new CommandError(
            "conflict",
            "Terminal input identity already records different input",
          );
        return { result: existing.result };
      });
      if (previous) {
        await authorized(userID, record, true);
        return previous.result ?? { requestID: input.requestID, state: "uncertain" };
      }
      try {
        await call(
          userID,
          record,
          input.action === "input" ? "pty-input" : "pty-resize",
          {
            id: record.id,
            ...(input.action === "input"
              ? { input: Buffer.from(input.input ?? "").toString("base64") }
              : { columns: input.columns, rows: input.rows }),
          },
          true,
        );
      } catch {
        await authorized(userID, record, true);
        return { requestID: input.requestID, state: "uncertain" };
      }
      const result = view(await row(record.id));
      await database.db
        .update(workspaceTerminalOperation)
        .set({ result, completedAt: query`now()` })
        .where(eq(workspaceTerminalOperation.id, input.requestID));
      await authorized(userID, record);
      return result;
    },
    async close() {
      closing = true;
      unsubscribe();
      await Promise.allSettled([...starts]);
      await Promise.allSettled([...observations]);
    },
  };
}
