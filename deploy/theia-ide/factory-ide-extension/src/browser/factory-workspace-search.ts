import URI from "@theia/core/lib/common/uri";
import type {
  SearchInWorkspaceClient,
  SearchInWorkspaceOptions,
  SearchInWorkspaceServer,
  SearchMatch,
} from "@theia/search-in-workspace/lib/common/search-in-workspace-interface";
import type { SourceTransport } from "./factory-source-client";
import { workspaceResource } from "./factory-workspace-files";

function searchResults(value: unknown): {
  readonly files: ReadonlyArray<{ readonly path: string; readonly matches: SearchMatch[] }>;
  readonly truncated: boolean;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("results" in value) ||
    !Array.isArray(value.results) ||
    value.results.length > 500 ||
    !("truncated" in value) ||
    typeof value.truncated !== "boolean"
  )
    throw new Error("Invalid source search result");
  let count = 0;
  const files = value.results.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("path" in item) ||
      typeof item.path !== "string" ||
      !("matches" in item) ||
      !Array.isArray(item.matches)
    )
      throw new Error("Invalid source search file");
    const matches = item.matches.map((match: unknown): SearchMatch => {
      if (
        ++count > 500 ||
        typeof match !== "object" ||
        match === null ||
        !("line" in match) ||
        typeof match.line !== "number" ||
        !Number.isSafeInteger(match.line) ||
        match.line < 1 ||
        !("character" in match) ||
        typeof match.character !== "number" ||
        !Number.isSafeInteger(match.character) ||
        match.character < 1 ||
        !("length" in match) ||
        typeof match.length !== "number" ||
        !Number.isSafeInteger(match.length) ||
        match.length < 1 ||
        !("lineText" in match) ||
        typeof match.lineText !== "string" ||
        match.lineText.length > 8192
      )
        throw new Error("Invalid source search match");
      return {
        line: match.line,
        character: match.character,
        length: match.length,
        lineText: match.lineText,
      };
    });
    return { path: item.path, matches };
  });
  return { files, truncated: value.truncated };
}

export class FactoryWorkspaceSearch implements SearchInWorkspaceServer {
  private nextID = 0;
  private readonly pending = new Map<number, AbortController>();

  constructor(
    private readonly transport: SourceTransport,
    private client: SearchInWorkspaceClient | undefined,
  ) {}

  setClient(client: SearchInWorkspaceClient | undefined): void {
    this.client = client;
  }

  async search(
    what: string,
    roots: string[],
    options: SearchInWorkspaceOptions = {},
  ): Promise<number> {
    if (roots.length !== 1) throw new Error("Select one Workspace for source search");
    const root = new URI(roots[0]);
    const identity = workspaceResource(root);
    if (identity.path) throw new Error("Search the Workspace root");
    if (options.multiline || options.followSymlinks)
      throw new Error("Multiline and symlink search are not supported");
    const id = ++this.nextID;
    const controller = new AbortController();
    this.pending.set(id, controller);
    // Deliver after Theia has stored the returned ID and installed its callbacks.
    setTimeout(() => {
      void this.execute(id, root, what, options, controller);
    }, 0);
    return id;
  }

  private async execute(
    id: number,
    root: URI,
    query: string,
    options: SearchInWorkspaceOptions,
    controller: AbortController,
  ): Promise<void> {
    if (controller.signal.aborted) return;
    try {
      const { workspaceID } = workspaceResource(root);
      const result = searchResults(
        await this.transport.request(
          workspaceID,
          "search",
          {
            path: "",
            search: {
              query,
              regex: options.useRegExp,
              matchCase: options.matchCase,
              wholeWord: options.matchWholeWord,
              include: options.include,
              exclude: options.exclude,
              maxResults: options.maxResults,
            },
          },
          controller.signal,
        ),
      );
      if (controller.signal.aborted) return;
      for (const file of result.files) {
        const resource = root.resolve(file.path);
        workspaceResource(resource);
        this.client?.onResult(id, {
          root: root.toString(),
          fileUri: resource.toString(),
          matches: file.matches,
        });
      }
      this.client?.onDone(
        id,
        result.truncated
          ? "Search reached its source limit. Narrow the query or included files."
          : undefined,
      );
    } catch {
      if (!controller.signal.aborted)
        this.client?.onDone(id, "Workspace source search is unavailable.");
    } finally {
      this.pending.delete(id);
    }
  }

  async cancel(id: number): Promise<void> {
    this.pending.get(id)?.abort();
    this.pending.delete(id);
  }

  dispose(): void {
    for (const pending of this.pending.values()) pending.abort();
    this.pending.clear();
    this.client = undefined;
  }
}
