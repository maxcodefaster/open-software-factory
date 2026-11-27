import { expect, test } from "bun:test";
import { createRoot, createSignal, flush, untrack } from "solid-js";
import { splitInlineCode } from "../interview-options";
import type { ConversationView } from "../project-agent/contracts";
import { createConversationSelection } from "../project-agent/selection";
import { createConversationState } from "./conversation-state";

test("Conversation state owns read fences, private context selection and provisional turn identities", () => {
  const owned = createRoot((dispose) => {
    const [project, setProject] = createSignal<string | undefined>("project-one");
    const ticket = () => undefined;
    const selection = createConversationSelection("owned-user", project, ticket);
    const state = createConversationState({
      projectID: project,
      ticketID: ticket,
      selection,
      onEntry() {},
    });
    return { dispose, state, selection, setProject };
  });
  try {
    const view = {
      projectId: "project-one",
      ticketId: null,
      contextId: "original",
      entries: [],
    } as unknown as ConversationView;
    const read = owned.state.beginRead();
    owned.state.publish(view);
    flush();
    expect(owned.state.currentRead(read)).toBe(false);
    expect(untrack(owned.state.current)).toBe(view);
    const scope = untrack(owned.selection.key);
    owned.state.publishProvisional(scope, "second-turn", "Retained partial answer");
    flush();
    owned.state.clearProvisional(scope, "first-turn");
    flush();
    expect(untrack(owned.state.provisional)?.text).toBe("Retained partial answer");
    owned.state.clearProvisional(scope, "second-turn");
    flush();
    expect(untrack(owned.state.provisional)).toBeUndefined();
    owned.setProject("project-two");
    flush();
    expect(untrack(owned.state.current)).toBeUndefined();
    const controller = new AbortController();
    owned.state.trackStream(controller);
    owned.dispose();
    expect(controller.signal.aborted).toBe(true);
    expect(untrack(owned.state.current)).toBeUndefined();
  } finally {
    owned.dispose();
  }
});

test.each(["uncertain", "failed", "stopped", "completed"] as const)(
  "publishing a settled %s turn aborts its tracked stream and clears its provisional answer",
  (terminalState) => {
    const owned = createRoot((dispose) => {
      const [project] = createSignal<string | undefined>("project-one");
      const ticket = () => undefined;
      const selection = createConversationSelection("owned-user", project, ticket);
      const state = createConversationState({
        projectID: project,
        ticketID: ticket,
        selection,
        onEntry() {},
      });
      return { dispose, state, selection };
    });
    try {
      const turnId = "turn-settled";
      const controller = new AbortController();
      owned.state.trackStream(controller, () => turnId);
      const scope = untrack(owned.selection.key);
      owned.state.publishProvisional(scope, turnId, "Partial text");
      flush();
      expect(untrack(owned.state.provisional)?.text).toBe("Partial text");
      expect(controller.signal.aborted).toBe(false);

      owned.state.publish({
        projectId: "project-one",
        ticketId: null,
        contextId: "original",
        entries: [],
        turn: {
          id: turnId,
          commandId: "cmd-1",
          state: terminalState,
          engine: "mastra",
          mode: "investigate",
          modelId: "test-model",
          skills: [],
        },
      } as unknown as ConversationView);
      flush();
      expect(controller.signal.aborted).toBe(true);
      expect(untrack(owned.state.provisional)).toBeUndefined();
    } finally {
      owned.dispose();
    }
  },
);

test("splitInlineCode separates inline backtick spans without swallowing literal text", () => {
  expect(splitInlineCode("Use `apps/factory/src` and `bun test` here.")).toEqual([
    { code: false, text: "Use " },
    { code: true, text: "apps/factory/src" },
    { code: false, text: " and " },
    { code: true, text: "bun test" },
    { code: false, text: " here." },
  ]);
  expect(splitInlineCode("Plain question without code")).toEqual([
    { code: false, text: "Plain question without code" },
  ]);
  expect(splitInlineCode("Keep `unclosed literal")).toEqual([
    { code: false, text: "Keep `unclosed literal" },
  ]);
  expect(splitInlineCode("Keep `` empty literal")).toEqual([
    { code: false, text: "Keep `` empty literal" },
  ]);
});
