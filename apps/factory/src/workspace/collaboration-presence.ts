import { createHash } from "node:crypto";
import { and, eq, gt, sql as query } from "drizzle-orm";
import * as Y from "yjs";
import type { createDatabase } from "#db/client";
import { authSession, authUser, oauthClient } from "#db/schema";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { SharedSyncInput } from "./collaboration-document";

export type CollaborationActor = {
  userID: string;
  sessionID: string;
  kind: "person" | "agent";
  oauthClientID?: string;
};

type Presence = {
  oauthClientID?: string;
  workspaceID: string;
  path: string;
  userID: string;
  sessionID: string;
  kind: "person" | "agent";
  participantID: string;
  clientID: number;
  name: string;
  color: string;
  cursor: { anchor: string; head: string } | null;
  seen: number;
};

const PRESENCE_TTL_MS = 30_000;
const MAX_WORKSPACE_PARTICIPANTS = 256;
const PARTICIPANT_COLORS = ["#375dc5", "#a23c69", "#137363", "#8f5a12", "#7b46b3", "#a44032"];

function participantColor(userID: string) {
  const hash = parseInt(createHash("sha256").update(userID).digest("hex").slice(0, 8), 16);
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length] ?? PARTICIPANT_COLORS[0] ?? "#375dc5";
}

export class CollaborationPresenceRoom {
  readonly #database: ReturnType<typeof createDatabase>;
  readonly #presence = new Map<string, Presence>();

  constructor(database: ReturnType<typeof createDatabase>) {
    this.#database = database;
  }

  #pruneExpired() {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [id, peer] of this.#presence) {
      if (peer.seen < cutoff) this.#presence.delete(id);
    }
  }

  async participants(workspaceID: string, userID: string, path?: string) {
    await this.#database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, userID));
    this.#pruneExpired();
    const peers = [...this.#presence.values()].filter(
      (peer) => peer.workspaceID === workspaceID && (!path || peer.path === path),
    );
    const allowed = new Map<string, boolean>();
    for (const peer of peers) {
      const key = `${peer.userID}:${peer.sessionID}`;
      if (!allowed.has(key)) {
        const [session] = await this.#database.db
          .select({ id: authSession.id })
          .from(authSession)
          .where(
            and(
              eq(authSession.id, peer.sessionID),
              eq(authSession.userId, peer.userID),
              gt(authSession.expiresAt, query`now()`),
            ),
          );
        try {
          await this.#database.client.begin((sql) =>
            workspaceAuthorityIn(sql, workspaceID, peer.userID),
          );
          allowed.set(key, Boolean(session));
        } catch {
          allowed.set(key, false);
        }
      }
    }
    return peers
      .filter((peer) => allowed.get(`${peer.userID}:${peer.sessionID}`))
      .map(({ sessionID: _session, seen: _seen, workspaceID: _workspace, ...peer }) => peer);
  }

  async touch(
    workspaceID: string,
    path: string,
    actor: CollaborationActor,
    input: SharedSyncInput,
  ) {
    this.#pruneExpired();
    const previous = this.#presence.get(input.participantID);
    if (
      !previous &&
      [...this.#presence.values()].filter((peer) => peer.workspaceID === workspaceID).length >=
        MAX_WORKSPACE_PARTICIPANTS
    )
      throw new CommandError("unavailable", "Workspace participant limit reached");
    if (
      previous &&
      (previous.userID !== actor.userID ||
        previous.sessionID !== actor.sessionID ||
        previous.oauthClientID !== actor.oauthClientID)
    )
      throw new CommandError("conflict", "Participant identity belongs to another connection");
    if (
      [...this.#presence.values()].some(
        (peer) =>
          peer.workspaceID === workspaceID &&
          peer.path === path &&
          peer.clientID === input.clientID &&
          peer.participantID !== input.participantID &&
          peer.seen > Date.now() - PRESENCE_TTL_MS,
      )
    )
      throw new CommandError("conflict", "Document client identity is already connected");
    const [person] = await this.#database.db
      .select({ name: query<string>`left(${authUser.name},160)` })
      .from(authUser)
      .where(eq(authUser.id, actor.userID));
    const [client] = actor.oauthClientID
      ? await this.#database.db
          .select({ name: query<string | null>`left(${oauthClient.name},80)` })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, actor.oauthClientID))
      : [];
    this.#presence.set(input.participantID, {
      workspaceID,
      path,
      ...actor,
      participantID: input.participantID,
      clientID: input.clientID,
      name: `${person?.name ?? "Developer"}${actor.kind === "agent" ? ` · ${client?.name ?? "local agent"}` : ""}`,
      color: participantColor(actor.userID),
      cursor: input.cursor ?? null,
      seen: Date.now(),
    });
  }

  async touchAgentEdit(workspaceID: string, path: string, actor: CollaborationActor, doc: Y.Doc) {
    const text = doc.getText("text");
    const previous = [...this.#presence.values()].find(
      (peer) =>
        peer.workspaceID === workspaceID &&
        peer.path === path &&
        peer.sessionID === actor.sessionID &&
        peer.oauthClientID === actor.oauthClientID &&
        peer.kind === "agent",
    );
    const position = Y.createRelativePositionFromTypeIndex(text, text.length);
    const encoded = Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
    await this.touch(workspaceID, path, actor, {
      path,
      participantID: previous?.participantID ?? crypto.randomUUID(),
      clientID: previous?.clientID ?? doc.clientID,
      vector: "",
      cursor: { anchor: encoded, head: encoded },
    });
  }

  revoke(workspaceID: string, userID: string) {
    for (const [id, peer] of this.#presence)
      if (peer.workspaceID === workspaceID && peer.userID === userID) this.#presence.delete(id);
  }

  clear() {
    this.#presence.clear();
  }
}
