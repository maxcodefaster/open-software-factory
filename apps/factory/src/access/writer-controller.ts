import { createAgentTurnStore } from "../agent/turns-api";
import { writerActivity } from "./writer-activity";
import type {
  ChangeWriterControllerOptions,
  HumanTransfer,
  WriterContext,
  WriterView,
} from "./writer-decisions";
import { confirmAgentSource, prepareAgentWriter } from "./writer-fencing";
import { releaseChangeWriter } from "./writer-release";
import { takeOverChangeWriter } from "./writer-takeover";
import {
  findEditingRequestRequester,
  findPendingViewContinuation,
  readWriterView,
  recordWriterActivity,
  requestChangeEditing,
} from "./writer-views";

export function createChangeWriterController(options: ChangeWriterControllerOptions) {
  const { database } = options;
  const turns = createAgentTurnStore(database);
  const activity = options.activity ?? writerActivity;
  const context: WriterContext = { ...options, activity };

  return {
    async activity(
      changeID: string,
      userID: string,
      expectedEpoch: number,
      kind: "edit" | "heartbeat",
    ) {
      await recordWriterActivity(database, activity, changeID, userID, expectedEpoch, kind);
    },
    /** Pure observation: opening the shared chat must never acquire editing. */
    async status(changeID: string, userID: string): Promise<WriterView> {
      return readWriterView(database, activity, changeID, userID);
    },
    async request(changeID: string, userID: string, commandID: string, expectedEpoch: number) {
      await requestChangeEditing(database, changeID, userID, commandID, expectedEpoch);
      return readWriterView(database, activity, changeID, userID);
    },
    async approve(
      changeID: string,
      userID: string,
      commandID: string,
      requestID: string,
      expectedEpoch: number,
    ) {
      const requesterID = await findEditingRequestRequester(database, changeID, userID, requestID);
      await this.takeOver(changeID, requesterID, commandID, undefined, {
        epoch: expectedEpoch,
        approverID: userID,
        requestID,
      });
      return readWriterView(database, activity, changeID, userID);
    },
    async takeIdle(changeID: string, userID: string, commandID: string, expectedEpoch: number) {
      return this.takeOver(changeID, userID, commandID, undefined, { epoch: expectedEpoch });
    },
    async release(
      changeID: string,
      userID: string,
      commandID: string,
      expectedEpoch: number,
    ): Promise<WriterView> {
      return releaseChangeWriter(context, changeID, userID, commandID, expectedEpoch);
    },
    async view(changeID: string, userID: string): Promise<WriterView> {
      const continuation = await findPendingViewContinuation(database, changeID, userID);
      if (continuation?.kind === "takeover")
        return this.takeOver(changeID, userID, continuation.commandID);
      if (continuation?.kind === "release")
        return this.release(changeID, userID, continuation.commandID, continuation.epoch);
      return readWriterView(database, activity, changeID, userID);
    },
    async prepareAgent(changeID: string, turnID: string, ownerToken?: string) {
      return prepareAgentWriter(context, turns, changeID, turnID, ownerToken);
    },
    async confirmSource(
      changeID: string,
      turnID: string,
      ownerToken: string,
      attemptID: string,
      sessionID: string,
    ) {
      return confirmAgentSource(context, turns, changeID, turnID, ownerToken, attemptID, sessionID);
    },
    async takeOver(
      changeID: string,
      userID: string,
      commandID: string,
      completedEpoch?: string,
      humanTransfer?: HumanTransfer,
      observedEpoch?: number,
    ): Promise<WriterView> {
      return takeOverChangeWriter(
        context,
        changeID,
        userID,
        commandID,
        completedEpoch,
        humanTransfer,
        observedEpoch,
      );
    },
  };
}
