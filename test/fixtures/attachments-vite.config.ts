import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    solid({
      ssr: false,
      serverFunctions: {
        devMiddleware: false,
        filter: {
          include: resolve(
            import.meta.dirname,
            "../../apps/factory/src/server-functions/**/*.{ts,tsx}",
          ),
        },
      },
    }),
  ],
  build: {
    target: "esnext",
    rolldownOptions: { input: `${import.meta.dirname}/attachments.html` },
  },
});
