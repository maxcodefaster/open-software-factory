import { createHash } from "node:crypto";
import { dirname } from "node:path/posix";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  projectSetupConfirmation,
  projectSetupInspection,
  workspaceSharedDocument,
} from "../../../../packages/db/src/schema";
import { setupInspectionOutput } from "../../../../packages/project-domain/src/setup";
import { parseSystemContract } from "../../../../packages/system-contract/src/system-contract";
import { CommandError } from "../command-error";
import type { InitialSourceSeed } from "./source-initialization";

type SQL = ReturnType<typeof createDatabase>["client"] | DatabaseTransaction;
type Forward = (operation: string, body: Record<string, unknown>) => Promise<Response>;
type StartupSource = {
  workspaceID: string;
  actorUID: string | null;
  owner: "actor" | "service";
  writable: boolean;
  seed: InitialSourceSeed | null;
  seedConfirmedAt: Date | null;
};

async function readFile(forward: Forward, path: string): Promise<Buffer | undefined> {
  const response = await forward("read", { path });
  if (response.status === 404) return;
  if (!response.ok)
    throw new CommandError("unavailable", "Saved Source configuration could not be read");
  return fileBytes(await response.json());
}

function fileBytes(value: unknown) {
  const file = value as { content?: unknown; version?: unknown } | null;
  if (
    !file ||
    typeof file.content !== "string" ||
    typeof file.version !== "string" ||
    file.content.length > 3_000_000
  )
    throw new CommandError("unavailable", "Saved Source configuration is invalid");
  const bytes = Buffer.from(file.content, "base64");
  if (
    bytes.toString("base64") !== file.content ||
    createHash("sha256").update(bytes).digest("hex") !== file.version
  )
    throw new CommandError("unavailable", "Saved Source configuration version is unconfirmed");
  return bytes;
}

/**
 * Explicit Start, under the existing Workspace lock. A never-started checkout
 * can predate setup confirmation. Add only its exact approved missing files;
 * keep the original Git basis, saved application edits and seed provenance.
 */
export async function sourceStartupContract(sql: SQL, lease: StartupSource, forward: Forward) {
  if (lease.owner !== "service" || !lease.writable)
    throw new CommandError("unavailable", "Independent Source is not ready for Workspace Start");
  const db = drizzleTransaction(sql);
  if (lease.actorUID === null) {
    if (!lease.seed || !lease.seedConfirmedAt || lease.seed.workspaceID !== lease.workspaceID)
      throw new CommandError("unavailable", "Initial Source publication is unconfirmed");
    const [setup] = await db
      .select({ output: projectSetupInspection.output })
      .from(projectSetupInspection)
      .innerJoin(
        projectSetupConfirmation,
        eq(projectSetupConfirmation.inspectionId, projectSetupInspection.id),
      )
      .where(
        and(
          eq(projectSetupInspection.projectId, lease.seed.projectID),
          eq(projectSetupInspection.sourceCommit, lease.seed.revision),
          eq(projectSetupInspection.state, "confirmed"),
        ),
      )
      .orderBy(desc(projectSetupInspection.createdAt))
      .limit(1);
    if (setup) {
      const approved = setupInspectionOutput.parse(setup.output);
      if (approved.questions.length)
        throw new CommandError("conflict", "Confirmed setup still has unanswered questions");
      if (approved.files.length) {
        const [unsaved] = await db
          .select({ path: workspaceSharedDocument.path })
          .from(workspaceSharedDocument)
          .where(
            and(
              eq(workspaceSharedDocument.workspaceId, lease.workspaceID),
              inArray(
                workspaceSharedDocument.path,
                approved.files.map((file) => file.path),
              ),
              or(
                eq(workspaceSharedDocument.dirty, true),
                eq(workspaceSharedDocument.conflict, true),
              ),
            ),
          )
          .limit(1);
        if (unsaved)
          throw new CommandError(
            "conflict",
            "Save or resolve shared setup edits before Workspace Start",
          );
      }
      const missing: typeof approved.files = [];
      // Check every existing file before the first write. No approved path may
      // replace newer local content, even after an interrupted partial copy.
      for (const file of approved.files) {
        const saved = await readFile(forward, file.path);
        if (!saved) missing.push(file);
        else if (!saved.equals(Buffer.from(file.content)))
          throw new CommandError(
            "conflict",
            `Saved ${file.path} differs from confirmed setup. Your edits were preserved.`,
          );
      }
      for (const file of missing) {
        const parents: string[] = [];
        for (let path = dirname(file.path); path !== "."; path = dirname(path))
          parents.unshift(path);
        for (const path of parents) {
          const current = await forward("stat", { path });
          if (current.status === 404) {
            if (!(await forward("mkdir", { path })).ok)
              throw new CommandError(
                "unavailable",
                "Confirmed setup directory creation is unconfirmed",
              );
          } else if (!current.ok || (await current.json()).kind !== "directory") {
            throw new CommandError(
              "conflict",
              "Saved setup path is not a directory; Source was preserved",
            );
          }
        }
        const bytes = Buffer.from(file.content);
        // Empty observed version is create-only in the existing Source API.
        // An identical save positively recovers a lost reply; different bytes conflict.
        const written = await forward("write", {
          path: file.path,
          content: bytes.toString("base64"),
          version: "",
        });
        if (!written.ok || !fileBytes(await written.json()).equals(bytes))
          throw new CommandError("unavailable", "Confirmed setup file publication is unconfirmed");
      }
    }
  }
  const content = await readFile(forward, ".factory/system.json");
  if (!content)
    throw new CommandError(
      "conflict",
      "Saved Source has no confirmed Factory configuration. Confirm Project setup before Start.",
    );
  return parseSystemContract(content.toString("utf8"));
}
