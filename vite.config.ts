import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, existsSync } from 'node:fs';

const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    const from = resolve(__dirname, 'manifest.json');
    if (existsSync(from)) copyFileSync(from, resolve(__dirname, 'dist/manifest.json'));
  },
};

/**
 * Two separate builds, because the content script must be a single IIFE
 * (Chrome injects it as a classic script) while the MV3 service worker can be
 * an ES module. Rollup cannot emit IIFE with multiple inputs.
 */
export default defineConfig(({ mode }) => {
  if (mode === 'harness') {
    // `build.lib` is required: a plain rollupOptions entry with only
    // re-exports gets its exports tree-shaken away (preserveEntrySignatures
    // defaults to false), producing an empty bundle.
    return {
      build: {
        outDir: 'dist',
        emptyOutDir: false,
        target: 'chrome121',
        minify: false,
        lib: {
          entry: resolve(__dirname, 'src/harness-entry.ts'),
          formats: ['es'],
          fileName: () => 'gpu/harness-bundle.js',
        },
      },
      publicDir: false,
    };
  }

  if (mode === 'background') {
    return {
      plugins: [copyManifest],
      build: {
        outDir: 'dist',
        emptyOutDir: false,
        target: 'chrome121',
        minify: false,
        rollupOptions: {
          input: { background: resolve(__dirname, 'src/background/service-worker.ts') },
          output: { entryFileNames: '[name].js', format: 'iife' },
        },
      },
      publicDir: false,
    };
  }

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'chrome121',
      minify: false,
      rollupOptions: {
        input: { content: resolve(__dirname, 'src/content/index.ts') },
        output: {
          entryFileNames: '[name].js',
          format: 'iife',
          inlineDynamicImports: true,
        },
      },
    },
    publicDir: 'public',
  };
});
