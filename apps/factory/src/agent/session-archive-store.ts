import { isDeepStrictEqual } from "node:util";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createPrivateObjects, type PrivateObjects } from "../storage/objects";
import { projectMessages } from "./message-projection";
import type { createOpenCodeClient } from "./opencode-client";
import { readNativeSessionArchive, saveNativeSessionArchive } from "./session-archive";

type Database = ReturnType<typeof createDatabase>;
type Pending = {
  turnID: string;
  runtimeAttemptID: string;
  sessionID: string;
  promptID: string;
  source: Record<string, unknown>;
};

export function createSessionArchives(
  database: Database,
  client: (attemptID: string) => ReturnType<typeof createOpenCodeClient>,
  objects: PrivateObjects = createPrivateObjects(),
) {
  let saving: Promise<void> | undefined;
  async function enqueue() {
    // Derive identity and approved Source references from authoritative storage,
    // not caller supplied values. This is read-only with respect to execution.
    await database.client`INSERT INTO factory.session_archive(turn_id,runtime_attempt_id,session_id,prompt_id,source_refs)
      SELECT turn.id,intent.runtime_attempt_id,intent.session_id,intent.prompt_id,
        jsonb_build_object('projectID',turn.project_id,'workspaceID',attempt.workspace_id,
          'revision',attempt.revision,'requirementApprovalID',change.requirement_approval_id,
          'branch',change.branch_name,'workerID',attempt.factorybox_worker_id,
          'admissionID',attempt.factorybox_admission_id,
          'runtimeArtifacts',COALESCE(artifact.runtime_host_image,provision.intent#>>'{configuration,workloadImage}'),
          'environment',environment.environment,'environmentVersion',environment.version,
          'requirementRevisionID',approval.requirement_revision_id)
        || CASE WHEN attempt.substrate THEN jsonb_build_object(
          'nativeRuntime',jsonb_build_object('engine','substrate','profile',binding.intent->'profile',
            'runtime',binding.intent->'runtime','actorUID',binding.actor_uid,
            'templateUID',binding.intent->'templateUID','templateSHA256',binding.intent->'templateSHA256'),
          'lastConfirmedSource',CASE WHEN source.checkpoint IS NOT NULL THEN jsonb_build_object(
            'id',source.checkpoint->'id','generation',source.checkpoint->'generation',
            'writerEpoch',source.checkpoint->'writerEpoch','bundleSHA256',source.checkpoint#>'{bundle,sha256}',
            'manifestKey','workspace-source/v1/'||attempt.workspace_id::text||'/'||(source.checkpoint->>'id')||'/manifest.json',
            'relationship','last-confirmed-generation-not-turn-atomic') ELSE NULL END)
          ELSE '{}'::jsonb END
      FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
      JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
      JOIN factory.change change ON change.id=turn.change_id AND change.id=attempt.change_id
      JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
       LEFT JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
       LEFT JOIN factory.runtime_environment_intent environment ON environment.runtime_attempt_id=attempt.id
       LEFT JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
       LEFT JOIN factory.substrate_workspace provision ON provision.workspace_id=attempt.workspace_id
       LEFT JOIN factory.substrate_source source ON source.workspace_id=attempt.workspace_id
      WHERE turn.state='completed'
        AND NOT EXISTS(SELECT 1 FROM factory.session_archive archive WHERE archive.turn_id=turn.id)
      ORDER BY turn.created_at,turn.id LIMIT 16 ON CONFLICT DO NOTHING`;
  }
  async function save() {
    const sql = database.coordination();
    try {
      const [lock] = await sql<
        { granted: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext('factory-session-archive-save')) AS granted`;
      if (!lock?.granted) return;
      await enqueue();
      const pending = await sql<Pending[]>`SELECT archive.turn_id AS "turnID",
        archive.runtime_attempt_id AS "runtimeAttemptID",archive.session_id AS "sessionID",
        archive.prompt_id AS "promptID",archive.source_refs AS source
        FROM factory.session_archive archive JOIN factory.runtime_attempt attempt ON attempt.id=archive.runtime_attempt_id
        WHERE archive.state<>'saved' AND archive.retry_after<=now() AND attempt.state='ready'
        ORDER BY archive.created_at,archive.turn_id LIMIT 4`;
      for (const checkpoint of pending) {
        await sql`UPDATE factory.session_archive SET attempts=attempts+1,retry_after=now()+interval '1 minute'
          WHERE turn_id=${checkpoint.turnID} AND state<>'saved'`;
        try {
          const saved = await saveNativeSessionArchive(
            client(checkpoint.runtimeAttemptID),
            objects,
            checkpoint,
            checkpoint.source,
          );
          await sql`UPDATE factory.session_archive SET state='saved',manifest_key=${saved.key},
            manifest_sha256=${saved.manifestSHA256},through_message_id=${saved.manifest.checkpoint.throughMessageID},
            producer_version=${saved.manifest.producer.version},summary=${JSON.stringify(saved.summary)}::text::jsonb,
            last_error=NULL,saved_at=now() WHERE turn_id=${checkpoint.turnID} AND state<>'saved'`;
        } catch {
          // Neither native errors nor object-store errors may leak transcript
          // bytes, credentials or signed URLs into product diagnostics.
          await sql`UPDATE factory.session_archive SET state='failed',
            retry_after=now()+interval '1 minute',
            last_error='Transcript archive save could not be confirmed; retry pending. Recovery uses the last successfully saved checkpoint.'
            WHERE turn_id=${checkpoint.turnID} AND state<>'saved'`;
          console.warn("[factory] native transcript archive save failed", {
            turnID: checkpoint.turnID,
          });
        }
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  return {
    // Called only after the conversation owner authenticated its Project and
    // selected this exact archived context. No wake, native request or import.
    // A previous checkpoint cannot stand in for the captured terminal turn, and
    // separate implementation/review Sessions still require their own history.
    async retainedMessages(contextID: string) {
      const [saved] = await database.client<
        (Pending & { changeID: string; key: string; sha256: string; throughMessageID: string })[]
      >`SELECT archive.turn_id AS "turnID",archive.runtime_attempt_id AS "runtimeAttemptID",
          archive.session_id AS "sessionID",archive.prompt_id AS "promptID",archive.source_refs AS source,
          archive.manifest_key AS key,archive.manifest_sha256 AS sha256,
          archive.through_message_id AS "throughMessageID",context.change_id AS "changeID"
        FROM factory.conversation_context context
        JOIN factory.agent_turn turn ON turn.id=(context.archived_session->>'active_turn_id')::uuid
          AND turn.change_id=context.change_id AND turn.state='completed'
          AND turn.input->>'contextId' IS NOT DISTINCT FROM CASE WHEN context.original THEN NULL ELSE context.id::text END
        JOIN factory.session_archive archive ON archive.turn_id=turn.id AND archive.state='saved'
          AND archive.session_id=context.native_session_id
          AND archive.session_id=context.archived_session->>'opencode_session_id'
          AND archive.runtime_attempt_id=(context.archived_session->>'runtime_attempt_id')::uuid
        WHERE context.id=${contextID} AND context.kind='coding' AND context.archived_session IS NOT NULL`;
      if (!saved) return;
      const { manifest, native } = await readNativeSessionArchive(objects, saved.key, saved.sha256);
      if (
        !isDeepStrictEqual(manifest.checkpoint, {
          turnID: saved.turnID,
          runtimeAttemptID: saved.runtimeAttemptID,
          sessionID: saved.sessionID,
          promptID: saved.promptID,
          throughMessageID: saved.throughMessageID,
        }) ||
        !isDeepStrictEqual(manifest.source, saved.source)
      )
        throw new Error("Native transcript checkpoint differs from its retained context");
      const inputs = await database.client<{ promptID: string; text: string | null }[]>`
        SELECT intent.prompt_id AS "promptID",CASE WHEN turn.input->>'kind'='change-start'
          THEN NULL ELSE turn.input->>'text' END AS text
        FROM factory.change_agent_turn_intent intent JOIN factory.agent_turn turn ON turn.id=intent.turn_id
        WHERE intent.change_id=${saved.changeID} AND intent.session_id=${saved.sessionID}`;
      return {
        messages: projectMessages(
          { data: native.messages.toReversed() },
          new Map(inputs.map((input) => [input.promptID, input.text])),
        ),
        messagesAvailable: true,
      };
    },
    // All failures, including unavailable PostgreSQL, remain independent of
    // authoritative turn settlement and external product mutation persistence.
    savePending() {
      saving ??= save()
        .catch(() => {
          console.warn("[factory] transcript archive reconciliation unavailable");
        })
        .finally(() => {
          saving = undefined;
        });
      return saving;
    },
    async status(changeID: string) {
      const latest = await database.client<
        { turnID: string; state: string; attempts: number; lastError: string | null }[]
      >`
        SELECT archive.turn_id AS "turnID",archive.state,archive.attempts,archive.last_error AS "lastError"
        FROM factory.session_archive archive JOIN factory.agent_turn turn ON turn.id=archive.turn_id
        WHERE turn.change_id=${changeID} ORDER BY turn.created_at DESC,turn.id DESC LIMIT 1`;
      const [checkpoint] = await database.client<
        {
          turnID: string;
          sessionID: string;
          runtimeAttemptID: string;
          savedAt: string;
          throughMessageID: string;
        }[]
      >`
        SELECT archive.turn_id AS "turnID",archive.session_id AS "sessionID",
          archive.runtime_attempt_id AS "runtimeAttemptID",archive.saved_at::text AS "savedAt",
          archive.through_message_id AS "throughMessageID"
        FROM factory.session_archive archive JOIN factory.agent_turn turn ON turn.id=archive.turn_id
        WHERE turn.change_id=${changeID} AND archive.state='saved' ORDER BY turn.created_at DESC,turn.id DESC LIMIT 1`;
      return {
        latest: latest[0] ?? null,
        lastSaved: checkpoint ?? null,
        recovery:
          "Last successfully saved completed-turn transcript only; unsaved work, external files and execution state may be unavailable.",
      };
    },
  };
}
