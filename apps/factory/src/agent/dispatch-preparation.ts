import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import { nativeSkillManifestInput } from "../skills/api";
import { personalGitStatus } from "../workspace/api";
import type { AgentActivity, AgentTurnStore, RuntimeController } from "./controller-types";
import { installedOpenCodeSkillIDs } from "./opencode-adapter";
import type {
  AgentIntent,
  CurrentChange,
  OpenCodeClient,
  OpenCodeLocation,
} from "./turn-lifecycle";

export async function installNativeSkills(
  hub: RuntimeHub,
  turns: AgentTurnStore,
  params: {
    attemptID: string;
    turnID: string;
    ownerToken: string;
    client: OpenCodeClient;
    location: OpenCodeLocation;
    intent: AgentIntent;
    skillRevisionIDs: readonly string[];
  },
): Promise<void> {
  const { attemptID, turnID, ownerToken, client, location, intent, skillRevisionIDs } = params;
  const manifest = nativeSkillManifestInput.parse(intent.skillManifest);
  if (manifest.files.length > 0)
    await hub.parentOperation(
      attemptID,
      {
        operationId: `${attemptID}-skills-${manifest.digest}`,
        action: "skills-install",
        data: JSON.stringify(manifest),
      },
      async (send) => {
        if (
          !(await turns.validateExecution(turnID, ownerToken, async () => {
            send();
          }))
        )
          throw new CommandError("conflict", "Build authority changed before skill installation");
      },
    );
  const expected = skillRevisionIDs.map((id) => `factory-${id}`).sort();
  let ready = false;
  for (let probe = 0; probe < 40; probe++) {
    const observed = installedOpenCodeSkillIDs((await client.skill.list({ location })).data);
    if (JSON.stringify(observed) === JSON.stringify(expected)) {
      ready = true;
      break;
    }
    await Bun.sleep(250);
  }
  if (!ready) throw new Error("Native skills do not match the exact admitted packages");
}

export async function prepareReviewApps(
  hub: RuntimeHub,
  runtime: RuntimeController,
  turns: AgentTurnStore,
  activity: Pick<AgentActivity, "signal">,
  params: {
    attemptID: string;
    turnID: string;
    ownerToken: string;
    intent: AgentIntent;
    current: CurrentChange;
    candidate: string;
  },
): Promise<void> {
  const { attemptID, turnID, ownerToken, intent, current, candidate } = params;
  const apps = current.declaredApps;
  const advertised = hub.appChannels(attemptID);
  if (apps.length !== advertised.length || apps.some((app) => !advertised.includes(app)))
    throw new CommandError("unavailable", "Review declared Apps are not connected");
  if (!apps.length) return;
  if (!runtime.processAction)
    throw new CommandError("unavailable", "Review App preparation is not configured");
  const beforeSend = async (send: () => void) => {
    if (
      !(await turns.validateExecution(turnID, ownerToken, async (sql) => {
        activity.signal.throwIfAborted();
        if (apps.some((app) => !hub.hasAppChannel(attemptID, app)))
          throw new CommandError("unavailable", "Review declared Apps are not connected");
        const [matched] = await sql`
          SELECT intent.turn_id FROM factory.change_agent_turn_intent intent
          JOIN factory.agent_turn turn ON turn.id=intent.turn_id
          JOIN factory.change change ON change.id=intent.change_id
          JOIN factory.change_agent_session session ON session.change_id=change.id
          JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
          JOIN factory.change_writer writer ON writer.change_id=change.id
          WHERE intent.turn_id=${turnID} AND intent.session_id=${intent.sessionID}
            AND intent.runtime_attempt_id=${attemptID} AND change.runtime_attempt_id=${attemptID}
            AND session.runtime_attempt_id=${attemptID} AND session.active_turn_id=${turnID}
            AND session.opencode_session_id=${intent.sessionID} AND session.state='starting'
            AND NOT session.stop_pending AND attempt.state='ready' AND attempt.stop_intended_at IS NULL
            AND writer.state='agent' AND writer.turn_id=${turnID} AND NOT writer.fence_required
            AND turn.owner_token=${ownerToken} AND turn.owner_expires_at>clock_timestamp()
          FOR SHARE OF attempt,session`;
        if (!matched)
          throw new CommandError(
            "conflict",
            "Review Runtime Attempt changed before App preparation",
          );
        send();
      }))
    )
      throw new CommandError("conflict", "Review authority changed before App preparation");
  };
  const confirmCheckout = async () => {
    const status = await hub.parentOperation(
      attemptID,
      {
        operationId: crypto.randomUUID(),
        action: "workspace-git",
        data: JSON.stringify({ action: "status", branch: current.branchName }),
      },
      beforeSend,
    );
    const checkout = personalGitStatus.parse(JSON.parse(status.data ?? "null"));
    if (
      checkout.head !== candidate ||
      checkout.branch !== current.branchName ||
      checkout.files.length
    )
      throw new CommandError("conflict", "Review App needs the clean submitted candidate");
  };
  await confirmCheckout();
  // Non-watch commands still hold bootstrap code after submission.
  // Refresh before creating the independent Session. An unknown effect
  // leaves no Session for recovery to resume and is never replayed.
  const signal = AbortSignal.any([activity.signal, AbortSignal.timeout(nativeLifecycleWindowMS)]);
  for (const app of apps)
    await runtime.processAction(attemptID, app, "restart", {
      beforeSend,
      waitForReady: true,
      signal,
    });
  await confirmCheckout();
  if (!(await turns.validateExecution(turnID, ownerToken)))
    throw new CommandError("conflict", "Review authority changed during App preparation");
}
