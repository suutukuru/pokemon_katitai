import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/cli/src/bin.ts",
        "packages/cli/src/data-commands.ts",
        "packages/sim/src/pool.ts",
        "packages/sim/src/worker.ts",
      ],
    },
  },
});
