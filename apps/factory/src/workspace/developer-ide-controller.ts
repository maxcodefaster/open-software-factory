import { and, eq, sql as expression, inArray, isNull, ne } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { accountAccess, administrator, operation, projectMembership } from "#db/schema";
import {
  createDeveloperIDEClient,
  type DeveloperIDEClient,
  DeveloperIDEIntentConflict,
  type DeveloperIDEObservation,
} from "#runtime-kubernetes/developer-ide";
import type { DeveloperIDEResources } from "#runtime-kubernetes/developer-ide-manifest";
import { type DeveloperIDEState, developerIDEIdentity } from "#workspace-domain/developer-ide";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";

const DEVELOPER_IDE_KIND = "workspace.developer_ide";
type Database = ReturnType<typeof createDatabase>;
type IDEQuery = Database["client"] | DatabaseTransaction;
interface IDERow {
  userID: string;
  resourceID: string;
  epoch: string;
  state: DeveloperIDEState;
  image: string;
  namespaceUID: string | null;
  podUID: string | null;
  failure: string | null;
}
export interface DeveloperIDEView {
  readonly serviceID: string;
  readonly epoch: number;
  readonly state: DeveloperIDEState;
  readonly failure: string | null;
}

async function developerAuthority(sql: IDEQuery, userID: string) {
  const db = drizzleTransaction(sql);
  const [access] = await db
    .select({ userID: accountAccess.userId })
    .from(accountAccess)
    .where(
      and(
        eq(accountAccess.userId, userID),
        isNull(accountAccess.disabledAt),
        isNull(accountAccess.directoryDisabledAt),
      ),
    )
    .for("share");
  if (!access) throw new CommandError("forbidden", "Account access is disabled");
  const administrators = await db
    .select({ userID: administrator.userId })
    .from(administrator)
    .where(eq(administrator.userId, userID))
    .for("share");
  if (administrators.length) return;
  const memberships = await db
    .select({ userID: projectMembership.userId })
    .from(projectMembership)
    .where(and(eq(projectMembership.userId, userID), eq(projectMembership.role, "developer")))
    .for("share");
  if (!memberships.length) throw new CommandError("forbidden", "Developer access required");
}

export function createDeveloperIDEController(
  database: Database,
  client: DeveloperIDEClient = createDeveloperIDEClient(),
  now: () => number = () => performance.now(),
) {
  const pending = new Map<string, { wakeup: boolean }>();
  let closed = false;
  async function row(userID: string, sql: IDEQuery = database.client) {
    const [current] = await drizzleTransaction(sql)
      .select({
        userID: operation.scopeId,
        resourceID: expression<string>`${operation.payload}->>'resourceId'`,
        epoch: expression<string>`COALESCE(${operation.payload}->>'serviceEpoch','1')`,
        state: expression<DeveloperIDEState>`${operation.state}`,
        image: expression<string>`${operation.payload}->>'image'`,
        namespaceUID: expression<string | null>`${operation.payload}->>'namespaceUid'`,
        podUID: expression<string | null>`${operation.payload}->>'podUid'`,
        failure: operation.error,
      })
      .from(operation)
      .where(
        and(
          eq(operation.kind, DEVELOPER_IDE_KIND),
          eq(operation.scopeType, "user"),
          eq(operation.scopeId, userID),
        ),
      );
    return current ?? null;
  }
  function resources(current: IDERow): DeveloperIDEResources {
    return {
      identity: developerIDEIdentity(current.userID, Number(current.epoch), current.resourceID),
      image: current.image,
      namespaceUID: current.namespaceUID,
      podUID: current.podUID,
    };
  }
  function view(current: IDERow): DeveloperIDEView {
    const { serviceID, epoch } = resources(current).identity;
    return { serviceID, epoch, state: current.state, failure: current.failure };
  }
  async function record(current: IDERow, observed: DeveloperIDEObservation, sql: IDEQuery) {
    const failure = observed.failed
      ? "Editor preparation failed. Stop and retry the editor."
      : null;
    const updated = await drizzleTransaction(sql)
      .update(operation)
      .set({
        state: observed.failed ? "failed" : observed.ready ? "ready" : "preparing",
        error: failure,
        payload: expression`${operation.payload} || jsonb_build_object(
          'namespaceUid',${observed.namespaceUID}::text,
          'podUid',${observed.podUID}::text,
          'failure',${failure}::text,
          'createObservedAt',COALESCE(${operation.payload}->>'createObservedAt',now()::text)
        )`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.kind, DEVELOPER_IDE_KIND),
          eq(operation.scopeType, "user"),
          eq(operation.scopeId, current.userID),
          expression`(${operation.payload}->>'serviceEpoch')::bigint=${current.epoch}::bigint`,
          inArray(operation.state, ["create-intended", "preparing", "ready"]),
        ),
      )
      .returning({ userID: operation.scopeId });
    if (!updated.length)
      throw new CommandError("conflict", "Editor lifecycle changed during preparation");
  }
  async function reconcile(userID: string) {
    // Kubernetes preparation can wait while authorization and Stop need the
    // application pool. Keep its session lock on a short-lived dedicated connection.
    const sql = database.coordination();
    const key = `developer-ide:${userID}`;
    try {
      await sql`SELECT pg_advisory_lock(hashtext(${key}))`;
      let current = await row(userID, sql);
      if (!current || current.state === "stopped" || current.state === "failed") return false;
      try {
        await database.client.begin((transaction) => developerAuthority(transaction, userID));
      } catch (cause) {
        if (!(cause instanceof CommandError)) throw cause;
        await drizzleTransaction(sql)
          .update(operation)
          .set({
            state: "stop-intended",
            payload: expression`${operation.payload} || jsonb_build_object(
              'stopIntendedAt',COALESCE(${operation.payload}->>'stopIntendedAt',now()::text)
            )`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(operation.kind, DEVELOPER_IDE_KIND),
              eq(operation.scopeType, "user"),
              eq(operation.scopeId, userID),
              ne(operation.state, "stopped"),
            ),
          );
        current = await row(userID, sql);
        if (!current) return false;
      }
      const input = resources(current);
      if (current.state === "stop-intended") {
        await client.stop(input);
        await drizzleTransaction(sql)
          .update(operation)
          .set({
            state: "stopped",
            error: null,
            completedAt: expression`now()`,
            payload: expression`${operation.payload} || jsonb_build_object(
              'failure',NULL,
              'stoppedAt',now()::text
            )`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(operation.kind, DEVELOPER_IDE_KIND),
              eq(operation.scopeType, "user"),
              eq(operation.scopeId, userID),
              expression`(${operation.payload}->>'serviceEpoch')::bigint=${current.epoch}::bigint`,
              eq(operation.state, "stop-intended"),
            ),
          );
        return false;
      }
      const observed = await (input.podUID ? client.observe(input) : client.prepare(input)).catch(
        async (cause: unknown) => {
          if (cause instanceof DeveloperIDEIntentConflict) throw cause;
          const recovered = await client.observe(input);
          if (!recovered && !input.podUID)
            throw new Error("Editor create outcome remains unconfirmed");
          return recovered;
        },
      );
      if (!observed) {
        // A confirmed missing Pod is not permission to create another Pod
        // under its immutable recorded identity.
        const missingFailure =
          "The recorded editor service is no longer available. Restart the editor to prepare a new service.";
        await drizzleTransaction(sql)
          .update(operation)
          .set({
            state: "failed",
            error: missingFailure,
            payload: expression`${operation.payload} || jsonb_build_object('failure',${missingFailure}::text)`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(operation.kind, DEVELOPER_IDE_KIND),
              eq(operation.scopeType, "user"),
              eq(operation.scopeId, userID),
              expression`(${operation.payload}->>'serviceEpoch')::bigint=${current.epoch}::bigint`,
              inArray(operation.state, ["create-intended", "preparing", "ready"]),
            ),
          );
        return false;
      }
      await record(current, observed, sql);
      return !observed.ready && !observed.failed;
    } catch (cause) {
      if (cause instanceof DeveloperIDEIntentConflict) {
        const conflictFailure =
          "Editor resources conflict with this recorded intent. Existing resources were not changed. Restart the editor to prepare a separate service.";
        await drizzleTransaction(sql)
          .update(operation)
          .set({
            state: expression`CASE WHEN ${operation.state}='stop-intended' THEN ${operation.state} ELSE 'failed' END`,
            error: conflictFailure,
            payload: expression`${operation.payload} || jsonb_build_object('failure',${conflictFailure}::text)`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(operation.kind, DEVELOPER_IDE_KIND),
              eq(operation.scopeType, "user"),
              eq(operation.scopeId, userID),
              inArray(operation.state, ["create-intended", "preparing", "ready", "stop-intended"]),
            ),
          );
        return false;
      }
      const unavailableFailure =
        "Editor resources are unavailable. Factory is checking the recorded intent.";
      await drizzleTransaction(sql)
        .update(operation)
        .set({
          state: expression`CASE WHEN ${operation.state}='ready' THEN 'preparing' ELSE ${operation.state} END`,
          error: unavailableFailure,
          payload: expression`${operation.payload} || jsonb_build_object('failure',${unavailableFailure}::text)`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operation.kind, DEVELOPER_IDE_KIND),
            eq(operation.scopeType, "user"),
            eq(operation.scopeId, userID),
            inArray(operation.state, ["create-intended", "preparing", "ready", "stop-intended"]),
          ),
        );
      return (await row(userID, sql))?.state === "stop-intended" ? false : "unavailable";
    } finally {
      try {
        await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  }
  function schedule(userID: string) {
    if (closed) return;
    const running = pending.get(userID);
    if (running) {
      running.wakeup = true;
      return;
    }
    const worker = { wakeup: false };
    pending.set(userID, worker);
    void (async () => {
      try {
        let deadline = now() + 150_000;
        do {
          worker.wakeup = false;
          let retry: boolean | "unavailable" = "unavailable";
          try {
            retry = await reconcile(userID);
            if (!retry && !worker.wakeup) return;
            const current = await row(userID);
            if (
              !current ||
              !["create-intended", "preparing", "stop-intended"].includes(current.state)
            )
              return;
          } catch {
            // Acquiring/releasing the observer connection or reading its result
            // can fail outside reconcile's own catch. Observe the same intent
            // again instead of orphaning a healthy editor until a human Retry.
          }
          // A confirmed Pending Pod is still the same valid start, not an
          // unavailable observation or permission to require a human restart.
          if (retry === true) deadline = now() + 150_000;
          await Bun.sleep(500);
        } while (!closed && now() < deadline);
        if (!closed) {
          const timeoutFailure =
            "Editor resources could not be confirmed. Retry the connection to observe the retained editor.";
          await database.db
            .update(operation)
            .set({
              state: "failed",
              error: timeoutFailure,
              payload: expression`${operation.payload} || jsonb_build_object('failure',${timeoutFailure}::text)`,
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(operation.kind, DEVELOPER_IDE_KIND),
                eq(operation.scopeType, "user"),
                eq(operation.scopeId, userID),
                inArray(operation.state, ["create-intended", "preparing"]),
              ),
            );
        }
      } finally {
        pending.delete(userID);
        if (worker.wakeup) schedule(userID);
      }
    })().catch(reportFailure("Developer IDE reconciliation failed"));
  }
  return {
    async ensure(projectID: string, userID: string) {
      const image = process.env["FACTORY_DEVELOPER_IDE_IMAGE"];
      if (!image || !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
        throw new CommandError("unavailable", "Independent editor artifact is not configured");
      // An upgrade can ship a new editor image. A running editor keeps its recorded image, so
      // opening the IDE stops the older one and lets the stopped branch below start the new epoch.
      const outdated = await row(userID);
      let restartEpoch = outdated?.state === "stopped" ? outdated.epoch : undefined;
      if (
        outdated &&
        outdated.image !== image &&
        (outdated.state === "ready" || outdated.state === "preparing")
      ) {
        const stopping = await database.db
          .update(operation)
          .set({
            state: "stop-intended",
            payload: expression`${operation.payload} || jsonb_build_object(
              'stopIntendedAt',COALESCE(${operation.payload}->>'stopIntendedAt',now()::text)
            )`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(operation.kind, DEVELOPER_IDE_KIND),
              eq(operation.scopeType, "user"),
              eq(operation.scopeId, userID),
              expression`(${operation.payload}->>'serviceEpoch')::bigint=${outdated.epoch}::bigint`,
              inArray(operation.state, ["ready", "preparing"]),
            ),
          )
          .returning({ userID: operation.scopeId });
        if (stopping.length) restartEpoch = outdated.epoch;
        schedule(userID);
        const deadline = now() + 60_000;
        while (now() < deadline && (await row(userID))?.state === "stop-intended")
          await Bun.sleep(300);
      }
      await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await projectDevelopmentAuthorityIn(sql, userID, projectID);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`developer-ide-intent:${userID}`}))`;
        const current = await row(userID, sql);
        if (!current) {
          const resourceId = crypto.randomUUID();
          const nowIso = new Date().toISOString();
          await db.insert(operation).values({
            id: crypto.randomUUID(),
            kind: DEVELOPER_IDE_KIND,
            scopeType: "user",
            scopeId: userID,
            idempotencyKey: `workspace.developer_ide:${userID}`,
            activeKey: `workspace.developer_ide.resource:${resourceId}`,
            state: "create-intended",
            error: null,
            createdBy: userID,
            completedAt: null,
            payload: {
              userId: userID,
              serviceEpoch: 1,
              image,
              namespaceUid: null,
              podUid: null,
              failure: null,
              createIntendedAt: nowIso,
              createObservedAt: null,
              stopIntendedAt: null,
              stoppedAt: null,
              lastActiveAt: nowIso,
              resourceId,
            },
          });
        } else if (current.state === "stopped" && current.epoch === restartEpoch)
          // A request already opening/observing this epoch cannot turn a later
          // owner Stop into permission for another epoch.
          await db
            .update(operation)
            .set({
              state: "create-intended",
              error: null,
              completedAt: null,
              payload: expression`${operation.payload} || jsonb_build_object(
                'serviceEpoch',(${operation.payload}->>'serviceEpoch')::bigint+1,
                'image',${image}::text,
                'podUid',NULL,
                'failure',NULL,
                'createIntendedAt',now()::text,
                'createObservedAt',NULL,
                'stopIntendedAt',NULL,
                'stoppedAt',NULL,
                'lastActiveAt',now()::text
              )`,
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(operation.kind, DEVELOPER_IDE_KIND),
                eq(operation.scopeType, "user"),
                eq(operation.scopeId, userID),
              ),
            );
        else if (current.state === "failed")
          // Explicit Retry observes the same immutable intent. A preparation deadline
          // does not establish that its Pod failed or permit a replacement epoch.
          await db
            .update(operation)
            .set({
              state: "preparing",
              error: null,
              payload: expression`${operation.payload} || jsonb_build_object(
                'failure',NULL,
                'lastActiveAt',now()::text
              )`,
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(operation.kind, DEVELOPER_IDE_KIND),
                eq(operation.scopeType, "user"),
                eq(operation.scopeId, userID),
                eq(operation.state, "failed"),
              ),
            );
        else
          await db
            .update(operation)
            .set({
              payload: expression`${operation.payload} || jsonb_build_object('lastActiveAt',now()::text)`,
            })
            .where(
              and(
                eq(operation.kind, DEVELOPER_IDE_KIND),
                eq(operation.scopeType, "user"),
                eq(operation.scopeId, userID),
              ),
            );
      });
      const current = await row(userID);
      if (!current) throw new CommandError("unavailable", "Editor intent was not recorded");
      schedule(userID);
      return view(current);
    },
    async get(userID: string) {
      return database.client.begin(async (sql) => {
        await developerAuthority(sql, userID);
        const current = await row(userID, sql);
        if (!current) throw new CommandError("not-found", "Editor not prepared");
        return view(current);
      });
    },
    async connection(userID: string, epoch: number) {
      const input = await database.client.begin(async (sql) => {
        await developerAuthority(sql, userID);
        const current = await row(userID, sql);
        if (!current || Number(current.epoch) !== epoch || current.state !== "ready")
          throw new CommandError(
            "unavailable",
            "Editor is preparing or its connection has expired",
          );
        return resources(current);
      });
      return client.endpoint(input).catch((cause: unknown) => {
        if (cause instanceof DeveloperIDEIntentConflict) throw cause;
        throw new CommandError("unavailable", "Editor connection is temporarily unavailable");
      });
    },
    async stop(userID: string) {
      // An authenticated owner may also stop their own editor after losing their last Developer role.
      await database.db
        .update(operation)
        .set({
          state: "stop-intended",
          payload: expression`${operation.payload} || jsonb_build_object(
            'stopIntendedAt',COALESCE(${operation.payload}->>'stopIntendedAt',now()::text)
          )`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operation.kind, DEVELOPER_IDE_KIND),
            eq(operation.scopeType, "user"),
            eq(operation.scopeId, userID),
            ne(operation.state, "stopped"),
          ),
        );
      schedule(userID);
    },
    async revokeMember(_projectID: string, userID: string) {
      schedule(userID);
    },
    async recover() {
      const rows = await database.db
        .select({ userID: operation.scopeId })
        .from(operation)
        .where(
          and(
            eq(operation.kind, DEVELOPER_IDE_KIND),
            eq(operation.scopeType, "user"),
            inArray(operation.state, ["create-intended", "preparing", "ready", "stop-intended"]),
          ),
        );
      for (const current of rows) schedule(current.userID);
    },
    async close() {
      closed = true;
      client.close();
      const deadline = performance.now() + 5_000;
      while (pending.size && performance.now() < deadline) await Bun.sleep(10);
    },
  };
}
