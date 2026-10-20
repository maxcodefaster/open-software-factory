export type FactoryLanguage = "typescript" | "python";

export function languagePreset(languageID: string): FactoryLanguage | undefined {
  if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(languageID))
    return "typescript";
  return languageID === "python" ? "python" : undefined;
}

// Presentation only. The authenticated runtime edge independently checks the
// exact Workspace, Runtime Attempt, session and current writing authority.
export class FactoryLanguageState {
  private readonly ready = new Set<string>();
  private readonly listeners = new Set<() => void>();
  has(workspaceID: string, language: FactoryLanguage) {
    return this.ready.has(`${workspaceID}:${language}`);
  }
  set(workspaceID: string, language: FactoryLanguage, ready: boolean) {
    const key = `${workspaceID}:${language}`;
    if (this.ready.has(key) === ready) return;
    if (ready) this.ready.add(key);
    else this.ready.delete(key);
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

export const factoryLanguageState = new FactoryLanguageState();
