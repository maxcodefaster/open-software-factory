// Reframe the existing public demo screenshots; never invent or repaint UI.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "assets/story");
await mkdir(output, { recursive: true });
GlobalFonts.registerFromPath(
  resolve(root, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  "Inter",
);
GlobalFonts.registerFromPath(
  resolve(root, "node_modules/@fontsource/sansita/files/sansita-latin-700-normal.woff2"),
  "Sansita",
);
const scenes = [
  {
    name: "hero",
    image: "board",
    label: "SOFTWARE FACTORY FOR ENTERPRISE TEAMS",
    lines: ["Your cloud. Your workflow.", "Your software factory."],
    caption: "Business intent → implementation → verified delivery",
  },
  {
    name: "intent",
    image: "spec",
    label: "01 / DEFINE THE OUTCOME",
    lines: ["Start with the business.", "Keep the decision yours."],
    caption: "Shared requirements. Explicit acceptance criteria. Human approval.",
  },
  {
    name: "build",
    image: "ide",
    label: "02 / BUILD IN ISOLATION",
    lines: ["Real code. Real tools.", "Your development environment."],
    caption: "Your Dev Container. Private Docker. Source and running services.",
  },
  {
    name: "deliver",
    image: "review",
    label: "03 / VERIFY BEFORE DELIVERY",
    lines: ["Evidence before confidence.", "Approval before delivery."],
    caption: "Exact-commit checks, independent review and recorded App QA.",
  },
];
const provenance = [];
for (const scene of scenes) {
  const source = resolve(root, `assets/screens/${scene.image}.jpg`);
  const bytes = await readFile(source);
  const image = await loadImage(bytes);
  const screenshotHeight = scene.name === "hero" ? 420 : 900;
  const canvasHeight = 348 + screenshotHeight + 52;
  const canvas = createCanvas(1600, canvasHeight);
  const context = canvas.getContext("2d");
  const background = context.createLinearGradient(0, 0, 1600, canvasHeight);
  background.addColorStop(0, "#f6f8fb");
  background.addColorStop(1, "#e7edf4");
  context.fillStyle = background;
  context.fillRect(0, 0, 1600, canvasHeight);
  context.fillStyle = "#375d78";
  context.font = "600 17px Inter";
  context.fillText(scene.label, 80, 65);
  context.fillStyle = "#142330";
  context.font = "700 66px Sansita";
  scene.lines.forEach((line, index) => {
    context.fillText(line, 80, 153 + index * 80);
  });
  context.fillStyle = "#556678";
  context.font = "400 23px Inter";
  context.fillText(scene.caption, 80, 287);
  // Published images already include an outer frame. Crop that frame only;
  // every displayed UI pixel remains an unmodified screenshot pixel.
  const x = 80,
    y = 348,
    width = 1440,
    height = screenshotHeight;
  context.save();
  context.shadowColor = "#17314926";
  context.shadowBlur = 36;
  context.shadowOffsetY = 18;
  context.fillStyle = "#eef2f5";
  context.beginPath();
  context.roundRect(x, y, width, height, 24);
  context.fill();
  context.restore();
  context.save();
  context.beginPath();
  context.roundRect(x, y, width, height, 24);
  context.clip();
  context.drawImage(image, 80, 50, 1440, screenshotHeight, x, y, width, height);
  context.restore();
  const rendered = await canvas.encode("png");
  await writeFile(resolve(output, `${scene.name}.png`), rendered);
  provenance.push({
    output: `${scene.name}.png`,
    source: `../screens/${scene.image}.jpg`,
    sourceSHA256: createHash("sha256").update(bytes).digest("hex"),
    outputSHA256: createHash("sha256").update(rendered).digest("hex"),
    presentationOnly: true,
    imageSize: [1600, canvasHeight],
    bytes: rendered.length,
  });
}
await writeFile(
  resolve(output, "provenance.json"),
  `${JSON.stringify(
    {
      purpose: "Presentation of existing public demo screenshots, not new live proof",
      generator: "scripts/factory/readme-art.ts",
      images: provenance,
    },
    null,
    2,
  )}\n`,
);
console.log(provenance.map(({ output, bytes }) => ({ output, bytes })));
