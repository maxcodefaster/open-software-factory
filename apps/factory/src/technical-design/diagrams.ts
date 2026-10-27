import { z } from "zod";
import {
  architectureDiagramInput,
  type TechnicalDesignContent,
} from "../../../../packages/requirement-domain/src/technical-design";

export const diagramRendererVersion = "plantuml-mcp-js@0.2.3/viz@3.31.0";
let active = 0;
const renderedDiagram = z.object({
  valid: z.boolean(),
  svg: z.string().max(512_000).optional(),
  errorMessage: z.string().optional(),
});

export async function renderArchitectureDiagram(
  diagram: TechnicalDesignContent["diagrams"][number],
): Promise<string> {
  architectureDiagramInput.parse(diagram);
  if (active >= 2) throw new Error("Diagram rendering is busy. Try again after it finishes.");
  active++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./diagram-worker.ts", import.meta.url).href, {
      env: {},
      preload: [],
    });
    const running = worker;
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The diagram took too long to render.")), 10_000);
      running.onerror = () => reject(new Error("The diagram renderer failed."));
      running.onmessage = (event: MessageEvent<{ result?: unknown; error?: string }>) => {
        const result = renderedDiagram.safeParse(event.data.result);
        if (!result.success || !result.data.valid || !result.data.svg) {
          reject(new Error(event.data.error ?? "Correct the PlantUML diagram before saving."));
          return;
        }
        const svg = result.data.svg;
        if (
          !svg.includes("<svg") ||
          /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|@import|url\(\s*["']?(?!#)|<(?:script|foreignObject|iframe|image|audio|video|animate|animateTransform|animateMotion|set|handler|listener)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)/i.test(
            svg,
          )
        ) {
          reject(new Error("The diagram contains unsupported active or external content."));
          return;
        }
        resolve(svg);
      };
      running.postMessage({ source: diagram.source });
    });
  } finally {
    if (timer) clearTimeout(timer);
    worker?.terminate();
    active--;
  }
}

export async function renderArchitectureDiagrams(content: TechnicalDesignContent) {
  const renders: string[] = [];
  for (const diagram of content.diagrams) renders.push(await renderArchitectureDiagram(diagram));
  return renders;
}
