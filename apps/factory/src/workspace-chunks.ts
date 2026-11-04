// One loader per developer-only chunk, shared by the lazy components and the idle prefetch.
export const loadRuntimeWorkspace = () => import("./runtime-workspace");
export const loadDeveloperIDEWorkspace = () => import("./developer-ide-workspace");

export function prefetchDeveloperWorkspaceChunks() {
  void loadRuntimeWorkspace().catch(() => undefined);
  void loadDeveloperIDEWorkspace().catch(() => undefined);
}
