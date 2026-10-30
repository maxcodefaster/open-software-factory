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

class DiagramRenderFailure extends Error {
  constructor(
    readonly reason: "busy" | "unavailable" | "invalid" | "timeout" | "unsafe",
    message: string,
  ) {
    super(message);
    this.name = "DiagramRenderFailure";
  }
}

export async function renderArchitectureDiagram(
  diagram: TechnicalDesignContent["diagrams"][number],
): Promise<string> {
  architectureDiagramInput.parse(diagram);
  if (active >= 2)
    throw new DiagramRenderFailure(
      "busy",
      "Diagram rendering is busy. Try again after it finishes.",
    );
  active++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      worker = new Worker(new URL("./diagram-worker.ts", import.meta.url).href, {
        env: {},
        preload: [],
      });
    } catch {
      throw new DiagramRenderFailure("unavailable", "The diagram renderer could not start.");
    }
    const running = worker;
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new DiagramRenderFailure("timeout", "The diagram took too long to render.")),
        10_000,
      );
      running.onerror = () =>
        reject(new DiagramRenderFailure("unavailable", "The diagram renderer failed."));
      running.onmessage = (event: MessageEvent<{ result?: unknown; error?: string }>) => {
        const result = renderedDiagram.safeParse(event.data.result);
        if (!result.success || !result.data.valid || !result.data.svg) {
          reject(
            new DiagramRenderFailure(
              result.success && !result.data.valid ? "invalid" : "unavailable",
              event.data.error ?? "Correct the PlantUML diagram before saving.",
            ),
          );
          return;
        }
        const svg = result.data.svg;
        if (
          !svg.includes("<svg") ||
          /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|@import|url\(\s*["']?(?!#)|<(?:script|foreignObject|iframe|image|audio|video|animate|animateTransform|animateMotion|set|handler|listener)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)/i.test(
            svg,
          )
        ) {
          reject(
            new DiagramRenderFailure(
              "unsafe",
              "The diagram contains unsupported active or external content.",
            ),
          );
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

export function renderArchitectureDiagrams(content: TechnicalDesignContent): Promise<string[]>;
export function renderArchitectureDiagrams(
  content: TechnicalDesignContent,
  options: { allowUnrendered: true },
): Promise<(string | null)[]>;
export async function renderArchitectureDiagrams(
  content: TechnicalDesignContent,
  options?: { allowUnrendered: true },
) {
  const renders: (string | null)[] = [];
  for (const diagram of content.diagrams) {
    try {
      renders.push(await renderArchitectureDiagram(diagram));
    } catch (cause) {
      // Only a failed optional rendering can be retained as unavailable.
      // Source validation, unsafe SVG and unexpected publication errors remain hard failures.
      if (
        !options?.allowUnrendered ||
        !(cause instanceof DiagramRenderFailure) ||
        cause.reason === "unsafe"
      )
        throw cause;
      renders.push(null);
    }
  }
  return renders;
}
