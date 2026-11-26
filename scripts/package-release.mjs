/**
 * Package the built extension into a distributable ZIP for GitHub Releases.
 *
 * Why this exists: dist/ is a dev artifact and is gitignored, so a source
 * checkout alone gave users no downloadable, ready-to-install extension.
 * This script produces the exact ZIP that a user can unzip and load via
 * chrome://extensions -> Developer mode -> Load unpacked.
 *
 * Must run AFTER `pnpm build` (assert-fresh-build checks dist freshness there).
 * Output: release/web-video-scope-<version>.zip
 * The ZIP contains manifest.json at its root, never a wrapping dist/ folder.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const DIST = join(ROOT, 'dist');
const RELEASE = join(ROOT, 'release');

if (!existsSync(join(DIST, 'manifest.json')) || !existsSync(join(DIST, 'content.js'))) {
  console.error('package-release: dist/ is missing or incomplete — run `pnpm build` first.');
  process.exit(1);
}

// Keep the package name and version in lockstep with the manifest the user
// will actually install, not with a separately maintained constant.
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const { name, version } = manifest;
if (!name || !version) {
  console.error('package-release: manifest.json must declare both name and version.');
  process.exit(1);
}

const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const zipName = `${slug}-${version}.zip`;
mkdirSync(RELEASE, { recursive: true });
const zipPath = join(RELEASE, zipName);

// Collect only files that actually belong in the extension package. Source
// maps, node_modules, and dotfiles must never leak into a distributable.
const files = [];
function walk(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, rel);
    else if (entry.isFile()) files.push({ rel, abs });
  }
}
walk(DIST);
files.sort((a, b) => a.rel.localeCompare(b.rel));

if (files.length === 0) {
  console.error('package-release: dist/ contains no packageable files.');
  process.exit(1);
}

// -X removes macOS AppleDouble metadata (__MACOSX, ._*) from the archive.
// Paths are added from inside dist/ so manifest.json sits at the ZIP root.
execFileSync('zip', ['-X', '-q', '-r', zipPath, ...files.map((f) => f.rel)], { cwd: DIST });

const bytes = statSync(zipPath).size;
console.log(`packaged ${files.length} files -> release/${zipName} (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`  ${files.map((f) => f.rel).join(', ')}`);
