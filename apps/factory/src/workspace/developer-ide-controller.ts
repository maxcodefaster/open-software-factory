import type { createDatabase } from "../../../../packages/db/src/client";
import {
  createDeveloperIDEClient,
  DeveloperIDEIntentConflict,
  type DeveloperIDEClient,
  type DeveloperIDEObservation,
} from "../../../../packages/runtime-kubernetes/src/developer-ide";
import type { DeveloperIDEResources } from "../../../../packages/runtime-kubernetes/src/developer-ide-manifest";
import {
  type DeveloperIDEState,
  developerIDEIdentity,
} from "../../../../packages/workspace-domain/src/developer-ide";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;
type IDEQuery = Database["client"] | AgentTurnTransaction;
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
  const [access] = await sql`SELECT user_id FROM factory.account_access
    WHERE user_id=${userID} AND disabled_at IS NULL AND directory_disabled_at IS NULL FOR SHARE`;
  if (!access) throw new CommandError("forbidden", "Account access is disabled");
  const administrators =
    await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userID} FOR SHARE`;
  if (administrators.length) return;
  const memberships =
    await sql`SELECT user_id FROM factory.project_membership WHERE user_id=${userID} AND role='developer' FOR SHARE`;
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
    const [current] = await sql<
      IDERow[]
    >`SELECT user_id AS "userID",resource_id AS "resourceID",service_epoch::text AS epoch,state,image,namespace_uid AS "namespaceUID",pod_uid AS "podUID",failure FROM factory.developer_ide WHERE user_id=${userID}`;
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
    const updated =
      await sql`UPDATE factory.developer_ide SET namespace_uid=${observed.namespaceUID},pod_uid=${observed.podUID},state=${observed.failed ? "failed" : observed.ready ? "ready" : "preparing"},failure=${observed.failed ? "Editor preparation failed. Stop and retry the editor." : null},create_observed_at=COALESCE(create_observed_at,now()),updated_at=now() WHERE user_id=${current.userID} AND service_epoch=${current.epoch} AND state IN ('create-intended','preparing','ready') RETURNING user_id`;
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
        await sql`UPDATE factory.developer_ide SET state='stop-intended',stop_intended_at=COALESCE(stop_intended_at,now()),updated_at=now() WHERE user_id=${userID} AND state<>'stopped'`;
        current = await row(userID, sql);
        if (!current) return false;
      }
      const input = resources(current);
      if (current.state === "stop-intended") {
        await client.stop(input);
        await sql`UPDATE factory.developer_ide SET state='stopped',stopped_at=now(),updated_at=now() WHERE user_id=${userID} AND service_epoch=${current.epoch} AND state='stop-intended'`;
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
        await sql`UPDATE factory.developer_ide SET state='failed',
          failure='The recorded editor service is no longer available. Restart the editor to prepare a new service.',
          updated_at=now() WHERE user_id=${userID} AND service_epoch=${current.epoch}
          AND state IN ('create-intended','preparing','ready')`;
        return false;
      }
      await record(current, observed, sql);
      return !observed.ready && !observed.failed;
    } catch (cause) {
      if (cause instanceof DeveloperIDEIntentConflict) {
        await sql`UPDATE factory.developer_ide SET state=CASE WHEN state='stop-intended' THEN state ELSE 'failed' END,
          failure='Editor resources conflict with this recorded intent. Existing resources were not changed. Restart the editor to prepare a separate service.',
          updated_at=now() WHERE user_id=${userID} AND state IN ('create-intended','preparing','ready','stop-intended')`;
        return false;
      }
      await sql`UPDATE factory.developer_ide SET state=CASE WHEN state='ready' THEN 'preparing' ELSE state END,failure='Editor resources are unavailable. Factory is checking the recorded intent.',updated_at=now() WHERE user_id=${userID} AND state IN ('create-intended','preparing','ready','stop-intended')`;
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
          const retry = await reconcile(userID);
          if (!retry && !worker.wakeup) return;
          // A confirmed Pending Pod is still the same valid start, not an
          // unavailable observation or permission to require a human restart.
          if (retry === true) deadline = now() + 150_000;
          const current = await row(userID);
          if (
            !current ||
            !["create-intended", "preparing", "stop-intended"].includes(current.state)
          )
            return;
          await Bun.sleep(500);
        } while (!closed && now() < deadline);
        if (!closed)
          await database.client`UPDATE factory.developer_ide SET state='failed',failure='Editor resources could not be confirmed. Retry the connection to observe the retained editor.',updated_at=now() WHERE user_id=${userID} AND state IN ('create-intended','preparing')`;
      } finally {
        pending.delete(userID);
        if (worker.wakeup) schedule(userID);
      }
    })().catch(() => console.error("Developer IDE reconciliation failed"));
  }
  return {
    async ensure(projectID: string, userID: string) {
      const image = process.env["FACTORY_DEVELOPER_IDE_IMAGE"];
      if (!image || !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
        throw new CommandError("unavailable", "Independent editor artifact is not configured");
      await database.client.begin(async (sql) => {
        await projectDevelopmentAuthorityIn(sql, userID, projectID);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`developer-ide-intent:${userID}`}))`;
        const current = await row(userID, sql);
        if (!current)
          await sql`INSERT INTO factory.developer_ide(user_id,state,image) VALUES(${userID},'create-intended',${image})`;
        else if (current.state === "stopped")
          await sql`UPDATE factory.developer_ide SET service_epoch=service_epoch+1,
            resource_id=CASE WHEN resource_id=user_id THEN gen_random_uuid() ELSE resource_id END,
            namespace_uid=CASE WHEN resource_id=user_id THEN NULL ELSE namespace_uid END,
            state='create-intended',image=${image},pod_uid=NULL,failure=NULL,create_intended_at=now(),create_observed_at=NULL,stop_intended_at=NULL,stopped_at=NULL,last_active_at=now(),updated_at=now() WHERE user_id=${userID}`;
        else if (current.state === "failed")
          // Explicit Retry observes the same immutable intent. A preparation deadline
          // does not establish that its Pod failed or permit a replacement epoch.
          await sql`UPDATE factory.developer_ide SET state='preparing',failure=NULL,last_active_at=now(),updated_at=now() WHERE user_id=${userID} AND state='failed'`;
        else
          await sql`UPDATE factory.developer_ide SET last_active_at=now() WHERE user_id=${userID}`;
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
      await database.client`UPDATE factory.developer_ide SET state='stop-intended',stop_intended_at=COALESCE(stop_intended_at,now()),updated_at=now() WHERE user_id=${userID} AND state<>'stopped'`;
      schedule(userID);
    },
    async revokeMember(_projectID: string, userID: string) {
      schedule(userID);
    },
    async recover() {
      const rows = await database.client<
        Array<{ userID: string }>
      >`SELECT user_id AS "userID" FROM factory.developer_ide WHERE state IN ('create-intended','preparing','ready','stop-intended')`;
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
