import { type Accessor, createEffect, createSignal } from "solid-js";
import { zeroQueries } from "../../../../packages/zero-schema/src";
import { useZeroPreload, useZeroQuery } from "../../../../packages/zero-solid/src";
import type {
  KnowledgeGeneration,
  KnowledgeRevision,
  KnowledgeSearchResult,
  OpenRepositoryDocument,
  RepositoryDocument,
} from "../api-contracts";
import type { KnowledgeDraft } from "../knowledge-workspace";
import {
  archiveKnowledgePage,
  generateKnowledge,
  getKnowledgeGeneration,
  getKnowledgeHistory,
  getRepositoryDocument,
  getRepositoryDocuments,
  saveKnowledgePage,
  searchKnowledge,
} from "../server-functions/knowledge";
import { serverCall } from "../server-functions/result";
import type { WorkspaceTab } from "../workspace-tabs";

export function createKnowledgeState(options: {
  projectID: Accessor<string | undefined>;
  canDevelop(): boolean;
  tabs(): WorkspaceTab[];
  openTab(tab: WorkspaceTab, publish?: boolean): void;
  mutate(operation: () => Promise<unknown>): Promise<unknown>;
  onError(message: string): void;
}) {
  const drafts = new Map<string, KnowledgeDraft>();
  const [selectedPageID, setSelectedPageID] = createSignal<string>();
  const [documents, setDocuments] = createSignal<RepositoryDocument[]>([]);
  const [document, setDocument] = createSignal<OpenRepositoryDocument>();
  const [generation, setGeneration] = createSignal<KnowledgeGeneration>();
  const [history, setHistory] = createSignal<KnowledgeRevision[]>([]);
  const [results, setResults] = createSignal<KnowledgeSearchResult[]>([]);
  const [query, setQuery] = createSignal("");
  const pages = useZeroQuery(() => {
    const projectId = options.projectID();
    return projectId && options.tabs().some((tab) => tab.view === "knowledge")
      ? zeroQueries.knowledge.outline({ projectId })
      : null;
  });
  const page = useZeroQuery(
    () => {
      const projectId = options.projectID(),
        pageId = selectedPageID();
      return projectId && pageId && options.tabs().some((tab) => tab.view === "knowledge")
        ? zeroQueries.knowledge.page({ projectId, pageId })
        : null;
    },
    { ttl: "none" },
  );
  useZeroPreload(
    () => {
      const projectId = options.projectID();
      return projectId ? zeroQueries.knowledge.outline({ projectId }) : null;
    },
    { ttl: "30s" },
  );
  let searchRequest = 0,
    documentRequest = 0,
    accessEpoch = 0;
  let accessKey: string | undefined,
    inventory = "";
  createEffect(
    () => ({
      key: `${options.projectID()}:${options.canDevelop()}`,
      canDevelop: options.canDevelop(),
    }),
    ({ key, canDevelop }) => {
      if (key === accessKey) return;
      accessKey = key;
      accessEpoch++;
      documentRequest++;
      searchRequest++;
      setHistory([]);
      setResults([]);
      if (!canDevelop) {
        setDocuments([]);
        setDocument(undefined);
      }
    },
  );
  // An explicit URL selection must not silently jump to a different Wiki page
  // while a partial planning projection is arriving.
  createEffect(
    () => ({
      firstPageID: pages.data()?.[0]?.id,
      id: selectedPageID(),
      document: Boolean(document()),
    }),
    (value) => {
      if (!value.document && !value.id && value.firstPageID) setSelectedPageID(value.firstPageID);
    },
  );
  async function refresh(signal?: AbortSignal) {
    const projectId = options.projectID();
    if (!projectId) return;
    const value = await serverCall(
      getKnowledgeGeneration({ ...(signal ? { signal } : {}), data: [projectId] }),
    );
    if (options.projectID() !== projectId) return;
    setGeneration(value ?? undefined);
    const next = `${projectId}:${options.canDevelop()}:${value?.id ?? ""}:${value?.state ?? ""}`;
    if (next === inventory) return;
    const source = options.canDevelop()
      ? await serverCall(
          getRepositoryDocuments({ ...(signal ? { signal } : {}), data: [projectId] }),
        )
      : { documents: [] };
    if (options.projectID() !== projectId) return;
    setDocuments(options.canDevelop() ? source.documents : []);
    inventory = next;
  }
  async function open(publish = true) {
    const projectId = options.projectID();
    if (!projectId) return;
    searchRequest++;
    setQuery("");
    setResults([]);
    options.openTab(
      { id: `knowledge:${projectId}`, view: "knowledge", label: "Knowledge" },
      publish,
    );
    await options.mutate(refresh);
  }
  return {
    drafts,
    pages,
    page,
    selectedPageID,
    documents,
    document,
    generation,
    history,
    results,
    query,
    refresh,
    open,
    select(pageID: string | undefined) {
      documentRequest++;
      setSelectedPageID(pageID);
      setDocument(undefined);
      setHistory([]);
    },
    reset() {
      inventory = "";
      searchRequest++;
      documentRequest++;
      setSelectedPageID(undefined);
      setDocument(undefined);
      setDocuments([]);
      setGeneration(undefined);
      setHistory([]);
      setResults([]);
      setQuery("");
    },
    async generate() {
      const projectId = options.projectID();
      if (!projectId) return;
      const value = await serverCall(generateKnowledge({ data: [projectId] }));
      if (options.projectID() === projectId) setGeneration(value ?? undefined);
    },
    async save(pageId: string, expectedVersion: number, title: string, body: string) {
      const saved = await serverCall(
        saveKnowledgePage({ data: [pageId, { expectedVersion, title, body }] }),
      );
      if (selectedPageID() === pageId) setHistory([]);
      return saved;
    },
    async archive() {
      const current = page.data();
      if (!current) return false;
      let archived = false;
      await options.mutate(async () => {
        await serverCall(archiveKnowledgePage({ data: [current.id, current.version] }));
        archived = true;
        if (selectedPageID() === current.id) {
          setSelectedPageID(undefined);
          setHistory([]);
        }
      });
      return archived;
    },
    async loadHistory(pageID: string) {
      const epoch = accessEpoch;
      const body = await serverCall(getKnowledgeHistory({ data: [pageID] }));
      if (selectedPageID() === pageID && epoch === accessEpoch) setHistory(body.revisions);
    },
    async openDocument(path: string) {
      const request = ++documentRequest,
        projectId = options.projectID();
      if (!projectId || !options.canDevelop()) return false;
      try {
        const value = await serverCall(getRepositoryDocument({ data: [projectId, path] }));
        if (
          options.projectID() !== projectId ||
          request !== documentRequest ||
          !options.canDevelop()
        )
          return false;
        setDocument(value);
        setSelectedPageID(undefined);
        setHistory([]);
        return true;
      } catch (cause) {
        if (options.projectID() === projectId && request === documentRequest)
          options.onError(
            cause instanceof Error ? cause.message : "The repository document could not load.",
          );
        return false;
      }
    },
    async search(text: string) {
      const projectId = options.projectID(),
        request = ++searchRequest;
      setQuery(text);
      if (!projectId || !text.trim()) {
        setResults([]);
        return;
      }
      try {
        const body = await serverCall(searchKnowledge({ data: [projectId, text.trim()] }));
        if (request === searchRequest && options.projectID() === projectId)
          setResults(body.results);
      } catch (cause) {
        if (request === searchRequest && options.projectID() === projectId)
          options.onError(
            cause instanceof Error ? cause.message : "Knowledge search could not be loaded.",
          );
      }
    },
  };
}
