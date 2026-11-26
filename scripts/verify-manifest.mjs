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

// ---- on-demand content script wiring ------------------------------------
// The extension uses pure on-demand injection (`activeTab` + `chrome.scripting.executeScript`)
// when the user clicks the toolbar button or presses Alt+S. It must NOT inject
// background content_scripts onto every webpage or request `<all_urls>`.
check('on-demand bundle exists: content.js', existsSync(join(DIST, 'content.js')));
check(
  'no automatic content_scripts declared (pure on-demand injection)',
  (manifest.content_scripts ?? []).length === 0,
  JSON.stringify(manifest.content_scripts ?? []),
);

// The content script must be a self-executing classic script: a bare ESM export
// would be skipped by Chrome without any error.
const contentJs = existsSync(join(DIST, 'content.js'))
  ? readFileSync(join(DIST, 'content.js'), 'utf8')
  : '';
check(
  'content.js is an IIFE with no top-level import/export',
  /^\(function\s*\(/.test(contentJs.trimStart()) && !/^\s*(import|export)\s/m.test(contentJs),
);
check('content.js is non-trivial', contentJs.length > 5000, `${contentJs.length} bytes`);

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

// ---- permissions are minimal AND justified -------------------------------
// Every permission below has code that calls it; anything else is a surprise.
const perms = manifest.permissions ?? [];
const JUSTIFIED = {
  activeTab: 'action click grants temporary access to the current tab',
  scripting: 'injects content.js into tabs that predate the install',
  storage: 'persists HUD settings (units, layout, quality tier)',
  tabCapture: 'brokers a stream id for cross-origin video a content script cannot read',
};
const unexpected = perms.filter((p) => !(p in JUSTIFIED));
check('no unrequested permissions', unexpected.length === 0, perms.join(','));

// A permission with no matching call is dead weight that store review will ask
// about. Verify each one is actually used somewhere in the bundle.
const bundleText = scripts.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n');
const API_FOR = {
  activeTab: null, // granted implicitly, no API surface
  scripting: 'chrome.scripting',
  storage: 'chrome.storage',
  tabCapture: 'chrome.tabCapture',
};
for (const [perm, api] of Object.entries(API_FOR)) {
  if (!api || !perms.includes(perm)) continue;
  check(`permission "${perm}" is used (${api})`, bundleText.includes(api));
}
// Least-privilege check: no broad `<all_urls>` host_permissions. `activeTab` + `scripting`
// grants temporary access ONLY when the user clicks the icon or invokes the command.
const hostPerms = manifest.host_permissions ?? [];
check(
  'no broad host_permissions declared (uses activeTab on demand)',
  hostPerms.length === 0,
  JSON.stringify(hostPerms),
);

// ---- extension-specific rules from the chrome-extensions skill -----------
// Icons: only reference files that exist. Omitted is fine (Chrome defaults).
const iconRefs = [
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.action?.default_icon ? Object.values(manifest.action.default_icon) : []),
];
if (iconRefs.length === 0) {
  check('icons omitted rather than referenced but missing', true, 'Chrome default icon');
} else {
  const missing = iconRefs.filter((f) => !existsSync(join(DIST, f)));
  check('every referenced icon file exists', missing.length === 0, missing.join(','));
}

// chrome.action.* requires an "action" key in the manifest.
check(
  'action key present (required by chrome.action.*)',
  'action' in manifest,
  JSON.stringify(manifest.action ?? null),
);

// Content scripts must not be declared in all frames unless justified: the
// panel would appear once per iframe on sites with embedded players.
const csList = manifest.content_scripts ?? [];
check(
  'no content script runs in every frame',
  csList.every((c) => c.all_frames !== true),
  csList.map((c) => String(c.all_frames)).join(','),
);

// No inline scripts or handlers in any packaged HTML.
const htmlFiles = readdirSync(DIST).filter((f) => f.endsWith('.html'));
for (const file of htmlFiles) {
  const html = readFileSync(join(DIST, file), 'utf8');
  check(`${file}: no inline <script> body`, !/<script(?![^>]*\bsrc=)[^>]*>[^<]+<\/script>/.test(html));
  check(`${file}: no on*= inline handler`, !/\son\w+\s*=\s*["']/i.test(html));
}

// ---- zero document.title pollution & command wiring ----------------------
check(
  'content.js never mutates document.title',
  !/document\.title\s*=/.test(contentJs) && !/\[VS:/.test(contentJs),
);
check(
  'declares toggle-scopes keyboard command (Alt+S)',
  !!manifest.commands?.['toggle-scopes'],
  JSON.stringify(manifest.commands ?? null),
);

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
