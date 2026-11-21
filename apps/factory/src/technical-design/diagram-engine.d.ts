declare module "@plantuml/mcp-js/engine.js" {
  export function renderSvg(source: string, result: (serialized: string) => void): void;
}
