import { render } from "@solidjs/web";
import { createSignal, Loading } from "solid-js";
import type {
  KnowledgeGeneration,
  KnowledgePage,
  KnowledgeRevision,
  KnowledgeSearchResult,
} from "../../apps/factory/src/api-contracts";
import type { KnowledgeDraft } from "../../apps/factory/src/knowledge/draft";
import { KnowledgeWorkspace } from "../../apps/factory/src/knowledge-workspace";
import { WorkspaceTabbar } from "../../apps/factory/src/workspace-tabbar";
import "../../apps/factory/src/tokens.css";
import "../../apps/factory/src/knowledge-workspace.css";
import "../../apps/factory/src/style.css";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { fixtureValue } from "./value";

const query = new URLSearchParams(location.search);
const scenario = query.get("s") ?? "populated";
const project = "10000000-0000-4000-8000-000000000001";
const commit = "a".repeat(40);
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const table = `| Bereich | Status | Hinweis |
| --- | --- | --- |
| Vorschau | Bereit | Läuft auf Port 4321 |
| Formulare | Wartet | Ein sehr langer Text in einer Tabellenzelle, der umbrechen oder seitlich scrollen muss, ohne die Seite zu sprengen |
| Konfiguration | Fehler | \`FACTORY_RUNTIME_PREVIEW_ORIGIN_MISSING_AND_THEREFORE_THE_PROXY_CANNOT_BE_RESOLVED_AT_ALL\` |
| Straße | Größe | Übergrößen-Prüfung für ä, ö, ü und ß |`;
const wideCode = `\`\`\`ts
export async function resolveEditorApi(origin: string, sandbox: string): Promise<URL> {
  const url = new URL(\`/__factory/sandbox/\${sandbox}/api/admin/auth/config?cache=bust&very=long&parameter=that-keeps-going-and-going-without-any-break-opportunity\`, origin);
  return url;
}
\`\`\``;
const german = (n: number) =>
  `Überprüfung der Größenänderung für äußerst lange Überschriften mit Umlauten und Sonderzeichen wie ß, ö, ü und „typografischen Anführungszeichen“ im Fließtext, Absatz ${n}.`;
const longBody = [
  "## Überblick",
  german(1),
  "## Tabelle",
  table,
  "## Code",
  wideCode,
  "```sh\npnpm check && pnpm test && pnpm build && pnpm visual -- forms && pnpm performance:forms --profile=deterministic --no-cache --verbose\n```",
  "## Liste",
  "- Erster Punkt mit `inline code`\n  - Verschachtelt\n    - Noch tiefer verschachtelt mit einem sehr langen Text, der in der Seitenspalte umbrechen muss\n- Zweiter Punkt\n\n1. Eins\n2. Zwei",
  "> Zitat: Same-origin ist die portable Variante.",
  "Lange URL: https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "Siehe auch [Betrieb und CI](#wiki/operations-ci) und [Unbekannte Seite](#wiki/missing-page).",
  ...Array.from({ length: 30 }, (_, index) => `### Abschnitt ${index + 1}\n\n${german(index + 2)}`),
].join("\n\n");

type Spec = {
  id: string;
  slug: string;
  title: string;
  parent?: string;
  body: string;
};
const specs: Spec[] = [
  {
    id: id(1),
    slug: "overview",
    title: "ACME Astro",
    body: "Astro-/Preact-Plattform für ACME-Seiten.\n\nSiehe [Betrieb und CI](#wiki/operations-ci).",
  },
  {
    id: id(2),
    slug: "operations-ci",
    title: "Betrieb und CI",
    parent: id(1),
    body: longBody,
  },
  {
    id: id(3),
    slug: "architecture",
    title: "Architektur und Zuständigkeiten für Überschriften in äußerst langer Form mit Umlauten",
    parent: id(1),
    body: "## Kurz\n\nNur ein kurzer Absatz.",
  },
  {
    id: id(4),
    slug: "english",
    title: "English page with a long title that must truncate in the tree without breaking",
    parent: id(1),
    body: "## Notes\n\nPlain English content with `code` and a [link](https://example.com).",
  },
  ...Array.from({ length: 24 }, (_, index) => ({
    id: id(10 + index),
    slug: `guide-${index + 1}`,
    title: `Anleitung ${index + 1}: ${index % 2 ? "Deployment prüfen" : "Lokale Entwicklung"}`,
    parent: id(1),
    body: `## Anleitung ${index + 1}\n\n${german(index)}`,
  })),
];
const empty = scenario === "empty" || scenario.startsWith("empty-");
const generating: Record<string, KnowledgeGeneration> = {
  pending: { id: "g", state: "pending" },
  "running-bare": { id: "g", state: "running" },
  planning: {
    id: "g",
    state: "running",
    progress: { phase: "planning", topicsTotal: 0, topicsDone: 0, currentTopic: null },
  },
  writing: {
    id: "g",
    state: "running",
    pageCount: 3,
    progress: {
      phase: "writing",
      topicsTotal: 7,
      topicsDone: 3,
      currentTopic:
        "Lokal entwickeln und Änderungen prüfen mit einem sehr langen Themennamen, der umbrechen muss",
    },
  },
  publishing: {
    id: "g",
    state: "running",
    pageCount: 6,
    progress: { phase: "publishing", topicsTotal: 7, topicsDone: 6, currentTopic: null },
  },
  failed: {
    id: "g",
    state: "failed",
    failure:
      "The model provider returned HTTP 429 (rate limit) after 3 attempts. ".repeat(6) +
      "\nRequestID: req_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  succeeded: { id: "g", state: "succeeded", pageCount: 5 },
};
const generationKey = scenario.replace(/^empty-/, "");
const generation = generating[generationKey];
const pages = (empty ? [] : specs).map((spec, index) => ({
  id: spec.id,
  projectId: project,
  slug: spec.slug,
  title: spec.title,
  state: "active" as const,
  version: 1,
  parentId: spec.parent ?? null,
  sortOrder: index,
  icon: "knowledge" as const,
  metadataVersion: 1,
  currentRevisionId: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
}));
function fullPage(pageID: string): KnowledgePage | undefined {
  const outline = pages.find((page) => page.id === pageID);
  const spec = specs.find((entry) => entry.id === pageID);
  return outline && spec
    ? { ...outline, currentBody: `# ${spec.title}\n\n${spec.body}` }
    : undefined;
}
const revisions: KnowledgeRevision[] = [
  {
    id: "30000000-0000-4000-8000-000000000001",
    ordinal: 3,
    kind: "human",
    title: "Betrieb und CI",
    body: "Menschliche Änderung.\n\n" + german(1),
    createdAt: "2026-11-04T10:00:00Z",
    author: "Anna Beispiel-Mustermann-Weißenfelser",
  },
  {
    id: "30000000-0000-4000-8000-000000000002",
    ordinal: 2,
    kind: "generated",
    title: "Betrieb und CI",
    body: "Generierte Fassung.\n\n" + german(2),
    sourceCommitSha: commit,
    createdAt: "2026-11-03T10:00:00Z",
  },
  {
    id: "30000000-0000-4000-8000-000000000003",
    ordinal: 1,
    kind: "proposed",
    title: "Betrieb und CI",
    body: "Vorgeschlagene Fassung.",
    createdAt: "2026-11-02T10:00:00Z",
  },
];
const searchResults: KnowledgeSearchResult[] = [
  {
    id: id(2),
    kind: "page",
    title: "Betrieb und CI",
    path: "",
    snippet: "…Prüfungen passend auswählen. Beginne mit den Prüfungen…",
  },
  {
    id: "d",
    kind: "document",
    title: "docs architecture",
    path: "docs/architecture.md",
    snippet: "…Schreibvorgänge verwenden stabile Idempotenz…",
  },
];

function Surface() {
  const [selected, setSelected] = createSignal<string | undefined>(
    empty ? undefined : (query.get("page") ?? (scenario === "root" ? undefined : id(2))),
  );
  const [searchQuery, setSearchQuery] = createSignal("");
  const [results, setResults] = createSignal<KnowledgeSearchResult[]>([]);
  const [saves, setSaves] = createSignal(0);
  const [generateCalls, setGenerateCalls] = createSignal(0);
  const drafts = new Map<string, KnowledgeDraft>();
  const searchMode = query.get("search") ?? "ok";
  const saveMode = query.get("save") ?? "ok";
  const page = () => {
    const current = selected();
    return current ? fullPage(current) : undefined;
  };
  return (
    <main class="factory-desktop" data-background="river-landscape">
      <h1 class="sr-only">Delivery floor</h1>
      <section class="workspace-window workspace-window-knowledge" aria-label="knowledge workspace">
        <WorkspaceTabbar
          tabs={[{ id: "knowledge", view: "knowledge", label: "Knowledge" }]}
          activeTabID="knowledge"
          onActivate={() => {}}
          onClose={() => {}}
          onMinimize={() => {}}
        />
        <div class="workspace-view-body" role="tabpanel" id="workspace-view-panel" tabindex="-1">
          <Loading fallback={<p role="status">Opening workspace…</p>}>
            <KnowledgeWorkspace
              projectID={project}
              userID="10000000-0000-4000-8000-000000000009"
              repositoryURL="http://127.0.0.1:1/factory/acme.git"
              canDevelop={query.get("role") !== "contributor"}
              drafts={drafts}
              pages={pages}
              loading={scenario === "loading"}
              selectedPage={page()}
              documents={[
                {
                  path: "docs/architecture.md",
                  title: "architecture",
                  sha: "b".repeat(40),
                  size: 1200,
                },
                {
                  path: "docs/operations/runbook-with-a-very-long-file-name-that-must-truncate.md",
                  title: "runbook",
                  sha: "c".repeat(40),
                  size: 900,
                },
              ]}
              generation={generation}
              revisions={revisions}
              searchResults={results()}
              searchQuery={searchQuery()}
              pending={query.has("pending")}
              onSelectPage={setSelected}
              onOpenDocument={() => {}}
              onLoadDocuments={async () => {}}
              onGenerate={() => setGenerateCalls((value) => value + 1)}
              onSearch={async (text) => {
                setSearchQuery(text);
                if (!text.trim()) {
                  setResults([]);
                  return "found";
                }
                await new Promise((resolve) =>
                  setTimeout(resolve, Number(query.get("delay") ?? 300)),
                );
                if (searchMode === "fail") return "failed";
                setResults(searchMode === "none" ? [] : searchResults);
                return "found";
              }}
              onSavePage={async (pageId, version, title, body) => {
                await new Promise((resolve) => setTimeout(resolve, 200));
                if (saveMode === "fail") throw new Error("The Wiki could not be saved.");
                setSaves((value) => value + 1);
                return { id: pageId, version: version + 1, title, body, revisionId: null };
              }}
              onHistory={async () => {}}
              onSources={async () => [{ path: "docs/architecture.md", commitSha: commit }]}
              onArchive={() => {}}
              onMove={async () => {}}
              onIcon={async () => {}}
              onOpenIDE={() => {}}
              onRestore={async (pageId, _revision, version) => ({
                id: pageId,
                version: version + 1,
                title: "Betrieb und CI",
                body: "Wiederhergestellt",
                revisionId: null,
              })}
            />
          </Loading>
        </div>
      </section>
      <p class="sr-only" role="status" data-testid="fixture-state">
        saves {saves()} generate {generateCalls()}
      </p>
    </main>
  );
}

render(
  () => <Surface />,
  fixtureValue(document.getElementById("root"), 'document.getElementById("root")'),
);
