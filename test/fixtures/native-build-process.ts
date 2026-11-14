import { createHash } from "node:crypto";
import type { createDatabase } from "../../packages/db/src/client";
import { fixture } from "./change-agent-turns";
import { eventually } from "./factory-process";
import type { nativeProcessProtocol } from "./native-process-protocol";

// Controlled prior work, not a live model/runtime proof. The actual admission,
// writer, native provisioning and OpenCode controller establish one completed
// no-change input and its confirmed Session before a process-recovery scenario.
export async function nativeBuildProcessFixture(
  database: ReturnType<typeof createDatabase>,
  native: Awaited<ReturnType<typeof nativeProcessProtocol>>,
) {
  const owned = await fixture(undefined, undefined, database, { runtime: "deferred-native" });
  const revision = "a".repeat(40);
  const originalParent = owned.hub.parentOperation.bind(owned.hub);
  owned.hub.parentOperation = async (...args) => {
    const result = await originalParent(...args);
    return args[1].action === "skills-install"
      ? result
      : { ...result, commitSHA: revision, remoteSHA: revision };
  };
  try {
    const controller = owned.controller(async () => {
      const id = await native.startWorkspace(
        owned.projectID,
        owned.userID,
        {
          version: 1,
          primaryApp: "web",
          apps: [
            {
              id: "web",
              label: "Owned Web",
              command: ["node", "web.js"],
              port: 4321,
              healthPath: "/",
            },
          ],
        },
        owned.changeID,
      );
      if (id !== owned.attemptID) throw Error("Controlled native Ticket identity changed");
      // This peer is in-process; the later real process must establish its own
      // transport readiness and cannot inherit these mocked connections.
      await database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${id}`;
      await database.client`UPDATE factory.change SET state='active' WHERE id=${owned.changeID}`;
      return null;
    });
    const commandID = crypto.randomUUID();
    await controller.start(owned.changeID, owned.userID, commandID);
    await eventually(
      async () => {
        const turn = await owned.turn(commandID);
        if (turn && ["failed", "uncertain"].includes(turn.state))
          throw Error(`Controlled prior Session failed: ${turn.summary ?? turn.state}`);
        return owned.requests();
      },
      (count) => count === 1,
      "Controlled native prior Session did not submit its input",
    );
    await owned.requested;
    owned.finish();
    owned.release();
    await eventually(
      async () => {
        const [session] = await database.client<
          { state: string; turnState: string; error: string | null }[]
        >`
          SELECT session.state,turn.state AS "turnState",session.last_error AS error
          FROM factory.change_agent_session session JOIN factory.agent_turn turn
            ON turn.id=session.active_turn_id
          WHERE session.change_id=${owned.changeID}`;
        if (session?.error)
          throw Error(`Controlled prior Session did not settle: ${session.error}`);
        return session;
      },
      (session) => session?.state === "committed" && session.turnState === "completed",
      "Controlled native prior Session did not settle",
    );
    await controller.shutdown();
    const [bound] = await database.client<
      {
        uid: string;
        parentHash: string;
        childHash: string;
        sourceUID: string;
      }[]
    >`SELECT binding.actor_uid AS uid,attempt.parent_connector_token_hash AS "parentHash",
        attempt.child_connector_token_hash AS "childHash",source.actor_uid AS "sourceUID"
      FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      JOIN factory.substrate_source source ON source.workspace_id=attempt.workspace_id
      WHERE attempt.id=${owned.attemptID}`;
    if (!bound || bound.uid !== bound.sourceUID || bound.parentHash === bound.childHash)
      throw Error("Controlled native prior Session has no original Source/role binding");
    for (const role of ["parent", "child"] as const) {
      const headers = await native.connectorHeaders(owned.attemptID, role);
      const hash = createHash("sha256").update(headers.authorization.slice(7)).digest("hex");
      if (hash !== (role === "parent" ? bound.parentHash : bound.childHash))
        throw Error("Controlled native role capability differs from its admission");
    }
    if (owned.requests() !== 1) throw Error("Controlled prior Session submitted another input");
    owned.hub.parentOperation = originalParent;
    await owned.nextInput();
    return owned;
  } catch (cause) {
    await owned.shutdown();
    owned.restoreEnvironment();
    throw cause;
  }
}
