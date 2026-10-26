#!/usr/bin/env node
/**
 * Browser-level tests for the Mystery Bakebite site.
 *
 * These run the REAL page HTML with the REAL scripts inside jsdom, so they
 * catch integration faults that a source-grep test cannot: a contact field the
 * module forgets to fill, a WhatsApp link left pointing at a stale number, a
 * course list that renders an empty grid instead of an explanation.
 *
 * Requires jsdom (a dev dependency, not shipped to the browser):
 *     npm install jsdom
 *
 * Usage:
 *     node tests/ui-tests.mjs
 *
 * If jsdom is not installed the file exits 0 with a notice, so the
 * dependency-free security suite can still gate a release on its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.log('jsdom is not installed — skipping UI tests. Run: npm install jsdom');
  process.exit(0);
}

let passed = 0;
let failed = 0;
const failures = [];

function t(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (extra ? '  -> ' + extra : '')); console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Load a page with real scripts and no network (an offline browser). */
function bootPage(page, scripts) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  vc.on('error', (e) => errors.push(String(e)));

  const html = read(page).replace(/<script src="assets\/js\/[^"]+"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://example.test/' + page,
    virtualConsole: vc
  });
  const w = dom.window;
  w.fetch = () => Promise.reject(new Error('Failed to fetch'));
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.IntersectionObserver = function () { this.observe = () => {}; this.unobserve = () => {}; this.disconnect = () => {}; };

  for (const f of scripts) {
    const p = 'assets/js/' + f;
    if (!fs.existsSync(path.join(ROOT, p))) continue;
    try { w.eval(read(p)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  return { w, errors, dom };
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/* =====================================================================
 * 1. Contact profile renders on every page and never leaks a stale number
 * ===================================================================== */

const PAGES = {
  'index.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js'],
  'contact.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js'],
  'menu.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js'],
  'products.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js'],
  'classes.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js', 'classes.js'],
  'booking.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js', 'pay.js', 'booking.js'],
  'checkout.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js', 'pay.js', 'checkout.js'],
  'order.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js', 'order.js'],
  'receipt.html': ['config.js', 'supabase.js', 'contact.js', 'main.js', 'cart.js', 'receipt.js'],
  'admin.html': ['config.js', 'supabase.js', 'contact.js', 'main.js']
};

for (const [page, scripts] of Object.entries(PAGES)) {
  const { w, errors } = bootPage(page, scripts);
  await settle();
  const d = w.document;

  t(page + ': loads without a script error', errors.length === 0, errors.slice(0, 2).join(' | '));

  const nodes = [...d.querySelectorAll('[data-contact]')];
  const blank = nodes.filter((el) => !el.textContent.trim());
  t(page + ': every contact placeholder is filled', blank.length === 0,
    blank.map((e) => e.getAttribute('data-contact')).join(', '));

  const wa = [...d.querySelectorAll('[data-contact-link="whatsapp"]')];
  const bad = wa.filter((a) => !/^https:\/\/wa\.me\/\d{7,15}([?]|$)/.test(a.getAttribute('href') || ''));
  t(page + ': every WhatsApp link is a real wa.me URL', bad.length === 0, bad.length + ' of ' + wa.length);
}

/* =====================================================================
 * 2. Contact module behaviour against controlled payloads
 * ===================================================================== */

async function contactWith(contactPayload, page = 'contact.html') {
  const html = read(page);
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' + page });
  const w = dom.window;
  w.MB = { api: () => Promise.resolve({ config: { contact: contactPayload } }) };
  w.eval(read('assets/js/contact.js'));
  await w.MB.contact.load();
  w.MB.contact.apply(w.document, w.MB.contact.get());
  return w;
}

{
  const w = await contactWith({
    businessName: 'Mystery Bakebite',
    tagline: 'Home bakery & baking school',
    phone: '233201234567', phoneDisplay: '+233 20 123 4567',
    email: 'orders@example.com', whatsapp: '233209999888',
    whatsappMessage: 'Hi bakery', alerts: '',
    address: { line1: '12 Market Rd', line2: '', city: 'Tamale', region: 'Northern Region', country: 'Ghana', mapUrl: 'https://maps.example/x' },
    hours: { days: 'Mon to Sat', open: '09:00', close: '17:30', note: 'Closed Sundays' },
    social: { instagram: 'https://instagram.com/otherhandle', facebook: '', tiktok: '', x: '', youtube: '' }
  });
  const d = w.document;
  t('db value: click-to-call uses the configured number',
    d.querySelector('[data-contact-link="phone"]').getAttribute('href') === 'tel:+233201234567');
  t('db value: WhatsApp uses the configured number',
    /wa\.me\/233209999888/.test(d.querySelector('[data-contact-link="whatsapp"]').getAttribute('href')));
  t('db value: email link updated',
    d.querySelector('[data-contact-link="email"]').getAttribute('href') === 'mailto:orders@example.com');
  t('db value: Instagram link updated',
    d.querySelector('[data-contact-link="instagram"]').getAttribute('href') === 'https://instagram.com/otherhandle');
  t('db value: address reads naturally',
    d.querySelector('[data-contact="address"]').textContent === '12 Market Rd, Tamale, Northern Region, Ghana');
  t('db value: hours converted to 12-hour clock',
    d.querySelector('[data-contact="hoursTime"]').textContent === '9:00am \u2013 5:30pm');
}

{
  const w = await contactWith({ phone: 'abc', email: 'nope', whatsapp: '', address: {}, hours: {} }, 'index.html');
  const d = w.document;
  t('invalid payload: phone is not blanked', d.querySelector('[data-contact="phone"]').textContent.trim() !== '');
  t('invalid payload: email is not blanked', d.querySelector('[data-contact="email"]').textContent.trim() !== '');
}

{
  const html = read('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  w.MB = { api: () => Promise.reject(new Error('offline')) };
  w.eval(read('assets/js/contact.js'));
  await w.MB.contact.load();
  const d = w.document;
  t('offline: phone still rendered', d.querySelector('[data-contact="phone"]').textContent.trim() !== '');
  t('offline: WhatsApp link still valid',
    /wa\.me\/\d+/.test(d.querySelector('[data-contact-link="whatsapp"]').getAttribute('href')));
  t('offline: Instagram link still valid',
    /instagram\.com/.test(d.querySelector('[data-contact-link="instagram"]').getAttribute('href')));
}

{
  const w = await contactWith({ social: { instagram: '' } });
  const igs = [...w.document.querySelectorAll('[data-contact-link="instagram"]')];
  t('cleared social link is hidden, not a dead href', igs.every((a) => a.hasAttribute('hidden')));
}

/* =====================================================================
 * 3. Course loading — every failure mode explains itself
 * ===================================================================== */

const SIX = [
  ['bread-beginner', 'bread', 1, 'Beginner', 'Bread Making \u00b7 Beginner', 150000],
  ['bread-intermediate', 'bread', 2, 'Intermediate', 'Bread Making \u00b7 Intermediate', 220000],
  ['bread-advanced', 'bread', 3, 'Advanced', 'Bread Making \u00b7 Advanced', 300000],
  ['pastry-beginner', 'pastry', 1, 'Beginner', 'Pastry & Savoury \u00b7 Beginner', 150000],
  ['pastry-intermediate', 'pastry', 2, 'Intermediate', 'Pastry & Bakery \u00b7 Intermediate', 220000],
  ['pastry-advanced', 'pastry', 3, 'Advanced', 'P\u00e2tisserie & Desserts \u00b7 Advanced', 300000]
].map(([slug, track, level, levelLabel, name, fee]) => ({
  slug, track, level, levelLabel, name, summary: 's', description: 'd', fee,
  hours: '1 week', schedule: 'Mon-Fri', recipes: ['A'], skills: ['s'],
  provided: ['p'], bring: ['b'], bringNote: 'Everything is provided.', prereq: 'none'
}));

function bootClasses(apiImpl) {
  const html = read('classes.html').replace(/<script src="assets\/js\/[^"]+"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/classes.html' });
  const w = dom.window;
  w.MB = { api: apiImpl };
  w.eval(read('assets/js/classes.js'));
  return w;
}

{
  const w = bootClasses(() => Promise.resolve({ ok: false, code: 'PGRST202', error: 'missing' }));
  await settle(60);
  const bread = w.document.getElementById('classes-bread').textContent;
  const pastry = w.document.getElementById('classes-pastry').textContent;
  t('missing RPC: says the service is unavailable', /not available yet/i.test(bread));
  t('missing RPC: pastry column is not left blank', pastry.trim().length > 0);
  t('missing RPC: offers Try again', !!w.document.getElementById('classes-retry'));
  t('missing RPC: no endless loading text', !/Loading the bread courses/i.test(bread));
}

{
  const w = bootClasses(() => Promise.resolve({ ok: true, classes: [], config: {} }));
  await settle(60);
  t('empty catalogue: explains there are no open courses',
    /No courses are open for booking/i.test(w.document.getElementById('classes-bread').textContent));
}

{
  const w = bootClasses(() => Promise.reject(new Error('Failed to fetch')));
  await settle(60);
  t('network failure: says the bakery could not be reached',
    /could not reach the bakery/i.test(w.document.getElementById('classes-bread').textContent));
}

{
  let calls = 0;
  const w = bootClasses(() => {
    calls++;
    return calls === 1
      ? Promise.resolve({ ok: false, code: 'network', error: 'down' })
      : Promise.resolve({ ok: true, classes: SIX, config: { bundle_two_pct: 15, bundle_three_pct: 25 } });
  });
  await settle(60);
  t('retry: first attempt fails visibly', /could not reach/i.test(w.document.getElementById('classes-bread').textContent));
  w.document.getElementById('classes-retry').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(80);
  t('retry: clicking Try again renders the courses', w.document.querySelectorAll('.cls').length === 6,
    'rendered ' + w.document.querySelectorAll('.cls').length);
  t('retry: three bread courses', w.document.getElementById('classes-bread').querySelectorAll('.cls').length === 3);
  t('retry: three pastry courses', w.document.getElementById('classes-pastry').querySelectorAll('.cls').length === 3);
  t('retry: bringNote is rendered', /Everything is provided/.test(w.document.body.textContent));
}

/* =====================================================================
 * 4. Booking pricing and bundle discounts (local seed data)
 * ===================================================================== */

{
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'https://example.test/' });
  const w = dom.window;
  w.MB_CONFIG = { url: '', anonKey: '' };   // force the offline database
  w.eval(read('assets/js/supabase.js'));
  const MB = w.MB;

  const cat = await MB.api('/api/catalogue');
  t('catalogue: returns six courses', (cat.classes || []).length === 6, 'got ' + (cat.classes || []).length);
  t('catalogue: two tracks', new Set((cat.classes || []).map((c) => c.track)).size === 2);
  t('catalogue: every course has a fee', (cat.classes || []).every((c) => typeof c.fee === 'number' && c.fee > 0));

  const one = await MB.api('/api/price/booking', { method: 'POST', body: { items: [{ slug: 'bread-beginner', qty: 1 }] } });
  t('pricing: one course, no discount', one.ok && one.total === 150000 && one.discount === 0);

  const two = await MB.api('/api/price/booking', { method: 'POST', body: { items: [{ slug: 'bread-beginner', qty: 1 }, { slug: 'pastry-beginner', qty: 1 }] } });
  t('pricing: two courses gets 15% off', two.ok && two.discount === 45000 && two.total === 255000);

  const three = await MB.api('/api/price/booking', { method: 'POST', body: { items: [
    { slug: 'bread-beginner', qty: 1 }, { slug: 'bread-intermediate', qty: 1 }, { slug: 'bread-advanced', qty: 1 }
  ] } });
  t('pricing: three courses gets 25% off', three.ok && three.discount === 167500 && three.total === 502500);
}

/* =====================================================================
 * 5. Catalogue sync — dashboard prices reach the static shop page
 * ===================================================================== */

{
  const pageHtml = read('products.html').replace(/<script src="assets\/js\/[^"]+"[^>]*><\/script>/g, '');

  function bootSync(apiImpl) {
    const dom = new JSDOM(pageHtml, { runScripts: 'outside-only', url: 'https://example.test/products.html' });
    const w = dom.window;
    w.MB = { api: apiImpl, formatMoney: (p) => 'GH\u20b5 ' + (p / 100).toFixed(2) };
    w.eval(read('assets/js/catalogue-sync.js'));
    return w;
  }

  const staticPrice = new JSDOM(read('products.html')).window.document
    .querySelector('.vrow[data-sku="milky-2"] .vrow__price').textContent;

  const w = bootSync(() => Promise.resolve({ ok: true, products: [
    { sku: 'milky-2', price: 4500, discountPct: 0 },
    { sku: 'milky-3', price: 4200, discountPct: 10 }
  ] }));
  await settle(80);
  const d = w.document;
  t('catalogue sync: dashboard price reaches the shop page',
    d.querySelector('.vrow[data-sku="milky-2"] .vrow__price').textContent.trim() === 'GH\u20b5 45.00');
  t('catalogue sync: discount renders struck-through original',
    /GH\u20b5 42\.00/.test(d.querySelector('.vrow[data-sku="milky-3"] .vrow__price').innerHTML));
  t('catalogue sync: product name left untouched',
    d.querySelector('.vrow[data-sku="milky-2"] .vrow__name').textContent.trim() === 'Milky donuts, 2 pcs');
  t('catalogue sync: unpublished item marked unavailable',
    d.querySelector('.vrow[data-sku="milky-6"] .vrow__price').textContent.trim() === 'Unavailable');

  for (const [label, impl] of [
    ['empty catalogue', () => Promise.resolve({ ok: true, products: [] })],
    ['offline', () => Promise.reject(new Error('offline'))],
    ['missing RPC', () => Promise.resolve({ ok: false, code: 'PGRST202' })]
  ]) {
    const w2 = bootSync(impl);
    await settle(80);
    t('catalogue sync: ' + label + ' keeps the static price',
      w2.document.querySelector('.vrow[data-sku="milky-2"] .vrow__price').textContent === staticPrice);
    t('catalogue sync: ' + label + ' never blanks a price',
      [...w2.document.querySelectorAll('.vrow__price')].every((e) => e.textContent.trim().length > 0));
  }
}

console.log('\n=== ' + passed + ' passed, ' + failed + ' failed ===');
if (failed) {
  console.log('\nFailures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
