import solid from "@solidjs/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
  plugins: [
    tanstackStart({
      router: { basepath: "/" },
      serverFns: { base: "/_server" },
      vite: { installDevServerMiddleware: true },
    }),
    solid({ ssr: true, serverFunctions: { devMiddleware: false } }),
    ...(command === "build"
      ? [
          nitro({
            preset: "node-server",
            buildDir: ".tanstack/nitro",
            routeRules: {
              "/assets/**": {
                headers: { "cache-control": "public, max-age=31536000, immutable" },
              },
            },
          }),
        ]
      : []),
  ],
  build: { target: "esnext" },
}));
