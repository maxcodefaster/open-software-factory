import { strToU8, zipSync } from "fflate";
import { fixtureValue } from "./value";

function pdf(objects: (string | Uint8Array)[]) {
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = fixtureValue(chunks[0], "chunks[0]").length;
  for (const [index, value] of objects.entries()) {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      typeof value === "string" ? Buffer.from(value) : value,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(object);
    length += object.length;
  }
  const xref = length;
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(chunks));
}
export function attachmentPDF(text: string) {
  const stream = `BT /F1 18 Tf 30 100 Td (${text}) Tj ET`;
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]);
}
export function scannedAttachmentPDF(jpeg: Uint8Array, width: number, height: number) {
  const stream = `q ${width} 0 0 ${height} 0 0 cm /Image Do Q`;
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Image 4 0 R >> >> /Contents 5 0 R >>`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]);
}
export function attachmentDOCX(
  content = "<w:p><w:r><w:t>Reference requirement 7319</w:t></w:r></w:p>",
  extra: Record<string, Uint8Array> = {},
) {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}</w:body></w:document>`,
    ),
    ...extra,
  });
}
