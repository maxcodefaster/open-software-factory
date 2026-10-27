import * as access from "./access";
import * as agent from "./agent";
import * as attachments from "./attachments";
import * as bootstrap from "./bootstrap";
import * as conversations from "./conversations";
import * as delivery from "./delivery";
import * as environments from "./environments";
import * as inbox from "./inbox";
import * as inputs from "./inputs";
import * as knowledge from "./knowledge";
import * as learning from "./learning";
import * as mcp from "./mcp";
import * as models from "./models";
import * as projects from "./projects";
import * as releases from "./releases";
import * as review from "./review";
import * as runtime from "./runtime";
import * as setup from "./setup";
import * as skills from "./skills";
import * as tickets from "./tickets";
import * as usage from "./usage";
import * as workspaces from "./workspaces";
import * as writer from "./writer";

// Introspection for deployment identity checks and owned integration fixtures.
// Start alone resolves and executes functions.
const authoredFunctions = {
  ...access,
  ...agent,
  ...attachments,
  ...bootstrap,
  ...conversations,
  ...delivery,
  ...environments,
  ...inbox,
  ...inputs,
  ...knowledge,
  ...learning,
  ...mcp,
  ...models,
  ...projects,
  ...releases,
  ...review,
  ...runtime,
  ...setup,
  ...skills,
  ...tickets,
  ...usage,
  ...workspaces,
  ...writer,
};
// The Solid compiler also adds module-URL metadata to namespace exports.
// Only authored callable exports have a compiled function identity.
export const factoryFunctions = Object.fromEntries(
  Object.entries(authoredFunctions).filter(([, value]) => typeof value === "function"),
) as typeof authoredFunctions;
export const publicFunctionIDs: ReadonlySet<string> = new Set([
  compiledFunctionID(bootstrap.getBootstrap),
]);
export const functionIDs: ReadonlySet<string> = new Set(
  Object.values(factoryFunctions).map(compiledFunctionID),
);
export function compiledFunctionID(fn: unknown): string {
  const id = (fn as { serverFnMeta?: { id?: unknown } }).serverFnMeta?.id;
  if (typeof id !== "string" || !id) throw new Error("Compiled Start function identity is missing");
  return id;
}
