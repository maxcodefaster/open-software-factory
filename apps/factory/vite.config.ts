import solid from "@solidjs/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite";
import { factoryDevelopmentProxy } from "../../scripts/factory/dev-proxy";
import { factoryBuildDirectory } from "./src/build-directory";

export default defineConfig(() => ({
  root: import.meta.dirname,
  plugins: [
    tanstackStart({ server: { entry: "./start-server.ts" }, serverFns: { base: "/_server" } }),
    solid({ ssr: true }),
    factoryDevelopmentProxy(),
  ],
  build: {
    target: "esnext",
    outDir: factoryBuildDirectory(),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Reader/highlighter and Tiptap share these packages. Assign them
            // before the editor group recursively captures its dependencies.
            { name: "document-shared", test: /node_modules\/(?:marked|devlop)\// },
            {
              name: "document-highlighting",
              test: /node_modules\/(?:highlight\.js|lowlight|hast-util-[^/]+|property-information|comma-separated-tokens|space-separated-tokens)\//,
            },
            { name: "document-engine", test: /node_modules\/(?:@tiptap\/|prosemirror-[^/]+\/)/ },
          ],
        },
      },
    },
  },
  environments: {
    ssr: {
      build: {
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    },
  },
  oxc: {},
}));
