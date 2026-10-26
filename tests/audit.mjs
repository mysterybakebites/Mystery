#!/usr/bin/env node
/**
 * Full application audit for Mystery Bakebite.
 *
 * This is the static + DOM audit that complements:
 *   tests/security-tests.mjs  — security invariants over the source
 *   tests/ui-tests.mjs        — behaviour of real pages in jsdom
 *
 * What it checks
 *   1. Every JS file parses.
 *   2. Every page parses and has a title, viewport, CSP and no duplicate ids.
 *   3. Every local asset (script, stylesheet, image, favicon) exists.
 *   4. Every internal link resolves, including #fragments.
 *   5. Every getElementById / querySelector id used by a page's scripts exists.
 *   6. No credentials are exposed (service-role key, JWTs, private keys).
 *   7. config.js is publishable-key only.
 *   8. GitHub Pages compatibility (no root-absolute paths, .nojekyll present).
 *
 * Requires jsdom. Run:  npm install jsdom && node tests/audit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('jsdom is not installed — the DOM audit CANNOT run. Run: npm ci');
  process.exit(1);
}

const results = { pass: 0, fail: 0, warn: 0 };
const problems = [];
const warnings = [];

function pass(label) { results.pass++; }
function fail(label, detail) { results.fail++; problems.push(label + (detail ? '  -> ' + detail : '')); }
function warn(label, detail) { results.warn++; warnings.push(label + (detail ? '  -> ' + detail : '')); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ------------------------------------------------------------------ *
 * 1. JavaScript syntax
 * ------------------------------------------------------------------ */
const jsFiles = fs.readdirSync(path.join(ROOT, 'assets/js')).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  const src = read('assets/js/' + f);
  try {
    // Function constructor parses without executing
    new Function(src);
    pass('js parses: ' + f);
  } catch (e) {
    fail('js syntax error: ' + f, e.message);
  }
}

/* ------------------------------------------------------------------ *
 * 2–5. Page-level DOM audit
 * ------------------------------------------------------------------ */
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();

/** Collect ids and data-* anchors per page for cross-page fragment checks. */
const pageIds = {};
const pageHtml = {};
for (const p of pages) {
  pageHtml[p] = read(p);
  const dom = new JSDOM(pageHtml[p]);
  pageIds[p] = new Set([...dom.window.document.querySelectorAll('[id]')].map((el) => el.id));
}

for (const page of pages) {
  const dom = new JSDOM(pageHtml[page]);
  const d = dom.window.document;

  /* title */
  if (d.title && d.title.trim()) pass(page + ': has a title');
  else fail(page + ': missing <title>');

  /* viewport (mobile responsiveness) */
  const vp = d.querySelector('meta[name="viewport"]');
  if (vp && /width=device-width/.test(vp.getAttribute('content') || '')) pass(page + ': responsive viewport');
  else fail(page + ': missing width=device-width viewport');

  /* CSP */
  const csp = d.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (csp) {
    const c = csp.getAttribute('content') || '';
    if (/connect-src[^;]*https:\/\/\*\.supabase\.co/.test(c)) pass(page + ': CSP allows the Supabase origin');
    else fail(page + ': CSP does not allow https://*.supabase.co — every API call would be blocked');
    if (/script-src[^;]*'unsafe-eval'/.test(c)) fail(page + ': CSP allows unsafe-eval');
    else pass(page + ': CSP does not allow unsafe-eval');
  } else {
    fail(page + ': no Content-Security-Policy meta tag');
  }

  /* duplicate ids */
  const ids = [...d.querySelectorAll('[id]')].map((el) => el.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) fail(page + ': duplicate element ids', [...new Set(dupes)].join(', '));
  else pass(page + ': no duplicate ids');

  /* assets */
  const assetRefs = [
    ...d.querySelectorAll('script[src]'),
    ...d.querySelectorAll('link[rel="stylesheet"][href]'),
    ...d.querySelectorAll('img[src]'),
    ...d.querySelectorAll('link[rel="icon"][href]')
  ];
  for (const el of assetRefs) {
    const raw = el.getAttribute('src') || el.getAttribute('href');
    if (!raw || /^(https?:|data:|mailto:|tel:|#)/.test(raw)) continue;
    const clean = raw.split('?')[0].split('#')[0];
    if (exists(clean)) pass(page + ': asset ' + clean);
    else fail(page + ': missing asset', raw);
  }

  /* images need alt text for accessibility */
  const noAlt = [...d.querySelectorAll('img:not([alt])')];
  if (noAlt.length) warn(page + ': images without alt', noAlt.length + ' image(s)');
  else pass(page + ': all images have alt text');

  /* internal links + fragments */
  for (const a of d.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || /^(https?:|mailto:|tel:|#$)/.test(href)) continue;
    if (href.startsWith('#')) {
      const frag = href.slice(1);
      if (!frag || pageIds[page].has(frag)) pass(page + ': in-page anchor ' + href);
      else fail(page + ': broken in-page anchor', href);
      continue;
    }
    const [file, frag] = href.split('#');
    const target = file.split('?')[0];
    if (!target) continue;
    if (!exists(target)) {
      fail(page + ': broken link', href);
      continue;
    }
    pass(page + ': link ' + target);
    if (frag && pageIds[target] && !pageIds[target].has(frag)) {
      fail(page + ': link fragment not found in ' + target, '#' + frag);
    }
  }

  /* buttons inside forms must declare a type, or they submit unexpectedly */
  const untyped = [...d.querySelectorAll('button:not([type])')];
  if (untyped.length) warn(page + ': buttons without type', untyped.length);
  else pass(page + ': all buttons declare a type');
}

/* ------------------------------------------------------------------ *
 * 5b. getElementById targets used by a page's own scripts
 * ------------------------------------------------------------------ */
const PAGE_SCRIPTS = {
  'checkout.html': ['checkout.js'],
  'booking.html': ['booking.js'],
  'classes.html': ['classes.js'],
  'order.html': ['order.js'],
  'receipt.html': ['receipt.js'],
  'admin.html': ['admin.js'],
  'products.html': ['builder.js', 'bundle-copy.js']
};

for (const [page, scripts] of Object.entries(PAGE_SCRIPTS)) {
  if (!exists(page)) continue;
  const dom = new JSDOM(pageHtml[page]);
  const ids = pageIds[page];
  for (const s of scripts) {
    const p = 'assets/js/' + s;
    if (!exists(p)) { fail('missing script ' + p); continue; }
    const src = read(p);
    const wanted = [...src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    /* The dashboard and the proof-upload UI build their panels at runtime, so an
       id can legitimately be absent from the static HTML while still existing by
       the time getElementById runs. Count an id as present when the page's own
       script declares it (id="x" or id=\'x\' inside a template string). */
    const declared = new Set(
      [...src.matchAll(/id=\\?["']([A-Za-z][\w-]*)["']/g)].map((m) => m[1])
    );
    const missing = [...new Set(wanted)].filter((id) => !ids.has(id) && !declared.has(id));
    if (missing.length) fail(page + ' / ' + s + ': getElementById target not in page', missing.join(', '));
    else pass(page + ' / ' + s + ': all id targets exist');
  }
}

/* ------------------------------------------------------------------ *
 * 6–7. Credential exposure
 * ------------------------------------------------------------------ */
/* Only real key material counts. A comment that says "never put the
   service_role key here", or code that actively REJECTS a service_role key, is
   a control — not a leak — so comments are stripped before matching. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const SECRET_PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/, 'raw JWT (possibly a service key)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/['"]service_role['"]\s*[,}]/, 'service_role used as a JWT role value in browser code'],
  [/\bsk_(live|test)_[A-Za-z0-9]{10,}/, 'stripe-style secret key']
];

const shipped = [
  ...pages,
  ...jsFiles.map((f) => 'assets/js/' + f)
];

const secretHits = [];
for (const f of shipped) {
  const src = stripComments(read(f));
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(src)) secretHits.push(f + ': ' + label);
  }
}
if (secretHits.length) fail('credential exposure', secretHits.join(' | '));
else pass('no credentials exposed in shipped files');

const cfg = read('assets/js/config.js');
if (/url:\s*'https:\/\/[a-z0-9]+\.supabase\.co'/.test(cfg)) pass('config.js has a project URL');
else fail('config.js has no project URL');
if (/anonKey:\s*'sb_publishable_/.test(cfg) || /anonKey:\s*'eyJ/.test(cfg)) pass('config.js uses a publishable/anon key');
else fail('config.js anonKey is missing or not a publishable key');

/* ------------------------------------------------------------------ *
 * 8. GitHub Pages compatibility
 * ------------------------------------------------------------------ */
if (exists('.nojekyll')) pass('.nojekyll present'); else fail('.nojekyll missing — assets/ may be stripped by Jekyll');

const absolute = [];
for (const page of pages) {
  const dom = new JSDOM(pageHtml[page]);
  for (const el of dom.window.document.querySelectorAll('[src],[href]')) {
    const v = el.getAttribute('src') || el.getAttribute('href');
    if (v && /^\/[^/]/.test(v)) absolute.push(page + ' -> ' + v);
  }
}
if (absolute.length) fail('root-absolute paths break on a project subpath', absolute.join(', '));
else pass('all asset and link paths are relative (subpath safe)');

if (exists('.github/workflows/deploy.yml')) {
  const wf = read('.github/workflows/deploy.yml');
  if (/path:\s*'\.'/.test(wf) && !/_site/.test(wf)) fail('deploy workflow publishes the whole repository');
  else pass('deploy workflow stages only the public site');
} else {
  warn('no deploy workflow found');
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
console.log('\n=== AUDIT: ' + results.pass + ' passed, ' + results.fail + ' failed, ' + results.warn + ' warnings ===');

if (warnings.length) {
  console.log('\nWarnings:');
  warnings.forEach((w) => console.log('  ! ' + w));
}
if (problems.length) {
  console.log('\nProblems:');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}
