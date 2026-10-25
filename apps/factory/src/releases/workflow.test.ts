import { expect, test } from "bun:test";
import { validatePublicationWorkflow } from "./workflow";

const source = `
on:
  workflow_dispatch:
    inputs:
      factory_release_id: {required: true}
      version: {required: true}
      package_owner: {required: true}
jobs:
  publish:
    runs-on: [factory-publication, 'factory-release-\${{ inputs.factory_release_id }}']
    steps:
      - run: echo build
`;
test("publication admits a single explicitly dispatched isolated job", () => {
  expect(() => validatePublicationWorkflow(source)).not.toThrow();
  for (const changed of [
    source.replace("workflow_dispatch:", "push:"),
    source.replace("factory-publication", "factory-verification"),
    source.replace("    steps:", "    strategy: {matrix: {os: [linux]}}\n    steps:"),
    `${source}\n  second:\n    runs-on: ubuntu-latest\n`,
  ])
    expect(() => validatePublicationWorkflow(changed)).toThrow();
});
