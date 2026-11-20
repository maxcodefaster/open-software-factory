import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql as query } from "drizzle-orm";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createTicketService } from "../../apps/factory/src/change/service";
import type {
  RequirementApprovalView,
  RequirementRevisionView,
} from "../../apps/factory/src/change/types";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createDatabase, drizzleTransaction } from "../../packages/db/src/client";
import {
  authUser,
  branchCreateOperation,
  change as changeTable,
  project,
  projectMembership,
  technicalDesignRevision,
  ticketConversation,
} from "../../packages/db/src/schema";
import {
  type createForgejoClient,
  ForgeAmbiguousWriteError,
  ForgeConflictError,
} from "../../packages/forge/src/forge";
import {
  canonicalRequirementContent,
  requirementDigest,
} from "../../packages/requirement-domain/src/requirement";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  appendTicketAuthoringIn,
  insertInitialTicketIn,
} from "../../packages/ticket-authoring/src/authoring";
import { ticketWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
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
    devcontainerPath: ".devcontainer/devcontainer.json",
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

test("Requirement revisions serialize ordinals and retain every DTO field and timestamp", async () => {
  const changes = controller();
  const revisions = await Promise.all([
    changes.createRevision(ticketID, requirement, userID),
    changes.createRevision(ticketID, { ...requirement, summary: "Second saved scope" }, userID),
  ]);
  expect(revisions.map((value) => value?.ordinal).sort()).toEqual([1, 2]);
  for (const revision of revisions) {
    if (!revision) throw new Error("Requirement Revision is missing");
    const [stored] = await database.client<RequirementRevisionView[]>`
      SELECT id,ticket_id AS "ticketId",ordinal,canonical_content AS "canonicalContent",
        content_digest AS "contentDigest",created_at AS "createdAt"
      FROM factory.requirement_revision WHERE id=${revision.id}`;
    if (!stored) throw new Error("Stored Requirement Revision is missing");
    expect(revision).toEqual(stored);
    expect(typeof revision?.createdAt).toBe("string");
    expect(new Date(revision?.createdAt ?? "").toISOString()).toContain("T");
  }
  const latest = revisions.find((revision) => revision?.ordinal === 2);
  if (!latest) throw new Error("Latest revision is missing");
  const approvals = await Promise.all([
    changes.approve(ticketID, latest.id, userID),
    changes.approve(ticketID, latest.id, userID),
  ]);
  expect(approvals[0]).toEqual(approvals[1]);
  const [stored] = await database.client<RequirementApprovalView[]>`
    SELECT id,ticket_id AS "ticketId",requirement_revision_id AS "requirementRevisionId",
      approved_by AS "approvedBy",approved_at AS "approvedAt"
    FROM factory.requirement_approval WHERE ticket_id=${ticketID}`;
  expect(approvals[0]).toEqual(stored);
  await expect(changes.createRevision(ticketID, requirement, userID)).rejects.toThrow("immutable");
  await expect(
    changes.approve(ticketID, revisions.find((value) => value?.ordinal === 1)?.id ?? "", userID),
  ).rejects.toThrow("latest");
  expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
});

test("reserved Drizzle queries share the same PostgreSQL PID through manual rollback and commit", async () => {
  const changes = controller();
  const revision = await changes.createRevision(ticketID, requirement, userID);
  if (!revision) throw new Error("Requirement Revision is missing");
  const approval = await changes.approve(ticketID, revision.id, userID);
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
    await db.insert(branchCreateOperation).values({
      id: identity.branchOperationID,
      changeId: identity.changeID,
      repositoryOwner: "owned",
      repositoryName: "repository",
      branchName: identity.branchName,
      startSha: baseSHA,
      idempotencyKey: `change:${identity.changeID}:create-branch`,
      state: "executing",
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
        .update(branchCreateOperation)
        .set({
          state: "succeeded",
          observedHeadSha: baseSHA,
          completedAt: query`now()`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: query`now()`,
          lastError: null,
        })
        .where(
          and(
            eq(branchCreateOperation.id, identity.branchOperationID),
            eq(branchCreateOperation.state, "executing"),
          ),
        );
      await db
        .update(changeTable)
        .set({ state: "active", version: query`${changeTable.version} + 1` })
        .where(and(eq(changeTable.id, identity.changeID), eq(changeTable.state, "branch-pending")));
      const [inside] = await db
        .select({
          branch: branchCreateOperation.state,
          change: changeTable.state,
          pid: query<number>`pg_backend_pid()`,
        })
        .from(changeTable)
        .innerJoin(branchCreateOperation, eq(branchCreateOperation.changeId, changeTable.id))
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
  const revision = await changes.createRevision(ticketID, requirement, userID);
  if (!revision) throw new Error("Requirement Revision is missing");
  await changes.approve(ticketID, revision.id, userID);
  // A disposable constraint fails the second write of the real reserved transaction.
  await database.client`ALTER TABLE factory.change ADD CONSTRAINT owned_reconcile_failure CHECK(state<>'active')`;
  const started = await changes.start(ticketID, userID);
  if (!started) throw new Error("Change is missing");
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await changes.get(started.id))?.branchState === "ambiguous") break;
    await Bun.sleep(10);
  }
  const [failed] = await database.client`
    SELECT change.state,change.version::integer AS version,operation.state AS branch,
      operation.completed_at AS completed,operation.last_error AS error
    FROM factory.change change JOIN factory.branch_create_operation operation ON operation.change_id=change.id
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
  const revision = await changes.createRevision(ticketID, requirement, userID);
  if (!revision) throw new Error("Requirement Revision is missing");
  await changes.approve(ticketID, revision.id, userID);
  const started = await changes.start(ticketID, userID);
  if (!started) throw new Error("Change is missing");
  await settle(changes, started.id, "active");
  const commitSHA = "c".repeat(40);
  const verificationID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const otherApprovalID = crypto.randomUUID();
  const otherUserID = crypto.randomUUID();
  const content = "Retained repository document";
  await database.db.insert(authUser).values({
    id: otherUserID,
    name: "Other approver",
    email: `${otherUserID}@change.invalid`,
  });
  await database.client.begin(async (sql) => {
    await sql`
      INSERT INTO factory.change_commit_operation(id,change_id,sequence,branch_name,expected_parent_sha,
        commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at,
        source,repository_path,repository_blob_sha,repository_content,content_digest)
      VALUES(${crypto.randomUUID()},${started.id},1,${started.branchName},${baseSHA},${commitSHA},
        ${commitSHA},'Saved documentation',${crypto.randomUUID()},'succeeded',${userID},now(),
        'repository-document','README.md',${"b".repeat(40)},${content},${requirementDigest(content)})`;
    await sql`
      INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,action_run_id,runner_name,state,
        created_by,created_at,completed_at)
      VALUES(${verificationID},${started.id},${commitSHA},1,9,'owned-check','succeeded',${userID},
        '2026-11-19T10:00:00Z','2026-11-19T10:01:00Z'),
        (${crypto.randomUUID()},${started.id},${"d".repeat(40)},1,10,'wrong-commit','failed',${userID},
        '2026-11-19T11:00:00Z','2026-11-19T11:01:00Z')`;
    await sql`
      INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,approved_by,approved_at)
      VALUES(${approvalID},${started.id},${verificationID},${commitSHA},${userID},
        '2026-11-19T12:00:00.123456+02:00'),
        (${otherApprovalID},${started.id},${verificationID},${commitSHA},${otherUserID},
        '2026-11-19T13:00:00.654321+02:00')`;
    await sql`
      INSERT INTO factory.merge_operation(id,change_id,delivery_approval_id,pull_request_number,base_sha,
        commit_sha,idempotency_key,state,observed_default_sha,requested_at,completed_at)
      VALUES(${crypto.randomUUID()},${started.id},${approvalID},1,${baseSHA},${commitSHA},
        ${crypto.randomUUID()},'succeeded',${commitSHA},'2026-11-19T12:30:00Z','2026-11-19T12:31:00Z'),
        (${crypto.randomUUID()},${started.id},${otherApprovalID},1,${baseSHA},${commitSHA},
        ${crypto.randomUUID()},'failed',NULL,'2026-11-19T13:30:00Z','2026-11-19T13:31:00Z')`;
    await sql`
      INSERT INTO factory.promotion_operation(id,change_id,project_id,commit_sha)
      VALUES(${crypto.randomUUID()},${started.id},${projectID},${commitSHA})`;
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
    const revision = await changes.createRevision(ticketID, requirement, userID);
    if (!revision) throw new Error("Requirement Revision is missing");
    await changes.approve(ticketID, revision.id, userID);
    const started = await changes.start(ticketID, userID);
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
        follow.source_ticket_id AS source,follow.source_document_id AS document,
        follow.source_revision_id AS revision,requirement.ordinal,requirement.canonical_content AS canonical,
        requirement.content_digest AS digest,requirement.created_by AS author
      FROM factory.ticket ticket JOIN factory.ticket_follow_up follow ON follow.ticket_id=ticket.id
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
        SELECT change.id,change.base_sha AS sha,operation.start_sha AS start,
          operation.idempotency_key AS key,operation.state
        FROM factory.change change JOIN factory.branch_create_operation operation ON operation.change_id=change.id`;
      expect(intent?.["id"]).toBe(protectedID);
      expect(intent?.["sha"]).toBe(baseSHA);
      expect(intent?.["start"]).toBe(baseSHA);
      expect(intent?.["key"]).toBe(`change:${protectedID}:create-branch`);
      expect(intent?.["state"]).toBe("executing");
    },
  });
  const revision = await changes.createRevision(ticketID, requirement, userID);
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
  expect(await database.client`SELECT id FROM factory.branch_create_operation`).toHaveLength(0);
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
  expect((await changes.start(ticketID, userID))?.id).toBe(started.id);
  expect(branchCalls).toBe(1);
  await changes.cancel(started.id);
  await settle(changes, started.id, "cancelled");
});

test("waiting dependencies retain order identity, exact source and explicit cancellation", async () => {
  const changes = controller();
  const revision = await changes.createRevision(ticketID, requirement, userID);
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
    SELECT command_id AS command,requirement_revision_id AS revision,coding_reasoning AS reasoning,
      source_sha AS source,state FROM factory.implementation_order`;
  expect(order).toEqual({
    command: admission.commandID,
    revision: revision.id,
    reasoning: "high",
    source: baseSHA,
    state: "waiting",
  });
  expect(await database.client`SELECT id FROM factory.change`).toHaveLength(0);
  await expect(changes.start(ticketID, userID)).rejects.toThrow("Prerequisites");
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
    SELECT cancelled_by AS author,cancelled_at AS at,requirement_revision_id AS revision,
      source_sha AS source,coding_reasoning AS reasoning FROM factory.implementation_order WHERE command_id=${admission.commandID}`;
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
  await expect(changes.approve(ticketID, complete.id, userID)).rejects.toThrow("Use Implement");
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
  expect(await database.client`SELECT id FROM factory.branch_create_operation`).toHaveLength(0);
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
  const revision = await controller().createRevision(ticketID, requirement, userID);
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
    const revision = await changes.createRevision(ticketID, requirement, userID);
    if (!revision) throw new Error("Requirement Revision is missing");
    await changes.approve(ticketID, revision.id, userID);
    const started = await changes.start(ticketID, userID);
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
          parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,failure)
        VALUES(${attemptID},${projectID},${started.id},${workspaceID},1,${baseSHA},
          'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${userID},
          ${state === "failed" ? "Owned cleanup failed" : null})`;
      await sql`
        INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
        VALUES(${attemptID},${`fa-${attemptID.replaceAll("-", "")}`},
          ${`runtime-${attemptID.replaceAll("-", "")}`},'{}')`;
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
  const revision = await changes.createRevision(ticketID, requirement, userID);
  if (!revision) throw new Error("Requirement Revision is missing");
  await changes.approve(ticketID, revision.id, userID);
  const started = await changes.start(ticketID, userID);
  if (!started) throw new Error("Change is missing");
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await changes.get(started.id))?.branchState === "ambiguous") break;
    await Bun.sleep(10);
  }
  expect((await changes.get(started.id))?.branchState).toBe("ambiguous");
  await database.client`UPDATE factory.branch_create_operation SET reconcile_after=now() WHERE change_id=${started.id}`;
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
  const other = await conflict.createRevision(otherID, requirement, userID);
  if (!other) throw new Error("Requirement Revision is missing");
  await conflict.approve(otherID, other.id, userID);
  const failed = await conflict.start(otherID, userID);
  if (!failed) throw new Error("Change is missing");
  const result = await settle(conflict, failed.id, "failed");
  expect(result.failure).toBe("Owned source moved");
  expect(result.branchState).toBe("failed");
});
