import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { change, changeAgentSession, runtimeAttempt } from "#db/schema";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";

// Recovery may confirm Stop while its original dispatcher is still awaiting a
// connection/body. Serialize the actual send with that exact pending Stop.
export function createStopTransport(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  target: { changeID: string; stopID: string; attemptID: string; sessionID: string },
) {
  return (request: Request, path: string) =>
    hub.request(
      target.attemptID,
      "agent",
      request,
      path,
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : async (send) => {
            await database.client.begin(async (sql) => {
              const session = alias(changeAgentSession, "session");
              const lockedChange = alias(change, "change");
              const attempt = alias(runtimeAttempt, "attempt");
              const current = await drizzleTransaction(sql)
                .select({ id: session.changeId })
                .from(session)
                .innerJoin(lockedChange, eq(lockedChange.id, session.changeId))
                .innerJoin(attempt, eq(attempt.id, session.runtimeAttemptId))
                .where(
                  and(
                    eq(session.changeId, target.changeID),
                    eq(session.state, "stopped"),
                    eq(session.stopPending, true),
                    eq(session.stopDispatched, true),
                    eq(session.stopId, target.stopID),
                    eq(session.runtimeAttemptId, target.attemptID),
                    eq(lockedChange.runtimeAttemptId, target.attemptID),
                    eq(session.opencodeSessionId, target.sessionID),
                    eq(attempt.state, "ready"),
                  ),
                )
                .for("update", { of: session });
              if (!current[0])
                throw new CommandError("conflict", "Stop authority changed before dispatch");
              send();
            });
          },
    );
}
