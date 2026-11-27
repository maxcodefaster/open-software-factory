import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql as query } from "drizzle-orm";
import { changeIdentity } from "#change-domain/change";
import { createDatabase, drizzleTransaction } from "#db/client";
import {
  authUser,
  change as changeTable,
  operation as operationTable,
  project,
  projectMembership,
  requirementApproval,
  requirementRevision,
  technicalDesignRevision,
  ticketConversation,
} from "#db/schema";
import {
  type createForgejoClient,
  ForgeAmbiguousWriteError,
  ForgeConflictError,
} from "#forge/forge";
import { canonicalRequirementContent, requirementDigest } from "#requirement-domain/requirement";
import { runtimeIdentity } from "#runtime-domain/identity";
import { appendTicketAuthoringIn, insertInitialTicketIn } from "#ticket-authoring/authoring";
import { ticketWorkspaceIdentity } from "#workspace-domain/workspace";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createTicketService } from "../../apps/factory/src/change/service";
import type {
  RequirementApprovalView,
  RequirementRevisionView,
} from "../../apps/factory/src/change/types";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
let owned: Awaited<ReturnType<typeof ownedTestDatabase>>;
let database: ReturnType<typeof createDatabase>;
let userID: string;
let projectID: string;
let ticketID: string;
const baseSHA = "a".repeat(40);
const requirement = {
  summary: "Retain the saved specification.",
  acceptanceCriteria: ["Only the approved source is implemented."],
  nonGoals: ["Do not start inference while saving."],
};
const configuration = {
  FACTORY_FORGEJO_API_URL: "https://owned-change.invalid/api/v1/",
  FACTORY_FORGEJO_PUBLIC_URL: "https://owned-change.invalid",
  FACTORY_FORGEJO_TOKEN: "owned-unused-change-token",
  FACTORY_FORGEJO_OWNER: "owned",
};
const previous = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const [key, value] of Object.entries(configuration)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  server = await ownedPostgresServer();
}, 60_000);

afterAll(async () => {
  try {
    await server?.dispose();
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}, 60_000);

beforeEach(async () => {
  owned = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = owned.url;
  try {
    database = createDatabase(4);
  } finally {
    if (previousURL === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousURL;
  }
  userID = crypto.randomUUID();
  projectID = crypto.randomUUID();
  ticketID = crypto.randomUUID();
  await database.db.insert(authUser).values({
    id: userID,
    name: "Owned Change author",
    email: `${userID}@change.invalid`,
  });
  await database.db.insert(project).values({
    id: projectID,
    slug: `owned-${projectID}`,
    name: "Owned Change",
    repositoryUrl: "https://owned-change.invalid/owned/repository.git",
    defaultBranch: "main",
    actorTemplatePath: ".factory/actor-template.json",
    createdBy: userID,
  });
  await database.db.insert(projectMembership).values({
    projectId: projectID,
    userId: userID,
    role: "developer",
    updatedBy: userID,
  });
  await insertInitialTicketIn(database.db, {
    id: ticketID,
    projectId: projectID,
    title: "Saved Ticket",
    description: "Saved description",
    state: "inbox",
    createdBy: userID,
  });
});

afterEach(async () => {
  try {
    await database?.client.end({ timeout: 2 });
  } finally {
    await owned?.dispose();
  }
}, 60_000);

function controller(options?: {
  ensureBranch?: () => Promise<void>;
  protect?: (changeID: string) => Promise<void>;
}) {
  const forge = {
    getDefaultBranch: async () => ({ name: "main", headSha: baseSHA }),
    getBranch: async () => null,
    ensureBranch: async (_repository: unknown, name: string, start: string) => {
      await options?.ensureBranch?.();
      return { name, headSha: start };
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  return createChangeController(
    database,
    { stop: async () => null },
    undefined,
    options?.protect,
    forge,
  );
}

function ticketService(changes = controller()) {
  const unused = async () => {
    throw new Error("Reads and ordinary saves must not start an engine");
  };
  return createTicketService({
    database,
    access: createAccessController(database),
    documents: createTicketDocumentController(database),
    trash: { trash: unused, restore: unused },
    changes: { ...changes, start: unused },
    agent: { admitStartIn: unused },
  });
}

async function settle(changes: ReturnType<typeof controller>, id: string, state: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await changes.get(id);
    if (value?.state === state) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Owned Change did not settle to ${state}`);
}

function documentInput() {
  return {
    commandId: crypto.randomUUID(),
    expectedVersion: 1,
    expectedDocumentId: null,
    requirementRevisionId: null,
    title: "Saved Ticket",
    description: "Saved description",
    requirement,
  };
}

async function requirementFixture(id = ticketID, content = requirement) {
  const [latest] = await database.db
    .select({ ordinal: requirementRevision.ordinal })
    .from(requirementRevision)
    .where(eq(requirementRevision.ticketId, id))
    .orderBy(query`${requirementRevision.ordinal} DESC`)
    .limit(1);
  const revisionID = crypto.randomUUID();
  await appendTicketAuthoringIn(database.db, {
    ticketId: id,
    createdBy: userID,
    title: "Saved Ticket",
    description: "Saved description",
    canonicalContent: canonicalRequirementContent(content),
    requirement: { id: revisionID, ordinal: (latest?.ordinal ?? 0) + 1 },
  });
  const [revision] = await database.client<RequirementRevisionView[]>`
    SELECT id,ticket_id AS "ticketId",ordinal,canonical_content AS "canonicalContent",
      content_digest AS "contentDigest",created_at::text AS "createdAt"
    FROM factory.requirement_revision WHERE id=${revisionID}`;
  if (!revision) throw new Error("Fixture Requirement Revision is missing");
  return revision;
}

function commission(revisionID: string) {
  return { commandID: crypto.randomUUID(), revisionID, admitBuild: async () => {} };
}

test("document saves retain revision history and Implement serializes the exact approval", async () => {
  const changes = controller();
  const documents = createTicketDocumentController(database);
  const first = await documents.save(ticketID, userID, documentInput());
  if (!first.requirementRevisionId) throw new Error("Saved requirements are incomplete");
  const second = await documents.save(ticketID, userID, {
    ...documentInput(),
    expectedVersion: first.ticketVersion,
    expectedDocumentId: first.id,
    requirementRevisionId: first.requirementRevisionId,
    requirement: { ...requirement, summary: "Second saved scope" },
  });
  if (!second.requirementRevisionId) throw new Error("Second saved requirements are incomplete");
  const detail = await ticketService().detail(userID, ticketID);
  const revisions = detail.revisions;
  expect(revisions.map((value) => value?.ordinal).sort()).toEqual([1, 2]);
  expect(revisions.map((revision) => revision.id)).toEqual([
    second.requirementRevisionId,
    first.requirementRevisionId,
  ]);
  for (const revision of revisions) {
    if (!revision) throw new Error("Requirement Revision is missing");
    const [stored] = await database.client<RequirementRevisionView[]>`
      SELECT id,ticket_id AS "ticketId",ordinal,canonical_content AS "canonicalContent",
        content_digest AS "contentDigest",created_at AS "createdAt"
      FROM factory.requirement_revision WHERE id=${revision.id}`;
    if (!stored) throw new Error("Stored Requirement Revision is missing");
    if (typeof stored.createdAt !== "string")
      throw new Error("Observed Requirement Revision timestamp is missing");
    expect(stored.ticketId).toBe(ticketID);
    expect(stored.contentDigest).toBe(requirementDigest(stored.canonicalContent));
    expect(revision).toEqual({
      id: stored.id,
      ordinal: stored.ordinal,
      canonicalContent: stored.canonicalContent,
      contentDigest: stored.contentDigest,
      createdAt: new Date(stored.createdAt).toISOString(),
      author: "Owned Change author",
      approvalId: undefined,
      approvedAt: undefined,
      monitoringIncidentId: undefined,
    });
    expect(typeof revision?.createdAt).toBe("string");
    if (typeof revision.createdAt !== "string")
      throw new Error("Returned Requirement Revision timestamp is missing");
    expect(new Date(revision.createdAt).toISOString()).toContain("T");
  }
  const latest = revisions.find((revision) => revision?.ordinal === 2);
  if (!latest) throw new Error("Latest revision is missing");
  const admission = commission(latest.id);
  const started = await Promise.all([
    changes.start(ticketID, userID, admission),
    changes.start(ticketID, userID, admission),
  ]);
  expect(started[0]?.id).toBe(started[1]?.id);
  if (!started[0]) throw new Error("Change is missing");
  await settle(changes, started[0].id, "active");
  const [stored] = await database.client<RequirementApprovalView[]>`
    SELECT id,ticket_id AS "ticketId",requirement_revision_id AS "requirementRevisionId",
      approved_by AS "approvedBy",approved_at AS "approvedAt"
    FROM factory.requirement_approval WHERE ticket_id=${ticketID}`;
  expect(stored).toMatchObject({
    id: started[0].requirementApprovalId,
    ticketId: ticketID,
    requirementRevisionId: second.requirementRevisionId,
    approvedBy: userID,
  });
  expect(await database.client`SELECT id FROM factory.requirement_approval`).toHaveLength(1);
  await expect(
    changes.start(ticketID, userID, commission(first.requirementRevisionId)),
  ).rejects.toThrow("current requirements");
  expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  await changes.cancel(started[0].id);
  await settle(changes, started[0].id, "cancelled");
});

test("reserved Drizzle queries share the same PostgreSQL PID through manual rollback and commit", async () => {
  const changes = controller();
  const revision = await requirementFixture();
  if (!revision) throw new Error("Requirement Revision is missing");
  const [approval] = await database.db
    .insert(requirementApproval)
    .values({
      id: crypto.randomUUID(),
      ticketId: ticketID,
      requirementRevisionId: revision.id,
      approvedBy: userID,
    })
    .returning({ id: requirementApproval.id });
  if (!approval) throw new Error("Requirement Approval is missing");
  const identity = changeIdentity(ticketID, approval.id);
  await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await db.insert(changeTable).values({
      id: identity.changeID,
      projectId: projectID,
      ticketId: ticketID,
      requirementApprovalId: approval.id,
      branchName: identity.branchName,
      baseSha: baseSHA,
      state: "branch-pending",
      createdBy: userID,
    });
    await db.insert(operationTable).values({
      id: identity.branchOperationID,
      kind: "delivery.branch_create",
      scopeType: "change",
      scopeId: identity.changeID,
      idempotencyKey: `delivery.branch_create:change:${identity.changeID}:create-branch`,
      activeKey: `delivery.branch_create:${identity.changeID}`,
      state: "executing",
      payload: {
        changeId: identity.changeID,
        repositoryOwner: "owned",
        repositoryName: "repository",
        branchName: identity.branchName,
        startSha: baseSHA,
        attemptCount: 1,
        leaseGeneration: 1,
        reconcileAfter: null,
      },
      createdBy: userID,
    });
  });
  const lock = await database.client.reserve();
  const db = drizzleTransaction(lock);
  const helperIsOmitted: "transaction" extends keyof typeof db ? true : false = false;
  expect(helperIsOmitted).toBe(false);
  expect(drizzleTransaction(lock)).toBe(db);
  const [native] = await lock<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  if (!native) throw new Error("Reserved PostgreSQL PID is missing");
  let inTransaction = false;
  try {
    for (const outcome of ["ROLLBACK", "COMMIT"] as const) {
      await lock`BEGIN`;
      inTransaction = true;
      const [before] = await db
        .select({ pid: query<number>`pg_backend_pid()` })
        .from(changeTable)
        .where(eq(changeTable.id, identity.changeID));
      expect(before?.pid).toBe(native.pid);
      await db
        .update(operationTable)
        .set({
          state: "succeeded",
          activeKey: null,
          result: { observedHeadSha: baseSHA },
          completedAt: query`now()`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: query`now()`,
          error: null,
        })
        .where(
          and(
            eq(operationTable.id, identity.branchOperationID),
            eq(operationTable.kind, "delivery.branch_create"),
            eq(operationTable.state, "executing"),
          ),
        );
      await db
        .update(changeTable)
        .set({ state: "active", version: query`${changeTable.version} + 1` })
        .where(and(eq(changeTable.id, identity.changeID), eq(changeTable.state, "branch-pending")));
      const [inside] = await db
        .select({
          branch: operationTable.state,
          change: changeTable.state,
          pid: query<number>`pg_backend_pid()`,
        })
        .from(changeTable)
        .innerJoin(
          operationTable,
          and(
            eq(operationTable.kind, "delivery.branch_create"),
            eq(operationTable.scopeType, "change"),
            eq(operationTable.scopeId, query<string>`${changeTable.id}::text`),
          ),
        )
        .where(eq(changeTable.id, identity.changeID));
      expect(inside).toEqual({ branch: "succeeded", change: "active", pid: native.pid });
      const outside = await changes.get(identity.changeID);
      expect(outside?.branchState).toBe("executing");
      expect(outside?.state).toBe("branch-pending");
      if (outcome === "ROLLBACK") await lock`ROLLBACK`;
      else await lock`COMMIT`;
      inTransaction = false;
      const [after] = await db
        .select({ pid: query<number>`pg_backend_pid()` })
        .from(changeTable)
        .where(eq(changeTable.id, identity.changeID));
      expect(after?.pid).toBe(native.pid);
      const persisted = await changes.get(identity.changeID);
      expect(persisted?.branchState).toBe(outcome === "COMMIT" ? "succeeded" : "executing");
      expect(persisted?.state).toBe(outcome === "COMMIT" ? "active" : "branch-pending");
      expect(String(persisted?.version)).toBe(outcome === "COMMIT" ? "2" : "1");
    }
  } finally {
    if (inTransaction) await lock`ROLLBACK`;
    lock.release();
  }
});

test("reconciliation rolls back a branch result when Change persistence fails before explicit retry", async () => {
  let externalCreates = 0;
  const changes = controller({
    ensureBranch: async () => {
      externalCreates++;
    },
  });
  const revision = await requirementFixture();
  if (!revision) throw new Error("Requirement Revision is missing");
  // A disposable constraint fails the second write of the real reserved transaction.
  await database.client`ALTER TABLE factory.change ADD CONSTRAINT owned_reconcile_failure CHECK(state<>'active')`;
  const started = await changes.start(ticketID, userID, commission(revision.id));
  if (!started) throw new Error("Change is missing");
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await changes.get(started.id))?.branchState === "ambiguous") break;
    await Bun.sleep(10);
  }
  const [failed] = await database.client`
    SELECT change.state,change.version::integer AS version,operation.state AS branch,
      operation.completed_at AS completed,operation.error AS error
    FROM factory.change change JOIN factory.operation operation
      ON operation.kind='delivery.branch_create' AND operation.scope_type='change'
        AND operation.scope_id=change.id::text
    WHERE change.id=${started.id}`;
  expect(failed).toMatchObject({
    state: "branch-pending",
    version: 1,
    branch: "ambiguous",
    completed: null,
  });
  expect(String(failed?.["error"])).toContain("owned_reconcile_failure");
  await database.client`ALTER TABLE factory.change DROP CONSTRAINT owned_reconcile_failure`;
  await changes.reconcile(started.id);
  const result = await settle(changes, started.id, "active");
  expect(result.branchState).toBe("succeeded");
  expect(externalCreates).toBe(2);
  expect(String(result.version)).toBe("2");
});

test("Change projections retain exact verification, merge approval and timestamp representations", async () => {
  const changes = controller();
  const revision = await requirementFixture();
  if (!revision) throw new Error("Requirement Revision is missing");
  const started = await changes.start(ticketID, userID, commission(revision.id));
  if (!started) throw new Error("Change is missing");
  await settle(changes, started.id, "active");
  const commitSHA = "c".repeat(40);
  const verificationID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const otherApprovalID = crypto.randomUUID();
  const otherUserID = crypto.randomUUID();
  const workspaceID = ticketWorkspaceIdentity(started.id).workspaceID;
  const attemptID = runtimeIdentity(workspaceID, 1).attemptID;
  await database.db.insert(authUser).values({
    id: otherUserID,
    name: "Other approver",
    email: `${otherUserID}@change.invalid`,
  });
  await database.client.begin(async (sql) => {
    await sql`
      INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,
        source_branch,source_revision,created_by)
      VALUES(${workspaceID},${projectID},'ticket',${ticketID},${started.id},
        ${started.branchName},${baseSHA},${userID})`;
    await sql`
      INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,
        parent_connector_token_hash,create_intended_at,created_by,atespace,actor_name,binding_intent)
      VALUES(${attemptID},${projectID},${started.id},${workspaceID},1,${baseSHA},
        'create-intended',${"b".repeat(64)},now(),${userID},
        ${`fa-${attemptID.replaceAll("-", "")}`},${`runtime-${attemptID.replaceAll("-", "")}`},'{}')`;
    await sql`
      INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,
        expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,
        created_by,completed_at,source)
      VALUES(${crypto.randomUUID()},${started.id},${attemptID},1,${started.branchName},${baseSHA},${commitSHA},
        ${commitSHA},'Saved candidate',${crypto.randomUUID()},'succeeded',${userID},now(),'agent')`;
    await sql`
      INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,action_run_id,state,
        created_by,created_at,completed_at)
      VALUES(${verificationID},${started.id},${commitSHA},1,9,'succeeded',${userID},
        '2026-11-19T10:00:00Z','2026-11-19T10:01:00Z'),
        (${crypto.randomUUID()},${started.id},${"d".repeat(40)},1,10,'failed',${userID},
        '2026-11-19T11:00:00Z','2026-11-19T11:01:00Z')`;
    await sql`
      INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,approved_by,approved_at)
      VALUES(${approvalID},${started.id},${verificationID},${commitSHA},${userID},
        '2026-11-19T12:00:00.123456+02:00'),
        (${otherApprovalID},${started.id},${verificationID},${commitSHA},${otherUserID},
        '2026-11-19T13:00:00.654321+02:00')`;
    await sql`
      INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,result,created_by,created_at,completed_at)
      VALUES(${crypto.randomUUID()},'delivery.merge','change',${started.id},
        ${`delivery.merge:${crypto.randomUUID()}`},NULL,'succeeded',
        jsonb_build_object(
          'changeId',${started.id}::text,'commitSha',${commitSHA}::text,'baseSha',${baseSHA}::text,
          'pullRequestNumber',1,'approvalId',${approvalID}::text,'deliveryPolicyId',NULL::text
        ),
        jsonb_build_object('mergeSha',${commitSHA}::text),${userID},'2026-11-19T12:30:00Z','2026-11-19T12:31:00Z'),
        (${crypto.randomUUID()},'delivery.merge','change',${started.id},
        ${`delivery.merge:${crypto.randomUUID()}`},NULL,'failed',
        jsonb_build_object(
          'changeId',${started.id}::text,'commitSha',${commitSHA}::text,'baseSha',${baseSHA}::text,
          'pullRequestNumber',1,'approvalId',${otherApprovalID}::text,'deliveryPolicyId',NULL::text
        ),
        NULL,${userID},'2026-11-19T13:30:00Z','2026-11-19T13:31:00Z')`;
    await sql`
      INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${crypto.randomUUID()},'delivery.promotion','change',${started.id},
        ${`delivery.promotion:${started.id}:1`},${`delivery.promotion:${projectID}`},'pending',
        jsonb_build_object(
          'changeId',${started.id}::text,'projectId',${projectID}::text,'commitSha',${commitSHA}::text,
          'previousRuntimeAttemptId',NULL::text,'replacementRuntimeAttemptId',NULL::text,
          'ordinal',1,'supersedesId',NULL::text,'retryCommandId',NULL::text
        ),${userID})`;
  });
  const [original] = await database.client<{ at: string }[]>`
    SELECT approved_at AS at FROM factory.delivery_approval WHERE id=${approvalID}`;
  if (!original) throw new Error("Delivery Approval is missing");
  const view = await changes.get(started.id);
  expect(view?.verificationState).toBe("succeeded");
  expect(view?.mergeState).toBe("succeeded");
  expect(view?.deliveryApprovedAt).toBe(original.at);
  expect(typeof view?.deliveryApprovedAt).toBe("string");
  expect(view?.promotionState).toBe("pending");
  expect(await changes.list(projectID, userID)).toEqual(view ? [view] : []);
});

test("manual documents keep CAS, partial replay bases, authority and no implicit approval", async () => {
  const documents = createTicketDocumentController(database);
  const input = documentInput();
  const attempts = await Promise.allSettled([
    documents.save(ticketID, userID, input),
    documents.save(ticketID, userID, { ...input, commandId: crypto.randomUUID() }),
  ]);
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  const [current] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.ticket_document_revision WHERE ticket_id=${ticketID}`;
  if (!current) throw new Error("Saved document is missing");
  const partialInput = {
    ...input,
    commandId: crypto.randomUUID(),
    expectedVersion: 2,
    expectedDocumentId: current.id,
    requirementRevisionId: current.id,
    requirement: { ...requirement, acceptanceCriteria: [] },
  };
  const partial = await documents.save(ticketID, userID, partialInput);
  expect(partial).toEqual({
    id: partialInput.commandId,
    ticketVersion: 3,
    requirementRevisionId: current.id,
  });
  const [partialRevision] = await database.client`
    SELECT requirement_revision_id AS revision FROM factory.ticket_document_revision WHERE id=${partial.id}`;
  expect(partialRevision?.["revision"]).toBeNull();
  const complete = await documents.save(ticketID, userID, {
    ...input,
    commandId: crypto.randomUUID(),
    expectedVersion: partial.ticketVersion,
    expectedDocumentId: partial.id,
    requirementRevisionId: partial.requirementRevisionId,
    requirement: { ...requirement, summary: "Completed next scope" },
  });
  expect(complete.ticketVersion).toBe(4);
  expect(complete.requirementRevisionId).toBe(complete.id);
  expect(await documents.save(ticketID, userID, partialInput)).toEqual(partial);
  await expect(
    documents.save(ticketID, userID, { ...partialInput, title: "Reused command" }),
  ).rejects.toThrow("another document");
  const stranger = crypto.randomUUID();
  await database.db.insert(authUser).values({
    id: stranger,
    name: "Stranger",
    email: `${stranger}@change.invalid`,
  });
  await expect(documents.save(ticketID, stranger, input)).rejects.toThrow("Project not found");
  const [saved] = await database.client`
    SELECT title,description,state,version::integer FROM factory.ticket WHERE id=${ticketID}`;
  if (!saved) throw new Error("Saved Ticket is missing");
  expect(saved).toEqual({
    title: input.title,
    description: input.description,
    state: "ready",
    version: 4,
  });
  expect(await database.client`SELECT id FROM factory.requirement_approval`).toHaveLength(0);
  expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  expect(await database.client`SELECT id FROM factory.change`).toHaveLength(0);
  const detail = await ticketService().detail(userID, ticketID);
  expect(detail.ticket).toMatchObject(saved);
  expect(detail.documentRevisions.map((revision) => revision.id)).toEqual([
    complete.id,
    partial.id,
    current.id,
  ]);
  expect(detail.revisions.map((revision) => revision.id)).toEqual([complete.id, current.id]);
  expect(detail.documentRevisions[1]).toMatchObject({
    requirementRevisionId: null,
    author: "Owned Change author",
    authorKind: "human",
  });
  expect(detail.documentRevisions[1]?.approvalId).toBeUndefined();
  for (const revision of [...detail.revisions, ...detail.documentRevisions])
    expect(revision.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  expect(detail).toMatchObject({
    proposal: null,
    origin: null,
    followUps: [],
    technicalDesignPresent: false,
    technicalPlanningPending: false,
    technicalDesigns: [],
    implementationOrder: null,
  });
  expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  expect(await database.client`SELECT id FROM factory.change`).toHaveLength(0);
});

test.each([false, true])(
  "approved scope stays pinned through human documents and follow-up with document=%s",
  async (withDocument) => {
    const changes = controller();
    const revision = await requirementFixture();
    if (!revision) throw new Error("Requirement Revision is missing");
    const started = await changes.start(ticketID, userID, commission(revision.id));
    if (!started) throw new Error("Change is missing");
    await settle(changes, started.id, "active");
    const documents = createTicketDocumentController(database);
    const [base] = await database.client<{ version: number }[]>`
      SELECT version::integer FROM factory.ticket WHERE id=${ticketID}`;
    const saved = withDocument
      ? await documents.save(ticketID, userID, {
          ...documentInput(),
          expectedVersion: base?.version ?? 0,
          requirementRevisionId: revision.id,
          requirement: { ...requirement, summary: "Later human wording" },
        })
      : null;
    const follow = {
      commandId: crypto.randomUUID(),
      expectedDocumentId: saved?.id ?? null,
      requirementRevisionId: revision.id,
    };
    await expect(documents.followUp(ticketID, userID, follow)).rejects.toThrow("delivered");
    await database.client`UPDATE factory.change SET state='delivered' WHERE id=${started.id}`;
    const results = await Promise.all([
      documents.followUp(ticketID, userID, follow),
      documents.followUp(ticketID, userID, follow),
    ]);
    expect(results).toEqual([{ ticketId: follow.commandId }, { ticketId: follow.commandId }]);
    const [created] = await database.client`
      SELECT ticket.project_id AS "projectID",ticket.title,ticket.description,ticket.state,
        (follow.payload->>'sourceTicketId')::uuid AS source,
        (follow.payload->>'sourceDocumentId')::uuid AS document,
        (follow.payload->>'sourceRevisionId')::uuid AS revision,
        requirement.ordinal,requirement.canonical_content AS canonical,
        requirement.content_digest AS digest,requirement.created_by AS author
      FROM factory.ticket ticket
      JOIN factory.audit_event follow
        ON follow.kind='tickets.follow_up'
        AND follow.scope_type='ticket'
        AND follow.scope_id=ticket.id::text
      JOIN factory.requirement_revision requirement ON requirement.ticket_id=ticket.id
      WHERE ticket.id=${follow.commandId}`;
    const canonical = canonicalRequirementContent({
      ...requirement,
      ...(withDocument ? { summary: "Later human wording" } : {}),
    });
    expect(created).toEqual({
      projectID,
      title: "Follow-up: Saved Ticket",
      description: "Saved description",
      state: "ready",
      source: ticketID,
      document: saved?.id ?? null,
      revision: revision.id,
      ordinal: 1,
      canonical,
      digest: requirementDigest(canonical),
      author: userID,
    });
    const [original] = await database.client`
      SELECT canonical_content AS canonical FROM factory.requirement_revision WHERE id=${revision.id}`;
    expect(original?.["canonical"]).toBe(revision.canonicalContent);
    expect(
      await database.client`SELECT id FROM factory.requirement_revision WHERE ticket_id=${ticketID}`,
    ).toHaveLength(1);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${follow.commandId}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id=${follow.commandId}`,
    ).toHaveLength(0);
    const service = ticketService(changes);
    const detail = await service.detail(userID, ticketID);
    expect(detail.revisions[0]).toMatchObject({
      id: revision.id,
      canonicalContent: revision.canonicalContent,
      contentDigest: revision.contentDigest,
      author: "Owned Change author",
    });
    expect(detail.revisions[0]?.approvalId).toBeString();
    expect(detail.revisions[0]?.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    if (saved) {
      expect(detail.documentRevisions[0]).toMatchObject({
        id: saved.id,
        requirementRevisionId: revision.id,
        canonicalContent: canonical,
      });
      expect(detail.documentRevisions[0]?.approvalId).toBeUndefined();
    }
    expect(detail.followUps).toEqual([{ id: follow.commandId, title: "Follow-up: Saved Ticket" }]);
    expect((await service.detail(userID, follow.commandId)).origin).toEqual({
      id: ticketID,
      title: "Saved Ticket",
    });
    await expect(
      documents.followUp(ticketID, userID, { ...follow, expectedDocumentId: crypto.randomUUID() }),
    ).rejects.toThrow("different work");
  },
);

test("proposal supersession and full Planning rollback use the caller transaction", async () => {
  const conversationID = crypto.randomUUID();
  await database.db.insert(ticketConversation).values({
    id: conversationID,
    projectId: projectID,
    ticketId: ticketID,
    createdBy: userID,
    mode: "plan",
  });
  const proposalID = crypto.randomUUID();
  const payload = {
    ticket: { title: "Proposal", description: "Proposal text" },
    requirement,
    base: { id: ticketID, version: 1, documentId: null, revisionId: null },
    fullPlanning: true,
    sourceCommit: baseSHA,
    contextId: crypto.randomUUID(),
    visibility: "developer",
  };
  await database.client`
    INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
    VALUES(${proposalID},${conversationID},1,'requirement','project-agent','plan','Proposal',
      ${JSON.stringify(payload)}::jsonb,${userID})`;
  const service = ticketService();
  expect((await service.detail(userID, ticketID)).proposal?.id).toBe(proposalID);
  const input = { ...documentInput(), proposalEntryId: proposalID };
  const documents = createTicketDocumentController(database, async (sql, context) => {
    expect(context).toEqual({
      commandID: input.commandId,
      projectID,
      ticketID,
      userID,
      sourceCommit: baseSHA,
      contextID: payload.contextId,
    });
    const [written] =
      await sql`SELECT id FROM factory.ticket_document_revision WHERE id=${input.commandId}`;
    expect(written?.["id"]).toBe(input.commandId);
    throw new Error("Continuation rejected");
  });
  await expect(documents.save(ticketID, userID, input)).rejects.toThrow("Continuation rejected");
  expect(await database.client`SELECT id FROM factory.ticket_document_revision`).toHaveLength(0);
  expect(await database.client`SELECT id FROM factory.requirement_revision`).toHaveLength(0);
  await database.db
    .update(projectMembership)
    .set({ role: "product-contributor" })
    .where(eq(projectMembership.userId, userID));
  expect((await service.detail(userID, ticketID)).proposal).toBeNull();
  await expect(documents.save(ticketID, userID, input)).rejects.toThrow("Developer access");
  await database.db
    .update(projectMembership)
    .set({ role: "developer" })
    .where(eq(projectMembership.userId, userID));
  const newerID = crypto.randomUUID();
  await database.client`
    INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
    VALUES(${newerID},${conversationID},2,'requirement','project-agent','plan','Newer',
      ${JSON.stringify(payload)}::jsonb,${userID})`;
  expect((await service.detail(userID, ticketID)).proposal?.id).toBe(newerID);
  await expect(documents.save(ticketID, userID, input)).rejects.toThrow("Elaborate");
  await appendTicketAuthoringIn(database.db, {
    ticketId: ticketID,
    createdBy: userID,
    title: payload.ticket.title,
    description: payload.ticket.description,
    canonicalContent: canonicalRequirementContent(requirement),
    document: {
      id: crypto.randomUUID(),
      ordinal: 1,
      requirementRevisionId: null,
      inputDigest: "a".repeat(64),
      authorKind: "ai",
      proposalEntryId: newerID,
    },
  });
  expect((await service.detail(userID, ticketID)).proposal).toBeNull();
});

test("admission rolls back its intent, then persists exact branch identity before external create", async () => {
  let protectedID: string | undefined;
  let branchCalls = 0;
  const changes = controller({
    protect: async (id) => {
      protectedID = id;
    },
    ensureBranch: async () => {
      branchCalls++;
      const [intent] = await database.client`
        SELECT change.id,change.base_sha AS sha,operation.payload->>'startSha' AS start,
          operation.idempotency_key AS key,operation.state
        FROM factory.change change JOIN factory.operation operation
          ON operation.kind='delivery.branch_create' AND operation.scope_type='change'
            AND operation.scope_id=change.id::text`;
      expect(intent?.["id"]).toBe(protectedID);
      expect(intent?.["sha"]).toBe(baseSHA);
      expect(intent?.["start"]).toBe(baseSHA);
      expect(intent?.["key"]).toBe(`delivery.branch_create:change:${protectedID}:create-branch`);
      expect(intent?.["state"]).toBe("executing");
    },
  });
  const revision = await requirementFixture();
  if (!revision) throw new Error("Requirement Revision is missing");
  const admission = {
    commandID: crypto.randomUUID(),
    revisionID: revision.id,
    codingReasoning: "high" as const,
    admitBuild: async () => {
      throw new Error("Build admission rejected");
    },
  };
  await expect(changes.start(ticketID, userID, admission)).rejects.toThrow(
    "Build admission rejected",
  );
  expect(await database.client`SELECT id FROM factory.change`).toHaveLength(0);
  expect(
    await database.client`SELECT id FROM factory.operation WHERE kind='delivery.branch_create'`,
  ).toHaveLength(0);
  expect(await database.client`SELECT id FROM factory.requirement_approval`).toHaveLength(0);
  expect(branchCalls).toBe(0);
  const started = await changes.start(ticketID, userID, {
    ...admission,
    admitBuild: async () => {},
  });
  if (!started) throw new Error("Change is missing");
  const active = await settle(changes, started.id, "active");
  expect(active).toEqual({
    id: started.id,
    projectId: projectID,
    ticketId: ticketID,
    requirementApprovalId: active.requirementApprovalId,
    branchName: active.branchName,
    baseSha: baseSHA,
    state: "active",
    version: active.version,
    runtimeAttemptId: null,
    failure: null,
    branchState: "succeeded",
    branchHeadSha: baseSHA,
    runtimeState: null,
    verificationState: null,
    buildTurnState: null,
    buildTurnPurpose: null,
    implementationState: null,
    deliveryApprovedAt: null,
    mergeState: null,
    promotionState: null,
  });
  // The unchanged SQL projection returns bigint text through Postgres.js.
  expect(String(active.version)).toBe("2");
  expect([...(await changes.list(projectID, userID))]).toEqual([active]);
  expect((await changes.start(ticketID, userID, commission(revision.id)))?.id).toBe(started.id);
  expect(branchCalls).toBe(1);
  await changes.cancel(started.id);
  await settle(changes, started.id, "cancelled");
});

test("waiting dependencies retain order identity, exact source and explicit cancellation", async () => {
  const changes = controller();
  const revision = await requirementFixture();
  if (!revision) throw new Error("Requirement Revision is missing");
  const prerequisiteID = crypto.randomUUID();
  await insertInitialTicketIn(database.db, {
    id: prerequisiteID,
    projectId: projectID,
    title: "Undelivered prerequisite",
    description: "",
    state: "ready",
    createdBy: userID,
  });
  await database.client`
    INSERT INTO factory.ticket_dependency(project_id,ticket_id,prerequisite_id,created_by)
    VALUES(${projectID},${ticketID},${prerequisiteID},${userID})`;
  const admission = {
    commandID: crypto.randomUUID(),
    revisionID: revision.id,
    expectedBaseSHA: baseSHA,
    codingReasoning: "high" as const,
    admitBuild: async () => {
      throw new Error("Blocked work must not admit Build");
    },
  };
  await expect(
    changes.start(ticketID, userID, { ...admission, expectedBaseSHA: "b".repeat(40) }),
  ).rejects.toThrow("default branch changed");
  expect(await changes.start(ticketID, userID, admission)).toBeNull();
  expect(await changes.start(ticketID, userID, admission)).toBeNull();
  const [order] = await database.client`
    SELECT id AS command,(payload->>'requirementRevisionId')::uuid AS revision,
      payload->>'codingReasoning' AS reasoning,payload->>'sourceSha' AS source,state
    FROM factory.operation WHERE kind='tickets.implementation_order'`;
  expect(order).toEqual({
    command: admission.commandID,
    revision: revision.id,
    reasoning: "high",
    source: baseSHA,
    state: "waiting",
  });
  expect(await database.client`SELECT id FROM factory.change`).toHaveLength(0);
  await expect(
    changes.start(ticketID, userID, { ...admission, commandID: crypto.randomUUID() }),
  ).rejects.toThrow("different implementation order");
  const service = ticketService(changes);
  const peer = crypto.randomUUID();
  await database.db.insert(authUser).values({
    id: peer,
    name: "Project contributor",
    email: `${peer}@change.invalid`,
  });
  await database.db.insert(projectMembership).values({
    projectId: projectID,
    userId: peer,
    role: "product-contributor",
    updatedBy: userID,
  });
  expect((await service.detail(peer, ticketID)).implementationOrder).toMatchObject({
    commandId: admission.commandID,
    state: "waiting",
    reason: null,
    canCancel: false,
  });
  await expect(
    service.cancelImplementation(peer, ticketID, admission.commandID),
  ).rejects.toMatchObject({ code: "forbidden" });
  await database.db
    .update(projectMembership)
    .set({ role: "product-contributor" })
    .where(eq(projectMembership.userId, userID));
  expect((await service.detail(userID, ticketID)).implementationOrder?.canCancel).toBe(true);
  await service.cancelImplementation(userID, ticketID, admission.commandID);
  const [cancelled] = await database.client`
    SELECT (payload->>'cancelledBy')::uuid AS author,payload->>'cancelledAt' AS at,
      (payload->>'requirementRevisionId')::uuid AS revision,
      payload->>'sourceSha' AS source,payload->>'codingReasoning' AS reasoning
    FROM factory.operation WHERE kind='tickets.implementation_order' AND id=${admission.commandID}`;
  expect(cancelled).toMatchObject({
    author: userID,
    revision: revision.id,
    source: baseSHA,
    reasoning: "high",
  });
  expect(new Date(String(cancelled?.["at"])).toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  await expect(service.cancelImplementation(userID, ticketID, admission.commandID)).rejects.toThrow(
    "no longer waiting",
  );
  expect((await service.detail(userID, ticketID)).implementationOrder?.state).toBe("cancelled");
  await expect(changes.start(ticketID, userID, admission)).rejects.toThrow("no longer waiting");
  expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  expect(await database.client`SELECT id FROM factory.change`).toHaveLength(0);
});

test("implementation rejects incomplete documents and pins the exact technical revision and source", async () => {
  const changes = controller();
  const documents = createTicketDocumentController(database);
  const input = documentInput();
  const complete = await documents.save(ticketID, userID, input);
  await documents.save(ticketID, userID, {
    ...input,
    commandId: crypto.randomUUID(),
    expectedVersion: 2,
    expectedDocumentId: complete.id,
    requirementRevisionId: complete.id,
    requirement: null,
  });
  const admission = {
    commandID: crypto.randomUUID(),
    revisionID: complete.id,
    admitBuild: async () => {},
  };
  await expect(changes.start(ticketID, userID, admission)).rejects.toThrow(
    "Finish the current specification",
  );
  expect(await database.client`SELECT id FROM factory.requirement_approval`).toHaveLength(0);
  const [latestDocument] = await database.client<{ id: string }[]>`
    SELECT id FROM factory.ticket_document_revision WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
  if (!latestDocument) throw new Error("Partial document is missing");
  await documents.save(ticketID, userID, {
    ...input,
    commandId: crypto.randomUUID(),
    expectedVersion: 3,
    expectedDocumentId: latestDocument.id,
    requirementRevisionId: complete.id,
  });
  const designID = crypto.randomUUID();
  const canonical = JSON.stringify({ design: "Bounded technical plan" });
  await database.db.insert(technicalDesignRevision).values({
    id: designID,
    ticketId: ticketID,
    requirementRevisionId: complete.id,
    ordinal: 1,
    sourceCommit: "b".repeat(40),
    canonicalContent: canonical,
    contentDigest: requirementDigest(canonical),
    rendererVersion: "owned-test",
    createdBy: userID,
    authorKind: "human",
  });
  await expect(changes.start(ticketID, userID, admission)).rejects.toThrow(
    "current technical design",
  );
  const designed = { ...admission, technicalDesignRevisionID: designID };
  await database.db
    .update(projectMembership)
    .set({ role: "product-contributor" })
    .where(eq(projectMembership.userId, userID));
  await expect(changes.start(ticketID, userID, designed)).rejects.toThrow("Developer access");
  await database.db
    .update(projectMembership)
    .set({ role: "developer" })
    .where(eq(projectMembership.userId, userID));
  await expect(changes.start(ticketID, userID, designed)).rejects.toThrow(
    "source changed since Technical Planning",
  );
  expect(await database.client`SELECT id FROM factory.requirement_approval`).toHaveLength(0);
  expect(
    await database.client`SELECT id FROM factory.operation WHERE kind='delivery.branch_create'`,
  ).toHaveLength(0);
  const currentDesignID = crypto.randomUUID();
  await database.db.insert(technicalDesignRevision).values({
    id: currentDesignID,
    ticketId: ticketID,
    requirementRevisionId: complete.id,
    previousRevisionId: designID,
    ordinal: 2,
    sourceCommit: baseSHA,
    canonicalContent: canonical,
    contentDigest: requirementDigest(canonical),
    rendererVersion: "owned-test",
    createdBy: userID,
    authorKind: "human",
  });
  const started = await changes.start(ticketID, userID, {
    ...admission,
    technicalDesignRevisionID: currentDesignID,
  });
  if (!started) throw new Error("Change is missing");
  await settle(changes, started.id, "active");
  const [approval] = await database.client`
    SELECT requirement_revision_id AS revision,technical_design_revision_id AS technical
    FROM factory.requirement_approval WHERE ticket_id=${ticketID}`;
  expect(approval).toEqual({ revision: complete.id, technical: currentDesignID });
  await expect(changes.start(ticketID, userID, designed)).rejects.toThrow(
    "current technical design",
  );
  await changes.cancel(started.id);
  await settle(changes, started.id, "cancelled");
});

test("contending document saves keep the winner's CAS base under an observed PostgreSQL lock", async () => {
  const revision = await requirementFixture();
  if (!revision) throw new Error("Requirement Revision is missing");
  const conversationID = crypto.randomUUID();
  const proposalID = crypto.randomUUID();
  await database.db.insert(ticketConversation).values({
    id: conversationID,
    projectId: projectID,
    ticketId: ticketID,
    createdBy: userID,
    mode: "plan",
  });
  const payload = {
    ticket: { title: "Contended proposal", description: "" },
    requirement,
    base: { id: ticketID, version: 1, documentId: null, revisionId: revision.id },
    fullPlanning: true,
    sourceCommit: baseSHA,
  };
  await database.client`
    INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
    VALUES(${proposalID},${conversationID},1,'requirement','project-agent','plan','Proposal',
      ${JSON.stringify(payload)}::jsonb,${userID})`;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const documents = createTicketDocumentController(database, async () => {
    entered.resolve();
    await release.promise;
  });
  const firstInput = {
    ...documentInput(),
    requirementRevisionId: revision.id,
    proposalEntryId: proposalID,
  };
  const first = documents.save(ticketID, userID, firstInput);
  await entered.promise;
  const second = documents
    .save(ticketID, userID, {
      ...documentInput(),
      requirementRevisionId: revision.id,
      title: "Competing draft",
    })
    .then(
      () => "unexpected success",
      (cause: unknown) => cause,
    );
  try {
    let contended = false;
    for (let observation = 0; observation < 100; observation++) {
      const [lock] = await database.client<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%') AS waiting`;
      if (lock?.waiting) {
        contended = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(contended).toBe(true);
  } finally {
    release.resolve();
  }
  const [saved, rejected] = await Promise.all([first, second]);
  expect(saved).toEqual({
    id: firstInput.commandId,
    ticketVersion: 2,
    requirementRevisionId: revision.id,
  });
  expect(rejected).toBeInstanceOf(Error);
  expect(String(rejected)).toContain("changed elsewhere");
  expect(await database.client`SELECT id FROM factory.ticket_document_revision`).toHaveLength(1);
});

test.each(["stopped", "failed"])(
  "cancellation observes only the recorded native attempt when runtime=%s",
  async (state) => {
    const changes = controller();
    const revision = await requirementFixture();
    if (!revision) throw new Error("Requirement Revision is missing");
    const started = await changes.start(ticketID, userID, commission(revision.id));
    if (!started) throw new Error("Change is missing");
    await settle(changes, started.id, "active");
    const workspaceID = ticketWorkspaceIdentity(started.id).workspaceID;
    const attemptID = runtimeIdentity(workspaceID, 1).attemptID;
    await database.client.begin(async (sql) => {
      await sql`
        INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,
          source_branch,source_revision,created_by)
        VALUES(${workspaceID},${projectID},'ticket',${ticketID},${started.id},
          ${started.branchName},${baseSHA},${userID})`;
      await sql`
        INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,
          parent_connector_token_hash,create_intended_at,created_by,failure,atespace,actor_name,binding_intent)
        VALUES(${attemptID},${projectID},${started.id},${workspaceID},1,${baseSHA},
          'create-intended',${"b".repeat(64)},now(),${userID},
          ${state === "failed" ? "Owned cleanup failed" : null},
          ${`fa-${attemptID.replaceAll("-", "")}`},${`runtime-${attemptID.replaceAll("-", "")}`},'{}')`;
      await sql`UPDATE factory.runtime_attempt SET state=${state}::factory.runtime_attempt_state WHERE id=${attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${attemptID},state='starting' WHERE id=${started.id}`;
    });
    const stopped: string[] = [];
    const runtime = createChangeController(database, {
      stop: async (id) => {
        stopped.push(id);
        return null;
      },
    });
    await runtime.recover();
    expect((await runtime.get(started.id))?.state).toBe("starting");
    await runtime.cancel(started.id);
    const result = await settle(runtime, started.id, state === "stopped" ? "cancelled" : "failed");
    expect(stopped).toEqual([attemptID]);
    expect(result.runtimeAttemptId).toBe(attemptID);
    expect(result.failure).toBe(state === "failed" ? "Owned cleanup failed" : null);
    expect(await database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(1);
  },
);

test("branch retries preserve terminal outcomes and recovery leaves recorded runtime identity alone", async () => {
  let calls = 0;
  const changes = controller({
    ensureBranch: async () => {
      if (++calls === 1) throw new ForgeAmbiguousWriteError("Owned lost acknowledgement");
    },
  });
  const revision = await requirementFixture();
  if (!revision) throw new Error("Requirement Revision is missing");
  const started = await changes.start(ticketID, userID, commission(revision.id));
  if (!started) throw new Error("Change is missing");
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await changes.get(started.id))?.branchState === "ambiguous") break;
    await Bun.sleep(10);
  }
  expect((await changes.get(started.id))?.branchState).toBe("ambiguous");
  await database.client`UPDATE factory.operation
    SET payload=jsonb_set(payload,'{reconcileAfter}',to_jsonb(now()::text))
    WHERE kind='delivery.branch_create' AND scope_type='change' AND scope_id=${started.id}`;
  await changes.reconcile(started.id);
  await settle(changes, started.id, "active");
  await changes.recover();
  expect(calls).toBe(2);
  await database.client`UPDATE factory.change SET state='starting' WHERE id=${started.id}`;
  await changes.recover();
  expect((await changes.get(started.id))?.state).toBe("active");
  await changes.cancel(started.id);
  await settle(changes, started.id, "cancelled");
  expect((await changes.get(started.id))?.branchState).toBe("succeeded");
  const otherID = crypto.randomUUID();
  await insertInitialTicketIn(database.db, {
    id: otherID,
    projectId: projectID,
    title: "Conflict",
    description: "",
    state: "ready",
    createdBy: userID,
  });
  const conflict = controller({
    ensureBranch: async () => {
      throw new ForgeConflictError("Owned source moved");
    },
  });
  const other = await requirementFixture(otherID);
  if (!other) throw new Error("Requirement Revision is missing");
  const failed = await conflict.start(otherID, userID, commission(other.id));
  if (!failed) throw new Error("Change is missing");
  const result = await settle(conflict, failed.id, "failed");
  expect(result.failure).toBe("Owned source moved");
  expect(result.branchState).toBe("failed");
});
