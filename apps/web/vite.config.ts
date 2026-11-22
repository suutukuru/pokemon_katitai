import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // relative asset URLs so the build also works when hosted under a sub-path
  base: "./",
  // Showdown's browser bundle (scripts/build-showdown.mjs) replaces the Node package
  resolve: {
    alias: {
      "pokemon-showdown": fileURLToPath(new URL("./src/gen/showdown.js", import.meta.url)),
    },
  },
  worker: { format: "es" },
  server: { fs: { allow: ["../.."] } },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
