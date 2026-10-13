export type DevelopmentPreviewMessage = {
  type: "factory:open-development-preview";
  attemptID: string;
  workspaceID: string;
  process: string;
  label: string;
};

export function developmentPreviewMessage(value: unknown): DevelopmentPreviewMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<DevelopmentPreviewMessage>;
  if (
    candidate.type !== "factory:open-development-preview" ||
    typeof candidate.attemptID !== "string" ||
    !/^[0-9a-f-]{36}$/.test(candidate.attemptID) ||
    typeof candidate.workspaceID !== "string" ||
    !/^[0-9a-f-]{36}$/.test(candidate.workspaceID) ||
    typeof candidate.process !== "string" ||
    !/^app(?:-[a-z][a-z0-9-]{0,26})?$/.test(candidate.process) ||
    typeof candidate.label !== "string" ||
    candidate.label.trim() !== candidate.label ||
    candidate.label.length < 1 ||
    candidate.label.length > 64
  ) {
    return undefined;
  }
  return candidate as DevelopmentPreviewMessage;
}
