import URI from "@theia/core/lib/common/uri";
import { Emitter, Event } from "@theia/core/lib/common/event";
import type { Disposable } from "@theia/core/lib/common/disposable";
import type {
  FileService,
  FileServiceContribution,
} from "@theia/filesystem/lib/browser/file-service";
import {
  FileChangeType,
  FileOperationError,
  FileOperationResult,
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileType,
  createFileSystemProviderError,
  type FileChange,
  type FileDeleteOptions,
  type FileOverwriteOptions,
  type FileSystemProviderWithFileReadWriteCapability,
  type FileWriteOptions,
  type Stat,
  type WatchOptions,
} from "@theia/filesystem/lib/common/files";
import {
  SourceResponseError,
  type SourceChange,
  type SourceTransport,
} from "./factory-source-client";

export const workspaceScheme = "factory-workspace";

export function workspaceResource(resource: URI): {
  readonly workspaceID: string;
  readonly path: string;
} {
  const name = resource.path.toString();
  if (
    resource.scheme !== workspaceScheme ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(resource.authority) ||
    resource.query ||
    resource.fragment ||
    !name.startsWith("/") ||
    name.includes("\\") ||
    name.length > 4096
  ) {
    throw createFileSystemProviderError(
      "Invalid Workspace source identity",
      FileSystemProviderErrorCode.NoPermissions,
    );
  }
  const path = name.slice(1);
  if (
    path.length > 0 &&
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === ".git" ||
          part.startsWith(".factory-save-"),
      )
  ) {
    throw createFileSystemProviderError(
      "Source path is not accessible",
      FileSystemProviderErrorCode.NoPermissions,
    );
  }
  return { workspaceID: resource.authority, path };
}

function sourceStat(value: unknown): Stat {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    (value.kind !== "file" && value.kind !== "directory") ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !("mtime" in value) ||
    typeof value.mtime !== "number" ||
    !Number.isFinite(value.mtime) ||
    !("ctime" in value) ||
    typeof value.ctime !== "number" ||
    !Number.isFinite(value.ctime)
  ) {
    throw createFileSystemProviderError(
      "Invalid source metadata",
      FileSystemProviderErrorCode.Unavailable,
    );
  }
  return {
    type: value.kind === "file" ? FileType.File : FileType.Directory,
    size: value.size,
    mtime: value.mtime,
    ctime: value.ctime,
  };
}

function sourceFile(value: unknown): { readonly content: Uint8Array; readonly version: string } {
  sourceStat(value);
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    typeof value.content !== "string" ||
    value.content.length > 3 << 20 ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.version)
  ) {
    throw createFileSystemProviderError(
      "Invalid source content",
      FileSystemProviderErrorCode.Unavailable,
    );
  }
  const decoded = atob(value.content);
  if (decoded.length > 2 << 20)
    throw createFileSystemProviderError(
      "Source file is too large",
      FileSystemProviderErrorCode.FileTooLarge,
    );
  return {
    content: Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
    version: value.version,
  };
}

function base64(content: Uint8Array): string {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += 32768) {
    chunks.push(String.fromCharCode(...content.subarray(index, index + 32768)));
  }
  return btoa(chunks.join(""));
}

export class FactoryWorkspaceFiles
  implements FileSystemProviderWithFileReadWriteCapability, Disposable
{
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  private readonly changes = new Emitter<readonly FileChange[]>();
  private readonly connectionChanges = new Emitter<ReadonlyMap<string, boolean>>();
  private readonly disconnected = new Map<string, boolean>();
  readonly onDidChangeFile = this.changes.event;
  // Theia interprets this event as native watcher capacity exhaustion.
  readonly onFileWatchError = Event.None;
  readonly onWatchConnectionChanged = this.connectionChanges.event;
  private readonly versions = new Map<string, string>();
  private readonly directoryMetadata = new Map<string, { stat: Stat; expires: number }>();
  private readonly watches = new Map<string, { references: number; close: () => void }>();

  constructor(private readonly transport: SourceTransport) {}

  private watchConnection(workspaceID: string, retrying: boolean | undefined) {
    if (retrying === undefined) {
      if (!this.disconnected.delete(workspaceID)) return;
    } else {
      if (this.disconnected.get(workspaceID) === retrying) return;
      this.disconnected.set(workspaceID, retrying);
    }
    this.connectionChanges.fire(new Map(this.disconnected));
  }

  private async request(
    resource: URI,
    operation: "stat" | "list" | "read" | "write" | "mkdir" | "rename" | "delete",
    extras: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    const { workspaceID, path } = workspaceResource(resource);
    try {
      return await this.transport.request(workspaceID, operation, { ...extras, path });
    } catch (error) {
      if (!(error instanceof SourceResponseError)) throw error;
      if (error.status === 409)
        throw new FileOperationError(error.message, FileOperationResult.FILE_MODIFIED_SINCE);
      const code =
        error.status === 404
          ? FileSystemProviderErrorCode.FileNotFound
          : error.status === 403
            ? FileSystemProviderErrorCode.NoPermissions
            : error.status === 413
              ? FileSystemProviderErrorCode.FileTooLarge
              : FileSystemProviderErrorCode.Unavailable;
      throw createFileSystemProviderError(error.message, code);
    }
  }

  async stat(resource: URI): Promise<Stat> {
    // Metadata refresh must never replace the content version a dirty buffer read.
    const listed = this.directoryMetadata.get(resource.toString());
    this.directoryMetadata.delete(resource.toString());
    if (listed && listed.expires > performance.now()) return listed.stat;
    return sourceStat(await this.request(resource, "stat"));
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const entries = await this.request(resource, "list");
    if (!Array.isArray(entries) || entries.length > 10000)
      throw new Error("Invalid source directory");
    const directory = entries.map((entry: unknown) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("name" in entry) ||
        typeof entry.name !== "string" ||
        !entry.name ||
        entry.name.includes("/") ||
        entry.name.includes("\\")
      )
        throw new Error("Invalid source entry");
      const child = resource.resolve(entry.name);
      workspaceResource(child);
      return { name: entry.name, key: child.toString(), stat: sourceStat(entry) };
    });
    // FileService asks for stat immediately after readdir. Reuse that already
    // authorized snapshot once; do not cache content or a dirty buffer's version.
    const now = performance.now();
    for (const [key, value] of this.directoryMetadata)
      if (value.expires <= now) this.directoryMetadata.delete(key);
    for (const entry of directory) {
      if (this.directoryMetadata.size >= 2048) {
        const oldest = this.directoryMetadata.keys().next().value;
        if (oldest) this.directoryMetadata.delete(oldest);
      }
      this.directoryMetadata.set(entry.key, { stat: entry.stat, expires: now + 1000 });
    }
    return directory.map((entry) => [entry.name, entry.stat.type]);
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const file = sourceFile(await this.request(resource, "read"));
    this.versions.set(resource.toString(), file.version);
    return file.content;
  }

  async writeFile(resource: URI, content: Uint8Array, options: FileWriteOptions): Promise<void> {
    this.clearDirectoryMetadata(resource.authority);
    if (content.length > 2 << 20)
      throw createFileSystemProviderError(
        "Source file is too large",
        FileSystemProviderErrorCode.FileTooLarge,
      );
    const observed = this.versions.get(resource.toString());
    if (!observed && !options.create)
      throw createFileSystemProviderError(
        "Read the source before saving",
        FileSystemProviderErrorCode.FileNotFound,
      );
    if (observed && !options.overwrite)
      throw createFileSystemProviderError(
        "Source already exists",
        FileSystemProviderErrorCode.FileExists,
      );
    const file = sourceFile(
      await this.request(resource, "write", { content: base64(content), version: observed ?? "" }),
    );
    this.versions.set(resource.toString(), file.version);
  }

  async mkdir(resource: URI): Promise<void> {
    this.clearDirectoryMetadata(resource.authority);
    await this.request(resource, "mkdir");
  }

  async delete(resource: URI, options: FileDeleteOptions): Promise<void> {
    this.clearDirectoryMetadata(resource.authority);
    await this.request(resource, "delete", { recursive: options.recursive });
    this.versions.delete(resource.toString());
  }

  async rename(from: URI, to: URI, options: FileOverwriteOptions): Promise<void> {
    this.clearDirectoryMetadata(from.authority);
    const original = workspaceResource(from);
    const destination = workspaceResource(to);
    if (original.workspaceID !== destination.workspaceID)
      throw createFileSystemProviderError(
        "Cannot move source across Workspaces",
        FileSystemProviderErrorCode.NoPermissions,
      );
    await this.request(from, "rename", {
      destination: destination.path,
      overwrite: options.overwrite,
    });
    this.versions.delete(from.toString());
    this.versions.delete(to.toString());
  }

  private changed(workspaceID: string, change: SourceChange): void {
    this.clearDirectoryMetadata(workspaceID);
    const root = new URI(`${workspaceScheme}://${workspaceID}/`);
    const resource = change.path ? root.resolve(change.path) : root;
    workspaceResource(resource);
    if (change.kind === "resync") {
      this.watchConnection(workspaceID, undefined);
      const observed = [...this.versions.keys()]
        .map((uri) => new URI(uri))
        .filter((uri) => uri.authority === workspaceID);
      this.changes.fire(
        [root, ...observed].map((resource) => ({ resource, type: FileChangeType.UPDATED })),
      );
    } else {
      const type =
        change.kind === "added"
          ? FileChangeType.ADDED
          : change.kind === "deleted"
            ? FileChangeType.DELETED
            : FileChangeType.UPDATED;
      this.changes.fire([{ resource, type }]);
    }
  }

  watch(resource: URI, _options: WatchOptions): Disposable {
    const { workspaceID } = workspaceResource(resource);
    let shared = this.watches.get(workspaceID);
    if (!shared) {
      shared = {
        references: 0,
        close: this.transport.watch(
          workspaceID,
          (change) => this.changed(workspaceID, change),
          (retrying = true) => {
            this.clearDirectoryMetadata(workspaceID);
            this.watchConnection(workspaceID, retrying);
          },
        ),
      };
      this.watches.set(workspaceID, shared);
    }
    shared.references++;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (--shared.references === 0) {
          shared.close();
          this.watches.delete(workspaceID);
          this.watchConnection(workspaceID, undefined);
        }
      },
    };
  }

  private clearDirectoryMetadata(workspaceID: string): void {
    const prefix = `${workspaceScheme}://${workspaceID}/`;
    for (const key of this.directoryMetadata.keys())
      if (key.startsWith(prefix)) this.directoryMetadata.delete(key);
  }

  dispose(): void {
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
    this.versions.clear();
    this.directoryMetadata.clear();
    this.changes.dispose();
    this.connectionChanges.dispose();
  }
}

export class FactoryWorkspaceFileContribution implements FileServiceContribution {
  constructor(private readonly provider: FactoryWorkspaceFiles) {}

  registerFileSystemProviders(service: FileService): void {
    service.registerProvider(workspaceScheme, this.provider);
  }
}
