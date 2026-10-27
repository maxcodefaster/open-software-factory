import { expect, test } from "bun:test";
import { architectureDiagramInput } from "../../../../packages/requirement-domain/src/technical-design";
import { renderArchitectureDiagram } from "./diagrams";

const diagram = (source: string) => ({
  title: "Ticket planning",
  description: "Owned flow",
  source,
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
