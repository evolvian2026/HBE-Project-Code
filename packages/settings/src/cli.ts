// Usage: pnpm config:check [path/to/file.env]
// Validates an env file (or the current environment) against the schema and selected profile.
import { readFileSync } from "node:fs";
import { describeSettings, loadSettings } from "./index.ts";

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const file = process.argv[2];
try {
  const settings = loadSettings(
    file ? { ...readEnvFile(file), HBE_CONFIG_DIR: process.env.HBE_CONFIG_DIR } : process.env,
  );
  console.log("Configuration OK");
  console.table(describeSettings(settings));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
