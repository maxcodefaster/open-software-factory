import { createHash } from "node:crypto";
import * as Y from "yjs";
import { z } from "zod";
import { CommandError } from "../command-error";
import type { createWorkspaceSourceController } from "./source-controller";

export const sharedDocumentPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part === ".git" ||
            part.startsWith(".factory-"),
        ),
    "Invalid shared document path",
  );

export const sharedSyncInputSchema = z.strictObject({
  path: sharedDocumentPathSchema,
  participantID: z.uuid(),
  clientID: z.number().int().min(0).max(0xffffffff),
  vector: z.string().max(131072).default(""),
  update: z
    .string()
    .max(6 << 20)
    .optional(),
  cursor: z
    .object({ anchor: z.string().max(2048), head: z.string().max(2048) })
    .nullable()
    .optional(),
});

export const sharedSaveInputSchema = z.strictObject({
  path: sharedDocumentPathSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export const sharedEditInputSchema = z.strictObject({
  path: sharedDocumentPathSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  edits: z
    .array(
      z.strictObject({
        offset: z.number().int().nonnegative(),
        deleteCount: z.number().int().nonnegative(),
        text: z.string().max(65536),
      }),
    )
    .min(1)
    .max(100),
});

export const sharedResolveInputSchema = z.strictObject({
  requestID: z.uuid(),
  path: sharedDocumentPathSchema,
  revision: z.string(),
  diskVersion: z.string(),
  choice: z.enum(["keep-shared", "use-saved"]),
});

export type SharedSyncInput = z.infer<typeof sharedSyncInputSchema>;
export type SharedDocumentEdit = z.infer<typeof sharedEditInputSchema>["edits"][number];

const diskFileSchema = z.object({
  version: z.string(),
  content: z.string().default(""),
  kind: z.literal("file"),
  size: z.number(),
  mtime: z.number(),
  ctime: z.number(),
});
export type DiskFileRecord = z.infer<typeof diskFileSchema>;

export type DiskDocumentSnapshot = {
  file: DiskFileRecord;
  content: string;
  missing: boolean;
};

export type PersistedSharedDocumentRow = {
  state: Uint8Array;
  diskVersion: string;
  syncState: "clean" | "dirty" | "conflict";
};

type SharedDocumentBase = {
  doc: Y.Doc;
  diskVersion: string;
  file: DiskFileRecord;
  missing: boolean;
};

export type SharedDocumentState =
  | ({ phase: "clean" } & SharedDocumentBase)
  | ({ phase: "dirty" } & SharedDocumentBase)
  | ({ phase: "conflict" } & SharedDocumentBase);

export function documentRevision(doc: Y.Doc) {
  return createHash("sha256").update(Y.encodeStateAsUpdate(doc)).digest("hex");
}

export function validateSharedCursor(cursor: { anchor: string; head: string } | null | undefined) {
  if (!cursor) return;
  try {
    Y.decodeRelativePosition(Buffer.from(cursor.anchor, "base64"));
    Y.decodeRelativePosition(Buffer.from(cursor.head, "base64"));
  } catch {
    throw new CommandError("invalid", "Shared cursor positions are invalid");
  }
}

export async function readDiskDocument(
  sources: Pick<ReturnType<typeof createWorkspaceSourceController>, "forward">,
  workspaceID: string,
  userID: string,
  path: string,
  wakeCompute = true,
): Promise<DiskDocumentSnapshot> {
  const response = await sources.forward(
    workspaceID,
    userID,
    "read",
    new Request("http://factory.internal/shared", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
    false,
    wakeCompute,
  );
  if (!response.ok)
    throw new CommandError(
      response.status === 404 ? "not-found" : "unavailable",
      "Shared document source is unavailable",
    );
  const file = diskFileSchema.parse(await response.json());
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length > 2 << 20 || bytes.includes(0))
    throw new CommandError("invalid", "Shared editing supports UTF-8 text files up to 2 MiB");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { file, content, missing: false };
}

export function missingDiskDocument(): DiskDocumentSnapshot {
  return {
    file: { version: "", content: "", kind: "file", size: 0, mtime: 0, ctime: 0 },
    content: "",
    missing: true,
  };
}

export function reconcileDocumentWithDisk(
  persisted: PersistedSharedDocumentRow | undefined,
  current: DiskDocumentSnapshot,
  incomingEdits = false,
): SharedDocumentState {
  const doc = new Y.Doc();
  if (persisted) Y.applyUpdate(doc, persisted.state);
  else doc.getText("text").insert(0, current.content);
  const text = doc.getText("text");
  let phase: SharedDocumentState["phase"] = persisted?.syncState ?? "clean";
  let diskVersion = persisted?.diskVersion ?? current.file.version;
  if (current.file.version !== diskVersion) {
    if (text.toString() === current.content) {
      phase = "clean";
      diskVersion = current.file.version;
    } else if (phase !== "clean" || incomingEdits) {
      phase = "conflict";
    } else {
      doc.transact(() => {
        text.delete(0, text.length);
        text.insert(0, current.content);
      });
      diskVersion = current.file.version;
      phase = "clean";
    }
  }
  return { phase, doc, diskVersion, file: current.file, missing: current.missing };
}

export function applyClientDocumentUpdate(
  state: SharedDocumentState,
  updateBase64: string,
): SharedDocumentState {
  const before = state.doc.getText("text").toString();
  Y.applyUpdate(state.doc, Buffer.from(updateBase64, "base64"));
  if (state.doc.getText("text").toString() !== before && state.phase === "clean")
    return { ...state, phase: "dirty" };
  return state;
}

export function applyIndexedDocumentEdits(
  state: SharedDocumentState,
  expectedRevision: string,
  edits: SharedDocumentEdit[],
): SharedDocumentState {
  if (documentRevision(state.doc) !== expectedRevision)
    throw new CommandError("conflict", "Shared document changed. Read it again before editing.");
  const text = state.doc.getText("text");
  for (const edit of edits) {
    if (edit.offset + edit.deleteCount > text.length)
      throw new CommandError("invalid", "Shared edit exceeds the document");
    text.delete(edit.offset, edit.deleteCount);
    text.insert(edit.offset, edit.text);
  }
  return state.phase === "clean" ? { ...state, phase: "dirty" } : state;
}

export function prepareDocumentSave(state: SharedDocumentState, expectedRevision: string) {
  if (state.phase === "conflict")
    throw new CommandError(
      "conflict",
      "Saved source changed outside shared editing. Your shared buffer is retained. Resolve the disk conflict before saving.",
    );
  if (documentRevision(state.doc) !== expectedRevision)
    throw new CommandError(
      "conflict",
      "Shared edits arrived before Save. Synchronize and save again.",
    );
  return {
    version: state.diskVersion,
    contentBase64: Buffer.from(state.doc.getText("text").toString()).toString("base64"),
  };
}

export function markDocumentSaved(
  state: SharedDocumentState,
  newDiskVersion: string,
): SharedDocumentState {
  return { ...state, phase: "clean", diskVersion: newDiskVersion };
}

export function resolveDocumentConflict(
  state: SharedDocumentState,
  expectedRevision: string,
  expectedDiskVersion: string,
  choice: "keep-shared" | "use-saved",
): SharedDocumentState {
  if (
    documentRevision(state.doc) !== expectedRevision ||
    state.file.version !== expectedDiskVersion
  )
    throw new CommandError(
      "conflict",
      "Shared or saved source changed. Compare the current versions before deciding.",
    );
  if (choice === "use-saved") {
    const text = state.doc.getText("text");
    state.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, Buffer.from(state.file.content, "base64").toString("utf8"));
    });
    return { ...state, phase: "clean", diskVersion: state.file.version };
  }
  return { ...state, phase: "dirty", diskVersion: state.file.version };
}

export async function writeDiskDocument(
  sources: Pick<ReturnType<typeof createWorkspaceSourceController>, "forward">,
  workspaceID: string,
  userID: string,
  path: string,
  payload: { version: string; contentBase64: string },
) {
  const response = await sources.forward(
    workspaceID,
    userID,
    "write",
    new Request("http://factory.internal/shared-save", {
      method: "POST",
      body: JSON.stringify({
        path,
        version: payload.version,
        content: payload.contentBase64,
      }),
    }),
    true,
  );
  if (!response.ok)
    throw new CommandError(
      response.status === 409 ? "conflict" : "unavailable",
      "Shared Save was not confirmed. Your buffer is retained.",
    );
  return z
    .object({ version: z.string() })
    .passthrough()
    .parse(await response.json());
}

export function formatSyncDocumentPayload(state: SharedDocumentState, vectorBase64: string) {
  return {
    update: Buffer.from(
      Y.encodeStateAsUpdate(
        state.doc,
        vectorBase64 ? Buffer.from(vectorBase64, "base64") : undefined,
      ),
    ).toString("base64"),
    vector: Buffer.from(Y.encodeStateVector(state.doc)).toString("base64"),
    revision: documentRevision(state.doc),
    dirty: state.phase !== "clean",
    conflict: state.phase === "conflict",
    diskVersion: state.file.version,
    diskMissing: state.missing,
  };
}

export function formatReadDocumentPayload(path: string, state: SharedDocumentState) {
  return {
    path,
    content: state.doc.getText("text").toString(),
    savedContent: Buffer.from(state.file.content, "base64").toString("utf8"),
    diskVersion: state.file.version,
    diskMissing: state.missing,
    revision: documentRevision(state.doc),
    dirty: state.phase !== "clean",
    conflict: state.phase === "conflict",
  };
}

export function encodeDocumentForPersistence(state: SharedDocumentState) {
  const yState = Buffer.from(Y.encodeStateAsUpdate(state.doc));
  if (yState.length > 8 << 20 || Buffer.byteLength(state.doc.getText("text").toString()) > 2 << 20)
    throw new CommandError(
      "invalid",
      "Shared document exceeds its size bound. Keep your local buffer.",
    );
  return {
    yState,
    diskVersion: state.diskVersion,
    syncState: state.phase,
  };
}
