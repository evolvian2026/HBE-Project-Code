// Creates .env.local from config/env/local.env.example, filling in the keys of the running
// local Supabase stack (`pnpm db:start`). Keys are never committed to the repository.
// Usage: pnpm env:local [--force]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const target = ".env.local";
if (existsSync(target) && !process.argv.includes("--force")) {
  console.log(`${target} already exists (use --force to regenerate).`);
  process.exit(0);
}

let status;
try {
  status = execFileSync("pnpm", ["-s", "exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  console.error("Could not read the local Supabase status. Start it first with `pnpm db:start`.");
  process.exit(1);
}
const values = Object.fromEntries(
  status
    .split("\n")
    .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const key of ["API_URL", "PUBLISHABLE_KEY", "SECRET_KEY", "DB_URL"]) {
  if (!values[key]) {
    console.error(`Local Supabase status is missing ${key}.`);
    process.exit(1);
  }
}

const filled = readFileSync("config/env/local.env.example", "utf8")
  .replace(/^SUPABASE_URL=.*$/m, `SUPABASE_URL=${values.API_URL}`)
  .replace(/^SUPABASE_PUBLISHABLE_KEY=.*$/m, `SUPABASE_PUBLISHABLE_KEY=${values.PUBLISHABLE_KEY}`)
  .replace(/^SUPABASE_SECRET_KEY=.*$/m, `SUPABASE_SECRET_KEY=${values.SECRET_KEY}`)
  .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${values.DB_URL}`)
  .replace(/^QUEUE_DATABASE_URL=.*$/m, `QUEUE_DATABASE_URL=${values.DB_URL}`);
writeFileSync(target, filled);
console.log(`Wrote ${target} for the local Supabase stack.`);
