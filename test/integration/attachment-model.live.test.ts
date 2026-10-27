import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { createAttachmentStore } from "../../apps/factory/src/attachments/store";
import { attachmentDigest } from "../../apps/factory/src/attachments/objects";
import { fixture } from "../fixtures/change-agent-turns";
import { ownedAttachmentS3 } from "../fixtures/attachment-s3";
import { attachmentDOCX, attachmentPDF, scannedAttachmentPDF } from "../fixtures/attachment-files";
import { attachmentMarkdown } from "../../packages/conversation-domain/src/attachments";
import { fixtureValue } from "../fixtures/value";

test.skipIf(process.env["FACTORY_ATTACHMENT_MODEL_LIVE"] !== "1")(
  "the configured planning model reads actual image, scanned/digital PDF and DOCX content through private S3 tools",
  async () => {
    projectModelConnection();
    const modelId = process.env["FACTORY_PROJECT_AGENT_MODEL"];
    if (!modelId) throw new Error("Configure the Planning model for this live proof");
    const s3 = await ownedAttachmentS3();
    const f = await fixture().catch(async (cause) => {
      await s3.dispose();
      throw cause;
    });
    try {
      const store = createAttachmentStore(f.database);
      const numbers = Array.from({ length: 4 }, () => String(randomInt(1000, 10000)));
      async function image(text: string) {
        const canvas = createCanvas(480, 180);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, 480, 180);
        context.fillStyle = "#000000";
        context.font = "72px sans-serif";
        context.fillText(text, 100, 120);
        return new Uint8Array(await canvas.encode("jpeg", 92));
      }
      const files = [
        {
          name: "visual.jpg",
          mediaType: "image/jpeg" as const,
          data: await image(fixtureValue(numbers[0], "numbers[0]")),
        },
        {
          name: "digital.pdf",
          mediaType: "application/pdf" as const,
          data: attachmentPDF(`Document code ${numbers[1]}`),
        },
        {
          name: "scan.pdf",
          mediaType: "application/pdf" as const,
          data: scannedAttachmentPDF(await image(fixtureValue(numbers[2], "numbers[2]")), 480, 180),
        },
        {
          name: "brief.docx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const,
          data: attachmentDOCX(`<w:p><w:r><w:t>Document code ${numbers[3]}</w:t></w:r></w:p>`),
        },
      ];
      const manifest = [];
      for (const file of files) {
        const input = {
          id: crypto.randomUUID(),
          projectId: f.projectID,
          name: file.name,
          mediaType: file.mediaType,
          bytes: file.data.length,
          sha256: attachmentDigest(file.data),
        };
        await store.begin(f.userID, input);
        manifest.push(await store.upload(f.userID, input.id, file.data));
      }
      const controller = createProjectAgentController(f.database, { start: async () => null });
      const view = await controller.message(
        f.projectID,
        undefined,
        [
          "Read all four attached files through attachment_read. Each contains a four-digit code, including the visual and scanned PDF. Report every filename and its code. Do not guess unread contents. Cite each inspected attachment separately.",
          ...manifest.map(attachmentMarkdown),
        ].join("\n\n"),
        f.userID,
        crypto.randomUUID(),
      );
      const output = view?.entries.findLast((entry) => entry.kind === "agent-message");
      for (const number of numbers) expect(output?.body).toContain(number);
      expect(view?.turn?.modelId).toBe(modelId);
      expect(new Set(output?.citations.map((citation) => citation.id)).size).toBe(4);
      expect(output?.citations.every((citation) => citation.source === "attachment")).toBe(true);
      const directory = resolve(".factory/test-results/attachments-model", f.projectID);
      await mkdir(directory, { recursive: true });
      await Bun.write(
        resolve(directory, "result.json"),
        JSON.stringify(
          { modelId, files: manifest, expectedCodes: numbers, turn: view?.turn?.id, output },
          null,
          2,
        ),
      );
    } finally {
      try {
        await f.dispose();
      } finally {
        await s3.dispose();
      }
    }
  },
  120_000,
);
