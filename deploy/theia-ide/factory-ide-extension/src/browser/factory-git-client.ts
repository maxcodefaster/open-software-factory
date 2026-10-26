import { factoryWorkspaceRuntimePath } from "./factory-runtime-context";

export interface FactoryGitStatus {
  readonly head: string;
  readonly branch: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly status: string }>;
}

export class FactoryGitClient {
  constructor(
    private readonly fetcher: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response> = (...args) => fetch(...args),
    private readonly href: () => string = () => window.location.href,
  ) {}
  async request(
    workspaceID: string,
    action: "status" | "diff" | "commit" | "fetch" | "pull",
    body?: { path: string } | { commandID: string; expectedHead: string; message: string },
  ): Promise<unknown> {
    const root = factoryWorkspaceRuntimePath(workspaceID, this.href()).replace(/\/runtime$/, "");
    const response = await this.fetcher(`${root}/git/${action}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      throw new Error(
        value && typeof value === "object" && "error" in value && typeof value.error === "string"
          ? value.error
          : "Git is unavailable. Reopen your personal Workspace and refresh Git status.",
      );
    }
    return value;
  }
}

export function factoryGitStatus(raw: unknown): FactoryGitStatus {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("head" in raw) ||
    typeof raw.head !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(raw.head) ||
    !("branch" in raw) ||
    typeof raw.branch !== "string" ||
    !("files" in raw) ||
    !Array.isArray(raw.files) ||
    raw.files.length > 1000 ||
    !raw.files.every(
      (file: unknown) =>
        file &&
        typeof file === "object" &&
        "path" in file &&
        typeof file.path === "string" &&
        "status" in file &&
        typeof file.status === "string" &&
        file.status.length === 2,
    )
  )
    throw new Error("Git status is invalid");
  return raw as FactoryGitStatus;
}
