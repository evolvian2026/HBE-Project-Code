import { z } from "zod";

/** The largest definition accepted: it travels to the grader as a workflow input. */
export const MAX_DEFINITION_BYTES = 16 * 1024;

const command = z.string().trim().min(1).max(2000);
const relativePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "Paths are relative to the repository root");
const image = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/,
    "A container image, e.g. node:20-bookworm-slim",
  );

/** A stage the profile runs in a container: setup, then the command. */
const containerStage = z
  .object({
    run: command,
    image: image.optional(),
    setup: command.optional(),
    report: z.enum(["text", "junit"]).optional(),
    junit: relativePath.optional(),
  })
  .strict();

/**
 * Line coverage of the student's own tests: `run` writes a report to `file` (relative to the
 * repository) in an `lcov` (Node, Jest, Vitest, c8) or `coverage-py` (`coverage json`) format.
 * Files matching `exclude` (globs, e.g. test files) don't count.
 */
const coverageStage = z
  .object({
    run: command,
    image,
    setup: command.optional(),
    format: z.enum(["lcov", "coverage-py"]),
    file: relativePath,
    exclude: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();

/**
 * What a stack profile tells the grader harness (grader/harness): how to recognise, build and
 * start the student's app, which services to wait for, and what lint, the student's own
 * tests and their coverage run. The same shape as grader/stacks/*.json.
 */
export const stackDefinitionSchema = z
  .object({
    detect: z.array(relativePath).max(20).default([]),
    stages: z
      .object({
        build: z.object({ run: command }).strict().optional(),
        lint: containerStage.optional(),
        student_tests: containerStage.optional(),
        coverage: coverageStage.optional(),
      })
      .strict()
      .default({}),
    services: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "Service names are lowercase (as in the compose file)"),
        z
          .object({
            port: z.number().int().min(1).max(65535),
            health: z
              .string()
              .regex(/^\/[\x21-\x7e]*$/, "A path such as /health")
              .max(200),
          })
          .strict(),
      )
      .refine((s) => Object.keys(s).length >= 1 && Object.keys(s).length <= 6, "One to six services"),
    datastores: z.array(image).max(5).default([]),
    env_required: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Environment variable names"))
      .max(30)
      .default([]),
    ignore_paths: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .strict()
  .refine((d) => JSON.stringify(d).length <= MAX_DEFINITION_BYTES, `At most ${MAX_DEFINITION_BYTES / 1024} KB`);

export type StackDefinition = z.infer<typeof stackDefinitionSchema>;
