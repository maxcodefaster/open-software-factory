import { and, asc, eq, sql as query } from "drizzle-orm";
import {
  attachmentIDs,
  attachmentToolCallInput,
  attachmentToolCatalogue,
} from "../../../../packages/conversation-domain/src/attachments";
import type { BuildBrowserResult } from "../../../../packages/conversation-domain/src/browser-tools";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { attachment, attachmentReference } from "../../../../packages/db/src/schema";
import { createAgentTurnStore } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { attachmentContextIn, createAttachmentStore, readableAttachmentIn } from "./store";

export function createAttachmentTools(
  database: ReturnType<typeof createDatabase>,
  store = createAttachmentStore(database),
) {
  const turns = createAgentTurnStore(database);
  async function authorize(turnID: string, token: string, id?: string) {
    const turn = await turns.get(turnID);
    if (!turn || !(await turns.validateExecution(turnID, token)))
      throw new CommandError("forbidden", "Attachment access no longer owns this task.");
    if (id) {
      const [reference] = await database.db
        .select({ attachmentId: attachmentReference.attachmentId })
        .from(attachmentReference)
        .where(
          and(
            eq(attachmentReference.kind, "turn"),
            eq(attachmentReference.referenceId, turnID),
            eq(attachmentReference.attachmentId, id),
          ),
        );
      if (!reference)
        throw new CommandError("not-found", "This file is not admitted for this task.");
    }
    return turn;
  }
  return {
    tools: () => attachmentToolCatalogue,
    async discover(turnID: string, token: string, content: string) {
      const turn = await authorize(turnID, token);
      const current = await turns.validateExecution(turnID, token, async (sql) => {
        for (const id of attachmentIDs(content)) {
          const asset = await readableAttachmentIn(sql, turn.command.createdBy, id);
          if (asset.projectId !== turn.command.projectId || asset.state !== "ready")
            throw new CommandError("not-found", "Source attachment is unavailable.");
          await drizzleTransaction(sql)
            .insert(attachmentReference)
            .values({ attachmentId: id, kind: "turn", referenceId: turnID, shared: false })
            .onConflictDoNothing();
        }
      });
      if (!current) throw new CommandError("forbidden", "Source attachment authority changed.");
    },
    async call(turnID: string, token: string, raw: unknown): Promise<BuildBrowserResult> {
      const call = attachmentToolCallInput.parse(raw);
      const turn = await authorize(
        turnID,
        token,
        call.name === "attachment_read" ? call.arguments.id : undefined,
      );
      if (call.name === "attachment_list") {
        const files = await database.db
          .select({
            id: attachment.id,
            name: attachment.name,
            mediaType: attachment.mediaType,
            sha256: attachment.sha256,
            pages: query<number>`jsonb_array_length(${attachment.objects})-1`,
            textCharacters: query<number>`length(${attachment.textContent})`,
          })
          .from(attachment)
          .innerJoin(attachmentReference, eq(attachmentReference.attachmentId, attachment.id))
          .where(
            and(
              eq(attachmentReference.kind, "turn"),
              eq(attachmentReference.referenceId, turnID),
              eq(attachment.projectId, turn.command.projectId),
              eq(attachment.state, "ready"),
            ),
          )
          .orderBy(asc(attachment.createdAt), asc(attachment.id))
          .limit(41)
          .offset(call.arguments.offset);
        const context = await database.client.begin((sql) => attachmentContextIn(sql, turnID));
        const offset = call.arguments.contextOffset;
        if (offset > context.length)
          throw new CommandError("conflict", "Attachment context offset is out of range.");
        await authorize(turnID, token);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                files: files.slice(0, 40),
                nextOffset: files.length > 40 ? call.arguments.offset + 40 : null,
                context: context.slice(offset, offset + 16000),
                nextContextOffset: context.length > offset + 16000 ? offset + 16000 : null,
              }),
            },
          ],
        };
      }
      const result = await store.modelRead(
        turn.command.createdBy,
        turn.command.projectId,
        call.arguments.id,
        call.arguments.page,
        call.arguments.offset,
      );
      await authorize(turnID, token, call.arguments.id);
      const { image, mediaType, ...text } = result;
      const images: Array<{ type: "image"; mimeType: "image/jpeg"; data: string }> = [];
      if (image) {
        if (!mediaType)
          throw new CommandError("unavailable", "Attachment image format is missing.");
        images.push({ type: "image", mimeType: mediaType, data: image });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(text) }, ...images],
      };
    },
  };
}
