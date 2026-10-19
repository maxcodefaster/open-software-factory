import { expect, test } from "bun:test";
import { fakeResponsesOutput } from "./fake-openai-responses";

test("controlled Responses fixtures contain the native tool lifecycle and terminal function call", async () => {
  const item = {
    type: "function_call" as const,
    id: "fc_owned",
    call_id: "call_owned",
    name: "shell",
    arguments: JSON.stringify({ command: "node --test" }),
  };
  const response = fakeResponsesOutput(item);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = (await response.text())
    .trim()
    .split("\n\n")
    .map((line) => JSON.parse(line.slice("data: ".length)));
  expect(events.map((event) => event.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.output_item.done",
    "response.completed",
  ]);
  expect(events.at(-1).response.output).toEqual([item]);
});

test("controlled Responses text finishes with ordinary prose, not a completion JSON form", async () => {
  const response = fakeResponsesOutput({
    type: "message",
    id: "msg_owned",
    role: "assistant",
    content: [{ type: "output_text", text: "Changed and checked.", annotations: [] }],
  });
  const body = await response.text();
  expect(body).toContain("response.completed");
  expect(body).toContain("Changed and checked.");
  expect(body).not.toContain("factory-build-result");
});
