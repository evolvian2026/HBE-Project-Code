import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers.ts";

const db = testDb();
afterAll(() => db.destroy());

const stacks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../grader/stacks");

describe("global stack profiles", () => {
  // The starter templates are tested against grader/stacks/*.json; the platform dispatches the
  // database's definitions. They must be the same.
  it.each(["node22-api", "mern-node20", "django-react"])("%s matches grader/stacks", async (key) => {
    const row = await db
      .selectFrom("stack_profiles")
      .select("definition")
      .where("key", "=", key)
      .where("version", "=", 1)
      .where("institution_id", "is", null)
      .executeTakeFirstOrThrow();
    expect(row.definition).toEqual(JSON.parse(readFileSync(path.join(stacks, `${key}.json`), "utf8")));
  });
});
