import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solid({ ssr: false })],
  build: { target: "esnext" },
});
