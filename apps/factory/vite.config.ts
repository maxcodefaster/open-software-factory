import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid({ ssr: false })],
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
  oxc: false,
});
