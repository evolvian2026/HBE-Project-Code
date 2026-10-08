// Bundles the server and the workspace packages (@hbe/*, shipped as TypeScript source)
// into dist/main.js. Third-party packages stay external and load from node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // ESM output still needs `require` for the few CommonJS deps esbuild inlines.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [
    {
      name: "externalise-third-party",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith("@hbe/") ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
