/* ============================================================
   Mystery Bakebite — security & regression test harness
   ------------------------------------------------------------
   Runs the real assets/js/supabase.js in a sandbox with a stubbed
   browser, against the built-in local fallback database. That path
   mirrors the SQL RPC contract (same codes, same refusals), so the
   authorisation logic can be attacked without touching a live
   Supabase project.

   Usage:  node tests/security-tests.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'assets/js/supabase.js'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function truthy(name, value, detail) {
  record(name, !!value, detail || (value ? '' : 'value was falsy'));
}

/* ---------- minimal browser ---------- */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; }
  };
}

function makeSharedStorage(sharedMap) {
  const own = new Map();
  const choose = (k) => (k === 'mb-local-db-v1' ? sharedMap : own);
  return {
    getItem: (k) => (choose(k).has(k) ? choose(k).get(k) : null),
    setItem: (k, v) => choose(k).set(String(k), String(v)),
    removeItem: (k) => choose(k).delete(k),
    clear: () => own.clear(),
    key: (i) => Array.from(choose('mb-local-db-v1').keys())[i] ?? null,
    get length() { return own.size; }
  };
}

function makeEnv(config = {}, sharedDb = null) {
  const listeners = {};
  const localStorage = sharedDb ? makeSharedStorage(sharedDb) : makeStorage();
  const sessionStorage = makeStorage();
  const win = {
    location: { pathname: '/index.html', search: '', hash: '', origin: 'https://example.github.io' },
    history: { replaceState() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach((fn) => fn(evt)); return true; },
    matchMedia() { return { matches: false, addEventListener() {} }; }
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      querySelector: () => null,
      getElementById: () => null,
      addEventListener() {},
      documentElement: { className: '' },
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      body: { appendChild() {} }
    },
    localStorage,
    sessionStorage,
    console,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    crypto: globalThis.crypto,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Blob: class {},
    FileReader: undefined,
    URLSearchParams,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Date,
    Math,
    JSON,
    isFinite,
    parseInt,
    parseFloat,
    Number,
    String,
    Object,
    Array,
    Error,
    Promise,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    unescape,
    escape
  };
  sandbox.globalThis = sandbox;
  win.MB_CONFIG = config; // blank config => local fallback database
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'supabase.js' });
  return { sandbox, win, MB: win.MB, localStorage, sessionStorage };
}

const isoOffset = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

async function registerAndSignIn(env, email, name, phone) {
  const res = await env.MB.signUpCustomer({
    fullName: name,
    email,
    phone,
    password: 'Bakebite#2026',
    passwordConfirm: 'Bakebite#2026'
  });
  if (!res.ok) throw new Error('signup failed: ' + JSON.stringify(res));
  const login = await env.MB.signInCustomer(email, 'Bakebite#2026', true);
  if (!login.ok) throw new Error('signin failed: ' + JSON.stringify(login));
  return login;
}

async function main() {
  console.log('\n=== Mystery Bakebite — security & regression tests ===\n');

  /* ---------------------------------------------------------------
     1. Anonymous access
     --------------------------------------------------------------- */
  const anon = makeEnv();
  truthy('Anonymous: client loads in local fallback mode', anon.MB.localMode === true);

  const anonOrder = await anon.MB.api('/api/orders', {
    method: 'POST',
    body: { name: 'Anon', phone: '0554520532', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(3), items: [{ id: 'milky-6', qty: 1 }] }
  });
  eq('Anonymous cannot create an order (auth_required)', [anonOrder.ok, anonOrder.code], [false, 'auth_required']);

  const anonBooking = await anon.MB.api('/api/bookings', {
    method: 'POST',
    body: { name: 'Anon', phone: '0554520532', paymentMethod: 'momo', items: [{ slug: 'bread-beginner', kind: 'class', qty: 1 }] }
  });
  eq('Anonymous cannot create a class booking', [anonBooking.ok, anonBooking.code], [false, 'auth_required']);

  const anonHistory = await anon.MB.api('/api/account/orders');
  eq('Anonymous cannot list order history', [anonHistory.ok, anonHistory.code], [false, 'auth_required']);

  const anonProfile = await anon.MB.api('/api/account/profile', { method: 'PATCH', body: { fullName: 'Anon', phone: '0554520532' } });
  eq('Anonymous cannot update a profile', [anonProfile.ok, anonProfile.code], [false, 'auth_required']);

  const anonAdmin = await anon.MB.api('/api/admin/orders', {});
  eq('Anonymous cannot reach admin order data', anonAdmin.ok, false);

  /* ---------------------------------------------------------------
     2. Registration rules
     --------------------------------------------------------------- */
  const weak = await anon.MB.signUpCustomer({ fullName: 'Weak Pw', email: 'weak@example.com', phone: '0554520532', password: 'password1', passwordConfirm: 'password1' });
  eq('Weak password rejected', [weak.ok, weak.code], [false, 'weak_password']);

  const mismatch = await anon.MB.signUpCustomer({ fullName: 'Mismatch', email: 'mismatch@example.com', phone: '0554520532', password: 'Bakebite#2026', passwordConfirm: 'Bakebite#2027' });
  eq('Password confirmation mismatch rejected', [mismatch.ok, mismatch.code], [false, 'password_mismatch']);

  const badMail = await anon.MB.signUpCustomer({ fullName: 'Bad Mail', email: 'not-an-email', phone: '0554520532', password: 'Bakebite#2026' });
  eq('Invalid email rejected', [badMail.ok, badMail.code], [false, 'invalid_email']);

  /* ---------------------------------------------------------------
     3. Customer A: register, sign in, order
     --------------------------------------------------------------- */
  const sharedDb = new Map();
  const envA = makeEnv({}, sharedDb);
  await registerAndSignIn(envA, 'customer.a@example.com', 'Customer A', '0550000001');
  truthy('Customer A is signed in', envA.MB.isSignedIn());
  eq('Customer A is not an administrator', envA.MB.isAdmin(), false);

  const badSku = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(3), items: [{ id: 'not-a-real-sku', qty: 1 }] }
  });
  eq('Fabricated product SKU rejected', [badSku.ok, badSku.code], [false, 'invalid_product']);

  const negativeQty = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(3), items: [{ id: 'milky-6', qty: -2 }] }
  });
  eq('Negative quantity rejected', [negativeQty.ok, negativeQty.code], [false, 'invalid_quantity']);

  const noDate = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', items: [{ id: 'milky-6', qty: 1 }] }
  });
  eq('Order without a preferred date rejected', [noDate.ok, noDate.code], [false, 'date_required']);

  const pastDate = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(-2), items: [{ id: 'milky-6', qty: 1 }] }
  });
  eq('Past preferred date rejected', [pastDate.ok, pastDate.code], [false, 'date_in_past']);

  /* Tampered price must be ignored: the catalogue price is GH₵75.00 (7500 pesewas) */
  const tampered = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: {
      name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(3),
      customerId: 'someone-else',
      items: [{ id: 'milky-6', qty: 1, unitPrice: 1, originalPrice: 1, price: 1, lineTotal: 1 }]
    }
  });
  truthy('Tampered order accepted at catalogue price', tampered.ok === true, JSON.stringify(tampered).slice(0, 240));
  eq('Tampered line price ignored (7500 pesewas)', tampered.order && tampered.order.total, 7500);
  truthy('Browser-supplied customerId ignored', tampered.order && tampered.order.customerId && tampered.order.customerId !== 'someone-else');
  const orderARef = tampered.order && tampered.order.ref;
  const orderAToken = tampered.token;

  /* A mobile-money order whose payment lifecycle we can exercise. */
  const payOrder = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: {
      name: 'Customer A', phone: '0550000001', paymentMethod: 'momo', eventDate: isoOffset(3),
      items: [{ id: 'milky-6', qty: 1 }]
    }
  });
  truthy('Mobile Money order created for payment tests', payOrder.ok === true, JSON.stringify(payOrder).slice(0, 200));
  const payRef = payOrder.order && payOrder.order.ref;
  const payToken = payOrder.token;

  /* ---------------------------------------------------------------
     4. Special order threshold, GH₵ 700.00 boundary
     --------------------------------------------------------------- */
  // milky-12 = 14000 pesewas; 50 x 14000 = 700000 (GH₵7,000) — need exact boundary tests
  // Build exact totals with a cheap item: chips-baked-s = 1000 pesewas (GH₵10.00)
  async function cashOrder(qty) {
    return envA.MB.api('/api/orders', {
      method: 'POST',
      body: {
        name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(3),
        items: [{ id: 'chips-baked-s', qty }]
      }
    });
  }
  const exactly700 = await cashOrder(70);   // 70 000 pesewas = GH₵700.00
  truthy('Cash order at exactly GH₵700.00 is allowed', exactly700.ok === true, JSON.stringify(exactly700).slice(0, 200));
  record('Exactly GH₵700.00 is not flagged as advance-required',
    exactly700.order && exactly700.order.total === 70000 && exactly700.order.advanceRequired === false,
    JSON.stringify(exactly700.order && { total: exactly700.order.total, adv: exactly700.order.advanceRequired }));

  const above700 = await cashOrder(71);     // 71 000 pesewas = GH₵710.00
  eq('Cash order above GH₵700.00 requires advance payment', [above700.ok, above700.code], [false, 'advance_required']);

  const momoAbove = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: {
      name: 'Customer A', phone: '0550000001', paymentMethod: 'momo', eventDate: isoOffset(3),
      items: [{ id: 'chips-baked-s', qty: 71 }]
    }
  });
  truthy('Mobile Money order above GH₵700.00 is accepted but marked advance_required',
    momoAbove.ok === true && momoAbove.order.advanceRequired === true,
    JSON.stringify(momoAbove).slice(0, 220));
  const bigRef = momoAbove.order && momoAbove.order.ref;

  /* ---------------------------------------------------------------
     5. Payment integrity
     --------------------------------------------------------------- */
  const paySubmit = await envA.MB.api('/api/orders/' + payRef + '/proof?token=' + encodeURIComponent(payToken), {
    method: 'POST',
    body: { reference: 'MOMO-REF-12345', note: 'Paid by MoMo' }
  });
  truthy('Customer can submit payment details', paySubmit.ok === true, JSON.stringify(paySubmit).slice(0, 200));
  eq('Payment stays pending verification (never auto-paid)', paySubmit.order.paymentStatus, 'payment_submitted');

  const dupProof = await envA.MB.api('/api/orders/' + payRef + '/proof?token=' + encodeURIComponent(payToken), {
    method: 'POST',
    body: { reference: 'MOMO-REF-12345' }
  });
  eq('Duplicate payment submission blocked', [dupProof.ok, dupProof.code], [false, 'duplicate_submission']);

  /* Customer tries to mark the payment verified through the admin RPC */
  const selfVerify = await envA.MB.api('/api/admin/orders/' + payRef + '/verify', {
    method: 'POST',
    body: { action: 'confirm' }
  });
  eq('Customer cannot mark a payment verified', selfVerify.ok, false);

  /* ---------------------------------------------------------------
     7. Confirmation gate (> GH₵700 needs verified payment)
     --------------------------------------------------------------- */
  /* Same database, separate browser session: exactly how two users meet Supabase. */
  const adminEnv = makeEnv({}, sharedDb);
  await adminEnv.MB.provisionSuperAdmin('mysterybakebite@gmail.com', 'SuperBakebite#2026');
  const adminLogin = await adminEnv.MB.signIn('mysterybakebite@gmail.com', 'SuperBakebite#2026', true);
  truthy('Super Administrator can sign in (local fallback)', adminLogin.ok === true, JSON.stringify(adminLogin));
  truthy('Super Administrator is forced to change the temporary password', adminLogin.mustChangePassword === true);
  const pwdChange = await adminEnv.MB.completeFirstLoginPassword('SuperBakebite#2026', 'SuperBakebite#2027');
  truthy('Super Administrator completes the mandatory password change', pwdChange.ok === true, JSON.stringify(pwdChange));

  const confirmUnpaid = await adminEnv.MB.api('/api/admin/orders/' + bigRef, {
    method: 'PATCH',
    body: { orderStatus: 'confirmed' }
  });
  eq('Above-threshold order cannot be confirmed before payment verification',
    [confirmUnpaid.ok, confirmUnpaid.code], [false, 'payment_verification_required']);

  const invalidStatus = await adminEnv.MB.api('/api/admin/orders/' + bigRef, {
    method: 'PATCH',
    body: { orderStatus: 'shipped-to-mars' }
  });
  eq('Unknown order status rejected', [invalidStatus.ok, invalidStatus.code], [false, 'invalid_status']);

  /* Customer cannot change their own order status or payment status */
  const customerPatch = await envA.MB.api('/api/admin/orders/' + orderARef, {
    method: 'PATCH',
    body: { orderStatus: 'completed' }
  });
  eq('Customer cannot use the admin order-status endpoint', customerPatch.ok, false);

  /* ---------------------------------------------------------------
     6. IDOR: Customer B against Customer A
     --------------------------------------------------------------- */
  const envB = makeEnv({}, sharedDb);
  await registerAndSignIn(envB, 'customer.b@example.com', 'Customer B', '0550000002');

  const readA = await envB.MB.api('/api/orders/' + payRef);
  eq('Customer B cannot read Customer A\'s order', readA.ok, false);

  const readAWithToken = await envB.MB.api('/api/orders/' + payRef + '?token=' + encodeURIComponent(payToken));
  eq('Customer B cannot read A\'s order even with the token while signed in as B', readAWithToken.ok, false);

  const historyB = await envB.MB.api('/api/account/orders');
  truthy('Customer B sees only their own empty history',
    historyB.ok === true && (historyB.orders || []).length === 0,
    JSON.stringify(historyB).slice(0, 200));

  const profileB = await envB.MB.api('/api/account/profile');
  truthy('Customer B profile is their own account',
    profileB.ok && profileB.profile && profileB.profile.email === 'customer.b@example.com',
    JSON.stringify(profileB).slice(0, 200));

  const proofAsB = await envB.MB.api('/api/orders/' + payRef + '/proof?token=' + encodeURIComponent(payToken), {
    method: 'POST',
    body: { reference: 'HACK-REF-999' }
  });
  eq('Customer B cannot submit payment proof for A\'s order', [proofAsB.ok, proofAsB.code], [false, 'forbidden']);

  /* Lookup by reference + phone is scoped to the signed-in owner too */
  const lookupB = await envB.MB.api('/api/orders/lookup', { method: 'POST', body: { ref: payRef, phone: '0550000001' } });
  eq('Customer B cannot look up A\'s order by reference and phone', [lookupB.ok, lookupB.code], [false, 'forbidden']);

  /* ---------------------------------------------------------------
     8. Profile update rules
     --------------------------------------------------------------- */
  const profileUpdate = await envA.MB.api('/api/account/profile', { method: 'PATCH', body: { fullName: 'Customer A Renamed', phone: '0550000009' } });
  truthy('Customer can update their own name and phone', profileUpdate.ok === true && profileUpdate.profile.fullName === 'Customer A Renamed', JSON.stringify(profileUpdate).slice(0, 200));

  const badPhone = await envA.MB.api('/api/account/profile', { method: 'PATCH', body: { fullName: 'Customer A', phone: '12' } });
  eq('Invalid phone rejected on profile update', [badPhone.ok, badPhone.code], [false, 'invalid_phone']);

  /* ---------------------------------------------------------------
     9. Class booking rules (2+ classes only)
     --------------------------------------------------------------- */
  const oneClass = await envA.MB.api('/api/bookings', {
    method: 'POST',
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'momo', items: [{ slug: 'bread-beginner', kind: 'class', qty: 1 }] }
  });
  truthy('Single class booking accepted and linked to the account', oneClass.ok === true, JSON.stringify(oneClass).slice(0, 200));

  const classPricing1 = await envA.MB.api('/api/price/booking', { method: 'POST', body: { items: [{ slug: 'bread-beginner', kind: 'class' }] } });
  eq('No class discount for a single class', classPricing1.discount, 0);

  const classPricing2 = await envA.MB.api('/api/price/booking', {
    method: 'POST',
    body: { items: [{ slug: 'bread-beginner', kind: 'class' }, { slug: 'pastry-beginner', kind: 'class' }] }
  });
  truthy('Two classes earn the bundle discount', classPricing2.discount > 0, JSON.stringify(classPricing2).slice(0, 200));

  const bogusClass = await envA.MB.api('/api/bookings', {
    method: 'POST',
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'momo', items: [{ slug: 'free-class', kind: 'class' }] }
  });
  truthy('Fabricated class slug rejected', bogusClass.ok === false, JSON.stringify(bogusClass).slice(0, 200));

  /* ---------------------------------------------------------------
     10. Custom cake builder validation
     --------------------------------------------------------------- */
  const badCake = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: {
      name: 'Customer A', phone: '0550000001', paymentMethod: 'momo', eventDate: isoOffset(5),
      items: [{ id: 'custom-cake', kind: 'custom', qty: 1, unitPrice: 1, spec: { type: 'classic', size: '999', decor: 'basic', flavour: 'vanilla' } }]
    }
  });
  eq('Unapproved cake size rejected', [badCake.ok, badCake.code], [false, 'invalid_custom_spec']);

  const badAddon = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: {
      name: 'Customer A', phone: '0550000001', paymentMethod: 'momo', eventDate: isoOffset(5),
      items: [{ id: 'custom-cake', kind: 'custom', qty: 1, spec: { type: 'classic', size: '6', decor: 'basic', flavour: 'vanilla', addons: ['free-gold-leaf'] } }]
    }
  });
  eq('Unapproved cake add-on rejected', [badAddon.ok, badAddon.code], [false, 'invalid_custom_spec']);

  const goodCake = await envA.MB.api('/api/orders', {
    method: 'POST',
    body: {
      name: 'Customer A', phone: '0550000001', paymentMethod: 'momo', eventDate: isoOffset(5),
      items: [{ id: 'custom-cake', kind: 'custom', qty: 1, unitPrice: 1, spec: { type: 'classic', size: '6', decor: 'basic', flavour: 'vanilla', addons: ['writing'] } }]
    }
  });
  truthy('Approved custom cake priced from the builder table (GH₵230.00)',
    goodCake.ok === true && goodCake.order.total === 23000,
    JSON.stringify(goodCake.order && { total: goodCake.order.total }));

  /* ---------------------------------------------------------------
     11. Duplicate submission / idempotency
     --------------------------------------------------------------- */
  const idem = 'test-idem-' + Date.now();
  const first = await envA.MB.api('/api/orders', {
    method: 'POST',
    headers: { 'Idempotency-Key': idem },
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(4), items: [{ id: 'milky-2', qty: 1 }] }
  });
  const second = await envA.MB.api('/api/orders', {
    method: 'POST',
    headers: { 'Idempotency-Key': idem },
    body: { name: 'Customer A', phone: '0550000001', paymentMethod: 'cash_on_pickup', eventDate: isoOffset(4), items: [{ id: 'milky-2', qty: 1 }] }
  });
  truthy('Repeated idempotency key returns the same order instead of a duplicate',
    first.ok && second.ok && second.deduplicated === true && second.order.ref === first.order.ref,
    JSON.stringify({ first: first.order && first.order.ref, second: second.order && second.order.ref }));

  /* ---------------------------------------------------------------
     12. Session handling
     --------------------------------------------------------------- */
  const persisted = await envA.MB.refreshSession().then(() => true).catch(() => false);
  record('Session refresh works for a signed-in customer', persisted);
  await envA.MB.signOut();
  eq('Sign-out clears the session', envA.MB.isSignedIn(), false);
  const afterSignOut = await envA.MB.api('/api/account/orders');
  eq('Order history requires a session again after sign-out', [afterSignOut.ok, afterSignOut.code], [false, 'auth_required']);

  /* ---------------------------------------------------------------
     13. Repository / migration static checks
     --------------------------------------------------------------- */
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261023_customer_accounts_secure_ordering_and_rls.sql'), 'utf8');
  const tables = ['customer_profiles', 'orders', 'order_items', 'payments', 'payment_submissions', 'class_bookings', 'settings', 'admin_users', 'admin_audit_log', 'products', 'classes', 'categories', 'cake_options'];
  tables.forEach((t) => {
    const re = new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`, 'i');
    record(`RLS enabled on public.${t}`, re.test(sql));
  });
  record('Direct table writes revoked for order tables', /REVOKE ALL ON public\.orders\s+FROM anon, authenticated;/i.test(sql));
  record('Customer order policy scoped to auth.uid()', /customer_id = auth\.uid\(\)/i.test(sql));
  record('SECURITY DEFINER functions set a search_path', !/SECURITY DEFINER\s*\n(?!\s*SET search_path)/.test(sql) || (sql.match(/SECURITY DEFINER/g) || []).length <= (sql.match(/SET search_path/g) || []).length);
  record('Threshold default is GH₵700.00 (70000 pesewas)', /advance_threshold\s+INTEGER NOT NULL DEFAULT 70000/.test(sql) || /advance_threshold = 70000/.test(sql));
  record('Above-threshold confirmation gate present', /payment_verification_required/.test(sql));
  record('Email verification enforced inside order RPC', /email_not_verified/.test(sql));

  /* ---- canonical 20261022 migration -------------------------------------
     The two conflicting 20261022 files were merged into one. These assertions
     lock in the decisions that made the merge safe. */
  const MIG = path.join(ROOT, 'supabase/migrations');
  const canonicalFiles = fs.readdirSync(MIG).filter((f) => f.startsWith('20261022_'));
  record('Exactly one 20261022 migration exists', canonicalFiles.length === 1, canonicalFiles.join(', '));

  const canonPath = path.join(MIG, canonicalFiles[0] || 'missing.sql');
  const canonSql = fs.existsSync(canonPath) ? fs.readFileSync(canonPath, 'utf8') : '';
  /* Ignore `--` comments: the header documents the old conflicting shapes, and a
     naive regex would match that prose instead of real DDL. */
  const stripSqlComments = (s) => s.replace(/--[^\n]*/g, '');
  const sqlCode = stripSqlComments(sql);
  const canonCode = stripSqlComments(canonSql);

  const declaresUuid = (src, col) =>
    new RegExp(col + '\\s+UUID\\s+REFERENCES\\s+auth\\.users\\(id\\)', 'i').test(src);

  record('canonical: orders.verified_by is UUID', declaresUuid(canonCode, 'verified_by'));
  record('canonical: payment_submissions.reviewed_by is UUID', declaresUuid(canonCode, 'reviewed_by'));
  record('canonical: payments.verified_by is UUID', declaresUuid(sqlCode, 'verified_by'));
  record('canonical: no token_hash / idem_key / BIGSERIAL left', !/token_hash|idem_key|BIGSERIAL/i.test(canonCode));
  record('canonical: orders created exactly once',
    (canonCode.match(/CREATE TABLE IF NOT EXISTS public\.orders\b/g) || []).length === 1);
  record('canonical: payment_submissions created exactly once',
    (canonCode.match(/CREATE TABLE IF NOT EXISTS public\.payment_submissions\b/g) || []).length === 1);
  record('canonical: admin_users created exactly once',
    (canonCode.match(/CREATE TABLE IF NOT EXISTS public\.admin_users\b/g) || []).length === 1);
  record('canonical: payment_submissions.id is UUID',
    /id\s+UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i.test(canonCode));
  record('canonical: orders.idempotency_key is present',
    /idempotency_key\s+TEXT UNIQUE/i.test(canonCode));
  record('canonical: order status allows ready',
    /order_status IN \('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled'\)/.test(canonCode));
  record('canonical: admin roles match has_admin_permission',
    /role IN \('super_admin', 'administrator', 'manager', 'viewer'\)/.test(canonCode));
  record('canonical: superseded hardening policies are dropped',
    /DROP POLICY IF EXISTS orders_admin_all_policy/i.test(canonSql));
  record('canonical: proof upload compares the token, not a hash',
    /v_tok <> v_order\.token/i.test(canonCode));
  record('canonical: every function is defined once',
    (() => {
      const names = (canonCode.match(/CREATE OR REPLACE FUNCTION public\.[a-z_]+/g) || []);
      return names.length === new Set(names).size;
    })());

  /* ---- 20261023 reconciliation ------------------------------------------ */
  record('20261023 reconciles legacy TEXT columns to UUID', /ALTER COLUMN %I TYPE UUID/i.test(sql));
  record('Reconciliation covers orders, payment_submissions and payments',
    (sql.match(/'public\.(orders|payment_submissions|payments)',\s*'(verified_by|reviewed_by)'/g) || []).length >= 3);
  record('Reconciliation attaches the auth.users FK only when missing', /pg_constraint/.test(sql) && /ON DELETE SET NULL/.test(sql));
  record('No verified_by/reviewed_by column left as TEXT', !/(verified_by|reviewed_by)\s+TEXT\s+DEFAULT/i.test(canonCode + sqlCode));
  record('Order trigger records the verifying administrator UUID', /NEW\.verified_by := COALESCE\(NEW\.verified_by, auth\.uid\(\)\)/.test(sql));
  record('Order trigger keeps the payments mirror in sync', /SET verification_status = NEW\.payment_status/.test(sql));
  record('Local mock stores the admin user id, not an e-mail', /vo\.verifiedBy = admActorId/.test(SRC));

  record('Service role key never referenced in frontend', !/service_role\s*[:=]\s*['"][A-Za-z0-9._-]{20,}/.test(SRC));

  const cfg = fs.readFileSync(path.join(ROOT, 'assets/js/config.js'), 'utf8');
  record('config.js contains no committed key material', !/eyJ[A-Za-z0-9_-]{10,}\./.test(cfg));

  const htmlPages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const missingCsp = htmlPages.filter((f) => !/Content-Security-Policy/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  record('All HTML pages keep a Content-Security-Policy', missingCsp.length === 0, missingCsp.join(', '));
  record('account.html ships an account script', /assets\/js\/account\.js/.test(fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8')));
  const checkoutSrc = fs.readFileSync(path.join(ROOT, 'assets/js/checkout.js'), 'utf8');
  record('Checkout redirects unauthenticated visitors to the account page', /goToAccount\('signin_required'\)/.test(checkoutSrc));
  record('Checkout re-checks the session immediately before submit', /Re-check the session immediately before creating the order/.test(checkoutSrc));

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(' - ' + f.name + (f.detail ? ' :: ' + f.detail : '')));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exitCode = 1;
});
