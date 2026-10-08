import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests share the local database; each uses unique fixtures, but run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
