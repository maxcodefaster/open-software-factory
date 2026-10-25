import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { factoryDevelopmentProxy } from "../../scripts/factory/dev-proxy";
import { resolve } from "node:path";
import { factoryBuildDirectory } from "./src/build-directory";
import {
  factoryFunctionManifestID,
  factoryServerFunctionManifest,
} from "../../scripts/factory/server-function-manifest";

export default defineConfig(({ isSsrBuild }) => ({
  root: import.meta.dirname,
  plugins: [
    ...(isSsrBuild
      ? [factoryServerFunctionManifest(import.meta.dirname, factoryBuildDirectory())]
      : []),
    solid({
      ssr: false,
      serverFunctions: { devMiddleware: false, manifest: factoryFunctionManifestID },
    }),
    factoryDevelopmentProxy(),
  ],
  build: {
    target: "esnext",
    outDir: resolve(factoryBuildDirectory(), isSsrBuild ? "server" : "client"),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "document-engine", test: /node_modules\/.*(?:@tiptap|prosemirror)/ },
            {
              name: "document-highlighting",
              test: /node_modules\/.*(?:highlight\.js|lowlight|hast-util|property-information|comma-separated-tokens|space-separated-tokens)/,
            },
          ],
        },
      },
    },
  },
  oxc: {},
}));
