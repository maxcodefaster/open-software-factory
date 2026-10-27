import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { factoryFixtureStart } from "./start-plugins";
export default defineConfig({
  root: import.meta.dirname,
  plugins: [factoryFixtureStart(`${import.meta.dirname}/attachments.html`), solid({ ssr: false })],
  build: {
    target: "esnext",
  },
});
