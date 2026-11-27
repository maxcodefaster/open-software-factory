import { DrizzleQueryError } from "drizzle-orm";
import type { createDatabase, drizzleTransaction } from "#db/client";
import type { createForgejoClient } from "#forge/forge";
import type { RuntimeAttemptView } from "../runtime/types";
import type { createDeliveryCoordination } from "./coordination";
import type { createChangeIntegration } from "./integration";
import type { createDeliveryVerification } from "./verification";

export type Database = ReturnType<typeof createDatabase>;
export type DrizzleDB = ReturnType<typeof drizzleTransaction>;
export type ForgeClient = ReturnType<typeof createForgejoClient>;
export type DeliveryIntegration = Pick<ReturnType<typeof createChangeIntegration>, "reconcile">;
export type DeliveryCoordination = ReturnType<typeof createDeliveryCoordination>;
export type DeliveryVerificationChecks = ReturnType<typeof createDeliveryVerification>;

export type RuntimeController = {
  startVerification(verificationID: string, userID: string): Promise<RuntimeAttemptView | null>;
  startStagingReplacement(promotionID: string, userID: string): Promise<RuntimeAttemptView | null>;
  pause(attemptID: string): Promise<RuntimeAttemptView | null>;
  stop(attemptID: string): Promise<RuntimeAttemptView | null>;
};

export type AgentController = {
  review?(changeID: string, reviewID: string, userID: string): Promise<unknown>;
  prompt(
    changeID: string,
    text: string,
    userID: string,
    commandID: string,
    repair?: boolean,
  ): Promise<unknown>;
};

export function bounded(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function failureMessage(cause: unknown, fallback: string): string {
  // Drizzle's wrapper includes SQL parameters. Persist the original driver
  // message as before, never runner credentials or other query inputs.
  if (cause instanceof DrizzleQueryError) return failureMessage(cause.cause, fallback);
  return bounded(cause instanceof Error ? cause.message : fallback);
}
