import type { RuntimeHub } from "../runtime/transport-api";
import type { RuntimeAttemptView } from "../runtime/types";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import { publishStopBarrierIn } from "./stop-barrier";
import {
  commitStopConfirmation,
  dispatchLiveStop,
  readPendingStopCandidate,
  recordUnconfirmedStop,
} from "./stop-dispatch";
import { confirmUndispatchedReviewStopsIn } from "./stop-fencing";
import {
  canAttemptRetainedSettle,
  type Database,
  getPublishingOrigin,
  isConfirmedPausedBootstrap,
  isFreshUnconfirmedBootstrap,
  type PendingWriterHandoff,
  type RetainedStopTarget,
  type StopOrigin,
  settleStopTurnIn,
  withPublishingOrigin,
} from "./stop-state";

export {
  confirmUndispatchedReviewStopsIn,
  requirePendingWriterHandoffIn,
  requireStoppedAgentInputsIn,
} from "./stop-fencing";
export type { PendingWriterHandoff, RetainedStopTarget } from "./stop-state";

export function createChangeAgentStop(
  database: Database,
  hub: RuntimeHub,
  settleRetained?: (target: RetainedStopTarget) => Promise<boolean>,
  observeRuntime?: (attemptID: string) => Promise<RuntimeAttemptView | null>,
) {
  const usage = createRecordedOpenCodeUsage(database);

  return {
    async persist(changeID: string, handoff?: PendingWriterHandoff, origin: StopOrigin = "user") {
      const stopID = crypto.randomUUID();
      await withPublishingOrigin(stopID, changeID, origin, async () => {
        // Admission locks Change/Ticket before reading the barrier. Publish it
        // without waiting for any Turn lock: execution locks Turn before Change.
        const target = await database.client.begin((sql) =>
          publishStopBarrierIn(sql, changeID, stopID, origin, handoff),
        );
        const targetOrigin = target.stopID ? getPublishingOrigin(target.stopID, changeID) : origin;
        await settleStopTurnIn(database.client, changeID, target, targetOrigin);
        // A writer handoff may already be settling its old Session. An explicit
        // Stop must also cancel the captured new admission, without replacing
        // that original native-input Stop identity.
        if (target.pendingTurnID && target.pendingTurnID !== target.turnID) {
          await settleStopTurnIn(
            database.client,
            changeID,
            { stopID: null, turnID: target.pendingTurnID },
            origin,
          );
        }
      });
    },

    async recordUnconfirmed(
      changeID: string,
      target: { stopID: string; attemptID: string; sessionID: string | null },
    ) {
      await recordUnconfirmedStop(database, hub, changeID, target);
    },

    async confirm(
      changeID: string,
      expectedStopID?: string,
      mode: RetainedStopTarget["mode"] = "interrupt",
    ) {
      const current = await readPendingStopCandidate(database, changeID, expectedStopID);
      if (!current) return true;
      // Recovery fences the captured Turn after a crash between publication
      // and settlement. An in-flight publisher can supply its known origin;
      // recovery without that exact caller context must stay neutral.
      await settleStopTurnIn(
        database.client,
        changeID,
        current,
        getPublishingOrigin(current.stopID, changeID),
      );
      const currentStopID = current.stopID;
      if (
        currentStopID &&
        (await database.client.begin((sql) =>
          confirmUndispatchedReviewStopsIn(sql, { changeID, stopID: currentStopID }),
        ))
      )
        return true;
      if (current.currentAttemptID !== current.attemptID) return false;
      // A fresh Session cannot receive its prompt before native confirmation
      // is durable. Stop fences late confirmation. With exact compute teardown,
      // an unconfirmed bootstrap therefore has no queued input to cancel.
      // Reused or confirmed Sessions still require native history.
      const freshBootstrap = isFreshUnconfirmedBootstrap(current);
      const paused =
        freshBootstrap && !current.implementationConfirmed && current.runtimeState === "paused"
          ? await observeRuntime?.(current.attemptID)
          : null;
      const pausedBootstrap = isConfirmedPausedBootstrap(paused, current.attemptID, changeID);
      // Only a never-confirmed fresh bootstrap may use the retained native
      // compute fence. A confirmed/reused Session still needs queued-input
      // settlement; Source durability alone can never supply that result.
      const unsubmittedBootstrap =
        freshBootstrap && (current.runtimeState === "stopped" || pausedBootstrap);
      const retainedSettled =
        !unsubmittedBootstrap &&
        canAttemptRetainedSettle(current, hub.connected(current.attemptID)) &&
        Boolean(
          await settleRetained?.({
            changeID,
            stopID: current.stopID,
            attemptID: current.attemptID,
            sessionID: current.sessionID,
            promptID: current.promptID,
            mode,
          }),
        );
      // OpenCode's queued state survives compute suspension. Destruction of a
      // runtime is not evidence that an assigned input has been removed.
      if (
        current.runtimeState === "stopped" &&
        current.intentAttemptID &&
        !unsubmittedBootstrap &&
        !retainedSettled
      )
        return false;
      if (current.intentAttemptID && current.intentAttemptID !== current.attemptID) return false;
      if (current.runtimeState !== "stopped" && !retainedSettled && !unsubmittedBootstrap) {
        if (!(await dispatchLiveStop(database, hub, usage, changeID, current, mode))) return false;
      }
      if (retainedSettled && current.turnID && current.turnState === "stopped") {
        // Native work is settled, not its unobserved consumption. Preserve the
        // existing journal and mark any missing usage unknown, never zero.
        await usage.settle(current.turnID, "interrupted");
      }
      return commitStopConfirmation(database, changeID, current, {
        unsubmittedBootstrap,
        pausedBootstrap,
        retainedSettled,
      });
    },
  };
}
