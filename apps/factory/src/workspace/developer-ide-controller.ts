import { and, eq, sql as expression, inArray, isNull, ne } from "drizzle-orm";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  accountAccess,
  administrator,
  developerIde,
  projectMembership,
} from "../../../../packages/db/src/schema";
import {
  createDeveloperIDEClient,
  type DeveloperIDEClient,
  DeveloperIDEIntentConflict,
  type DeveloperIDEObservation,
} from "../../../../packages/runtime-kubernetes/src/developer-ide";
import type { DeveloperIDEResources } from "../../../../packages/runtime-kubernetes/src/developer-ide-manifest";
import {
  type DeveloperIDEState,
  developerIDEIdentity,
} from "../../../../packages/workspace-domain/src/developer-ide";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";

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
        userID: developerIde.userId,
        resourceID: developerIde.resourceId,
        epoch: expression<string>`${developerIde.serviceEpoch}::text`,
        state: developerIde.state,
        image: developerIde.image,
        namespaceUID: developerIde.namespaceUid,
        podUID: developerIde.podUid,
        failure: developerIde.failure,
      })
      .from(developerIde)
      .where(eq(developerIde.userId, userID));
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
    const updated = await drizzleTransaction(sql)
      .update(developerIde)
      .set({
        namespaceUid: observed.namespaceUID,
        podUid: observed.podUID,
        state: observed.failed ? "failed" : observed.ready ? "ready" : "preparing",
        failure: observed.failed ? "Editor preparation failed. Stop and retry the editor." : null,
        createObservedAt: expression`COALESCE(${developerIde.createObservedAt},now())`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(developerIde.userId, current.userID),
          eq(developerIde.serviceEpoch, expression`${current.epoch}::bigint`),
          inArray(developerIde.state, ["create-intended", "preparing", "ready"]),
        ),
      )
      .returning({ userID: developerIde.userId });
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
          .update(developerIde)
          .set({
            state: "stop-intended",
            stopIntendedAt: expression`COALESCE(${developerIde.stopIntendedAt},now())`,
            updatedAt: expression`now()`,
          })
          .where(and(eq(developerIde.userId, userID), ne(developerIde.state, "stopped")));
        current = await row(userID, sql);
        if (!current) return false;
      }
      const input = resources(current);
      if (current.state === "stop-intended") {
        await client.stop(input);
        await drizzleTransaction(sql)
          .update(developerIde)
          .set({
            state: "stopped",
            failure: null,
            stoppedAt: expression`now()`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(developerIde.userId, userID),
              eq(developerIde.serviceEpoch, expression`${current.epoch}::bigint`),
              eq(developerIde.state, "stop-intended"),
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
        await drizzleTransaction(sql)
          .update(developerIde)
          .set({
            state: "failed",
            failure:
              "The recorded editor service is no longer available. Restart the editor to prepare a new service.",
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(developerIde.userId, userID),
              eq(developerIde.serviceEpoch, expression`${current.epoch}::bigint`),
              inArray(developerIde.state, ["create-intended", "preparing", "ready"]),
            ),
          );
        return false;
      }
      await record(current, observed, sql);
      return !observed.ready && !observed.failed;
    } catch (cause) {
      if (cause instanceof DeveloperIDEIntentConflict) {
        await drizzleTransaction(sql)
          .update(developerIde)
          .set({
            state: expression`CASE WHEN ${developerIde.state}='stop-intended' THEN ${developerIde.state} ELSE 'failed' END`,
            failure:
              "Editor resources conflict with this recorded intent. Existing resources were not changed. Restart the editor to prepare a separate service.",
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(developerIde.userId, userID),
              inArray(developerIde.state, [
                "create-intended",
                "preparing",
                "ready",
                "stop-intended",
              ]),
            ),
          );
        return false;
      }
      await drizzleTransaction(sql)
        .update(developerIde)
        .set({
          state: expression`CASE WHEN ${developerIde.state}='ready' THEN 'preparing' ELSE ${developerIde.state} END`,
          failure: "Editor resources are unavailable. Factory is checking the recorded intent.",
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(developerIde.userId, userID),
            inArray(developerIde.state, ["create-intended", "preparing", "ready", "stop-intended"]),
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
        if (!closed)
          await database.db
            .update(developerIde)
            .set({
              state: "failed",
              failure:
                "Editor resources could not be confirmed. Retry the connection to observe the retained editor.",
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(developerIde.userId, userID),
                inArray(developerIde.state, ["create-intended", "preparing"]),
              ),
            );
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
          .update(developerIde)
          .set({
            state: "stop-intended",
            stopIntendedAt: expression`COALESCE(${developerIde.stopIntendedAt},now())`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(developerIde.userId, userID),
              eq(developerIde.serviceEpoch, expression`${outdated.epoch}::bigint`),
              inArray(developerIde.state, ["ready", "preparing"]),
            ),
          )
          .returning({ userID: developerIde.userId });
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
        if (!current)
          await db.insert(developerIde).values({ userId: userID, state: "create-intended", image });
        else if (current.state === "stopped" && current.epoch === restartEpoch)
          // A request already opening/observing this epoch cannot turn a later
          // owner Stop into permission for another epoch.
          await db
            .update(developerIde)
            .set({
              serviceEpoch: expression`${developerIde.serviceEpoch}+1`,
              state: "create-intended",
              image,
              podUid: null,
              failure: null,
              createIntendedAt: expression`now()`,
              createObservedAt: null,
              stopIntendedAt: null,
              stoppedAt: null,
              lastActiveAt: expression`now()`,
              updatedAt: expression`now()`,
            })
            .where(eq(developerIde.userId, userID));
        else if (current.state === "failed")
          // Explicit Retry observes the same immutable intent. A preparation deadline
          // does not establish that its Pod failed or permit a replacement epoch.
          await db
            .update(developerIde)
            .set({
              state: "preparing",
              failure: null,
              lastActiveAt: expression`now()`,
              updatedAt: expression`now()`,
            })
            .where(and(eq(developerIde.userId, userID), eq(developerIde.state, "failed")));
        else
          await db
            .update(developerIde)
            .set({ lastActiveAt: expression`now()` })
            .where(eq(developerIde.userId, userID));
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
        .update(developerIde)
        .set({
          state: "stop-intended",
          stopIntendedAt: expression`COALESCE(${developerIde.stopIntendedAt},now())`,
          updatedAt: expression`now()`,
        })
        .where(and(eq(developerIde.userId, userID), ne(developerIde.state, "stopped")));
      schedule(userID);
    },
    async revokeMember(_projectID: string, userID: string) {
      schedule(userID);
    },
    async recover() {
      const rows = await database.db
        .select({ userID: developerIde.userId })
        .from(developerIde)
        .where(
          inArray(developerIde.state, ["create-intended", "preparing", "ready", "stop-intended"]),
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
