import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { dirname } from "node:path/posix";
import { and, desc, eq, inArray, ne, sql as query } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { auditEvent, operation, workspaceSharedDocument } from "#db/schema";
import { setupInspectionOutput } from "#project-domain/setup";
import { parseSystemContract, type SystemContract } from "#system-contract/system-contract";
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
export type SourceStartupConfiguration = {
  systemContract: SystemContract | null;
  actorTemplate: { path: string; content: string; sha256: string } | null;
};
const actorTemplateBytes = 64 * 1024;

async function readFile(
  forward: Forward,
  path: string,
  maxBytes?: number,
): Promise<Buffer | undefined> {
  const response = await forward("read", { path });
  if (response.status === 404) return;
  if (!response.ok)
    throw new CommandError("unavailable", "Saved Source configuration could not be read");
  return fileBytes(await response.json(), maxBytes);
}

function fileBytes(value: unknown, maxBytes?: number) {
  const file = value as { content?: unknown; version?: unknown } | null;
  if (
    !file ||
    typeof file.content !== "string" ||
    typeof file.version !== "string" ||
    file.content.length > 3_000_000 ||
    (maxBytes !== undefined && file.content.length > Math.ceil(maxBytes / 3) * 4)
  )
    throw new CommandError("unavailable", "Saved Source configuration is invalid");
  const bytes = Buffer.from(file.content, "base64");
  if (
    (maxBytes !== undefined && bytes.byteLength > maxBytes) ||
    bytes.toString("base64") !== file.content ||
    createHash("sha256").update(bytes).digest("hex") !== file.version
  )
    throw new CommandError("unavailable", "Saved Source configuration version is unconfirmed");
  return bytes;
}

async function readActorTemplate(
  forward: Forward,
  path: string,
): Promise<SourceStartupConfiguration["actorTemplate"]> {
  const bytes = await readFile(forward, path, actorTemplateBytes);
  if (bytes === undefined) return null;
  if (!isUtf8(bytes))
    throw new CommandError("unavailable", "Saved Source ActorTemplate is not valid UTF-8");
  return {
    path,
    content: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Explicit Start, under the existing Workspace lock. A never-started checkout
 * can predate setup confirmation. Add only its exact approved missing files;
 * keep the original Git basis, saved application edits and seed provenance.
 */
export async function sourceStartupConfiguration(
  sql: SQL,
  lease: StartupSource,
  forward: Forward,
  actorTemplatePath: string,
): Promise<SourceStartupConfiguration> {
  if (lease.owner !== "service" || !lease.writable)
    throw new CommandError("unavailable", "Independent Source is not ready for Workspace Start");
  if (
    actorTemplatePath.length > 500 ||
    actorTemplatePath !== actorTemplatePath.trim() ||
    actorTemplatePath.includes("\\") ||
    /^[a-z]:/i.test(actorTemplatePath) ||
    [...actorTemplatePath].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    actorTemplatePath.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    throw new CommandError("invalid", "ActorTemplate path must stay within the Project repository");
  const db = drizzleTransaction(sql);
  if (lease.actorUID === null) {
    if (!lease.seed || !lease.seedConfirmedAt || lease.seed.workspaceID !== lease.workspaceID)
      throw new CommandError("unavailable", "Initial Source publication is unconfirmed");
    const [setup] = await db
      .select({ payload: operation.payload })
      .from(operation)
      .innerJoin(
        auditEvent,
        and(
          eq(auditEvent.kind, "projects.setup_confirmation"),
          eq(auditEvent.scopeType, "project"),
          eq(auditEvent.scopeId, lease.seed.projectID),
          eq(
            auditEvent.dedupeKey,
            query<string>`'projects.setup_confirmation:' || ${operation.id}::text`,
          ),
        ),
      )
      .where(
        and(
          eq(operation.kind, "project.setup_inspection"),
          eq(operation.scopeType, "project"),
          eq(operation.scopeId, lease.seed.projectID),
          query`${operation.payload}->>'sourceCommit' = ${lease.seed.revision}`,
          eq(operation.state, "confirmed"),
        ),
      )
      .orderBy(desc(operation.createdAt))
      .limit(1);
    if (setup) {
      const approved = setupInspectionOutput.parse(setup.payload["output"] ?? null);
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
              ne(workspaceSharedDocument.syncState, "clean"),
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
        const saved = await readFile(
          forward,
          file.path,
          file.path === actorTemplatePath ? actorTemplateBytes : undefined,
        );
        if (!saved) missing.push(file);
        else if (!saved.equals(Buffer.from(file.content)))
          throw new CommandError(
            "conflict",
            `Saved ${file.path} differs from confirmed setup. Your edits were preserved.`,
          );
      }
      // The selected template can be outside the approved missing files. Fail
      // on invalid saved bytes before publishing any part of that setup.
      if (missing.length) await readActorTemplate(forward, actorTemplatePath);
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
  const actorTemplate = await readActorTemplate(forward, actorTemplatePath);
  return {
    systemContract: content === undefined ? null : parseSystemContract(content.toString("utf8")),
    actorTemplate,
  };
}
