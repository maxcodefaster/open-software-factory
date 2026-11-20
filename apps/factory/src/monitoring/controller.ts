import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lt, or, sql as query } from "drizzle-orm";
import type { z } from "zod";
import type { MCPAssignment } from "../../../../packages/conversation-domain/src/mcp-library";
import {
  defaultAutofixInstructions,
  monitoringChange,
  monitoringSave,
  monitoringView,
} from "../../../../packages/conversation-domain/src/monitoring";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  monitoringCommand,
  monitoringHook,
  monitoringIncident,
  monitoringPolicy,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import {
  inputAssignmentsIn,
  manageMonitoringIn,
  monitoringAuthorityIn,
  retainedInputAssignments,
  validateInputAssignmentsIn,
} from "./authority";
import { type MonitoringSignal, monitoringDigest } from "./payload";

type Database = ReturnType<typeof createDatabase>;

export function createMonitoringController(
  database: Database,
  signingKey: string,
  origin: string,
  wake: (projectId: string) => void,
) {
  const manageIn = manageMonitoringIn;
  function key(id: string, commandId: string) {
    return createHmac("sha256", signingKey)
      .update(`factory-monitoring-key-v1:${id}:${commandId}`)
      .digest("base64url");
  }
  function webhook(id: string, commandId: string) {
    return `${origin}/hooks/inputs/${id}/${key(id, commandId)}`;
  }
  async function replayIn(
    sql: DatabaseTransaction,
    userId: string,
    projectId: string,
    hookId: string,
    commandId: string,
    action: string,
    input: unknown,
  ) {
    const db = drizzleTransaction(sql);
    await db.execute(
      query`SELECT pg_advisory_xact_lock(hashtext(${`monitoring-command:${commandId}`}))`,
    );
    const [old] = await db
      .select({
        userId: monitoringCommand.actorId,
        projectId: monitoringCommand.projectId,
        hookId: monitoringCommand.hookId,
        action: monitoringCommand.action,
        digest: monitoringCommand.inputDigest,
      })
      .from(monitoringCommand)
      .where(eq(monitoringCommand.id, commandId));
    if (
      old &&
      (old.userId !== userId ||
        old.projectId !== projectId ||
        old.hookId !== hookId ||
        old.action !== action ||
        old.digest !== monitoringDigest(input))
    )
      throw new CommandError(
        "conflict",
        "Webhook command identity was reused with different input",
      );
    return Boolean(old);
  }
  async function recordIn(
    sql: DatabaseTransaction,
    userId: string,
    projectId: string,
    hookId: string,
    commandId: string,
    action: string,
    input: unknown,
  ) {
    await drizzleTransaction(sql)
      .insert(monitoringCommand)
      .values({
        id: commandId,
        projectId,
        hookId,
        actorId: userId,
        action,
        inputDigest: monitoringDigest(input),
      });
  }
  const authorityIn = (sql: DatabaseTransaction, incidentId: string) =>
    monitoringAuthorityIn(database, sql, incidentId);
  return {
    authorityIn,
    authorize: (incidentId: string) => database.client.begin((sql) => authorityIn(sql, incidentId)),
    async view(projectId: string, userId: string) {
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const manager = await projectAuthorityIn(sql, userId, projectId);
        let developer = false;
        try {
          await projectDevelopmentAuthorityIn(sql, userId, projectId);
          developer = true;
        } catch (cause) {
          if (!(cause instanceof CommandError) || cause.code !== "forbidden") throw cause;
        }
        const hooks = await db
          .select({
            id: monitoringHook.id,
            name: monitoringHook.name,
            version: monitoringHook.version,
            enabled: monitoringHook.enabled,
            delegatedBy: monitoringPolicy.delegatedBy,
            policyId: monitoringPolicy.id,
            assignment: monitoringPolicy.assignment,
            sourceAssignments: monitoringPolicy.sourceAssignments,
            connectionIds: monitoringPolicy.sourceIds,
            instructions: query<string>`coalesce(${monitoringPolicy.instructions},${defaultAutofixInstructions})`,
            delegation: monitoringPolicy.delegation,
          })
          .from(monitoringHook)
          .innerJoin(monitoringPolicy, eq(monitoringPolicy.id, monitoringHook.policyId))
          .where(eq(monitoringHook.projectId, projectId))
          .orderBy(asc(monitoringHook.name), asc(monitoringHook.id));
        const checked = [];
        for (const hook of hooks) {
          let delegationCurrent = false;
          if (hook.enabled) {
            try {
              await manageIn(
                sql,
                hook.delegatedBy,
                projectId,
                hook.delegation === "prepare-ticket"
                  ? "prepare-ticket"
                  : "application-fix-and-delivery",
              );
              await validateInputAssignmentsIn(
                database,
                sql,
                retainedInputAssignments({
                  sourceAssignments: hook.sourceAssignments as MCPAssignment[] | null,
                  assignment: hook.assignment as MCPAssignment | null,
                }),
                projectId,
                hook.delegatedBy,
              );
              delegationCurrent = true;
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
            }
          }
          const assignments = retainedInputAssignments({
            sourceAssignments: hook.sourceAssignments as MCPAssignment[] | null,
            assignment: hook.assignment as MCPAssignment | null,
          });
          checked.push({
            ...hook,
            sourceIds: assignments.map((source) => source.connectionId),
            connectionIds:
              hook.sourceAssignments === null
                ? assignments.map((source) => source.connectionId)
                : hook.connectionIds,
            delegationCurrent,
          });
        }
        const incidents = await db
          .select({
            id: monitoringIncident.id,
            hookId: monitoringIncident.hookId,
            title: monitoringIncident.title,
            state: monitoringIncident.state,
            occurrences: monitoringIncident.occurrences,
            reason: monitoringIncident.reason,
            ticketId: monitoringIncident.ticketId,
            receivedAt: query<string>`${monitoringIncident.receivedAt}::text`,
            lastSeenAt: query<string>`${monitoringIncident.lastSeenAt}::text`,
          })
          .from(monitoringIncident)
          .where(eq(monitoringIncident.projectId, projectId))
          .orderBy(desc(monitoringIncident.lastSeenAt), asc(monitoringIncident.id))
          .limit(50);
        return monitoringView.parse({
          canManage: manager,
          canDelegate: manager && developer,
          canDisable: manager,
          hooks: checked,
          incidents,
        });
      });
    },
    async save(projectId: string, userId: string, value: z.input<typeof monitoringSave>) {
      const input = monitoringSave.parse(value);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await manageIn(sql, userId, projectId, input.delegation);
        const replay = await replayIn(
          sql,
          userId,
          projectId,
          input.id,
          input.commandId,
          "save",
          input,
        );
        const [old] = await db
          .select({
            projectId: monitoringHook.projectId,
            version: monitoringHook.version,
            digest: monitoringHook.secretDigest,
          })
          .from(monitoringHook)
          .where(eq(monitoringHook.id, input.id))
          .for("update");
        if (old && old.projectId !== projectId)
          throw new CommandError("not-found", "Webhook not found");
        if (replay)
          return {
            url:
              old?.digest === monitoringDigest(key(input.id, input.commandId))
                ? webhook(input.id, input.commandId)
                : null,
          };
        if ((old?.version ?? 0) !== input.expectedVersion)
          throw new CommandError("conflict", "Webhook changed. Reload before saving");
        const assignments = await inputAssignmentsIn(
          database,
          sql,
          input.connectionIds,
          projectId,
          userId,
        );
        if (input.delegation === "application-fix-and-delivery" && !assignments.length)
          throw new CommandError(
            "conflict",
            "Automatic fixes require a connected read-only source",
          );
        const policyId = crypto.randomUUID();
        if (old)
          await db
            .update(monitoringHook)
            .set({
              name: input.name,
              enabled: input.enabled,
              policyId,
              version: query<number>`${monitoringHook.version}+1`,
            })
            .where(eq(monitoringHook.id, input.id));
        else
          await db.insert(monitoringHook).values({
            id: input.id,
            projectId,
            name: input.name,
            enabled: input.enabled,
            version: 1,
            secretDigest: monitoringDigest(key(input.id, input.commandId)),
            policyId,
          });
        await db.insert(monitoringPolicy).values({
          id: policyId,
          hookId: input.id,
          connectionId: null,
          assignment: null,
          delegatedBy: userId,
          delegation: input.delegation,
          instructions: input.instructions,
          sourceIds: input.connectionIds,
          sourceAssignments: assignments,
        });
        await recordIn(sql, userId, projectId, input.id, input.commandId, "save", input);
        return { url: old ? null : webhook(input.id, input.commandId) };
      });
    },
    async change(
      projectId: string,
      id: string,
      userId: string,
      action: "disable" | "rotate",
      value: z.input<typeof monitoringChange>,
    ) {
      const input = monitoringChange.parse(value);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await projectAuthorityIn(sql, userId, projectId, true);
        const replay = await replayIn(sql, userId, projectId, id, input.commandId, action, input);
        const [old] = await db
          .select({ version: monitoringHook.version, digest: monitoringHook.secretDigest })
          .from(monitoringHook)
          .where(and(eq(monitoringHook.id, id), eq(monitoringHook.projectId, projectId)))
          .for("update");
        if (!old) throw new CommandError("not-found", "Webhook not found");
        if (replay)
          return {
            url:
              action === "rotate" && old.digest === monitoringDigest(key(id, input.commandId))
                ? webhook(id, input.commandId)
                : null,
          };
        if (old.version !== input.expectedVersion)
          throw new CommandError("conflict", "Webhook changed. Reload before changing it");
        // Rotation also disables execution. A fresh explicit save/delegation is
        // required, rather than carrying queued work across a leaked key.
        await db
          .update(monitoringHook)
          .set({
            enabled: false,
            version: query<number>`${monitoringHook.version}+1`,
            secretDigest:
              action === "rotate" ? monitoringDigest(key(id, input.commandId)) : old.digest,
          })
          .where(eq(monitoringHook.id, id));
        await recordIn(sql, userId, projectId, id, input.commandId, action, input);
        return { url: action === "rotate" ? webhook(id, input.commandId) : null };
      });
    },
    async authenticate(id: string, presented: string) {
      const [hook] = await database.db
        .select({ digest: monitoringHook.secretDigest, enabled: monitoringHook.enabled })
        .from(monitoringHook)
        .where(eq(monitoringHook.id, id));
      const expected = Buffer.from(hook?.digest ?? "0".repeat(64), "hex");
      const candidate = Buffer.from(monitoringDigest(presented), "hex");
      return Boolean(timingSafeEqual(expected, candidate) && hook?.enabled);
    },
    async receive(
      id: string,
      presented: string,
      payloadDigest: string,
      signals: MonitoringSignal[],
    ) {
      const result = await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const [hook] = await db
          .select({
            projectId: monitoringHook.projectId,
            policyId: monitoringHook.policyId,
            version: monitoringHook.version,
            digest: monitoringHook.secretDigest,
            enabled: monitoringHook.enabled,
          })
          .from(monitoringHook)
          .where(eq(monitoringHook.id, id))
          .for("update");
        if (
          !hook?.enabled ||
          !timingSafeEqual(
            Buffer.from(hook.digest, "hex"),
            Buffer.from(monitoringDigest(presented), "hex"),
          )
        )
          throw new CommandError("not-found", "Webhook not found");
        const expired = lt(monitoringHook.receivedWindow, query`now()-interval '1 minute'`);
        const [rate] = await db
          .update(monitoringHook)
          .set({
            receivedCount: query<number>`CASE WHEN ${expired} THEN 1 ELSE ${monitoringHook.receivedCount}+1 END`,
            receivedWindow: query<Date>`CASE WHEN ${expired} THEN now() ELSE ${monitoringHook.receivedWindow} END`,
          })
          .where(and(eq(monitoringHook.id, id), or(expired, lt(monitoringHook.receivedCount, 120))))
          .returning({ id: monitoringHook.id });
        if (!rate)
          return {
            projectId: hook.projectId,
            limited: true,
            accepted: 0,
            duplicates: 0,
            ignored: 0,
          };
        let accepted = 0;
        let duplicates = 0;
        let ignored = 0;
        for (const signal of signals) {
          if (signal.ignored) {
            ignored++;
            continue;
          }
          const [duplicate] = await db
            .update(monitoringIncident)
            .set({
              occurrences: query<number>`${monitoringIncident.occurrences}+1`,
              lastSeenAt: query<Date>`now()`,
            })
            .where(
              and(
                eq(monitoringIncident.hookId, id),
                eq(monitoringIncident.fingerprint, signal.fingerprint),
              ),
            )
            .returning({ id: monitoringIncident.id });
          if (duplicate) {
            duplicates++;
            continue;
          }
          const [queued] = await db
            .select({ count: count() })
            .from(monitoringIncident)
            .where(
              and(
                eq(monitoringIncident.hookId, id),
                inArray(monitoringIncident.state, ["queued", "diagnosing", "implementing"]),
              ),
            );
          if (Number(queued?.count) >= 50)
            throw new CommandError(
              "conflict",
              "This Input has 50 unsettled requests. Resolve them before sending more",
            );
          await db.insert(monitoringIncident).values({
            id: crypto.randomUUID(),
            hookId: id,
            projectId: hook.projectId,
            policyId: hook.policyId,
            hookVersion: hook.version,
            fingerprint: signal.fingerprint,
            payloadDigest,
            title: signal.title,
            reference: signal.reference,
            context: signal.context,
          });
          accepted++;
        }
        return { projectId: hook.projectId, limited: false, accepted, duplicates, ignored };
      });
      if (result.accepted) wake(result.projectId);
      return result;
    },
  };
}
