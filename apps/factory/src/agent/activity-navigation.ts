export type ActivityNavigation = { path: string; diff?: string; truncated?: boolean };

export function activityNavigation(
  name: string,
  input: unknown,
  metadata: unknown,
): ActivityNavigation | undefined {
  if (
    !["read", "write", "edit", "apply_patch"].includes(name) ||
    !input ||
    typeof input !== "object"
  )
    return;
  const fields = input as { path?: unknown; file?: unknown; filePath?: unknown };
  const supplied = fields.path ?? fields.file ?? fields.filePath;
  if (typeof supplied !== "string") return;
  const path = supplied.startsWith("/workspace/project/")
    ? supplied.slice("/workspace/project/".length)
    : supplied;
  if (
    !path ||
    path.length > 1000 ||
    path.startsWith("/") ||
    [...path].some(
      (character) =>
        character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.includes("://") ||
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
  )
    return;
  const diff =
    metadata &&
    typeof metadata === "object" &&
    "diff" in metadata &&
    typeof metadata.diff === "string"
      ? metadata.diff
      : undefined;
  return {
    path,
    ...(diff
      ? { diff: diff.slice(0, 64_000), ...(diff.length > 64_000 ? { truncated: true } : {}) }
      : {}),
  };
}
