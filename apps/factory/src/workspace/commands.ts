import { createHmac } from "node:crypto";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  workspaceCommandInput,
  workspaceCommandRead,
  type WorkspaceCommandInput,
  type WorkspaceCommandRead,
} from "../../../../packages/workspace-domain/src/commands";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import type { createRuntimeController } from "../runtime/controller";
import type { RuntimeHub } from "../runtime/hub";
import { createWorkspaceComputeAccess } from "./compute-access";

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
const terminalStates = ["exited", "cancelled", "failed", "interrupted"];

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
    const [record] = await database.client<CommandRow[]>`SELECT id,workspace_id AS "workspaceID",
      runtime_attempt_id AS "attemptID",actor_id AS "actorID",input_digest AS digest,state,
      dispatch_attempted_at IS NOT NULL AS attempted,result,kind FROM factory.workspace_command WHERE id=${id}`;
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
    await database.client`UPDATE factory.workspace_command SET state=${value.state},result=${JSON.stringify(result)}::text::jsonb,updated_at=now()
      WHERE id=${value.id} AND runtime_attempt_id=${attemptID} AND input_digest=${value.digest}
        AND state NOT IN ('exited','cancelled','failed','interrupted')`;
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
      const rows = await database.client<
        (CommandRow & { actorName: string; createdAt: string })[]
      >`SELECT command.id,command.workspace_id AS "workspaceID",command.runtime_attempt_id AS "attemptID",
        command.actor_id AS "actorID",left(person.name,160) AS "actorName",command.input_digest AS digest,command.state,command.kind,
        command.dispatch_attempted_at IS NOT NULL AS attempted,command.result,command.created_at::text AS "createdAt"
        FROM factory.workspace_command command JOIN auth."user" person ON person.id=command.actor_id
        WHERE command.workspace_id=${workspaceID} ORDER BY command.created_at DESC,command.id DESC OFFSET ${offset} LIMIT ${limit + 1}`;
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
        const [previous] = await database.client<
          { id: string }[]
        >`SELECT id FROM factory.workspace_command WHERE id=${input.requestID}`;
        const attemptID = previous
          ? (await row(input.requestID)).attemptID
          : await ready(input.workspaceID, userID);
        const claimed = await database.client.begin(async (sql) => {
          await workspaceWriteAuthorityIn(sql, input.workspaceID, userID);
          await sql`INSERT INTO factory.workspace_command(id,workspace_id,runtime_attempt_id,actor_id,input_digest,kind)
          VALUES(${input.requestID},${input.workspaceID},${attemptID},${userID},${digest},${kind}) ON CONFLICT(id) DO NOTHING`;
          const [current] = await sql<
            {
              digest: string;
              actorID: string;
              workspaceID: string;
              state: string;
              attempted: boolean;
            }[]
          >`
          SELECT input_digest AS digest,actor_id AS "actorID",workspace_id AS "workspaceID",state,
            dispatch_attempted_at IS NOT NULL AS attempted FROM factory.workspace_command WHERE id=${input.requestID} FOR UPDATE`;
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
          if (current.attempted || terminalStates.includes(current.state)) return false;
          await sql`UPDATE factory.workspace_command SET state='dispatching',dispatch_attempted_at=now(),updated_at=now() WHERE id=${input.requestID}`;
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
          await database.client`UPDATE factory.workspace_command SET state='uncertain',updated_at=now()
          WHERE id=${record.id} AND state IN ('start-intended','dispatching','starting')`;
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
      if (!terminalStates.includes(record.state) && hub.connected(record.attemptID)) {
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
      } else if (!terminalStates.includes(record.state)) {
        const attempt = await runtime.get(record.attemptID);
        if (attempt?.state === "stopped")
          await database.client`UPDATE factory.workspace_command SET state='interrupted',updated_at=now()
            WHERE id=${record.id} AND state NOT IN ('exited','cancelled','failed','interrupted')`;
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
        if (attempt?.state === "paused" || attempt?.state === "resuming")
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
      if (terminalStates.includes(record.state)) return view(record);
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
        const [created] =
          await sql`INSERT INTO factory.workspace_terminal_operation(id,command_id,actor_id,action,input_digest)
          VALUES(${input.requestID},${record.id},${userID},${input.action},${digest}) ON CONFLICT(id) DO NOTHING RETURNING id`;
        if (created) return undefined;
        const [existing] = await sql<
          { commandID: string; actorID: string; action: string; digest: string; result: unknown }[]
        >`
          SELECT command_id AS "commandID",actor_id AS "actorID",action,input_digest AS digest,result
          FROM factory.workspace_terminal_operation WHERE id=${input.requestID}`;
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
      await database.client`UPDATE factory.workspace_terminal_operation SET result=${JSON.stringify(result)}::text::jsonb,completed_at=now() WHERE id=${input.requestID}`;
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
