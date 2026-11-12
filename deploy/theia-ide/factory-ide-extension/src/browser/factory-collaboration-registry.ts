export interface SharedEditorDocument {
  save(): Promise<unknown>;
}
// The filesystem provider uses the same shared buffer as Monaco's collaboration binding.
export const sharedEditorDocuments = new Map<string, SharedEditorDocument>();
