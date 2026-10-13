import { createHash } from "node:crypto";
import type postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client";

const { client } = createDatabase(1);
const suffix = crypto.randomUUID().slice(0, 8);
const userID = "01994a7d-0000-7000-8000-000000000001";
const otherUserID = crypto.randomUUID();
const projectID = crypto.randomUUID();
const personalWorkspaceID = crypto.randomUUID();
const otherPersonalWorkspaceID = crypto.randomUUID();
const firstAttempt = crypto.randomUUID();
const secondAttempt = crypto.randomUUID();
const otherPersonalAttempt = crypto.randomUUID();

async function expectRejected(
  transaction: postgres.TransactionSql,
  operation: (savepoint: postgres.TransactionSql) => Promise<void>,
  matches: (cause: Error & { code?: string }) => boolean,
  message: string,
) {
  try {
    await transaction.savepoint(operation);
  } catch (cause) {
    if (cause instanceof Error && matches(cause)) return;
    throw cause;
  }
  throw new Error(message);
}

try {
  const migrations = await client<Array<{ version: number }>>`
    SELECT version FROM factory.schema_migration ORDER BY version
  `;
  if (migrations.map(({ version }) => version).join(",") !== "0,1") {
    throw new Error("PostgreSQL clean baseline is not applied exactly once");
  }
  await client.begin(async (transaction) => {
    await transaction`
      INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${otherUserID}, 'Other Developer', ${`other-${suffix}@factory.local`}, true)
    `;
    await transaction`
      INSERT INTO factory.user_ui_preference(user_id, desktop_background_key)
      VALUES
        (${userID}, 'the-harvesters'),
        (${otherUserID}, 'mountainous-landscape')
      ON CONFLICT (user_id) DO UPDATE SET
        desktop_background_key = EXCLUDED.desktop_background_key,
        updated_at = now()
    `;
    await transaction`
      UPDATE factory.user_ui_preference
      SET desktop_background_key = 'river-landscape'
      WHERE user_id = ${userID}
    `;
    const preferences = await transaction<Array<{ userID: string; desktopBackgroundKey: string }>>`
      SELECT
        user_id AS "userID",
        desktop_background_key AS "desktopBackgroundKey"
      FROM factory.user_ui_preference
      WHERE user_id IN (${userID}, ${otherUserID})
      ORDER BY user_id
    `;
    const otherPreference = preferences.find((preference) => preference.userID === otherUserID);
    if (otherPreference?.desktopBackgroundKey !== "mountainous-landscape") {
      throw new Error("PostgreSQL did not isolate Desktop Background preferences by user");
    }
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          UPDATE factory.user_ui_preference
          SET desktop_background_key = 'https://example.invalid/background.jpg'
          WHERE user_id = ${userID}
        `;
      },
      (cause) => cause.code === "23514",
      "PostgreSQL allowed an arbitrary Desktop Background URL",
    );
    await transaction`
      INSERT INTO factory.project(
        id, slug, name, repository_url, default_branch, devcontainer_path, created_by
      ) VALUES (
        ${projectID}, ${`integration-${suffix}`}, 'Integration Project',
        'https://example.invalid/project.git', 'main', '.devcontainer/devcontainer.json', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.development_workspace(
        id, project_id, kind, owner_user_id, source_branch, source_revision,
        kubernetes_namespace, volume_name, created_by
      ) VALUES
        (
          ${personalWorkspaceID}, ${projectID}, 'personal', ${userID}, 'main', ${"9".repeat(40)},
          ${`factory-workspace-${suffix.padEnd(12, "0")}`}, 'workspace-data', ${userID}
        ),
        (
          ${otherPersonalWorkspaceID}, ${projectID}, 'personal', ${otherUserID}, 'main',
          ${"9".repeat(40)}, ${`factory-workspace-${suffix.padEnd(12, "1")}`},
          'workspace-data', ${otherUserID}
        )
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.development_workspace(
            id, project_id, kind, owner_user_id, source_branch, source_revision,
            kubernetes_namespace, volume_name, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${projectID}, 'personal', ${userID}, 'main',
            ${"9".repeat(40)}, ${`factory-workspace-${suffix.padEnd(12, "2")}`},
            'workspace-data', ${userID}
          )
        `;
      },
      (cause) => cause.code === "23505",
      "PostgreSQL allowed two Personal Development Workspaces for one developer and Project",
    );
    await transaction`
      INSERT INTO factory.runtime_attempt(
        id, project_id, workspace_id, generation, revision, state, kubernetes_namespace,
        kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
        create_intended_at, created_by
      ) VALUES (
        ${firstAttempt}, ${projectID}, ${personalWorkspaceID}, 1, ${"9".repeat(40)}, 'create-intended',
        ${`factory-runtime-${suffix}`}, 'runtime', ${"a".repeat(64)}, ${"c".repeat(64)},
        now(), ${userID}
      )
    `;
    await transaction`
      UPDATE factory.runtime_attempt SET state = 'cleanup-failed' WHERE id = ${firstAttempt}
    `;
    await transaction`
      UPDATE factory.runtime_attempt SET
        state = CASE WHEN state = 'stopping'
          THEN 'stopping'::factory.runtime_attempt_state
          ELSE 'stop-intended'::factory.runtime_attempt_state END,
        stop_intended_at = now()
      WHERE id = ${firstAttempt}
    `;
    await transaction`
      UPDATE factory.runtime_attempt SET state = 'cleanup-failed' WHERE id = ${firstAttempt}
    `;
    let revisionRewriteRejected = false;
    try {
      await transaction.savepoint(async (savepoint) => {
        await savepoint`
          UPDATE factory.runtime_attempt SET revision = ${"f".repeat(40)} WHERE id = ${firstAttempt}
        `;
      });
    } catch (cause) {
      revisionRewriteRejected =
        cause instanceof Error && cause.message.includes("create intent are immutable");
    }
    if (!revisionRewriteRejected)
      throw new Error("PostgreSQL allowed Runtime Attempt revision drift");
    let duplicateRejected = false;
    try {
      await transaction.savepoint(async (savepoint) => {
        await savepoint`
          INSERT INTO factory.runtime_attempt(
            id, project_id, workspace_id, generation, revision, state, kubernetes_namespace,
            kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
            create_intended_at, created_by
          ) VALUES (
            ${secondAttempt}, ${projectID}, ${personalWorkspaceID}, 2, ${"9".repeat(40)}, 'starting',
            ${`factory-runtime-${suffix}-two`}, 'runtime', ${"b".repeat(64)}, ${"d".repeat(64)},
            now(), ${userID}
          )
        `;
      });
    } catch (cause) {
      duplicateRejected = cause instanceof Error && "code" in cause && cause.code === "23505";
    }
    if (!duplicateRejected)
      throw new Error("PostgreSQL allowed two active Runtime Attempts for one Workspace");
    await transaction`
      INSERT INTO factory.runtime_attempt(
        id, project_id, workspace_id, generation, revision, state, kubernetes_namespace,
        kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
        create_intended_at, created_by
      ) VALUES (
        ${otherPersonalAttempt}, ${projectID}, ${otherPersonalWorkspaceID}, 1,
        ${"9".repeat(40)}, 'create-intended', ${`factory-runtime-${suffix}-other`}, 'runtime',
        ${"7".repeat(64)}, ${"8".repeat(64)}, now(), ${otherUserID}
      )
    `;

    const secondProjectID = crypto.randomUUID();
    const ticketID = crypto.randomUUID();
    const otherTicketID = crypto.randomUUID();
    const revisionID = crypto.randomUUID();
    const otherRevisionID = crypto.randomUUID();
    const mismatchedRevisionID = crypto.randomUUID();
    const approvalID = crypto.randomUUID();
    const otherApprovalID = crypto.randomUUID();
    const changeID = crypto.randomUUID();
    const ticketWorkspaceID = crypto.randomUUID();
    const branchOperationID = crypto.randomUUID();
    const changeAttemptID = crypto.randomUUID();
    const canonicalContent = JSON.stringify({ summary: "PostgreSQL integration requirement" });
    const otherCanonicalContent = JSON.stringify({ summary: "Other requirement" });
    const mismatchedCanonicalContent = JSON.stringify({ summary: "Mismatched requirement" });
    const contentDigest = createHash("sha256").update(canonicalContent).digest("hex");
    const otherContentDigest = createHash("sha256").update(otherCanonicalContent).digest("hex");
    const mismatchedContentDigest = createHash("sha256")
      .update(mismatchedCanonicalContent)
      .digest("hex");
    const baseSHA = "e".repeat(40);
    const branchName = `factory/change-${suffix.padEnd(12, "0")}`;

    await transaction`
      INSERT INTO factory.project(
        id, slug, name, repository_url, default_branch, devcontainer_path, created_by
      ) VALUES (
        ${secondProjectID}, ${`integration-other-${suffix}`}, 'Other Integration Project',
        'https://example.invalid/other.git', 'main', '.devcontainer/devcontainer.json', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.ticket(id, project_id, title, created_by)
      VALUES
        (${ticketID}, ${projectID}, 'Integration Ticket', ${userID}),
        (${otherTicketID}, ${secondProjectID}, 'Other Integration Ticket', ${userID})
    `;
    await transaction`
      INSERT INTO factory.requirement_revision(
        id, ticket_id, ordinal, canonical_content, content_digest, created_by
      ) VALUES
        (${revisionID}, ${ticketID}, 1, ${canonicalContent}, ${contentDigest}, ${userID}),
        (${otherRevisionID}, ${otherTicketID}, 1, ${otherCanonicalContent}, ${otherContentDigest}, ${userID}),
        (${mismatchedRevisionID}, ${otherTicketID}, 2, ${mismatchedCanonicalContent}, ${mismatchedContentDigest}, ${userID})
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          UPDATE factory.requirement_revision SET canonical_content = '{"summary":"rewritten"}'
          WHERE id = ${revisionID}
        `;
      },
      (cause) => cause.message.includes("requirement_revision is immutable"),
      "PostgreSQL allowed Requirement Revision mutation",
    );
    await transaction`
      INSERT INTO factory.requirement_approval(
        id, ticket_id, requirement_revision_id, approved_by
      ) VALUES (${otherApprovalID}, ${otherTicketID}, ${otherRevisionID}, ${userID})
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.requirement_approval(
            id, ticket_id, requirement_revision_id, approved_by
          ) VALUES (${crypto.randomUUID()}, ${ticketID}, ${mismatchedRevisionID}, ${userID})
        `;
      },
      (cause) => cause.code === "23503",
      "PostgreSQL allowed Approval and Requirement Revision from different Tickets",
    );
    await transaction`
      INSERT INTO factory.requirement_approval(
        id, ticket_id, requirement_revision_id, approved_by
      ) VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID})
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          DELETE FROM factory.requirement_approval WHERE id = ${approvalID}
        `;
      },
      (cause) => cause.message.includes("requirement_approval is immutable"),
      "PostgreSQL allowed Requirement Approval deletion",
    );
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.change(
            id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
            state, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${secondProjectID}, ${ticketID}, ${approvalID},
            'factory/change-111111111111', ${baseSHA}, 'branch-pending', ${userID}
          )
        `;
      },
      (cause) => cause.code === "23503",
      "PostgreSQL allowed Change and Ticket from different Projects",
    );
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.change(
            id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
            state, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${projectID}, ${ticketID}, ${otherApprovalID},
            'factory/change-222222222222', ${baseSHA}, 'branch-pending', ${userID}
          )
        `;
      },
      (cause) => cause.code === "23503",
      "PostgreSQL allowed Change and Approval from different Tickets",
    );
    await transaction`
      INSERT INTO factory.change(
        id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
        state, created_by
      ) VALUES (
        ${changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${branchName}, ${baseSHA},
        'branch-pending', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.development_workspace(
        id, project_id, kind, ticket_id, change_id, source_branch, source_revision,
        kubernetes_namespace, volume_name, created_by
      ) VALUES (
        ${ticketWorkspaceID}, ${projectID}, 'ticket', ${ticketID}, ${changeID}, ${branchName},
        ${baseSHA}, ${`factory-workspace-${suffix.padEnd(12, "3")}`}, 'workspace-data', ${userID}
      )
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.development_workspace(
            id, project_id, kind, ticket_id, change_id, source_branch, source_revision,
            kubernetes_namespace, volume_name, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${projectID}, 'ticket', ${ticketID}, ${changeID},
            ${branchName}, ${baseSHA}, ${`factory-workspace-${suffix.padEnd(12, "4")}`},
            'workspace-data', ${userID}
          )
        `;
      },
      (cause) => cause.code === "23505",
      "PostgreSQL allowed two Ticket Workspaces for one Ticket",
    );
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.change(
            id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
            state, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${projectID}, ${ticketID}, ${approvalID},
            'factory/change-333333333333', ${baseSHA}, 'branch-pending', ${userID}
          )
        `;
      },
      (cause) => cause.code === "23505",
      "PostgreSQL allowed a second active Change for one Ticket",
    );
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.branch_create_operation(
            id, change_id, repository_owner, repository_name, branch_name, start_sha,
            idempotency_key
          ) VALUES (
            ${crypto.randomUUID()}, ${changeID}, 'factory', 'fixture', ${branchName},
            ${"f".repeat(40)}, ${`integration:${suffix}:mismatch`}
          )
        `;
      },
      (cause) => cause.code === "23503",
      "PostgreSQL allowed branch intent to drift from its Change base SHA",
    );
    await transaction`
      INSERT INTO factory.branch_create_operation(
        id, change_id, repository_owner, repository_name, branch_name, start_sha,
        idempotency_key, state, lease_owner, lease_expires_at
      ) VALUES (
        ${branchOperationID}, ${changeID}, 'factory', 'fixture', ${branchName}, ${baseSHA},
        ${`integration:${suffix}`}, 'executing', 'stale-worker', now() - interval '1 second'
      )
    `;
    const reclaimed = await transaction`
      UPDATE factory.branch_create_operation SET lease_owner = 'recovery-worker',
        lease_generation = lease_generation + 1, lease_expires_at = now() + interval '30 seconds'
      WHERE id = ${branchOperationID} AND state = 'executing' AND lease_expires_at < now()
      RETURNING id
    `;
    if (reclaimed.length !== 1)
      throw new Error("PostgreSQL did not reclaim an expired branch lease");
    await transaction`
      UPDATE factory.branch_create_operation SET state = 'succeeded', observed_head_sha = ${baseSHA},
        lease_owner = NULL, lease_expires_at = NULL, completed_at = now()
      WHERE id = ${branchOperationID}
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          UPDATE factory.branch_create_operation SET last_error = 'rewrite'
          WHERE id = ${branchOperationID}
        `;
      },
      (cause) => cause.message.includes("terminal result is immutable"),
      "PostgreSQL allowed terminal branch result mutation",
    );
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.runtime_attempt(
            id, project_id, change_id, workspace_id, generation, revision, state, kubernetes_namespace,
            kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
            create_intended_at, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${secondProjectID}, ${changeID}, ${ticketWorkspaceID}, 1,
            ${baseSHA}, 'create-intended',
            ${`factory-runtime-${suffix}-wrong`}, 'runtime', ${"1".repeat(64)}, ${"2".repeat(64)},
            now(), ${userID}
          )
        `;
      },
      (cause) => cause.code === "23503",
      "PostgreSQL allowed a Change Runtime Attempt in another Project",
    );
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.runtime_attempt(
            id, project_id, change_id, workspace_id, generation, revision, state, kubernetes_namespace,
            kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
            create_intended_at, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${projectID}, ${changeID}, ${ticketWorkspaceID}, 1,
            ${"f".repeat(40)},
            'create-intended', ${`factory-runtime-${suffix}-wrong-revision`}, 'runtime',
            ${"1".repeat(64)}, ${"2".repeat(64)}, now(), ${userID}
          )
        `;
      },
      (cause) => cause.code === "23503",
      "PostgreSQL allowed a Change Runtime Attempt at a different revision",
    );
    await transaction`
      INSERT INTO factory.runtime_attempt(
        id, project_id, change_id, workspace_id, generation, revision, state, kubernetes_namespace,
        kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
        create_intended_at, created_by
      ) VALUES (
        ${changeAttemptID}, ${projectID}, ${changeID}, ${ticketWorkspaceID}, 1, ${baseSHA},
        'create-intended',
        ${`factory-runtime-${suffix}-change`}, 'runtime', ${"3".repeat(64)}, ${"4".repeat(64)},
        now(), ${userID}
      )
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.runtime_attempt(
            id, project_id, change_id, workspace_id, generation, revision, state, kubernetes_namespace,
            kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
            create_intended_at, created_by
          ) VALUES (
            ${crypto.randomUUID()}, ${projectID}, ${changeID}, ${ticketWorkspaceID}, 2, ${baseSHA},
            'starting',
            ${`factory-runtime-${suffix}-change-two`}, 'runtime', ${"5".repeat(64)},
            ${"6".repeat(64)}, now(), ${userID}
          )
        `;
      },
      (cause) => cause.code === "23505",
      "PostgreSQL allowed two active Runtime Attempts for one Change",
    );
    const candidateSHA = "d".repeat(40);
    const verificationID = crypto.randomUUID();
    await transaction`
      INSERT INTO factory.pull_request_operation(
        id, change_id, repository_owner, repository_name, base_branch, head_branch,
        first_head_sha, title, body, idempotency_key, state,
        pull_request_number, pull_request_url, completed_at
      ) VALUES (
        ${crypto.randomUUID()}, ${changeID}, 'factory', 'fixture', 'main', ${branchName},
        ${candidateSHA}, 'Integration Ticket', '', ${`integration:${suffix}:pr`}, 'succeeded',
        1, 'https://example.invalid/pr/1', now()
      )
    `;
    await transaction`
      INSERT INTO factory.verification(
        id, change_id, commit_sha, pull_request_number, action_run_id, action_run_url,
        runner_name, state, summary, completed_at, created_by
      ) VALUES (
        ${verificationID}, ${changeID}, ${candidateSHA}, 1, 9,
        'https://example.invalid/actions/9', 'factory-integration', 'succeeded',
        'passed', now(), ${userID}
      )
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.delivery_approval(
            id, change_id, verification_id, commit_sha, approved_by
          ) VALUES (
            ${crypto.randomUUID()}, ${changeID}, ${verificationID}, ${"c".repeat(40)}, ${userID}
          )
        `;
      },
      (cause) => cause.code === "23503",
      "PostgreSQL allowed Delivery Approval to name a different commit",
    );
    const deliveryApprovalID = crypto.randomUUID();
    await transaction`
      INSERT INTO factory.delivery_approval(
        id, change_id, verification_id, commit_sha, approved_by
      ) VALUES (
        ${deliveryApprovalID}, ${changeID}, ${verificationID}, ${candidateSHA}, ${userID}
      )
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          DELETE FROM factory.delivery_approval WHERE id = ${deliveryApprovalID}
        `;
      },
      (cause) => cause.message.includes("delivery_approval is immutable"),
      "PostgreSQL allowed Delivery Approval deletion",
    );

    const generationID = crypto.randomUUID();
    const pageID = crypto.randomUUID();
    const knowledgeRevisionID = crypto.randomUUID();
    const sourceCommitSHA = "a".repeat(40);
    const citations = JSON.stringify([{ path: "README.md", commitSha: sourceCommitSHA }]);
    await transaction`
      INSERT INTO factory.knowledge_generation(
        id, project_id, source_commit_sha, state, page_count, conflict_count,
        created_by, completed_at
      ) VALUES (
        ${generationID}, ${projectID}, ${sourceCommitSHA}, 'succeeded', 1, 0,
        ${userID}, now()
      )
    `;
    await transaction`
      INSERT INTO factory.knowledge_page(
        id, project_id, slug, title, current_body, generated_body,
        source_commit_sha, citations, created_by
      ) VALUES (
        ${pageID}, ${projectID}, 'overview', 'Overview', '# Overview', '# Overview',
        ${sourceCommitSHA}, ${citations}::jsonb, ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.knowledge_revision(
        id, page_id, ordinal, kind, title, body, generated_body,
        source_commit_sha, citations, generation_id, created_by
      ) VALUES (
        ${knowledgeRevisionID}, ${pageID}, 1, 'generated', 'Overview', '# Overview',
        '# Overview', ${sourceCommitSHA}, ${citations}::jsonb, ${generationID}, ${userID}
      )
    `;
    await transaction`
      UPDATE factory.knowledge_page SET current_revision_id = ${knowledgeRevisionID}
      WHERE id = ${pageID}
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          UPDATE factory.knowledge_revision SET body = '# Rewritten'
          WHERE id = ${knowledgeRevisionID}
        `;
      },
      (cause) => cause.message.includes("knowledge_revision is immutable"),
      "PostgreSQL allowed Knowledge Revision mutation",
    );
    const activeGenerationID = crypto.randomUUID();
    await transaction`
      INSERT INTO factory.knowledge_generation(
        id, project_id, source_commit_sha, created_by
      ) VALUES (${activeGenerationID}, ${projectID}, ${sourceCommitSHA}, ${userID})
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          INSERT INTO factory.knowledge_generation(
            id, project_id, source_commit_sha, created_by
          ) VALUES (${crypto.randomUUID()}, ${projectID}, ${sourceCommitSHA}, ${userID})
        `;
      },
      (cause) => cause.code === "23505",
      "PostgreSQL allowed two active Knowledge Generations for one Project",
    );
    const documentOperationID = crypto.randomUUID();
    const documentBody = "# Updated documentation\n";
    const documentDigest = createHash("sha256").update(documentBody).digest("hex");
    await transaction`
      INSERT INTO factory.change_commit_operation(
        id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
        commit_message, idempotency_key, state, source, repository_path,
        repository_blob_sha, repository_content, content_digest, created_by
      ) VALUES (
        ${documentOperationID}, ${changeID}, NULL, 1, ${branchName}, ${baseSHA},
        'Update README.md', ${`integration:${suffix}:repository-document`},
        'push-intended', 'repository-document', 'README.md', ${"b".repeat(40)},
        ${documentBody}, ${documentDigest}, ${userID}
      )
    `;
    const conversationProjectID = crypto.randomUUID();
    const conversationID = crypto.randomUUID();
    const conversationEntryID = crypto.randomUUID();
    await transaction`
      INSERT INTO factory.project(
        id, slug, name, repository_url, default_branch, devcontainer_path, created_by
      ) VALUES (
        ${conversationProjectID}, ${`integration-conversation-${suffix}`},
        'Conversation Project', 'https://example.invalid/conversation.git', 'main',
        '.devcontainer/devcontainer.json', ${userID}
      )
    `;
    await transaction`
      INSERT INTO factory.ticket_conversation(id, project_id, created_by)
      VALUES (${conversationID}, ${conversationProjectID}, ${userID})
    `;
    await transaction`
      INSERT INTO factory.conversation_entry(
        id, conversation_id, ordinal, kind, actor, mode, body, created_by
      ) VALUES (
        ${conversationEntryID}, ${conversationID}, 1, 'user-message', 'user', 'investigate',
        'Immutable conversation entry', ${userID}
      )
    `;
    await expectRejected(
      transaction,
      async (savepoint) => {
        await savepoint`
          UPDATE factory.conversation_entry SET body = 'Rewritten'
          WHERE id = ${conversationEntryID}
        `;
      },
      (cause) => cause.message.includes("Conversation Entries are immutable"),
      "PostgreSQL allowed Conversation Entry mutation",
    );
    await transaction`DELETE FROM factory.project WHERE id = ${conversationProjectID}`;
    const deletedEntries = await transaction<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM factory.conversation_entry
      WHERE id = ${conversationEntryID}
    `;
    if (deletedEntries[0]?.count !== 0) {
      throw new Error("PostgreSQL did not cascade Project Conversation cleanup");
    }
    throw new Error("ROLLBACK_INTEGRATION_PROBE");
  });
} catch (cause) {
  if (!(cause instanceof Error) || cause.message !== "ROLLBACK_INTEGRATION_PROBE") throw cause;
  const concurrencyProjectID = crypto.randomUUID();
  const concurrencyTicketID = crypto.randomUUID();
  try {
    await client`
      INSERT INTO factory.project(
        id, slug, name, repository_url, default_branch, devcontainer_path, created_by
      ) VALUES (
        ${concurrencyProjectID}, ${`integration-cas-${suffix}`}, 'Concurrency Project',
        'https://example.invalid/concurrency.git', 'main', '.devcontainer/devcontainer.json',
        ${userID}
      )
    `;
    await client`
      INSERT INTO factory.ticket(id, project_id, title, created_by)
      VALUES (${concurrencyTicketID}, ${concurrencyProjectID}, 'Concurrent Ticket', ${userID})
    `;
    const [first, second] = await Promise.all([
      client`
        UPDATE factory.ticket SET description = 'first', version = version + 1
        WHERE id = ${concurrencyTicketID} AND project_id = ${concurrencyProjectID} AND version = 1
        RETURNING id
      `,
      client`
        UPDATE factory.ticket SET description = 'second', version = version + 1
        WHERE id = ${concurrencyTicketID} AND project_id = ${concurrencyProjectID} AND version = 1
        RETURNING id
      `,
    ]);
    if (first.length + second.length !== 1) {
      throw new Error("PostgreSQL did not serialize concurrent Ticket compare-and-swap updates");
    }
  } finally {
    await client`DELETE FROM factory.ticket WHERE id = ${concurrencyTicketID}`;
    await client`DELETE FROM factory.project WHERE id = ${concurrencyProjectID}`;
  }
} finally {
  await client.end();
}

console.log("PostgreSQL clean baseline invariants passed");
