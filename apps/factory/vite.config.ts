import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { factoryDevelopmentProxy } from "../../scripts/factory/dev-proxy";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid({ ssr: false }), factoryDevelopmentProxy()],
  build: {
    target: "esnext",
    outDir: "dist",
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
});
