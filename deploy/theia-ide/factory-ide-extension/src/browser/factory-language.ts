export type FactoryLanguage = "typescript" | "python";

export function languagePreset(languageID: string): FactoryLanguage | undefined {
  if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(languageID))
    return "typescript";
  return languageID === "python" ? "python" : undefined;
}
