import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/next-env.d.ts", "supabase/.temp/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JS config and build files run in Node.
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      // All configuration must go through @hbe/settings (docs/CONFIGURATION.md).
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: "Read configuration via loadSettings() from @hbe/settings." },
      ],
    },
  },
  {
    files: ["packages/settings/**", "**/*.test.ts", "**/test/**", "e2e/**", "**/*.config.{js,ts,mjs}", "apps/web/**"],
    rules: { "no-restricted-properties": "off" },
  },
  {
    // The grader runs on Actions runners, outside the platform's configuration system.
    files: ["grader/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Buffer: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: { "no-restricted-properties": "off" },
  },
);
