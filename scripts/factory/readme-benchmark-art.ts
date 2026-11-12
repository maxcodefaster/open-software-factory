// Render only measurements from the public, reproducible lifecycle fixture.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { z } from "zod";
import { summarizeLifecycle } from "../runtime/benchmark-model";

const root = resolve(import.meta.dir, "../..");
const sample = z.object({
  pauseMS: z.number().finite().nonnegative(),
  resumeToHealthyMS: z.number().finite().nonnegative(),
  beforeAnonBytes: z.number().int().nonnegative(),
  afterAnonBytes: z.number().int().nonnegative(),
  preserved: z.boolean(),
});
const evidence = z.object({
  measuredAt: z.string(),
  platform: z.string(),
  kernel: z.string(),
  fixture: z.literal("test/fixtures/runtime-project"),
  randomMemoryMiB: z.literal(256),
  runs: z.array(sample).min(1),
});
const source = resolve(root, "assets/story/lifecycle.json");
const data = evidence.parse(JSON.parse(await readFile(source, "utf8")));
const summary = summarizeLifecycle(data.runs);
if (summary.successfulRestores !== summary.samples || !summary.anonymousRAMReleased)
  throw new Error("Do not render success headlines for failed state or RAM checks");
GlobalFonts.registerFromPath(
  resolve(root, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  "Inter",
);
GlobalFonts.registerFromPath(
  resolve(root, "node_modules/@fontsource/sansita/files/sansita-latin-700-normal.woff2"),
  "Sansita",
);
const canvas = createCanvas(1600, 940);
const c = canvas.getContext("2d");
c.fillStyle = "#f1f5f9";
c.fillRect(0, 0, 1600, 940);
c.fillStyle = "#375d78";
c.font = "600 17px Inter";
c.fillText("FACTORYBOX / MEASURED ON A REAL KUBERNETES NODE", 80, 65);
c.fillStyle = "#142330";
c.font = "700 66px Sansita";
c.fillText("Pause compute. Keep progress.", 80, 156);
c.fillStyle = "#556678";
c.font = "400 24px Inter";
c.fillText("Same processes. Same memory. A successful App response after every resume.", 80, 211);
const stats = [
  {
    value: `${(summary.resumeToHealthy.medianMS / 1000).toFixed(1)} s`,
    label: "RESUME TO HEALTHY",
    note: "Median · includes Kubernetes transport",
  },
  {
    value: `${summary.successfulRestores}/${summary.samples}`,
    label: "STATE CHECKS PASSED",
    note: "Process, memory, counter and containers",
  },
  {
    value: "0 B",
    label: "ANONYMOUS RAM AFTER PAUSE",
    note: "Native capture receipt · storage retained",
  },
];
for (const [index, stat] of stats.entries()) {
  const x = 80 + index * 490;
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.roundRect(x, 274, 460, 215, 20);
  c.fill();
  c.fillStyle = "#142330";
  c.font = "700 70px Sansita";
  c.fillText(stat.value, x + 28, 357);
  c.fillStyle = "#375d78";
  c.font = "600 16px Inter";
  c.fillText(stat.label, x + 28, 401);
  c.fillStyle = "#556678";
  c.font = "400 16px Inter";
  c.fillText(stat.note, x + 28, 439);
}
const maximum = Math.max(
  1,
  Math.ceil(Math.max(...data.runs.flatMap((run) => [run.pauseMS, run.resumeToHealthyMS])) / 1000),
);
const top = 560,
  bottom = 757,
  left = 112,
  right = 1490;
c.font = "400 16px Inter";
c.lineWidth = 1;
for (let tick = 0; tick <= maximum; tick += Math.max(1, Math.ceil(maximum / 5))) {
  const y = bottom - (tick / maximum) * (bottom - top);
  c.strokeStyle = "#d6e0e9";
  c.beginPath();
  c.moveTo(left, y);
  c.lineTo(right, y);
  c.stroke();
  c.fillStyle = "#556678";
  c.fillText(`${tick} s`, 70, y + 6);
}
for (const [key, color] of [
  ["pauseMS", "#899caf"],
  ["resumeToHealthyMS", "#2c5a7a"],
] as const) {
  c.strokeStyle = color;
  c.lineWidth = 3;
  c.beginPath();
  data.runs.forEach((run, index) => {
    const x = left + (index / Math.max(1, data.runs.length - 1)) * (right - left);
    const y = bottom - (run[key] / 1000 / maximum) * (bottom - top);
    if (index === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  });
  c.stroke();
  for (const [index, run] of data.runs.entries()) {
    const x = left + (index / Math.max(1, data.runs.length - 1)) * (right - left);
    const y = bottom - (run[key] / 1000 / maximum) * (bottom - top);
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2);
    c.fill();
  }
}
c.fillStyle = "#556678";
c.font = "400 17px Inter";
c.fillText(`Cycle 1`, left, bottom + 31);
c.fillText(`Cycle ${data.runs.length}`, right - 70, bottom + 31);
c.fillText(
  `Pause (grey) · Resume to healthy (blue) · p95 ${(summary.resumeToHealthy.p95MS / 1000).toFixed(1)} s`,
  370,
  bottom + 31,
);
c.fillText(
  `${data.platform} · kernel ${data.kernel} · ${data.measuredAt.slice(0, 10)} · ${summary.samples} cycles on one warmed environment`,
  80,
  860,
);
c.fillText(
  "Two-service demo + 256 MiB random memory. Not a provider comparison or an enterprise workload benchmark.",
  80,
  895,
);
await writeFile(resolve(root, "assets/story/lifecycle.png"), await canvas.encode("png"));
console.log(summary);
