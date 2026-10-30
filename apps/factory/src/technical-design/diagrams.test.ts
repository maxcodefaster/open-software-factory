import { expect, test } from "bun:test";
import { architectureDiagramInput } from "../../../../packages/requirement-domain/src/technical-design";
import { renderArchitectureDiagram, renderArchitectureDiagrams } from "./diagrams";

const diagram = (source: string) => ({
  title: "Ticket planning",
  description: "Owned flow",
  source,
});

const design = (source: string) => ({
  context: "The existing setup should remain usable without private references.",
  proposedChanges: "Separate optional reference downloads from the normal setup.",
  decisions: ["Keep all existing verification assertions."],
  assumptions: [],
  risks: [],
  validation: [{ criterion: 1, check: "Run setup without private repository access." }],
  diagrams: [diagram(source)],
});

test("an invalid optional render retains the exact design instead of losing the planning response", async () => {
  const content = design("@startuml\nthis is invalid syntax\n@enduml");
  await expect(renderArchitectureDiagrams(content, { allowUnrendered: true })).resolves.toEqual([
    null,
  ]);
  expect(content.diagrams[0]?.source).toBe("@startuml\nthis is invalid syntax\n@enduml");
});

test("optional rendering never relaxes the source safety boundary", async () => {
  await expect(
    renderArchitectureDiagrams(
      design("@startuml\n!includeurl https://example.invalid/private\n@enduml"),
      { allowUnrendered: true },
    ),
  ).rejects.toThrow("self-contained PlantUML");
});

test("busy optional rendering does not start another worker or lose the design", async () => {
  const first = renderArchitectureDiagram(diagram("@startuml\nAlice -> Bob: First\n@enduml"));
  const second = renderArchitectureDiagram(diagram("@startuml\nAlice -> Bob: Second\n@enduml"));
  try {
    expect(
      await renderArchitectureDiagrams(design("@startuml\nAlice -> Bob: Third\n@enduml"), {
        allowUnrendered: true,
      }),
    ).toEqual([null]);
    expect(await first).toContain("<svg");
    expect(await second).toContain("<svg");
  } finally {
    await Promise.allSettled([first, second]);
  }
});

test("unsafe renderer output is rejected even when optional rendering may be unavailable", async () => {
  const OriginalWorker = globalThis.Worker;
  globalThis.Worker = new Proxy(OriginalWorker, {
    construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker;
      worker.postMessage = () => {
        queueMicrotask(() =>
          worker.onmessage?.(
            new MessageEvent("message", {
              data: { result: { valid: true, svg: "<svg><script>alert(1)</script></svg>" } },
            }),
          ),
        );
      };
      return worker;
    },
  });
  try {
    await expect(
      renderArchitectureDiagrams(design("@startuml\nAlice -> Bob: Safe input\n@enduml"), {
        allowUnrendered: true,
      }),
    ).rejects.toThrow("unsupported active or external content");
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});

test("renders real component and sequence diagrams with the pinned headless engine", async () => {
  for (const source of [
    "@startuml\n[Product] --> [Technical design]\n[Technical design] --> [Coding]\n@enduml",
    "@startuml\nUser -> Factory: Confirm requirements\nFactory -> Planner: Read pinned code\nPlanner --> User: Technical design\n@enduml",
    "@startuml TicketPlanning\nUser -> Factory: Confirm requirements\n@enduml",
  ]) {
    const svg = await renderArchitectureDiagram(diagram(source));
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("<script");
  }
});

test("renders without passing Factory environment or preload modules to the worker", async () => {
  const OriginalWorker = globalThis.Worker;
  let options: Bun.WorkerOptions | undefined;
  globalThis.Worker = new Proxy(OriginalWorker, {
    construct(target, args) {
      options = args[1];
      return Reflect.construct(target, args);
    },
  });
  try {
    const svg = await renderArchitectureDiagram(diagram("@startuml\nAlice -> Bob: Plan\n@enduml"));
    expect(svg).toContain("<svg");
    expect(options?.env).toEqual({});
    expect(options?.preload).toEqual([]);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});

test("rejects external resources, macros and invalid syntax rather than storing an error image", async () => {
  for (const source of [
    "@startuml\n!include example.puml\n@enduml",
    "@startuml\n!includeurl https://example.invalid/a\n@enduml",
    '@startuml\nAlice -> Bob: %getenv("SECRET")\n@enduml',
    "@startuml\n[External] [[https://example.invalid]]\n@enduml",
    "@startuml\nAlice -> Bob: <img:example.png>\n@enduml",
  ])
    expect(architectureDiagramInput.safeParse(diagram(source)).success).toBe(false);
  await expect(
    renderArchitectureDiagram(diagram("@startuml\nthis is invalid syntax\n@enduml")),
  ).rejects.toThrow();
});
