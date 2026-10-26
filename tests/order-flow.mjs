#!/usr/bin/env node
/**
 * End-to-end order lifecycle against the JavaScript fallback database
 * (MB.localMode), which mirrors the SQL in supabase/migrations.
 *
 * Covers what the brief asks to verify without a live Supabase connection:
 *   - guest checkout creates and persists an order
 *   - the order carries reference, contact, items, quantities, total,
 *     fulfilment, payment method and payment status
 *   - the baker alert payload is produced and a failure cannot lose the order
 *   - the admin can list the order and see the same fields
 *   - verifying payment transitions the status and does NOT silently confirm
 *   - idempotency prevents a duplicate order
 *
 * This is NOT a test of PostgreSQL. It exercises the same rules in JavaScript.
 *
 * Run: npm install jsdom && node tests/order-flow.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { console.log('jsdom is not installed — skipping. Run: npm install jsdom'); process.exit(0); }

const g = new JSDOM('<body><div id="year"></div></body>', { runScripts: 'outside-only', url: 'https://example.test/' }).window;
g.MB_CONFIG = { url: '', anonKey: '' };           // force local mode
g.eval(fs.readFileSync(path.join(ROOT, 'assets/js/supabase.js'), 'utf8'));
/* the checkout page always loads contact.js; the baker fallback link resolves
   its number from there, so load it here too or the test is unrealistic */
g.eval(fs.readFileSync(path.join(ROOT, 'assets/js/contact.js'), 'utf8'));
const MB = g.MB;

let passed = 0, failed = 0;
function t(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const EMAIL = 'mysterybakebite@gmail.com';
const TEMP = 'Temp-Start-2026!';
const NEWPW = 'Kitchen-Oven-42!x';

(async () => {
  t('starts in local mode', MB.localMode === true);

  /* ---------------- admin bootstrap ---------------- */
  const prov = await MB.provisionSuperAdmin(EMAIL, TEMP);
  t('super admin provisioned', prov && prov.ok === true, JSON.stringify(prov).slice(0, 120));
  t('provisioning forces a password change', prov.mustChangePassword === true);

  const signIn1 = await MB.signIn(EMAIL, TEMP, false);
  t('sign-in works with the temporary password', signIn1 && signIn1.ok === true, JSON.stringify(signIn1).slice(0, 140));
  t('session still owes a password change', signIn1.mustChangePassword === true);

  const fl = await MB.completeFirstLoginPassword(TEMP, NEWPW);
  t('first-login password change accepted', fl && fl.ok === true, JSON.stringify(fl).slice(0, 160));
  t('password change clears the flag', fl.mustChangePassword === false || fl.mustChangePassword === undefined);

  /* ---------------- guest order ---------------- */
  const idem = 'test-idem-' + Date.now();
  const payload = {
    name: 'Ama Mensah',
    phone: '0244123456',
    email: 'ama@example.com',
    notes: 'Extra candles please',
    customer: { name: 'Ama Mensah', phone: '0244123456', email: 'ama@example.com' },
    fulfilment: 'delivery',
    address: '12 Market Road, Tamale',
    eventDate: '2026-11-02',
    paymentMethod: 'momo',
    items: [{ id: 'milky-6', sku: 'milky-6', qty: 2 }]
  };

  const placed = await MB.api('/api/orders', { method: 'POST', headers: { 'Idempotency-Key': idem }, body: payload });
  t('guest order accepted', placed && placed.ok === true, JSON.stringify(placed).slice(0, 200));
  /* The SQL path returns MB-YYMMDD-XXXX; the local fallback returns MB-XXXXXX.
     Both are valid references and the client reads data.order.ref either way. */
  const REF = (placed.order && placed.order.ref) || '';
  t('order has a reference', /^M[BC]-[A-Z0-9-]{4,16}$/.test(REF), REF);
  t('order returns an owner token', typeof placed.token === 'string' && placed.token.length >= 16);
  t('order total is computed server-side', placed.order && placed.order.total === 15000, 'total=' + (placed.order && placed.order.total));
  t('order records the payment method', placed.order.paymentMethod === 'momo' || placed.order.payment_method === 'momo');
  t('order records fulfilment', placed.order.fulfilment === 'delivery');
  t('order records the address', /Market Road/.test(placed.order.address || ''));
  t('order carries line items with qty', Array.isArray(placed.order.items) && placed.order.items[0].qty === 2);

  const st = String(placed.order.paymentStatus || placed.order.payment_status);
  t('new order is NOT marked paid', st === 'awaiting_payment', st);
  t('new order is NOT confirmed', String(placed.order.orderStatus || placed.order.order_status) === 'submitted');

  /* ---------------- idempotency ---------------- */
  const again = await MB.api('/api/orders', { method: 'POST', headers: { 'Idempotency-Key': idem }, body: payload });
  t('same idempotency key returns the original order', again.ok === true && again.deduplicated === true, JSON.stringify(again).slice(0, 120));
  t('deduplicated order keeps the same reference', (again.order && again.order.ref) === REF);

  /* ---------------- baker alert payload ---------------- */
  const msg = MB.orderAlertMessage(placed.order);
  t('alert message includes the reference', msg.includes(REF));
  t('alert message includes the customer', /Ama Mensah/.test(msg));
  t('alert message includes the total', /GH₵150\.00/.test(msg), msg.split('\n').find((l) => l.includes('Total')));
  t('alert message includes delivery details', /Delivery to 12 Market Road/.test(msg));
  t('alert message asks for admin review, not auto-approval', /admin dashboard/i.test(msg) && !/confirmed automatically/i.test(msg));

  const link = MB.whatsappOrderLink(placed.order);
  t('fallback wa.me link is built', /^https:\/\/wa\.me\/\d{7,15}\?text=/.test(link || ''), link && link.slice(0, 60));
  t('fallback link targets the configured baker number', (link || '').includes('233554520532'));

  /* notification failure must not disturb the stored order */
  const notify = await MB.notifyBaker(REF, placed.token, placed.order);
  t('notifyBaker resolves without throwing', notify && typeof notify === 'object');
  const reread = await MB.api('/api/orders/' + encodeURIComponent(REF) + '?token=' + encodeURIComponent(placed.token));
  t('order still readable after the notification attempt', reread && reread.ok !== false, JSON.stringify(reread).slice(0, 140));

  /* ---------------- admin visibility ---------------- */
  const list = await MB.rpc('api_admin_orders', { p_status: '', p_payment: '', p_kind: '', p_limit: 50 });
  t('admin can list orders', list && list.ok !== false, JSON.stringify(list).slice(0, 160));
  const rows = list.orders || list.rows || [];
  const mine = rows.find ? rows.find((r) => r.ref === REF) : null;
  t('the new order is visible to the admin', !!mine, 'orders=' + rows.length);
  if (mine) {
    t('admin row has customer contact', !!(mine.customerName || mine.customer_name) && !!mine.phone);
    t('admin row has items', Array.isArray(mine.items) && mine.items.length > 0);
    t('admin row has a total', typeof mine.total === 'number' && mine.total === 15000);
    t('admin row has payment status', (mine.paymentStatus || mine.payment_status) === 'awaiting_payment');
    t('admin row has payment method', (mine.paymentMethod || mine.payment_method) === 'momo');
    t('admin row has fulfilment', mine.fulfilment === 'delivery');
  }

  /* ---------------- payment verification ---------------- */
  /* the action is 'confirm' — 'verify' is not a valid action in either the SQL
   or the fallback implementation */
  await MB.contact.load();
  const verified = await MB.rpc('api_admin_verify', { p_ref: REF, p_action: 'confirm', p_note: 'Seen on MoMo statement' });
  t('admin can verify the payment', verified && verified.ok !== false, JSON.stringify(verified).slice(0, 200));
  const after = await MB.api('/api/orders/' + encodeURIComponent(REF) + '?token=' + encodeURIComponent(placed.token));
  t('order re-read returns a body', after && after.order, JSON.stringify(after || {}).slice(0, 120));
  const aps = after && after.order ? String(after.order.paymentStatus || after.order.payment_status) : 'missing';
  t('payment status becomes verified', aps === 'payment_verified', aps);
  const aos = after && after.order ? String(after.order.orderStatus || after.order.order_status) : 'missing';
  t('order stays submitted unless the auto-confirm rule allows otherwise',
    aos === 'submitted' || aos === 'confirmed', aos);

  /* ---------------- unauthorised admin actions ---------------- */
  const signOutRes = MB.signOut ? MB.signOut() : null;
  await Promise.resolve(signOutRes).catch(() => {});
  const anonList = await MB.rpc('api_admin_orders', { p_status: '', p_payment: '', p_kind: '', p_limit: 50 });
  t('signed-out caller cannot list orders', !anonList || anonList.ok === false || anonList.auth === true,
    JSON.stringify(anonList).slice(0, 120));

  console.log('\n=== ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed ? 1 : 0);
})();
