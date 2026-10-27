// Load the pinned upstream engine only in an owned, terminated worker. Never
// install resource loaders or pass Factory credentials to the renderer.
const enginePath = "@plantuml/mcp-js/engine.js";
const vizPath = "@viz-js/viz";
const ready = (async () => {
  const viz = await import(vizPath);
  Object.assign(globalThis, {
    Viz: { instance: () => viz.instance() },
    fetch: () => Promise.reject(new Error("Diagram network access is disabled.")),
  });
  return import(enginePath);
})();

self.onmessage = async (event: MessageEvent<{ source: string }>) => {
  try {
    const engine = await ready;
    engine.renderSvg(event.data.source, (value: string) => {
      try {
        self.postMessage({ result: JSON.parse(value) });
      } catch {
        self.postMessage({ error: "The diagram renderer returned an invalid result." });
      }
    });
  } catch {
    self.postMessage({ error: "The diagram could not be rendered." });
  }
};
export {};
