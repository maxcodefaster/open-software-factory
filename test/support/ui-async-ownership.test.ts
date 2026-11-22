import { expect, test } from "bun:test";
import * as documentModel from "../../apps/factory/src/document-model";
import * as documentSlash from "../../apps/factory/src/document-slash";
import * as board from "../../packages/interface-domain/src/ticket-board";
import * as progress from "../../packages/interface-domain/src/ticket-progress";
import * as document from "../../packages/requirement-domain/src/document";
import { editorCallbacks, editorSolid as solid } from "../fixtures/editor-callbacks";

const root = new URL("../../apps/factory/src/", import.meta.url).pathname;
const storage = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};
const mutate = async (operation: () => Promise<unknown>) => ({
  ok: true as const,
  value: await operation(),
});

test("callback runner exposes a private component through AST without changing nested returns or timer text", () => {
  const calls: unknown[] = [];
  const callbacks = editorCallbacks<{ schedule: () => string; nested: () => string }>({
    path: "private-editor.tsx",
    source: `
      import { record } from "fixture:callbacks";
      function PrivateEditor() {
        function nested() { return "nested result"; }
        const schedule = () => {
          const timer = setTimeout(() => record("settled"), 650);
          clearTimeout(timer);
          return "setTimeout( stays text";
        };
        return <section>{nested()}</section>;
      }
    `,
    component: "PrivateEditor",
    expose: ["schedule", "nested"],
    imports: { "fixture:callbacks": { record: (value: unknown) => calls.push(value) } },
    timers: {
      setTimeout: (callback, milliseconds) => {
        calls.push(milliseconds);
        callback();
        return 42;
      },
      clearTimeout: (id) => calls.push(id),
    },
  })({});
  expect(callbacks.nested()).toBe("nested result");
  expect(callbacks.schedule()).toBe("setTimeout( stays text");
  expect(calls).toEqual([650, "settled", 42]);
});

test("callback runner rejects unspecified imports and fails on access to an explicit unused dependency stub", () => {
  const options = {
    path: "dependency-editor.tsx",
    source: `
      import { outsideCase } from "fixture:unused";
      function Editor() {
        const save = () => outsideCase();
        return <section />;
      }
    `,
    component: "Editor",
    expose: ["save"],
    imports: {},
  };
  expect(() => editorCallbacks(options)).toThrow(
    "Unspecified editor dependency fixture:unused in dependency-editor.tsx",
  );
  const callbacks = editorCallbacks<{ save: () => void }>({
    ...options,
    stubs: ["fixture:unused"],
  })({});
  expect(callbacks.save).toThrow(
    "Stubbed editor dependency fixture:unused.outsideCase in dependency-editor.tsx",
  );
});

for (const scenario of [
  "switch-project",
  "leave-draft",
  "replace-draft",
  "edit-draft",
  "edit-draft-away",
  "minimize",
  "stay",
] as const)
  test(`held create acknowledgement retains its Project owner: ${scenario}`, async () => {
    const ack = Promise.withResolvers<void>();
    const draft = { id: "ticket-a", title: "A's Ticket", description: "A's request" };
    const drafts = new Map([["project-a", draft]]);
    const ticketDrafts = new Map<string, Draft>();
    let selected = "project-a";
    let activeTabID = "ticket-draft:project-a";
    const selections: string[] = [];
    const updates: unknown[] = [];
    const closed: string[] = [];
    const commands = editorCallbacks<{
      publishTicketDraft: (
        input: typeof draft,
        state: string,
        projectID: string,
      ) => Promise<boolean>;
    }>({
      path: `${root}desktop/project-commands.ts`,
      component: "createProjectCommands",
      expose: ["publishTicketDraft"],
      storage: localStorage,
      imports: {
        "../../../../packages/zero-schema/src": {
          zeroMutators: { tickets: { create: (input: unknown) => input } },
        },
      },
      stubs: ["../change/drafts"],
    })({
      selectedProjectID: () => selected,
      zero: () => ({ mutate: () => ({ server: ack.promise }) }),
      mutate,
      commitZeroMutation: (promise: Promise<void>) => promise,
      personalDrafts: drafts,
      ticketDrafts,
      userID: "user",
      workspaces: {
        current: () => ({ activeTabID }),
        update: (tab: unknown, key: string) => updates.push({ tab, key }),
        close: (id: string) => closed.push(id),
      },
      workspaceVisible: () => scenario !== "minimize",
      selectTicket: (id: string) => selections.push(`${selected}:${id}`),
      refreshTicketDetail: async () => undefined,
    });
    storage.set("ticket-draft:user:project-a", JSON.stringify(draft));
    const saving = commands.publishTicketDraft(draft, "ready", "project-a");
    if (scenario === "switch-project") {
      selected = "project-b";
      activeTabID = "ticket:ticket-b";
    } else if (scenario === "leave-draft") activeTabID = "ticket:other-a";
    else if (scenario === "replace-draft")
      drafts.set("project-a", { ...draft, id: "replacement", title: "Keep this new draft" });
    else if (scenario === "edit-draft" || scenario === "edit-draft-away")
      drafts.set("project-a", { ...draft, title: "Keep this later edit" });
    if (scenario === "edit-draft-away") {
      selected = "project-b";
      activeTabID = "ticket:ticket-b";
    }
    ack.resolve();
    expect(await saving).toBe(true);
    const activate = scenario === "stay" || scenario === "edit-draft";
    expect(selections).toEqual(activate ? ["project-a:ticket-a"] : []);
    expect(closed).toEqual(activate ? ["ticket-draft:project-a"] : []);
    if (scenario === "replace-draft") expect(drafts.get("project-a")?.id).toBe("replacement");
    else {
      expect(drafts.has("project-a")).toBe(false);
      expect(storage.has("ticket-draft:user:project-a")).toBe(false);
      expect(updates).toEqual([
        {
          key: "project-a",
          tab: {
            id: "ticket-draft:project-a",
            view: "ticket",
            ticketID: "ticket-a",
            label: "A's Ticket",
          },
        },
      ]);
    }
    if (scenario === "edit-draft" || scenario === "edit-draft-away") {
      expect(ticketDrafts.get("ticket-a")).toEqual({
        title: "Keep this later edit",
        description: "A's request",
        requirement: { summary: "A's request", acceptanceCriteria: [], nonGoals: [] },
        expectedVersion: 1,
        expectedDocumentId: null,
        requirementRevisionId: null,
      });
      expect(JSON.parse(storage.get("ticket-edit:user:ticket-a") ?? "null")).toEqual(
        ticketDrafts.get("ticket-a"),
      );
    }
  });

type Draft = import("../../apps/factory/src/change/contracts").TicketDraft;
type Callbacks = {
  richTextHandlers: (options: { field: "description"; update: (value: string) => void }) => {
    onFocus: () => void;
    onInput: (value: string, element: HTMLElement) => void;
  };
  updateDescription: (value: string) => void;
  draftDescription: () => string;
  hasChanges: () => boolean;
  saveChanges: () => Promise<void>;
  scheduleAutosave: () => void;
  conflict: () => boolean;
};

function editor(onSaveDocument: (...args: unknown[]) => Promise<unknown>, restoredDraft?: Draft) {
  storage.delete("ticket-edit:user:ticket-a");
  if (restoredDraft) storage.set("ticket-edit:user:ticket-a", JSON.stringify(restoredDraft));
  const drafts = new Map<string, Draft>();
  const timers = new Map<number, () => void>();
  let scheduled = 0;
  const path = `${root}ticket-workspace.tsx`;
  const component = editorCallbacks<Callbacks>({
    path,
    component: "TicketDocument",
    expose: [
      "richTextHandlers",
      "updateDescription",
      "draftDescription",
      "hasChanges",
      "saveChanges",
      "scheduleAutosave",
      "conflict",
    ],
    storage: localStorage,
    imports: {
      "solid-js": solid,
      "../../../packages/requirement-domain/src/document": document,
      "../../../packages/interface-domain/src/ticket-board": board,
      "../../../packages/interface-domain/src/ticket-progress": progress,
      "./document-model": documentModel,
      "./document-slash": documentSlash,
    },
    timers: {
      setTimeout: (callback) => {
        timers.set(++scheduled, callback);
        return scheduled;
      },
      clearTimeout: (id) => {
        if (id !== undefined) timers.delete(id);
      },
    },
    stubs: [
      "./document-link-editor",
      "./editor-popover-position",
      "./requirement-document",
      "./review/panel",
      "./rich-document-surface",
      "./source-review",
      "./ticket-action-bar",
      "./ticket-checks",
      "./ticket-dependencies",
      "./ticket-document-notice",
      "./ticket-planning",
      "./ticket-secondary-actions",
      "./ui/feedback",
      "./version-history",
    ],
  });
  let current = {
    ticket: { id: "ticket-a", title: "A", description: "Original A", state: "ready", version: 1 },
    documentRevisions: [],
    revisions: [],
  };
  const [observation, setObservation] = solid.createSignal(0);
  const owned = solid.createRoot((dispose) => ({
    dispose,
    callbacks: component({
      get current() {
        observation();
        return current;
      },
      storageKey: "ticket-edit:user:ticket-a",
      drafts,
      onSaveDocument,
    }),
  }));
  solid.flush();
  const input = owned.callbacks.richTextHandlers({
    field: "description",
    update: owned.callbacks.updateDescription,
  });
  return {
    ...owned,
    drafts,
    timers,
    scheduled: () => scheduled,
    observe: (id: string, version: number, description = "Original A") => {
      current = { ...current, ticket: { ...current.ticket, id, version, description } };
      setObservation((value) => value + 1);
    },
    focus: input.onFocus,
    edit: (value: string) => {
      input.onInput(value, {} as HTMLElement);
      solid.flush();
    },
  };
}

for (const restored of [false, true])
  test(`fresh Ticket hydration does not treat an unchanged ${restored ? "restored" : "focused"} editor as a human edit`, async () => {
    let saves = 0;
    const owned = editor(
      async () => {
        saves++;
        return undefined;
      },
      restored
        ? {
            title: "A",
            description: "Original A",
            expectedVersion: 1,
            expectedDocumentId: null,
            requirementRevisionId: null,
            requirement: { summary: "Original A", acceptanceCriteria: [], nonGoals: [] },
          }
        : undefined,
    );
    try {
      if (!restored) owned.focus();
      solid.flush();
      owned.observe("ticket-a", 2, "New saved A from another client");
      solid.flush();
      expect(owned.callbacks.draftDescription()).toBe("New saved A from another client");
      expect(owned.callbacks.hasChanges()).toBe(false);
      await owned.callbacks.saveChanges();
      solid.flush();
      expect(saves).toBe(0);
      expect(owned.callbacks.conflict()).toBe(false);
      owned.dispose();
      expect(owned.drafts.has("ticket-a")).toBe(false);
      expect(storage.has("ticket-edit:user:ticket-a")).toBe(false);
    } finally {
      owned.dispose();
    }
  });

for (const restored of [false, true])
  test(`fresh Ticket hydration retains genuinely unsaved ${restored ? "restored" : "new"} text and its original save base`, async () => {
    const writes: unknown[][] = [];
    const owned = editor(
      async (...args) => {
        writes.push(args);
        return undefined;
      },
      restored
        ? {
            title: "A",
            description: "My unsaved A",
            expectedVersion: 1,
            expectedDocumentId: null,
            requirementRevisionId: null,
            requirement: { summary: "My unsaved A", acceptanceCriteria: [], nonGoals: [] },
          }
        : undefined,
    );
    try {
      if (!restored) owned.edit("My unsaved A");
      owned.observe("ticket-a", 2, "Someone else's saved A");
      solid.flush();
      expect(owned.callbacks.draftDescription()).toBe("My unsaved A");
      await owned.callbacks.saveChanges();
      solid.flush();
      expect(writes[0]?.[0]).toMatchObject({
        description: "My unsaved A",
        expectedVersion: 1,
        expectedDocumentId: null,
      });
      expect(owned.callbacks.conflict()).toBe(true);
      expect(owned.drafts.get("ticket-a")?.description).toBe("My unsaved A");
    } finally {
      owned.dispose();
    }
  });

test("a first input and fresh hydration in the same settle retain the actual input", async () => {
  const owned = editor(async () => undefined);
  try {
    owned.callbacks
      .richTextHandlers({
        field: "description",
        update: owned.callbacks.updateDescription,
      })
      .onInput("Input ahead of hydration", {} as HTMLElement);
    owned.observe("ticket-a", 2, "Fresh saved A");
    solid.flush();
    expect(owned.callbacks.draftDescription()).toBe("Input ahead of hydration");
    expect(owned.drafts.get("ticket-a")?.expectedVersion).toBe(1);
  } finally {
    owned.dispose();
  }
});

test("an exact save acknowledgement stays visible ahead of delayed Ticket hydration", async () => {
  let saves = 0;
  const owned = editor(async () => {
    saves++;
    return { id: "saved-document", ticketVersion: 2, requirementRevisionId: null };
  });
  try {
    owned.edit("My acknowledged A");
    await owned.callbacks.saveChanges();
    solid.flush();
    expect(owned.callbacks.draftDescription()).toBe("My acknowledged A");
    owned.observe("ticket-a", 1, "A delayed older read");
    solid.flush();
    expect(owned.callbacks.draftDescription()).toBe("My acknowledged A");
    owned.observe("ticket-a", 2, "My acknowledged A");
    solid.flush();
    expect(owned.callbacks.hasChanges()).toBe(false);
    await owned.callbacks.saveChanges();
    expect(saves).toBe(1);
  } finally {
    owned.dispose();
  }
});

test("an admitted save settles A's retained newer draft without rescheduling its disposed editor", async () => {
  const ack = Promise.withResolvers<unknown>();
  const calls: unknown[][] = [];
  const owned = editor(async (...args) => {
    calls.push(args);
    return ack.promise;
  });
  try {
    owned.edit("Admitted A");
    const saving = owned.callbacks.saveChanges();
    solid.flush();
    owned.edit("Newer unsaved A");
    owned.dispose();
    const scheduled = owned.scheduled();
    ack.resolve({ id: "document-a", ticketVersion: 2, requirementRevisionId: "revision-a" });
    await saving;
    solid.flush();
    expect(owned.scheduled()).toBe(scheduled);
    expect(owned.timers.size).toBe(0);
    expect(calls[0]?.[1]).toBe("ticket-a");
    expect(owned.drafts.get("ticket-a")).toMatchObject({
      description: "Newer unsaved A",
      expectedVersion: 2,
      expectedDocumentId: "document-a",
      requirementRevisionId: "revision-a",
    });
    await owned.callbacks.saveChanges();
    expect(calls).toHaveLength(1);
  } finally {
    owned.dispose();
  }
});

test("a synchronous owner change fences scheduling and command admission", async () => {
  let calls = 0;
  const owned = editor(async () => {
    calls++;
  });
  try {
    owned.edit("A's local text");
    const scheduled = owned.scheduled();
    owned.observe("ticket-b", 99, "B's saved text");
    owned.callbacks.scheduleAutosave();
    await owned.callbacks.saveChanges();
    expect(owned.scheduled()).toBe(scheduled);
    expect(calls).toBe(0);
  } finally {
    owned.dispose();
  }
});

test("an exact admitted ACK clears only its disposed Ticket's settled draft", async () => {
  const ack = Promise.withResolvers<unknown>();
  const owned = editor(async () => ack.promise);
  const other = {
    title: "B",
    description: "Keep B's draft",
    requirement: { summary: "B", acceptanceCriteria: [], nonGoals: [] },
  };
  try {
    owned.drafts.set("ticket-b", other);
    owned.edit("A's confirmed text");
    const saving = owned.callbacks.saveChanges();
    solid.flush();
    owned.dispose();
    ack.resolve({ id: "document-a", ticketVersion: 2, requirementRevisionId: "revision-a" });
    await saving;
    expect(owned.drafts.has("ticket-a")).toBe(false);
    expect(storage.has("ticket-edit:user:ticket-a")).toBe(false);
    expect(owned.drafts.get("ticket-b")).toBe(other);
    expect(owned.timers.size).toBe(0);
  } finally {
    owned.dispose();
  }
});

test("a disposed save does not remove another retained draft or lose an unconfirmed draft", async () => {
  for (const replacementVersion of [undefined, 1, 10]) {
    const confirmed = replacementVersion !== undefined;
    const ack = Promise.withResolvers<unknown>();
    const owned = editor(async () => ack.promise);
    try {
      owned.edit("A's local text");
      const saving = owned.callbacks.saveChanges();
      solid.flush();
      owned.dispose();
      const retained = owned.drafts.get("ticket-a");
      expect(retained).toBeDefined();
      if (confirmed && retained)
        owned.drafts.set("ticket-a", {
          ...retained,
          description: "A reopened editor's draft",
          expectedVersion: replacementVersion ?? 1,
          expectedDocumentId: replacementVersion === 1 ? null : "document-new",
        });
      ack.resolve(
        confirmed
          ? { id: "document-a", ticketVersion: 2, requirementRevisionId: "revision-a" }
          : undefined,
      );
      await saving;
      expect(owned.drafts.get("ticket-a")?.description).toBe(
        confirmed ? "A reopened editor's draft" : "A's local text",
      );
      expect(owned.drafts.get("ticket-a")?.expectedVersion).toBe(replacementVersion ?? 1);
      expect(owned.timers.size).toBe(0);
    } finally {
      owned.dispose();
    }
  }
});

test("a failed stale save retains its conflict and admits no automatic retry", async () => {
  const ack = Promise.withResolvers<unknown>();
  let calls = 0;
  const owned = editor(async () => {
    calls++;
    return ack.promise;
  });
  try {
    owned.edit("A's conflicted text");
    const saving = owned.callbacks.saveChanges();
    solid.flush();
    owned.observe("ticket-a", 2, "Someone else's saved A");
    ack.resolve(undefined);
    await saving;
    solid.flush();
    expect(owned.callbacks.conflict()).toBe(true);
    owned.callbacks.scheduleAutosave();
    await owned.callbacks.saveChanges();
    expect(calls).toBe(1);
    expect(owned.timers.size).toBe(0);
    expect(owned.drafts.get("ticket-a")?.description).toBe("A's conflicted text");
  } finally {
    owned.dispose();
  }
});

test("settled input work cannot schedule autosave after synchronous disposal", async () => {
  const owned = editor(async () => undefined);
  try {
    owned.edit("Retain A");
    const scheduled = owned.scheduled();
    owned.callbacks
      .richTextHandlers({
        field: "description",
        update: owned.callbacks.updateDescription,
      })
      .onInput("Queued A", {} as HTMLElement);
    owned.dispose();
    solid.flush();
    expect(owned.scheduled()).toBe(scheduled);
    expect(owned.timers.size).toBe(0);
  } finally {
    owned.dispose();
  }
});

test("document commands use explicit A identity and bases while B is selected", async () => {
  const calls: unknown[] = [];
  const refreshed: string[] = [];
  const commands = editorCallbacks<{
    saveTicketDocument: (input: Draft, ticketID: string) => Promise<unknown>;
    confirmRequirements: (input: Draft, ticketID: string) => Promise<unknown>;
  }>({
    path: `${root}desktop/ticket-commands.ts`,
    component: "createTicketCommands",
    expose: ["saveTicketDocument", "confirmRequirements"],
    imports: {
      "../server-functions/tickets": {
        saveTicketDocument: async (input: unknown) => {
          calls.push(input);
          return { id: "document-a", ticketVersion: 2, requirementRevisionId: "revision-a" };
        },
      },
      "../server-functions/result": { serverCall: (promise: Promise<unknown>) => promise },
    },
    stubs: [
      "zod",
      "../../../../packages/conversation-domain/src/model-settings",
      "../command-error",
      "../server-functions/conversations",
      "../server-functions/delivery",
      "../server-functions/runtime",
    ],
  })({
    detail: () => ({
      ticket: { id: "ticket-b", version: 99 },
      documentRevisions: [{ id: "document-b" }],
      proposal: {
        id: "proposal-b",
        base: { version: 99, documentId: "document-b", revisionId: "revision-b" },
      },
    }),
    latestRevision: () => ({ id: "revision-b" }),
    mutate,
    agentCommandIds: { forInput: () => "command-a" },
    acknowledgeCommand: () => {},
    refreshTicketDetail: async (id: string) => refreshed.push(id),
  });
  const draft = {
    title: "A",
    description: "A's text",
    requirement: { summary: "A's requirement", acceptanceCriteria: [], nonGoals: [] },
  };
  // An incomplete stale callback must not adopt B's base.
  expect(await commands.saveTicketDocument(draft, "ticket-a")).toBeUndefined();
  expect(await commands.confirmRequirements(draft, "ticket-a")).toBeUndefined();
  expect(calls).toEqual([]);
  expect(
    await commands.saveTicketDocument(
      {
        ...draft,
        expectedVersion: 1,
        expectedDocumentId: null,
        requirementRevisionId: null,
      },
      "ticket-a",
    ),
  ).toMatchObject({ ticketVersion: 2 });
  expect(calls).toEqual([
    {
      data: [
        "ticket-a",
        {
          commandId: "command-a",
          ...draft,
          expectedVersion: 1,
          expectedDocumentId: null,
          requirementRevisionId: null,
        },
      ],
    },
  ]);
  expect(refreshed).toEqual(["ticket-a"]);
});
