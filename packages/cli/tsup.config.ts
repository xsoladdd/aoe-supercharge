import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { supercharge: 'src/index.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node24',
  bundle: true,
  // One self-contained file: fast cold start for `supercharge stage`, nothing to resolve at runtime.
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: false,
  outDir: 'dist',
  banner: {
    js: "import { createRequire as __scCreateRequire } from 'node:module'; const require = __scCreateRequire(import.meta.url);",
  },
});
