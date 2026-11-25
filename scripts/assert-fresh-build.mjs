/**
 * Fails the build if dist/ is older than the sources it was built from.
 *
 * Why this exists: `tsc --noEmit && vite build` aborts on a type error, leaving
 * the previous dist/ in place. Nothing downstream notices — tests import the
 * stale bundle and pass, the extension loads the stale bundle and behaves
 * exactly as before, and a "fix" appears to have no effect. That happened here
 * across several rounds of debugging.
 */
import { statSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = resolve('dist');
const ENTRY = join(DIST, 'content.js');

if (!existsSync(ENTRY)) {
  console.error('assert-fresh-build: dist/content.js is missing');
  process.exit(1);
}

const distTime = statSync(ENTRY).mtimeMs;

/** Newest mtime under a directory, recursively. */
function newest(dir) {
  let newestMs = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      newestMs = Math.max(newestMs, newest(p));
    } else if (/\.(ts|wgsl|json)$/.test(entry.name)) {
      newestMs = Math.max(newestMs, statSync(p).mtimeMs);
    }
  }
  return newestMs;
}

const srcMs = Math.max(newest(resolve('src')), statSync('manifest.json').mtimeMs);

if (srcMs > distTime + 1000) {
  const behind = ((srcMs - distTime) / 1000).toFixed(1);
  console.error(
    `assert-fresh-build: dist/ is ${behind}s older than src/.\n` +
      'A previous build step failed and left a stale bundle. Re-run the build.',
  );
  process.exit(1);
}

console.log(`assert-fresh-build: dist/ is current (${new Date(distTime).toISOString()})`);
