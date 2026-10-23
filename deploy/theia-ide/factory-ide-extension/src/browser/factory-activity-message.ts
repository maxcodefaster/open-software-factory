export type ActivityNavigationMessage = {
  type: "factory:open-activity";
  id: string;
  workspaceID: string;
  path: string;
  kind: "file" | "diff";
  diff?: string;
  truncated?: boolean;
};

export function activityNavigationMessage(value: unknown): ActivityNavigationMessage | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Partial<ActivityNavigationMessage>;
  if (
    candidate.type !== "factory:open-activity" ||
    typeof candidate.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(candidate.id) ||
    typeof candidate.workspaceID !== "string" ||
    !/^[0-9a-f-]{36}$/.test(candidate.workspaceID) ||
    typeof candidate.path !== "string" ||
    !candidate.path ||
    candidate.path.length > 1000 ||
    candidate.path.startsWith("/") ||
    [...candidate.path].some(
      (character) =>
        character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    candidate.path.includes("://") ||
    candidate.path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === ".git" ||
          part.startsWith(".factory-save-"),
      ) ||
    (candidate.kind !== "file" && candidate.kind !== "diff") ||
    (candidate.diff !== undefined &&
      (typeof candidate.diff !== "string" || candidate.diff.length > 64_000)) ||
    (candidate.kind === "diff" && !candidate.diff) ||
    (candidate.truncated !== undefined && typeof candidate.truncated !== "boolean")
  )
    return;
  return candidate as ActivityNavigationMessage;
}
