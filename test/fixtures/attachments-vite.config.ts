import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid({ ssr: false })],
  build: {
    target: "esnext",
    rolldownOptions: { input: `${import.meta.dirname}/attachments.html` },
  },
});
