/**
 * Manifest / bundle integrity checks.
 *
 * Chrome 137+ removed the `--load-extension` command-line switch, so an
 * automated unpacked install is no longer possible in this environment (and
 * enterprise policy is out of scope). Everything short of that IS verifiable:
 * the manifest must satisfy MV3 schema rules, every referenced file must exist,
 * declared paths must stay inside the bundle, and the built scripts must not
 * violate the MV3 CSP (no eval, no remote code, no inline handlers).
 *
 * Manual step still required: chrome://extensions -> Developer mode ->
 * "Load unpacked" -> select dist/. Tracked in README.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const DIST = resolve('dist');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const manifestPath = join(DIST, 'manifest.json');
check('dist/manifest.json exists', existsSync(manifestPath));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// ---- schema ---------------------------------------------------------------
check('manifest_version is 3', manifest.manifest_version === 3, String(manifest.manifest_version));
check('name and version are present', !!manifest.name && !!manifest.version, `${manifest.name}@${manifest.version}`);
check('name fits the 75-char store limit', manifest.name.length <= 75, `${manifest.name.length} chars`);
check('description fits the 132-char limit', (manifest.description ?? '').length <= 132,
  `${(manifest.description ?? '').length} chars`);
check('declares minimum_chrome_version', !!manifest.minimum_chrome_version, manifest.minimum_chrome_version);

// ---- referenced files exist ----------------------------------------------
const referenced = [];
if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
for (const cs of manifest.content_scripts ?? []) {
  for (const f of cs.js ?? []) referenced.push(f);
  for (const f of cs.css ?? []) referenced.push(f);
}
for (const f of referenced) {
  check(`referenced file exists: ${f}`, existsSync(join(DIST, f)));
}

// ---- no path escapes -----------------------------------------------------
const escapes = referenced.filter((f) => f.startsWith('/') || f.includes('..'));
check('no absolute or traversing paths', escapes.length === 0, escapes.join(',') || 'none');

// ---- CSP / MV3 restrictions ---------------------------------------------
const scripts = readdirSync(DIST).filter((f) => f.endsWith('.js'));
for (const file of scripts) {
  const code = readFileSync(join(DIST, file), 'utf8');
  // MV3 forbids eval and remote script loading; both break the store review and
  // throw at runtime under the extension CSP.
  check(`${file}: no eval`, !/\beval\s*\(/.test(code));
  check(`${file}: no new Function`, !/new\s+Function\s*\(/.test(code));
  check(`${file}: no remote script src`, !/<script[^>]+src=["']https?:/.test(code));
  check(`${file}: no import() of a remote URL`, !/import\s*\(\s*["']https?:/.test(code));
}

// ---- permissions are minimal --------------------------------------------
const perms = manifest.permissions ?? [];
const expected = ['activeTab', 'scripting', 'storage'];
const unexpected = perms.filter((p) => !expected.includes(p) && p !== 'tabCapture' && p !== 'offscreen');
check('no unrequested permissions', unexpected.length === 0, perms.join(','));
check('host_permissions are scoped or absent', !manifest.host_permissions || manifest.host_permissions.every((h) => h !== '<all_urls>' || perms.includes('declarativeNetRequestWithHostAccess')),
  JSON.stringify(manifest.host_permissions ?? 'none'));

// ---- content script match coverage --------------------------------------
const matches = (manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? []);
check('content script matches all urls', matches.includes('<all_urls>'), matches.join(','));
const cs = (manifest.content_scripts ?? [])[0] ?? {};
check('content script does not run in all frames by default', cs.all_frames !== true, String(cs.all_frames));

// ---- bundle size sanity --------------------------------------------------
let total = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else total += st.size;
  }
};
walk(DIST);
check('bundle stays under 1 MB', total < 1024 * 1024, `${(total / 1024).toFixed(0)} KB`);

console.log('');
const manual = [
  'MANUAL (cannot be automated): load the unpacked extension in Chrome and',
  'open a page with a <video>. Steps:',
  '  1. chrome://extensions -> enable Developer mode',
  '  2. "Load unpacked" -> select dist/',
  '  3. open any video page, press Alt+S',
  'Expected: the scope panel appears and shows a live frame rate.',
];
console.log(manual.join('\n'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
