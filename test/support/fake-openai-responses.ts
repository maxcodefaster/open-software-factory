// Controlled wire fixtures for the native Responses adapter, never a provider
// translator. No model inference or external network access occurs here.
export function fakeResponsesOutput(
  item:
    | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
    | {
        type: "message";
        id: string;
        role: "assistant";
        content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
      },
) {
  const events = [
    { type: "response.created", response: { id: "resp_factory_controlled" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: item.type === "function_call" ? { ...item, arguments: "" } : item,
    },
    ...(item.type === "function_call"
      ? [
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            delta: item.arguments,
          },
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_factory_controlled", output: [item] },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}
