// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", "apps/web/src/gen/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": "off",
    },
  },
  {
    // engine/calc/schema must stay platform-neutral (browser + Workers)
    files: ["packages/{schema,calc,engine,explain}/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*", "fs", "path", "crypto"] }],
    },
  },
);
