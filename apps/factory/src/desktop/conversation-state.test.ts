import { expect, test } from "bun:test";
import { createRoot, createSignal, flush, untrack } from "solid-js";
import type { ConversationView } from "../api-contracts";
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
