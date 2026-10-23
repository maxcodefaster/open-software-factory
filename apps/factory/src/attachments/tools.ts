import {
  attachmentToolCallInput,
  attachmentToolCatalogue,
  attachmentIDs,
} from "../../../../packages/conversation-domain/src/attachments";
import type { BuildBrowserResult } from "../../../../packages/conversation-domain/src/browser-tools";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createAgentTurnStore } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { createAttachmentStore, readableAttachmentIn, attachmentContextIn } from "./store";

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
      const [reference] =
        await database.client`SELECT attachment_id FROM factory.attachment_reference
        WHERE kind='turn' AND reference_id=${turnID} AND attachment_id=${id}`;
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
          await sql`INSERT INTO factory.attachment_reference(attachment_id,kind,reference_id,shared)
            VALUES(${id},'turn',${turnID},false) ON CONFLICT DO NOTHING`;
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
        const files = await database.client`SELECT a.id,a.name,a.media_type AS "mediaType",a.sha256,
          jsonb_array_length(a.objects)-1 AS pages,length(a.text_content) AS "textCharacters"
          FROM factory.attachment a JOIN factory.attachment_reference r ON r.attachment_id=a.id
          WHERE r.kind='turn' AND r.reference_id=${turnID} AND a.project_id=${turn.command.projectId} AND a.state='ready'
          ORDER BY a.created_at,a.id LIMIT 41 OFFSET ${call.arguments.offset}`;
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
      return {
        content: [
          { type: "text", text: JSON.stringify(text) },
          ...(image ? [{ type: "image" as const, mimeType: mediaType!, data: image }] : []),
        ],
      };
    },
  };
}
