import { createCanvas, loadImage, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { unzipSync } from "fflate";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { fileURLToPath } from "node:url";

import type { ConvertedAttachment } from "./conversion-result";
const maximumDerivedBytes = 100 * 1024 * 1024;
const maximumTextBytes = 1024 * 1024;

export function attachmentImageDimensions(data: Uint8Array) {
  const bytes = Buffer.from(data);
  if (bytes[0] === 137 && bytes.length >= 24) {
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      if (offset + length + 12 > bytes.length) break;
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        throw new Error("This image is animated. Attach static frames instead.");
      offset += length + 12;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker ?? 0))
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
    return null;
  }
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    if ((bytes[20] ?? 0) & 2)
      throw new Error("This image is animated. Attach static frames instead.");
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && bytes.length >= 30)
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  return null;
}

export function validateAttachmentType(data: Uint8Array, mediaType: string) {
  const first = Buffer.from(data.subarray(0, 16));
  const valid =
    mediaType === "image/png"
      ? first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mediaType === "image/jpeg"
        ? first[0] === 255 && first[1] === 216 && first[2] === 255
        : mediaType === "image/webp"
          ? first.toString("ascii", 0, 4) === "RIFF" && first.toString("ascii", 8, 12) === "WEBP"
          : mediaType === "application/pdf"
            ? first.toString("ascii", 0, 5) === "%PDF-"
            : mediaType.endsWith("wordprocessingml.document")
              ? first[0] === 80 && first[1] === 75 && first[2] === 3 && first[3] === 4
              : !data.includes(0);
  if (!valid) throw new Error("The file content does not match its supported file type.");
}

async function imagePreview(data: Uint8Array) {
  // Bound every supported header before a native decoder can allocate pixels.
  const dimensions = attachmentImageDimensions(data);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1)
    throw new Error("This image has an unsupported or invalid header.");
  if (dimensions.width * dimensions.height > 40_000_000)
    throw new Error("This image exceeds the 40 megapixel processing limit.");
  const image = await loadImage(Buffer.from(data));
  if (!image.width || !image.height || image.width * image.height > 40_000_000)
    throw new Error("This image exceeds the 40 megapixel processing limit.");
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const canvas = createCanvas(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Uint8Array(await canvas.encode("jpeg", 85));
}

export async function convertAttachment(
  data: Uint8Array,
  mediaType: string,
): Promise<ConvertedAttachment> {
  validateAttachmentType(data, mediaType);
  const result: ConvertedAttachment = { text: "", previews: [] };
  if (mediaType.startsWith("image/")) {
    result.previews.push({
      name: "Image",
      mediaType: "image/jpeg",
      data: await imagePreview(data),
    });
  } else if (mediaType.startsWith("text/")) {
    try {
      result.text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new Error("Text files must contain valid UTF-8.");
    }
  } else if (mediaType === "application/pdf") {
    // PDF scripting and external resource fetching are not enabled. Render scanned
    // pages as well as digital pages; text extraction alone is not visual context.
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(data),
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      stopAtErrors: true,
      maxImageSize: 40_000_000,
      canvasMaxAreaInBytes: 1600 * 1600 * 4,
      standardFontDataUrl: fileURLToPath(
        new URL("./standard_fonts/", import.meta.resolve("pdfjs-dist/package.json")),
      ),
      cMapUrl: fileURLToPath(new URL("./cmaps/", import.meta.resolve("pdfjs-dist/package.json"))),
      wasmUrl: fileURLToPath(new URL("./wasm/", import.meta.resolve("pdfjs-dist/package.json"))),
    });
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 200)
        throw new Error(
          "This PDF exceeds the 200-page processing limit. Attach a smaller document.",
        );
      let derivedBytes = 0;
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const raw = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(2, 1600 / Math.max(raw.width, raw.height)),
        });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
        const image = new Uint8Array(await canvas.encode("jpeg", 85));
        derivedBytes += image.byteLength;
        if (derivedBytes > maximumDerivedBytes)
          throw new Error(
            "Rendered pages exceed the 100 MiB processing limit. Attach a smaller PDF.",
          );
        result.previews.push({ name: `Page ${index}`, mediaType: "image/jpeg", data: image });
        const text = await page.getTextContent();
        result.text += `\n\n## Page ${index}\n${text.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("")}`;
        if (Buffer.byteLength(result.text) > maximumTextBytes)
          throw new Error("Extracted text exceeds 1 MiB. Attach a smaller document.");
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  } else {
    let expanded = 0;
    const entries = unzipSync(data, {
      filter: (file) => {
        expanded += file.originalSize;
        if (expanded > 64 * 1024 * 1024 || file.originalSize > 25 * 1024 * 1024)
          throw new Error("This DOCX expands beyond the safe processing limit.");
        return true;
      },
    });
    if (!entries["word/document.xml"] || entries["word/vbaProject.bin"])
      throw new Error("Use a regular DOCX without macros.");
    for (const [path, bytes] of Object.entries(entries)) {
      if (!path.endsWith(".xml")) continue;
      const xml = new TextDecoder().decode(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new Error("This DOCX contains unsupported XML declarations. Export it as PDF.");
      if (
        /^word\/(?:header|footer)\d*\.xml$/.test(path) &&
        /<(?:\w+:)?(?:t|drawing|pict)(?:\s|>)/.test(xml)
      )
        throw new Error(
          "This DOCX contains header or footer content that requires PDF export to preserve it.",
        );
    }
    if (Object.keys(entries).some((path) => /^word\/(?:charts|diagrams|embeddings)\//.test(path)))
      throw new Error("This DOCX contains diagrams or embedded objects. Export it as PDF.");
    const document = new TextDecoder().decode(entries["word/document.xml"]);
    if (/<(?:\w+:)?(?:object|pict|altChunk|chart|sp|wsp|wgp)\b/.test(document))
      throw new Error(
        "This DOCX contains drawings or embedded objects that cannot be read faithfully. Export it as PDF and attach that instead.",
      );
    const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).use(
      gfm,
    );
    const converted = await mammoth.convertToHtml(
      { buffer: Buffer.from(data) },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          if (!["image/png", "image/jpeg", "image/webp"].includes(image.contentType))
            throw new Error("This DOCX contains an unsupported embedded image. Export it as PDF.");
          const bytes = new Uint8Array(await image.read());
          validateAttachmentType(bytes, image.contentType);
          const index = result.previews.length + 1;
          result.previews.push({
            name: `Embedded image ${index}`,
            mediaType: "image/jpeg",
            data: await imagePreview(bytes),
          });
          return { src: `attachment-image-${index}`, alt: `Embedded image ${index}` };
        }),
      },
    );
    const unsupported = converted.messages.filter((message) =>
      /unrecogni[sz]ed|unsupported|could not|ignored/i.test(message.message),
    );
    if (unsupported.length)
      throw new Error(
        "Parts of this DOCX cannot be read faithfully. Export it as PDF and attach that instead.",
      );
    result.text = markdown.turndown(converted.value);
  }
  if (Buffer.byteLength(result.text) > maximumTextBytes)
    throw new Error("Extracted text exceeds 1 MiB. Attach a smaller document.");
  if (
    result.previews.reduce((sum, preview) => sum + preview.data.byteLength, 0) > maximumDerivedBytes
  )
    throw new Error("Image processing exceeds 100 MiB. Attach a smaller document.");
  return result;
}
