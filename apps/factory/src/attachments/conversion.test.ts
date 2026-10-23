import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { strToU8 } from "fflate";
import {
  attachmentDOCX,
  attachmentPDF,
  scannedAttachmentPDF,
} from "../../../../test/fixtures/attachment-files";
import { convertAttachment, processAttachment, validateAttachmentType } from "./conversion";

test("attachment conversion retains digital PDF text and actual page pixels", async () => {
  const result = await convertAttachment(attachmentPDF("Reference 7319"), "application/pdf");
  expect(result.text).toContain("Reference 7319");
  expect(result.previews).toHaveLength(1);
  const image = await loadImage(Buffer.from(result.previews[0]!.data));
  expect(image.width).toBeGreaterThan(100);
  expect(image.height).toBeGreaterThan(50);
});

test("the isolated conversion worker returns real image context and UTF-8 documents", async () => {
  const canvas = createCanvas(80, 40);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 80, 40);
  const result = await processAttachment(new Uint8Array(await canvas.encode("png")), "image/png");
  const image = await loadImage(Buffer.from(result.previews[0]!.data));
  const decoded = createCanvas(80, 40);
  decoded.getContext("2d").drawImage(image, 0, 0);
  expect(decoded.getContext("2d").getImageData(20, 20, 1, 1).data[0]).toBeGreaterThan(240);
  expect((await convertAttachment(strToU8("Änderung 7319"), "text/plain")).text).toBe(
    "Änderung 7319",
  );
});

test("scanned PDF pages remain images even when they contain no extractable text", async () => {
  const canvas = createCanvas(160, 80);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0055ff";
  context.fillRect(0, 0, 160, 80);
  const result = await convertAttachment(
    scannedAttachmentPDF(new Uint8Array(await canvas.encode("jpeg", 90)), 160, 80),
    "application/pdf",
  );
  expect(result.previews).toHaveLength(1);
  expect(result.text).not.toContain("0055ff");
  const decoded = createCanvas(320, 160);
  decoded.getContext("2d").drawImage(await loadImage(Buffer.from(result.previews[0]!.data)), 0, 0);
  expect(decoded.getContext("2d").getImageData(30, 30, 1, 1).data[2]).toBeGreaterThan(230);
});

test("DOCX keeps text and tables, while unsupported drawings fail explicitly", async () => {
  const result = await convertAttachment(
    attachmentDOCX(
      "<w:p><w:r><w:t>Reference requirement 7319</w:t></w:r></w:p>" +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Scope</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
    ),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  expect(result.text).toContain("Reference requirement 7319");
  expect(result.text).toContain("Owner");
  expect(result.text).toContain("Scope");
  await expect(
    convertAttachment(
      attachmentDOCX("<w:pict/>"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
  ).rejects.toThrow("PDF");
});

test("DOCX embedded images become actual model-readable previews beside extracted text", async () => {
  const canvas = createCanvas(80, 40);
  canvas.getContext("2d").fillStyle = "#0055ff";
  canvas.getContext("2d").fillRect(0, 0, 80, 40);
  const result = await convertAttachment(
    attachmentDOCX(
      "<w:p><w:r><w:t>Inspect the blue reference.</w:t></w:r></w:p>" +
        '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>' +
        '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImage"/>' +
        "</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
      {
        "word/_rels/document.xml.rels": strToU8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/reference.png"/>' +
            "</Relationships>",
        ),
        "word/media/reference.png": new Uint8Array(await canvas.encode("png")),
      },
    ),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  expect(result.text).toContain("Inspect the blue reference.");
  expect(result.text).toContain("Embedded image 1");
  expect(result.previews).toHaveLength(1);
  const decoded = createCanvas(80, 40);
  decoded.getContext("2d").drawImage(await loadImage(Buffer.from(result.previews[0]!.data)), 0, 0);
  expect(decoded.getContext("2d").getImageData(30, 20, 1, 1).data[2]).toBeGreaterThan(230);
});

test("file types, binary text and decompression dimensions are validated before publication", async () => {
  expect(() => validateAttachmentType(strToU8("<html>not an image</html>"), "image/png")).toThrow(
    "file type",
  );
  expect(() => validateAttachmentType(new Uint8Array([0, 1]), "text/plain")).toThrow();
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  view.setUint32(16, 100000);
  view.setUint32(20, 100000);
  await expect(convertAttachment(png, "image/png")).rejects.toThrow("megapixel");
});
