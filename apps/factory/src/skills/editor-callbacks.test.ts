import { expect, test } from "bun:test";
import type { SkillScope } from "../../../../packages/conversation-domain/src/skill-library";
import { APIRequestError } from "../api-client";
import * as skills from "../../../../packages/conversation-domain/src/skills";
import { editorCallbacks, editorSolid as solid } from "../../../../test/fixtures/editor-callbacks";

const content: skills.SkillContent = {
  key: "test-skill",
  name: "Test skill",
  description: "When testing",
  instructions: "Test it",
  roles: ["build"],
  references: [{ path: "references/note.md", body: "Original" }],
  files: [],
};
type Callbacks = {
  draft: () => skills.SkillContent;
  update: (patch: Partial<skills.SkillContent>) => void;
  attach: (list: FileList | null) => Promise<void>;
  save: (event: SubmitEvent) => Promise<void>;
  error: () => string;
  busy: () => boolean;
  scope: () => SkillScope;
  changeScope: (scope: SkillScope) => void;
};
function setup(
  saveSkill: (input: unknown) => Promise<unknown>,
  onSaved = (_saved: unknown) => {},
  props: { scope?: SkillScope; projectId?: string } = {},
) {
  const component = editorCallbacks<Callbacks>({
    path: `${import.meta.dir}/revision-editor.tsx`,
    component: "SkillRevisionEditor",
    expose: ["draft", "update", "attach", "save", "error", "busy", "scope", "changeScope"],
    imports: {
      "solid-js": solid,
      "../../../../packages/conversation-domain/src/skills": skills,
      "../server-functions/skills": { saveSkill },
      "../server-functions/result": { serverCall: (value: unknown) => value },
      "../command-error": { plainErrorMessage: (message: string) => message },
      "../api-client": { APIRequestError },
    },
  });
  return solid.createRoot((dispose) => ({
    dispose,
    callbacks: component({ content, scope: "personal", onSaved, ...props }),
  }));
}
function files(name: string, bytes: Promise<ArrayBuffer>) {
  return [{ name, size: 10, arrayBuffer: () => bytes }] as unknown as FileList;
}
const submit = { preventDefault() {} } as SubmitEvent;

test("a confirmed access denial permits a corrected personal submission", async () => {
  const requests: Array<SaveInput & { scope: SkillScope }> = [];
  const owned = setup(
    async (request) => {
      const input = (request as { data: [SaveInput & { scope: SkillScope }] }).data[0];
      requests.push(structuredClone(input));
      if (requests.length === 1) throw new APIRequestError(403, "Project manager access required");
      return { libraryId: input.libraryId, revisionId: input.revisionId };
    },
    () => {},
    { scope: "project", projectId: "project" },
  );
  try {
    await owned.callbacks.save(submit);
    owned.callbacks.changeScope("personal");
    owned.callbacks.update({ instructions: "Corrected instructions" });
    solid.flush();
    await owned.callbacks.save(submit);
    expect(requests[0]?.scope).toBe("project");
    expect(requests[1]?.scope).toBe("personal");
    expect(requests[1]?.content.instructions).toBe("Corrected instructions");
    expect(requests[1]?.revisionId).not.toBe(requests[0]?.revisionId);
    expect(requests[1]?.expectedRevision).toBe(0);
  } finally {
    owned.dispose();
  }
});

test("concurrent attachment reads retain both completed batches", async () => {
  const first = Promise.withResolvers<ArrayBuffer>();
  const second = Promise.withResolvers<ArrayBuffer>();
  const owned = setup(async () => ({}));
  try {
    const a = owned.callbacks.attach(files("a.txt", first.promise));
    const b = owned.callbacks.attach(files("b.txt", second.promise));
    first.resolve(new TextEncoder().encode("A").buffer);
    await a;
    solid.flush();
    second.resolve(new TextEncoder().encode("B").buffer);
    await b;
    solid.flush();
    expect(owned.callbacks.draft().files?.map((file) => file.path)).toEqual([
      "assets/a.txt",
      "assets/b.txt",
    ]);
  } finally {
    owned.dispose();
  }
});

test("a save acknowledgement leaves reference edits made while saving in the owned draft", async () => {
  const result = Promise.withResolvers<unknown>();
  const saved: unknown[] = [];
  const owned = setup(
    () => result.promise,
    (value) => {
      saved.push(value);
    },
  );
  try {
    const saving = owned.callbacks.save(submit);
    solid.flush();
    owned.callbacks.update({
      references: [{ path: "references/note.md", body: "Edited during save" }],
    });
    solid.flush();
    result.resolve({ libraryId: "library", revisionId: "revision" });
    await saving;
    solid.flush();
    expect(owned.callbacks.draft().references[0]?.body).toBe("Edited during save");
    // The library's onSaved callback closes and discards this editor.
    expect(saved).toEqual([]);
  } finally {
    owned.dispose();
  }
});

test("attachment batches settled in the same turn merge, while duplicate paths fail atomically", async () => {
  const result = Promise.withResolvers<ArrayBuffer>();
  const owned = setup(async () => ({}));
  try {
    const a = owned.callbacks.attach(files("a.txt", result.promise));
    const b = owned.callbacks.attach(files("b.txt", result.promise));
    const duplicate = owned.callbacks.attach(files("a.txt", result.promise));
    result.resolve(new TextEncoder().encode("Text").buffer);
    await Promise.all([a, b, duplicate]);
    solid.flush();
    expect(owned.callbacks.draft().files?.map((file) => file.path)).toEqual([
      "assets/a.txt",
      "assets/b.txt",
    ]);
    expect(owned.callbacks.error()).toContain("already exists");
  } finally {
    owned.dispose();
  }
});

test("an attachment read does not restore a file removed while reading", async () => {
  const result = Promise.withResolvers<ArrayBuffer>();
  const owned = setup(async () => ({}));
  try {
    owned.callbacks.update({
      files: [{ path: "assets/removed.txt", body: "Remove me", encoding: "utf8" }],
    });
    solid.flush();
    const attaching = owned.callbacks.attach(files("added.txt", result.promise));
    owned.callbacks.update({ files: [] });
    solid.flush();
    result.resolve(new TextEncoder().encode("Added").buffer);
    await attaching;
    solid.flush();
    expect(owned.callbacks.draft().files?.map((file) => file.path)).toEqual(["assets/added.txt"]);
  } finally {
    owned.dispose();
  }
});

type SaveInput = {
  libraryId: string;
  revisionId: string;
  expectedRevision: number;
  content: skills.SkillContent;
};
test("an attachment completed during saving is retained in a new exact revision of the same library", async () => {
  const result = Promise.withResolvers<unknown>();
  const bytes = Promise.withResolvers<ArrayBuffer>();
  const requests: SaveInput[] = [];
  const saved: unknown[] = [];
  const owned = setup(
    async (request) => {
      const input = (request as { data: [SaveInput] }).data[0];
      requests.push(structuredClone(input));
      if (requests.length === 1) await result.promise;
      return { libraryId: input.libraryId, revisionId: input.revisionId };
    },
    (value) => {
      saved.push(value);
    },
  );
  try {
    const attaching = owned.callbacks.attach(files("later.txt", bytes.promise));
    const saving = owned.callbacks.save(submit);
    solid.flush();
    result.resolve({});
    await saving;
    solid.flush();
    expect(saved).toHaveLength(0);
    expect(owned.callbacks.busy()).toBe(false);
    bytes.resolve(new TextEncoder().encode("Later attachment").buffer);
    await attaching;
    solid.flush();
    await owned.callbacks.save(submit);
    solid.flush();
    expect(requests[0]?.content.files).toEqual([]);
    expect(requests[1]?.content.files?.[0]?.path).toBe("assets/later.txt");
    expect(requests[1]?.libraryId).toBe(requests[0]?.libraryId);
    expect(requests[1]?.revisionId).not.toBe(requests[0]?.revisionId);
    expect(requests[1]?.expectedRevision).toBe(1);
    expect(saved).toHaveLength(1);
  } finally {
    owned.dispose();
  }
});

test("failed saves retry their exact identity before submitting later edits as a new revision", async () => {
  const requests: SaveInput[] = [];
  const saved: unknown[] = [];
  const owned = setup(
    async (request) => {
      const input = (request as { data: [SaveInput] }).data[0];
      requests.push(structuredClone(input));
      if (requests.length === 1) throw new Error("Response lost");
      return { libraryId: input.libraryId, revisionId: input.revisionId };
    },
    (value) => {
      saved.push(value);
    },
  );
  try {
    await owned.callbacks.save(submit);
    solid.flush();
    expect(owned.callbacks.error()).toBe("Response lost");
    owned.callbacks.update({ manualOnly: true });
    solid.flush();
    await owned.callbacks.save(submit);
    solid.flush();
    expect(requests[1]).toEqual(requests[0]);
    expect(saved).toHaveLength(0);
    expect(owned.callbacks.draft().manualOnly).toBe(true);
    await owned.callbacks.save(submit);
    solid.flush();
    expect(requests[2]?.content.manualOnly).toBe(true);
    expect(requests[2]?.expectedRevision).toBe(1);
    expect(saved).toHaveLength(1);
  } finally {
    owned.dispose();
  }
});

test("a failed submission can be confirmed while later incomplete reference edits stay unsaved", async () => {
  const requests: SaveInput[] = [];
  const saved: unknown[] = [];
  const owned = setup(
    async (request) => {
      const input = (request as { data: [SaveInput] }).data[0];
      requests.push(structuredClone(input));
      if (requests.length === 1) throw new Error("Response lost");
      return { libraryId: input.libraryId, revisionId: input.revisionId };
    },
    (value) => {
      saved.push(value);
    },
  );
  try {
    await owned.callbacks.save(submit);
    solid.flush();
    owned.callbacks.update({ references: [{ path: "references/note.md", body: "" }] });
    solid.flush();
    await owned.callbacks.save(submit);
    solid.flush();
    expect(requests[1]).toEqual(requests[0]);
    expect(owned.callbacks.draft().references[0]?.body).toBe("");
    expect(saved).toHaveLength(0);
  } finally {
    owned.dispose();
  }
});

test("an invalid attachment batch does not partially append its earlier files", async () => {
  const owned = setup(async () => ({}));
  try {
    const batch = [
      {
        name: "small.txt",
        size: 5,
        arrayBuffer: async () => new TextEncoder().encode("Small").buffer,
      },
      { name: "large.txt", size: 700001, arrayBuffer: async () => new ArrayBuffer(0) },
    ] as unknown as FileList;
    await owned.callbacks.attach(batch);
    solid.flush();
    expect(owned.callbacks.draft().files).toEqual([]);
    expect(owned.callbacks.error()).toContain("smaller than 700 KB");
  } finally {
    owned.dispose();
  }
});
