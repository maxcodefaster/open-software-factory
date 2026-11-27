import { and, eq, gt, inArray, isNotNull, isNull, notExists, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { runtimeAttempt, substrateProvision } from "#db/schema";
import { CommandError } from "../command-error";
import { substrateIsolatedGrantIn, substrateIsolatedPrincipalIn } from "./substrate-isolated-grant";
import {
  substrateVerificationGrantIn,
  substrateVerificationPrincipalIn,
} from "./substrate-verification-grant";

type ProjectEntry = {
  projectTemplate: unknown;
  actorUID: string;
  workspaceID: string | null;
};

// Resolve only the admitted native owner's immutable bytes. Provisioning is not
// product authority: isolated owners must still pass their existing exact-job
// grants. Workspace writer/Source grants remain with the caller, which has its
// database owner and must distinguish a pending Source lease from revocation.
export async function nativeProjectEntryIn(
  sql: DatabaseTransaction,
  attemptID: string,
): Promise<ProjectEntry> {
  const denied = () =>
    new CommandError("forbidden", "Current native Project entry grant is unavailable");
  const db = drizzleTransaction(sql);
  const attempt = alias(runtimeAttempt, "attempt");
  const newerAttempt = alias(runtimeAttempt, "newer");
  const [binding] = await db
    .select({
      projectID: attempt.projectId,
      generation: query<number>`${attempt.generation}::float8`,
      actorUID: query<string>`${attempt.actorUid}`,
      workspaceID: attempt.workspaceId,
      isolatedKind: attempt.isolatedKind,
      verificationID: attempt.verificationId,
    })
    .from(attempt)
    .where(
      and(
        eq(attempt.id, attemptID),
        inArray(attempt.state, ["starting", "ready"]),
        isNull(attempt.stopIntendedAt),
        isNotNull(attempt.actorUid),
        isNotNull(attempt.createAttemptedAt),
        eq(attempt.createRejected, false),
        isNull(attempt.deleteIntendedAt),
        isNull(attempt.deletedAt),
        notExists(
          db
            .select({ id: newerAttempt.id })
            .from(newerAttempt)
            .where(
              and(
                eq(newerAttempt.workspaceId, attempt.workspaceId),
                gt(newerAttempt.generation, attempt.generation),
              ),
            ),
        ),
      ),
    )
    .for("share", { of: attempt });
  if (!binding) throw denied();
  const result = (projectTemplate: unknown): ProjectEntry => ({
    projectTemplate,
    actorUID: binding.actorUID,
    workspaceID: binding.workspaceID,
  });
  if (binding.workspaceID) {
    const [provision] = await db
      .select({ projectTemplate: query<unknown>`${substrateProvision.intent}->'projectTemplate'` })
      .from(substrateProvision)
      .where(
        and(
          eq(substrateProvision.ownerId, binding.workspaceID),
          eq(substrateProvision.kind, "workspace"),
          eq(substrateProvision.generation, binding.generation),
        ),
      )
      .for("share");
    if (!provision) throw denied();
    return result(provision.projectTemplate);
  }
  if (binding.isolatedKind === "verification" && binding.verificationID) {
    const provisionRow = alias(substrateProvision, "provision");
    const newerProvision = alias(substrateProvision, "newer");
    const [provision] = await db
      .select({ projectTemplate: query<unknown>`${provisionRow.intent}->'projectTemplate'` })
      .from(provisionRow)
      .where(
        and(
          eq(provisionRow.kind, "verification"),
          eq(provisionRow.runtimeAttemptId, attemptID),
          eq(provisionRow.ownerId, binding.verificationID),
          eq(provisionRow.generation, binding.generation),
          notExists(
            db
              .select({ id: newerProvision.runtimeAttemptId })
              .from(newerProvision)
              .where(
                and(
                  eq(newerProvision.ownerId, provisionRow.ownerId),
                  eq(newerProvision.kind, "verification"),
                  gt(newerProvision.generation, provisionRow.generation),
                ),
              ),
          ),
        ),
      )
      .for("share", { of: provisionRow });
    if (!provision) throw denied();
    const principal = await substrateVerificationPrincipalIn(sql, attemptID);
    await substrateVerificationGrantIn(
      sql,
      binding.projectID,
      binding.verificationID,
      attemptID,
      principal,
    );
    return result(provision.projectTemplate);
  }
  if (binding.isolatedKind === "staging" || binding.isolatedKind === "publication") {
    const provisionRow = alias(substrateProvision, "provision");
    const newerProvision = alias(substrateProvision, "newer");
    const [provision] = await db
      .select({
        projectTemplate: query<unknown>`${provisionRow.intent}->'projectTemplate'`,
        isolatedID: provisionRow.ownerId,
        promotionID: query<string | null>`${provisionRow.intent}->>'promotionID'`,
      })
      .from(provisionRow)
      .where(
        and(
          eq(provisionRow.runtimeAttemptId, attemptID),
          eq(provisionRow.projectId, binding.projectID),
          eq(provisionRow.kind, binding.isolatedKind),
          eq(provisionRow.generation, binding.generation),
          notExists(
            db
              .select({ id: newerProvision.runtimeAttemptId })
              .from(newerProvision)
              .where(
                and(
                  eq(newerProvision.ownerId, provisionRow.ownerId),
                  eq(newerProvision.kind, provisionRow.kind),
                  gt(newerProvision.generation, provisionRow.generation),
                ),
              ),
          ),
        ),
      )
      .for("share", { of: provisionRow });
    if (!provision) throw denied();
    const principal = await substrateIsolatedPrincipalIn(sql, attemptID);
    await substrateIsolatedGrantIn(
      sql,
      binding.projectID,
      {
        isolatedKind: binding.isolatedKind,
        isolatedID: provision.isolatedID,
        promotionID: provision.promotionID,
      },
      attemptID,
      principal,
    );
    return result(provision.projectTemplate);
  }
  throw denied();
}
