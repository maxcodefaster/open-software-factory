import { expect, test } from "bun:test";
import { substrateTemplateSHA256 } from "../../apps/factory/src/runtime/substrate";
import { substrateWorkspaceGrantIn } from "../../apps/factory/src/runtime/substrate-grant";
import {
  createSubstrateWorkspaces,
  type SubstrateWorkspaceConfiguration,
} from "../../apps/factory/src/runtime/substrate-workspaces";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  type NativeActor,
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { substrateFixture } from "../fixtures/substrate";

test.each(["ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING"] as const)(
  "Workspace owner recovery skips a revoked %s and continues the next original allocation",
  async (firstState) => {
    const f = await substrateFixture();
    const secondUserID = crypto.randomUUID();
    const secondWorkspaceID = personalWorkspaceIdentity(f.projectID, secondUserID).workspaceID;
    const secondAttemptID = runtimeIdentity(secondWorkspaceID, 1).attemptID;
    const secondAtespace = `fa-${secondAttemptID.replaceAll("-", "")}`;
    type Resources = {
      attemptID: string;
      space: typeof f.space;
      template: typeof f.template;
      actor?: NativeActor;
      creates: number;
      resumes: number;
    };
    type Policy = {
      metadata: typeof f.space.metadata;
      bindings: Array<{ role: string; members: string[] }>;
    };
    const resources = new Map<string, Resources>([
      [
        f.atespace,
        { attemptID: f.attemptID, space: f.space, template: f.template, creates: 0, resumes: 0 },
      ],
    ]);
    const policies = new Map<string, Policy>();
    const recoveryReads = new Set<string>();
    let recovering = false;
    const facts = () => f.database.client`
    SELECT runtime_attempt_id::text AS "attemptID",action,origin_key,origin_checkpoint,
      actor_uid::text,native_version,stop_id::text,intended_at::text,attempted_at::text,
      outcome,outcome_recorded_at::text
    FROM factory.substrate_actor_rpc
    WHERE runtime_attempt_id IN (${f.attemptID},${secondAttemptID})
    ORDER BY runtime_attempt_id,action,origin_key`;
    const call: SubstrateCall = async (method, request) => {
      const input = request as {
        atespace?: { name: string };
        actorTemplate?: { atespace: string };
        actor?: { atespace?: string; metadata?: { atespace: string } };
      };
      const atespace =
        input.atespace?.name ??
        input.actorTemplate?.atespace ??
        input.actor?.atespace ??
        input.actor?.metadata?.atespace;
      const owned = resources.get(atespace ?? "");
      if (!owned || !atespace) throw Error(`Uncommissioned native resource for ${method}`);
      if (method === "GetAtespace") return structuredClone(owned.space);
      if (method === "GetActorTemplate") return structuredClone(owned.template);
      if (method === "GetAtespaceAccessPolicy") {
        const policy = policies.get(atespace);
        if (!policy) throw Error("Owned access policy missing");
        return structuredClone(policy);
      }
      if (method === "GetActorEgressPolicy")
        return {
          metadata: { ...owned.space.metadata, name: "default", atespace },
          rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
        };
      if (method === "GetActor") {
        if (recovering) recoveryReads.add(atespace);
        if (!owned.actor) throw new SubstrateRPCError("NotFound", "Owned Actor absent");
        return structuredClone(owned.actor);
      }
      if (method === "CreateActor") {
        owned.creates++;
        owned.actor = nativeActor.parse({
          metadata: {
            name: `runtime-${owned.attemptID.replaceAll("-", "")}`,
            atespace,
            uid: crypto.randomUUID(),
            version: "1",
            createTime: new Date().toISOString(),
          },
          actorTemplate: { atespace, name: "runtime" },
          workerSelector: { matchLabels: f.config.workerSelector },
          status: { state: "ACTOR_STATE_SUSPENDED" },
        });
        return structuredClone(owned.actor);
      }
      if (method === "ResumeActor" && owned.actor) {
        const [dispatch] = (await facts()).filter((row) => row["attemptID"] === owned.attemptID);
        expect(dispatch).toMatchObject({
          action: "resume",
          origin_key: "initial",
          origin_checkpoint: null,
          actor_uid: owned.actor.metadata.uid,
          stop_id: null,
          outcome: null,
        });
        expect(dispatch?.["attempted_at"]).not.toBeNull();
        owned.resumes++;
        owned.actor.metadata.version = String(BigInt(owned.actor.metadata.version) + 1n);
        owned.actor.status.workerAssignment = { sandboxRuntime: f.config.runtime };
        if (owned.actor.status.state === "ACTOR_STATE_SUSPENDED") {
          owned.actor.status.state = "ACTOR_STATE_RESUMING";
          throw new SubstrateRPCError("Canceled", "Owned original Resume interrupted");
        }
        expect(recovering).toBe(true);
        expect(atespace).toBe(secondAtespace);
        expect(owned.actor.status.state).toBe("ACTOR_STATE_RESUMING");
        owned.actor.status.state = "ACTOR_STATE_RUNNING";
        return { actor: structuredClone(owned.actor) };
      }
      throw Error(`Uncommissioned native operation ${method}`);
    };
    try {
      const runtime = await f.controller(call);
      await expect(runtime.start(f.projectID, f.userID)).rejects.toThrow(
        "Owned original Resume interrupted",
      );
      const [seed] = await f.database.client<
        Array<{
          intent: { configuration: SubstrateWorkspaceConfiguration; templateSHA256: string };
          policy: Policy;
        }>
      >`SELECT intent,policy FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID} AND generation=1`;
      if (!seed) throw Error("Original Workspace provisioning missing");
      policies.set(f.atespace, seed.policy);
      const createdAt = new Date().toISOString();
      const secondSpace = {
        metadata: {
          ...f.space.metadata,
          name: secondAtespace,
          uid: crypto.randomUUID(),
          createTime: createdAt,
        },
      };
      const secondTemplate = {
        ...structuredClone(f.template),
        metadata: {
          ...f.template.metadata,
          atespace: secondAtespace,
          uid: crypto.randomUUID(),
          createTime: createdAt,
        },
      };
      const secondPolicy = {
        ...structuredClone(seed.policy),
        metadata: { ...seed.policy.metadata, uid: crypto.randomUUID(), createTime: createdAt },
      };
      resources.set(secondAtespace, {
        attemptID: secondAttemptID,
        space: secondSpace,
        template: secondTemplate,
        creates: 0,
        resumes: 0,
      });
      policies.set(secondAtespace, secondPolicy);
      const secondIntent = {
        ...seed.intent,
        templateSHA256: substrateTemplateSHA256(secondTemplate),
      };
      await f.database.client.begin(async (sql) => {
        await sql`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${secondUserID},'Second native owner',${`${secondUserID}@factory.local`},true)`;
        await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${f.projectID},${secondUserID},'developer',${f.userID})`;
        await sql`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
        SELECT ${secondWorkspaceID},project_id,'personal',${secondUserID},source_branch,source_revision,${secondUserID}
        FROM factory.development_workspace WHERE id=${f.workspaceID}`;
        await sql`INSERT INTO factory.substrate_workspace(workspace_id,generation,intent,
        atespace_attempted_at,atespace,policy_attempted_at,policy,template_attempted_at,template)
        VALUES(${secondWorkspaceID},1,${JSON.stringify(secondIntent)}::text::jsonb,
          ${createdAt},${JSON.stringify(secondSpace)}::text::jsonb,
          ${createdAt},${JSON.stringify(secondPolicy)}::text::jsonb,
          ${createdAt},${JSON.stringify(secondTemplate)}::text::jsonb)`;
      });
      const workspaces = createSubstrateWorkspaces(
        f.database,
        f.hub,
        "owned-native-secret",
        seed.intent.configuration,
        call,
        call,
      );
      await expect(workspaces.start(secondUserID)).rejects.toThrow(
        "Owned original Resume interrupted",
      );
      for (const owned of resources.values()) {
        expect(owned.actor?.status.state).toBe("ACTOR_STATE_RESUMING");
        expect({ creates: owned.creates, resumes: owned.resumes }).toEqual({
          creates: 1,
          resumes: 1,
        });
      }
      const firstActor = resources.get(f.atespace)?.actor;
      if (!firstActor) throw Error("Original first Actor missing");
      if (firstState === "ACTOR_STATE_RUNNING") {
        firstActor.metadata.version = String(BigInt(firstActor.metadata.version) + 1n);
        firstActor.status.state = firstState;
      }
      const originalFacts = await facts();
      expect(originalFacts).toHaveLength(2);
      const ordered = await f.database.client`
      SELECT id::text,state,stop_intended_at FROM factory.runtime_attempt
      WHERE project_id=${f.projectID} ORDER BY created_at,id`;
      expect(ordered.map((row) => row["id"])).toEqual([f.attemptID, secondAttemptID]);
      for (const attempt of ordered)
        expect(attempt).toMatchObject({ state: "starting", stop_intended_at: null });
      await f.database.client`DELETE FROM factory.project_membership
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      await expect(
        f.database.client.begin((sql) =>
          substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, f.userID, true),
        ),
      ).rejects.toThrow();
      await expect(
        f.database.client.begin((sql) =>
          substrateWorkspaceGrantIn(f.database, sql, secondWorkspaceID, secondUserID, true),
        ),
      ).resolves.toMatchObject({ projectID: f.projectID, ownerID: secondUserID });

      // Exercise the real same-Project owner loop, with the revoked owner first.
      // Refusing that original allocation must not strand the next eligible one.
      recovering = true;
      await workspaces.recover();
      expect([...recoveryReads]).toEqual([f.atespace, secondAtespace]);
      const first = resources.get(f.atespace);
      const second = resources.get(secondAtespace);
      expect({ creates: first?.creates, resumes: first?.resumes }).toEqual({
        creates: 1,
        resumes: 1,
      });
      expect(first?.actor?.status.state).toBe(firstState);
      expect({ creates: second?.creates, resumes: second?.resumes }).toEqual({
        creates: 1,
        resumes: 2,
      });
      expect(second?.actor?.status.state).toBe("ACTOR_STATE_RUNNING");
      const recoveredFacts = await facts();
      expect(recoveredFacts).toHaveLength(2);
      const firstRecovered = recoveredFacts.find((row) => row["attemptID"] === f.attemptID);
      const originalFirst = originalFacts.find((row) => row["attemptID"] === f.attemptID);
      if (!firstRecovered || !originalFirst) throw Error("Original first Resume fact missing");
      if (firstState === "ACTOR_STATE_RUNNING") {
        expect(firstRecovered?.["outcome"]).toMatchObject({
          actorUID: firstActor.metadata.uid,
          state: firstState,
        });
        const firstDispatch: typeof originalFirst = {
          ...firstRecovered,
          outcome: null,
          outcome_recorded_at: null,
        };
        expect(firstDispatch).toEqual(originalFirst);
      } else {
        expect(firstRecovered).toEqual(originalFirst);
      }
      const completed = recoveredFacts.find((row) => row["attemptID"] === secondAttemptID);
      const originalSecond = originalFacts.find((row) => row["attemptID"] === secondAttemptID);
      if (!completed || !originalSecond) throw Error("Original second Resume fact missing");
      expect(completed?.["outcome"]).toMatchObject({
        actorUID: second?.actor?.metadata.uid,
        state: "ACTOR_STATE_RUNNING",
      });
      expect(completed?.["outcome_recorded_at"]).not.toBeNull();
      const completedDispatch: typeof originalSecond = {
        ...completed,
        outcome: null,
        outcome_recorded_at: null,
      };
      expect(completedDispatch).toEqual(originalSecond);
      const bindings = await f.database.client`
      SELECT runtime_attempt_id::text AS "attemptID",actor_uid::text,checkpoint
      FROM factory.substrate_binding WHERE runtime_attempt_id IN (${f.attemptID},${secondAttemptID})`;
      expect(bindings).toHaveLength(2);
      for (const binding of bindings) {
        const original = originalFacts.find((row) => row["attemptID"] === binding["attemptID"]);
        expect(binding).toMatchObject({ actor_uid: original?.["actor_uid"], checkpoint: null });
      }
    } finally {
      f.hub.revoke(secondAttemptID);
      await f.dispose();
    }
  },
  60_000,
);
