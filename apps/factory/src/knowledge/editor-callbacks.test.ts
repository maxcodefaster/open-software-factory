import { expect, test } from "bun:test";
import { withoutRepeatedTitle } from "../../../../packages/knowledge-domain/src/document-merge";
import { editorCallbacks, editorSolid as solid } from "../../../../test/fixtures/editor-callbacks";
import type { KnowledgePage, KnowledgeRevision, KnowledgeSave } from "../api-contracts";
import * as drafts from "./draft";

type Callbacks = {
  draft: () => drafts.KnowledgeDraft | undefined;
  changeDraft: (field: "title" | "body", value: string) => void;
  restoreRevision: (revision: KnowledgeRevision) => Promise<void>;
  save: () => Promise<void>;
  openHistory: () => Promise<void>;
  historyOpen: () => boolean;
  restoreError: () => string;
  restoring: () => boolean;
};

function setup(options: {
  onRestore?: (...args: unknown[]) => Promise<KnowledgeSave>;
  onSavePage?: (...args: unknown[]) => Promise<KnowledgeSave>;
}) {
  const storage = new Map<string, string>();
  const store = new Map<string, drafts.KnowledgeDraft>();
  const component = editorCallbacks<Callbacks>({
    path: `${import.meta.dir}/../knowledge-workspace.tsx`,
    component: "KnowledgeWorkspace",
    expose: [
      "draft",
      "changeDraft",
      "restoreRevision",
      "save",
      "openHistory",
      "historyOpen",
      "restoreError",
      "restoring",
    ],
    imports: {
      "solid-js": solid,
      "../../../packages/knowledge-domain/src/document-merge": { withoutRepeatedTitle },
      "./knowledge/draft": drafts,
      "./ui/workspace-navigation": { createWorkspaceNavigation: () => ({}) },
      "./command-error": { plainErrorMessage: (message: string) => message },
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
  });
  const pageA = { id: "A", version: 1, title: "Page A", currentBody: "Current A" } as KnowledgePage;
  const pageB = { id: "B", version: 1, title: "Page B", currentBody: "Current B" } as KnowledgePage;
  const owned = solid.createRoot((dispose) => {
    const [selectedPage, select] = solid.createSignal(pageA);
    const callbacks = component({
      get selectedPage() {
        return selectedPage();
      },
      pages: [],
      revisions: [],
      userID: "user",
      projectID: "project",
      drafts: store,
      onHistory: async () => {},
      ...options,
    });
    return { dispose, select, callbacks, store, storage, pageA, pageB };
  });
  solid.flush();
  return owned;
}
const revision = { id: "old-A", title: "Page A", body: "Restored A" } as KnowledgeRevision;
const savedA = { id: "A", version: 2, title: "Page A", body: "Restored A" } as KnowledgeSave;

test("restore settles for page A after navigation without overwriting page B's unsaved draft or history", async () => {
  const result = Promise.withResolvers<KnowledgeSave>();
  const calls: unknown[][] = [];
  const owned = setup({
    onRestore: (...args) => {
      calls.push(args);
      return result.promise;
    },
  });
  try {
    expect(owned.callbacks.draft()?.base.id).toBe("A");
    const restore = owned.callbacks.restoreRevision(revision);
    owned.select(owned.pageB);
    solid.flush();
    expect(owned.callbacks.draft()?.base.id).toBe("B");
    owned.callbacks.changeDraft("body", "Unsaved B");
    solid.flush();
    await owned.callbacks.openHistory();
    solid.flush();
    result.resolve(savedA);
    await restore;
    solid.flush();
    expect(owned.callbacks.draft()?.base.id).toBe("B");
    expect(owned.callbacks.draft()?.body).toBe("Unsaved B");
    expect(owned.callbacks.historyOpen()).toBe(true);
    expect(owned.store.get("user:project:page:B")?.body).toBe("Unsaved B");
    expect(calls).toEqual([["A", "old-A", 1]]);
    owned.select({ ...owned.pageA, version: 2, currentBody: "Restored A" });
    solid.flush();
    expect(owned.callbacks.draft()?.body).toBe("Restored A");
    expect(calls).toHaveLength(1);
  } finally {
    owned.dispose();
  }
});

test("restore acknowledges only unchanged fields and retains later edits for its page off screen", async () => {
  const result = Promise.withResolvers<KnowledgeSave>();
  const owned = setup({ onRestore: () => result.promise });
  try {
    const restoring = owned.callbacks.restoreRevision(revision);
    owned.callbacks.changeDraft("body", "Later edit to A");
    solid.flush();
    owned.select(owned.pageB);
    solid.flush();
    result.resolve(savedA);
    await restoring;
    solid.flush();
    const retained = owned.store.get("user:project:page:A");
    expect(retained?.body).toBe("Later edit to A");
    expect(retained?.base.version).toBe(2);
    expect(
      drafts.readDraft("user:project:page:A", { getItem: (key) => owned.storage.get(key) ?? null }),
    ).toEqual(retained);
    owned.select({ ...owned.pageA, version: 2, currentBody: "Restored A" });
    solid.flush();
    expect(owned.callbacks.draft()?.body).toBe("Later edit to A");
    expect(owned.callbacks.draft()?.conflict).toBe(false);
  } finally {
    owned.dispose();
  }
});

test("returning to a pending restore does not reissue it and projected acknowledgement preserves typing", async () => {
  const result = Promise.withResolvers<KnowledgeSave>();
  let calls = 0;
  const owned = setup({
    onRestore: () => {
      calls++;
      return result.promise;
    },
  });
  try {
    const restoring = owned.callbacks.restoreRevision(revision);
    owned.select(owned.pageB);
    solid.flush();
    owned.select(owned.pageA);
    solid.flush();
    expect(owned.callbacks.restoring()).toBe(true);
    await owned.callbacks.restoreRevision(revision);
    expect(calls).toBe(1);
    owned.callbacks.changeDraft("title", "Later title");
    solid.flush();
    owned.select({ ...owned.pageA, version: 2, currentBody: "Restored A" });
    solid.flush();
    expect(owned.callbacks.draft()?.title).toBe("Later title");
    expect(owned.callbacks.draft()?.body).toBe("Restored A");
    result.resolve(savedA);
    await restoring;
    solid.flush();
    expect(owned.callbacks.draft()?.title).toBe("Later title");
    expect(owned.callbacks.restoring()).toBe(false);
  } finally {
    owned.dispose();
  }
});

test("save acknowledgements preserve edits and advance only their owning retained draft", async () => {
  const result = Promise.withResolvers<KnowledgeSave>();
  const calls: unknown[][] = [];
  const owned = setup({
    onSavePage: (...args) => {
      calls.push(args);
      return result.promise;
    },
  });
  try {
    owned.callbacks.changeDraft("body", "Submitted A");
    solid.flush();
    const saving = owned.callbacks.save();
    owned.callbacks.changeDraft("body", "Later A");
    solid.flush();
    owned.select(owned.pageB);
    solid.flush();
    owned.callbacks.changeDraft("title", "Later B");
    solid.flush();
    result.resolve({ ...savedA, body: "Submitted A" });
    await saving;
    solid.flush();
    expect(owned.callbacks.draft()?.title).toBe("Later B");
    expect(owned.store.get("user:project:page:A")?.body).toBe("Later A");
    expect(owned.store.get("user:project:page:A")?.base.body).toBe("Submitted A");
    expect(calls).toEqual([["A", 1, "Page A", "Submitted A"]]);
  } finally {
    owned.dispose();
  }
});

test("restore failure after navigation leaves the selected page's feedback alone", async () => {
  const result = Promise.withResolvers<KnowledgeSave>();
  const owned = setup({
    onRestore: async () => {
      await result.promise;
      throw new Error("Restore failed");
    },
  });
  try {
    const restoring = owned.callbacks.restoreRevision(revision);
    owned.select(owned.pageB);
    solid.flush();
    result.resolve(savedA);
    await restoring;
    solid.flush();
    expect(owned.callbacks.restoreError()).toBe("");
    expect(owned.callbacks.restoring()).toBe(false);
    expect(owned.callbacks.draft()?.base.id).toBe("B");
  } finally {
    owned.dispose();
  }
});

test("a late restore acknowledgement cannot regress a newer observed revision", async () => {
  const result = Promise.withResolvers<KnowledgeSave>();
  const owned = setup({ onRestore: () => result.promise });
  try {
    const restoring = owned.callbacks.restoreRevision(revision);
    owned.select({ ...owned.pageA, version: 3, currentBody: "Newer revision" });
    solid.flush();
    result.resolve(savedA);
    await restoring;
    solid.flush();
    expect(owned.callbacks.draft()?.base.version).toBe(3);
    expect(owned.callbacks.draft()?.body).toBe("Newer revision");
  } finally {
    owned.dispose();
  }
});

test("a projected save and its acknowledgement both retain later edits on the active page", async () => {
  const result = Promise.withResolvers<KnowledgeSave>();
  const owned = setup({ onSavePage: () => result.promise });
  try {
    owned.callbacks.changeDraft("body", "Submitted A");
    solid.flush();
    const saving = owned.callbacks.save();
    owned.callbacks.changeDraft("body", "Later A");
    solid.flush();
    owned.select({ ...owned.pageA, version: 2, currentBody: "Submitted A" });
    solid.flush();
    expect(owned.callbacks.draft()?.body).toBe("Later A");
    expect(owned.callbacks.draft()?.conflict).toBe(false);
    result.resolve({ ...savedA, body: "Submitted A" });
    await saving;
    solid.flush();
    expect(owned.callbacks.draft()?.body).toBe("Later A");
    expect(owned.callbacks.draft()?.base.body).toBe("Submitted A");
  } finally {
    owned.dispose();
  }
});
