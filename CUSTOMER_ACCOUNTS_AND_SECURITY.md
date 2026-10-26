# Mystery Bakebite — Security Audit & (Historical) Customer Accounts Release

> ## ⚠️ ORDERING RULE — READ THIS FIRST
>
> **Customers order WITHOUT an account. Guest checkout is the only ordering model.**
>
> There is no customer registration, no customer sign-in, no account page in
> navigation, and no verified-email requirement. A visitor enters a name and a
> phone number at checkout and orders. The database permits `auth.uid()` to be
> `NULL` for an order.
>
> **This is the single authoritative statement of the ordering rule for the whole
> project.** If any other document, comment, test or section appears to require a
> customer account before ordering, that text is stale and this block overrides it.
>
> The only sign-in in the product is the **Baker Login** (`admin.html`), which is a
> separate administrator path and remains fully enforced.

> ### Status of this document
>
> **§1, §2 and the account-specific rows of §9 describe how the system worked
> BEFORE 25 October 2026**, when accounts were mandatory. They are kept as a record
> of the security work and are **not** a description of current behaviour.
>
> **§3, §4, §6, §7, §8 and §10 remain current** — the schema, RLS, grants,
> deployment and risks are unaffected by the ordering change.
>
> **§5 and §11 have been updated** to the guest-checkout model.
>
> For the current ordering, payment and WhatsApp workflow, see
> **`ORDERING_PAYMENT_AND_WHATSAPP.md`**, which is the second authoritative source
> and agrees with the block above.

_Account release: 23 October 2026 · Ordering model changed to guest checkout: 25 October 2026_

This document covers the security work behind ordering: trusted order creation that
re-prices everything server-side, manual-payment integrity, Row Level Security, the
security test report, and the Supabase / GitHub Pages configuration that still has
to be performed in your own accounts.

The customer-account feature described in §1–§2 was **removed from the product** on
25 October 2026. Customers order as guests. Those sections are history.

Nothing in this document claims that the system is "completely secure". It records
what was implemented, what was actually tested in this workspace, and what could
not be tested without access to a live Supabase project.

---

## 1. Architecture as found

| Layer | What exists | Notes |
| --- | --- | --- |
| Frontend | 11 static HTML pages + 16 JS files + 2 CSS files, hosted on GitHub Pages | No framework, no build step. All requests go through `assets/js/supabase.js`. |
| Auth | Supabase Auth (GoTrue REST endpoints called directly) | Previously only used for the administrator dashboard. Customers had no accounts. |
| Database | Supabase PostgreSQL; tables `categories`, `products`, `classes`, `cake_options`, `settings`, `admin_users`, `admin_audit_log`, `orders`, `payment_submissions` | Orders stored customer details + a JSONB `items` snapshot; there was no `customer_id`. |
| Server logic | `SECURITY DEFINER` RPCs (`api_config`, `api_catalogue`, `api_price`, `api_place_order`, `api_lookup_order`, `api_order`, `api_submit_proof`, `api_admin_*`) | `api_place_order` accepted **anonymous** orders. |
| Storage | Private `proofs` bucket for payment screenshots | Admin-only read policy already existed. |
| Admin | `admin.html` + `assets/js/admin.js`, RBAC roster with a protected Super Administrator | Access to admin RPCs is gated by `is_verified_admin()` / `has_admin_permission()`. |
| Offline fallback | `assets/js/supabase.js` falls back to a `localStorage` database when `MB_CONFIG` is empty | Useful for previewing; it now mirrors the same authorisation rules so the UI is testable. |

### Weaknesses found before this change

1. **No customer identity at all.** `orders` had no `customer_id`, so "my orders"
   could not be scoped to a person. Order tracking relied on an unguessable token
   in the URL.
2. **Anonymous ordering.** `POST /api/orders` (RPC `api_place_order`) created orders
   without a session. Any script could create unlimited orders.
3. **Client-trusted prices.** The browser sent `unitPrice` / `lineTotal`, and an
   unknown SKU silently fell back to the browser-supplied price.
4. **Custom-cake pricing was client-side.** `priceCustomSpec()` lived only in the
   browser; a crafted `spec` could request arbitrary amounts.
5. **No customer rows existed** in the database, so RLS on orders could only be
   written as "administrators only".
6. **`advance_threshold` default of 15 000 pesewas (GH₵ 150.00)** in the migration
   contradicted the confirmed business rule of **strictly greater than GH₵ 700.00**.
7. **Two contradictory migrations** (`token` vs `token_hash`, `idempotency_key` vs
   `idem_key`, `verified_by TEXT` vs `UUID`). Whichever ran first silently won.
   **Resolved** — the two files were merged into
   `20261022_canonical_schema_rbac_and_rls.sql`; see §10.3.
8. **`order_status` had no `ready` value**, and nothing stopped a customer-side path
   from moving an order straight to `confirmed`/`completed`.
9. **No account UI, no nav entry point, no password recovery page for customers.**

Each of these is addressed below; see §11 for what is still open.

---

## 2. Files created, changed, removed (HISTORICAL — 23 Oct 2026)

> **This table records what the account release did at the time. Most of it was
> undone on 25 October when accounts were removed.** In particular: the account
> gate in `checkout.js` and `booking.js` is **gone**, the `auth_required` /
> `email_not_verified` handling is **gone**, the "My Account" navigation entries
> are **gone**, and the checkout account bar is **gone**. Do not use this table to
> reason about current behaviour.

### Created

| File | Purpose |
| --- | --- |
| `account.html` | Customer sign-in / registration / password reset / account area. Same header, footer, fonts, palette and animations as the rest of the site. |
| `assets/js/account.js` | Account page logic: registration, sign-in, recovery, profile editing, password change, personal order & booking history. |
| `supabase/migrations/20261023_customer_accounts_secure_ordering_and_rls.sql` | Customer profiles, normalized `order_items` / `payments` / `class_bookings`, RLS + grants, trusted `api_place_order`, ownership-aware `api_order` / `api_submit_proof`, admin status-transition gate, GH₵ 700 rule. |
| `tests/security-tests.mjs` | 77 automated security & regression assertions (see §9). |
| `CUSTOMER_ACCOUNTS_AND_SECURITY.md` | This document. |

### Changed

| File | Change |
| --- | --- |
| `assets/js/supabase.js` | `getAuthenticatedOrderActor()`; `signUpCustomer`, `signInCustomer`, `signOutCustomer`, `requestCustomerPasswordReset`, `resendVerificationEmail`, `updateCustomerPassword`, `consumeAuthRedirect`, `refreshCustomerProfile`; `/api/account/*` routes; strict catalogue + custom-cake validation (`priceCustomSpec` now returns `valid/code/error`); order creation requires a verified session; `customerId` derived from the session; owner-scoped `api_order`, `api_lookup_order`, proof submission; admin status transitions validated (allowed values, immutable totals, GH₵ 700 gate); customer profile storage in the local fallback. |
| `assets/js/checkout.js` | Account gate on load and again immediately before submit, cart preserved across the redirect, profile prefill, read-only email, `auth_required` / `email_not_verified` handling. |
| `assets/js/booking.js` | Same account gate for class bookings. |
| `assets/js/order.js` | A signed-in owner may open their order by reference; non-owners still need the token. |
| `assets/js/main.js` | Customer account link in the header (`SIGN IN` → name), still hidden for administrators; kept the existing Dashboard-only-for-admins behaviour. |
| `checkout.html` | Account bar with sign-out, read-only verified email. |
| `classes.html`, `contact.html`, `index.html`, `menu.html`, `products.html`, `booking.html`, `order.html`, `admin.html`, `checkout.html` | “My Account” added to the mobile menu and footer navigation. |
| `assets/css/styles.css` | `.account-bar`, `.account-nav-link`, `.acct-*` component styles (brand tokens reused; no redesign of existing blocks). |
| `supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql` | Merged the two conflicting `20261022_*` migrations into one canonical file; `advance_threshold` default is `70000` pesewas. |

### Removed
Nothing. No existing page, table, policy, function or asset was deleted.

---

## 3. Database schema added by `20261023_…`

```
customer_profiles   user_id PK → auth.users(id) ON DELETE CASCADE
                    email UNIQUE, full_name, phone, email_verified, timestamps
                    (created/updated by a trigger on auth.users — never by the browser)

orders (altered)    customer_id → auth.users(id) ON DELETE SET NULL   (indexed)
                    idempotency_key (compat shim if only idem_key exists)
                    token (compat shim if only token_hash exists)
                    order_status CHECK now includes 'ready'
                    ref CHECK relaxed to ^M[BC]-[A-Z0-9-]{4,20}$

order_items         order_ref → orders(ref) ON DELETE CASCADE, customer_id,
                    line_index, item_kind (product|custom_cake|class),
                    product_sku / class_slug (nullable FKs), item_name, item_meta,
                    qty 1..100, unit_price (price snapshot), discount_pct 0..90,
                    line_discount, line_total, prep_days, custom_spec JSONB
                    UNIQUE (order_ref, line_index)

payments            order_ref UNIQUE → orders(ref), customer_id, payment_method,
                    expected_amount, transaction_reference, proof_image_path,
                    customer_note, verification_status, reject_reason,
                    requires_pre_confirmation_verification,
                    submitted_at, verified_at, verified_by

class_bookings      booking_ref UNIQUE → orders(ref), customer_id, courses JSONB,
                    bundles JSONB, subtotal/discount/total, payment_status,
                    booking_status, notes
```

Key database rules:

* `trg_sync_customer_profile` — idempotent (`ON CONFLICT (user_id)`) profile upsert
  on `auth.users` insert/update. It copies **only** `full_name` and `phone` from
  metadata. No role, no privilege, no `is_admin` flag is ever read from metadata.
* `trg_protect_customer_profile` — blocks a non-admin from changing `user_id`,
  `email`, `email_verified` or `created_at`, and re-validates name/phone length.
* `trg_orders_payment_state_machine` — verified payments are irreversible; only
  `has_admin_permission('verify')` may set `payment_verified`; duplicate customer
  proof submissions are blocked; `customer_id`, `subtotal`, `discount`, `total` and
  `kind` are immutable after insert; an order **> GH₵ 700.00** (or one flagged
  `advance_required`) cannot reach `confirmed`, `in_preparation`, `ready` or
  `completed` until `payment_status = 'payment_verified'`; cancelled/completed
  orders cannot move backwards.
* All monetary columns are `INTEGER` pesewas, never floats.

### Applying the migration

The local `.sql` file does **not** change the live database by itself.

```bash
# 1. Review what will change
supabase migration list --project-ref <PROJECT_REF>

# 2. Apply (CLI, linked project)
supabase db push --project-ref <PROJECT_REF>

#    …or paste the file into Supabase Dashboard → SQL Editor → Run
#    (run it inside a transaction; it already contains BEGIN/COMMIT)

# 3. Verify
supabase db diff --project-ref <PROJECT_REF>     # expect "No schema changes"
```

Post-apply verification queries:

```sql
-- RLS must be ON and FORCED on private tables
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('customer_profiles','orders','order_items','payments',
                  'payment_submissions','class_bookings')
order by relname;

-- Policies
select schemaname, tablename, policyname, cmd, roles
from pg_policies where schemaname = 'public' order by tablename, policyname;

-- Threshold
select advance_threshold from public.settings where id = 1;   -- expect 70000

-- Functions must be SECURITY DEFINER with a pinned search_path
select p.proname, p.prosecdef, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'api_%'
order by p.proname;
```

### Rollback / recovery

The migration is additive; nothing is dropped.

```sql
begin;
  drop table if exists public.class_bookings;
  drop table if exists public.payments;
  drop table if exists public.order_items;
  drop table if exists public.customer_profiles cascade;      -- drops its triggers
  alter table public.orders drop column if exists customer_id;
  alter table public.orders drop constraint if exists orders_order_status_check;
  alter table public.orders add  constraint orders_order_status_check
    check (order_status in ('submitted','confirmed','in_preparation','completed','cancelled'));
commit;
```

Then re-apply the previous `api_place_order` definition if you must return to the
anonymous flow (not recommended). Take a database backup first:
`supabase db dump -f backup-$(date +%F).sql`.

---

## 4. Row Level Security and grants

### Access matrix

| Table | `anon` | `authenticated` customer | verified admin |
| --- | --- | --- | --- |
| `categories`, `products`, `classes`, `cake_options` | `SELECT` published only | `SELECT` published only | `SELECT` all (policy) |
| `settings` | none | none | `ALL` with `settings` permission (`api_admin_settings` RPC only) |
| `customer_profiles` | none | `SELECT`/`UPDATE` **own row only** (`user_id = auth.uid()`); column grants limited to `full_name`, `phone`, `updated_at` | `SELECT` all |
| `orders` | none | `SELECT` `customer_id = auth.uid()` only | `SELECT` all, `UPDATE` with `orders` permission |
| `order_items` | none | `SELECT` `customer_id = auth.uid()` only | `SELECT` all |
| `payments` | none | `SELECT` `customer_id = auth.uid()` only | `ALL` with `verify` permission |
| `payment_submissions` | none | `SELECT` for own orders only (EXISTS on `orders.customer_id`) | `ALL` with `verify` |
| `class_bookings` | none | `SELECT` `customer_id = auth.uid()` only | `ALL` with `verify` |
| `admin_users`, `admin_audit_log` | none | none | roster/audit policies from the earlier migration |
| `storage.objects` (`proofs`) | none | none | `SELECT`/`DELETE` for verified admins |

### Grants

`REVOKE ALL` then targeted `GRANT`:

```sql
REVOKE ALL ON public.customer_profiles, public.orders, public.order_items,
              public.payments, public.payment_submissions, public.class_bookings
  FROM anon, authenticated;

GRANT SELECT ON public.categories, public.products, public.classes, public.cake_options TO anon, authenticated;
GRANT SELECT, UPDATE (full_name, phone, updated_at) ON public.customer_profiles TO authenticated;
GRANT SELECT ON public.orders, public.order_items, public.payments,
                 public.payment_submissions, public.class_bookings TO authenticated;
```

Consequences:

* There is **no** `INSERT`/`UPDATE`/`DELETE` grant on `orders`, `order_items`,
  `payments` or `class_bookings` for customers. All writes go through
  `SECURITY DEFINER` RPCs that re-check `auth.uid()`. A stolen anon key plus a
  hand-written REST call cannot write those tables.
* `customer_profiles` UPDATE is granted only on the three editable columns, so an
  `UPDATE ... SET email_verified = true` fails at the privilege layer as well as
  being blocked by the trigger.
* Every RPC pins `search_path = public, pg_temp` and is `SECURITY DEFINER`.
  `EXECUTE` is granted explicitly; `api_place_order` is `authenticated`-only.

---

## 5. Application flow

### Ordering (no registration, no sign-in)

1. The customer browses `menu.html`, `products.html`, `classes.html` and adds items
   to the cart. The cart lives in `localStorage` under `mb-cart-v1`.
2. `checkout.html` (and `booking.html` for classes) opens straight onto the form.
   **There is no auth gate and no redirect to `account.html`.** The fields are:
   name (required), phone (required), email (optional), notes (optional), preferred
   date, fulfilment (collect / deliver + address), and payment method.
3. `submit()` builds the payload locally, generates an idempotency key, and calls
   `api_place_order`. No session, token or email is required.
4. In the database `auth.uid()` is **allowed to be null**. When it is null the order
   is stored with `customer_id = NULL`; when a session happens to exist the order is
   linked to it. Nothing in the browser is trusted: the RPC re-reads the catalogue,
   re-prices every line, re-validates the custom cake spec and the date, and enforces
   the advance-payment threshold itself.
5. The confirmation screen shows the reference and a private **order token** link
   (`order.html?ref=…&token=…`) so the guest can return without an account. The
   token is never placed in the admin serialiser or any list response.
6. Recovery path: `order.html` → **Find my order** requires the reference **and** the
   phone number used at checkout (`api_lookup_order`), with a `pg_sleep(0.35)` on a
   miss to blunt enumeration and no distinction between "no such reference" and
   "wrong phone" in the response.

`account.html` is no longer linked from anywhere. Customer sign-in, sign-up, profile
and order-history screens are unreachable; the RPCs behind them
(`api_customer_whoami`, `api_customer_orders`, `api_customer_update_profile`) remain
defined and still require their own session, so they are inert rather than removed.
If accounts are ever re-enabled, the pages and RPCs are still there — only the entry
points are gone. **Baker/admin authentication is a separate path and was not
touched.**

### Trusted order creation (`api_place_order`)

1. Resolve `v_uid := auth.uid()`. **Null is accepted** (guest order). An email
   verification check is no longer applied, because there is no sign-up step.
2. Idempotency: `(idempotency_key, customer_id)` must be unique; a repeat returns
   the original order instead of a duplicate. For guests (`customer_id IS NULL`) the
   guard is the unique partial index on `idempotency_key` alone, so a double-tap or
   a retried request cannot create two orders.
3. Validate name, phone, fulfilment, address, payment method, cart size, and every
   quantity (`1..100`, whole number).
4. Look up every product by SKU / every class by slug **in the database**; reject
   unknown or unpublished items.
5. Re-price each line from `products.price` and `products.discount_pct`;
   the browser's `unitPrice`, `lineTotal`, `discount`, `total`, `customerId` are
   ignored entirely.
6. Custom cakes are validated against an allow-list of types, varieties, sizes,
   decorations, flavours and add-ons; the price is recomputed server-side. Unknown
   keys are rejected (`invalid_custom_spec`).
7. Validate the preferred date against the longest `prep_days` in the cart.
8. Apply the threshold: `advance_required := has_quote OR total > 70000`.
   Cash methods are refused above it (`advance_required`).
9. Insert `orders` + every `order_items` row + one `payments` row (+
   `class_bookings` for bookings) in the same transaction, then return `ref`,
   `token` and the sanitised order.

If any step raises, the whole function rolls back — no partial order remains.

### Manual payments

* `payments.verification_status` starts as `awaiting_payment` (or
  `pay_on_collection` for cash).
* `api_submit_proof` requires either the authenticated owner or the order token,
  then always writes `payment_submitted`. **It never sets `payment_verified`.**
* `payment_submissions` keeps a partial unique index (one active row per order) and
  a unique index on the upper-cased reference, so duplicates are refused at the
  database level even under a race.
* Only `api_admin_verify` (permission `verify`) can move a payment to
  `payment_verified`, and the trigger records `verified_at`/`verified_by` and locks
  the row permanently.
* An administrator rejecting a submission must supply a reason; that unlocks one
  new submission.

### Status model

`submitted → confirmed → in_preparation → ready → completed`, plus `cancelled`
(terminal). The trigger refuses backwards moves out of `cancelled`/`completed`, and
`api_admin_update_order` refuses an unknown status, changes to `customer_id`/totals,
and any confirmation of a `> GH₵ 700.00` order that is not `payment_verified`.

---

## 6. Supabase Dashboard configuration (required — cannot be done from here)

1. **Authentication → Providers → Email** — enable *Confirm email*.
2. **Authentication → URL Configuration**
   * Site URL: `https://<username>.github.io/<repository>/`
   * Additional redirect URLs:
     * `https://<username>.github.io/<repository>/account.html`
     * `https://<username>.github.io/<repository>/account.html?mode=reset`
     * `https://<username>.github.io/<repository>/checkout.html`
     * `https://<username>.github.io/<repository>/booking.html`
     * (development) `http://localhost:8000/account.html`
3. **Authentication → Email Templates → Confirm signup / Reset password** — confirm
   the link uses `{{ .ConfirmationURL }}` and mentions Mystery Bakebite.
4. **Authentication → Passwords** — minimum length 10, require upper/lower/number,
   enable *leaked password protection* if your plan includes it.
5. **Authentication → Rate limits** — keep the built-in limits; the site adds its own
   client-side throttle on sign-in, sign-up, recovery and lookup.
6. **Authentication → Sessions** — set JWT expiry to 3600s (the client refreshes a
   minute before expiry) and refresh-token reuse interval to the default.
7. **Database → Extensions** — `pgcrypto` (created by the migration).
8. **Database → Migrations** — apply `20261022_canonical_schema_rbac_and_rls.sql`
   first, then `20261023_customer_accounts_secure_ordering_and_rls.sql` (§3).
9. **Storage → proofs** — keep the bucket **private**; the migration sets it, verify
   the padlock in the dashboard.
10. **Project Settings → API** — copy only the **anon / publishable** key into the
    GitHub repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The
    `service_role` key must never be added to the repository or to `config.js`.
11. **Create the Super Administrator** — Dashboard → Authentication → Users → *Add user*
    with `mysterybakebites@gmail.com`. The `on_auth_user_created_super_admin` trigger
    enrols it as `super_admin` with `must_change_password = true`; the first sign-in
    forces a password change.
12. **Testing** — repeat the two-account IDOR tests in §9 against a *staging* project
    before touching production data.

GitHub Pages origin note: a project site lives under a sub-path
(`/mystery-bakebite/`), so every redirect URL above must include that prefix. All
in-site links are relative, so no base path had to change.

---

## 7. GitHub Pages deployment

* `.github/workflows/deploy.yml` is unchanged in behaviour: it optionally injects
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` into `assets/js/config.js` from repository
  secrets, then publishes the repository root with `actions/upload-pages-artifact`.
* `account.html` is a normal static page — no SPA rewrite rules are required, and
  every route is a real file, so a refresh never 404s.
* Never place secrets in `VITE_*`, `MB_CONFIG`, HTML or committed JS. The anon key is
  **public by design**; it is only safe because of the RLS and grants in §4.
* `config.js` in the repository contains empty strings, so a clone has no key
  material (verified by the test suite).
* Remember to add `SUPABASE_URL` and `SUPABASE_ANON_KEY` under
  *Settings → Secrets and variables → Actions* before the first deploy.

---

## 8. How to run the tests

```bash
node tests/security-tests.mjs
```

The harness loads the real `assets/js/supabase.js` in a sandbox with a stubbed
browser and two independent "browser" sessions that share one database, which is
how two customers meet the same Supabase project. The local fallback implements the
same authorisation decisions as the SQL RPCs, so refusals and price calculations can
be attacked without a live project.

Last run in this workspace: **77 passed, 0 failed**.

---

## 9. Security test report

Legend — **Passed**: executed in this workspace and green. **Not tested**: requires a
live Supabase project, a mail provider or a browser, which this environment does not
have. **Blocked**: cannot be exercised here.

### Authentication

| # | Test | Result | Evidence |
| --- | --- | --- | --- |
| A1 | Register a new customer | Passed | `Customer A is signed in` |
| A2 | Duplicate registration does not reveal whether the address exists | Passed | generic response path in `signUpCustomer` |
| A3 | ~~Unverified e-mail cannot order~~ **RULE REMOVED 25 Oct 2026** | N/A — superseded | Guest checkout means there is no e-mail to verify. `api_place_order` no longer returns `email_not_verified`; anonymous orders are accepted by design. See the ORDERING RULE block at the top of this file. |
| A4 | Wrong credentials rejected, generic message | Passed | `invalid_credentials` branch |
| A5 | Weak password / mismatch rejected | Passed | 3 assertions |
| A6 | Password recovery sends a single-use link | Not tested | needs Supabase + SMTP |
| A7 | Sign-out clears the session and re-locks history | Passed | `Sign-out clears the session`, `Order history requires a session again after sign-out` |
| A8 | Session survives refresh | Passed | `Session refresh works for a signed-in customer` |
| A9 | Expired/revoked session handled | Not tested | requires a real expired JWT |

### Authorization / IDOR

| # | Test | Result |
| --- | --- | --- |
| B1 | Anonymous cannot order or book | Passed |
| B2 | Anonymous cannot read history or update a profile | Passed |
| B3 | Customer A cannot read B's profile (RLS `user_id = auth.uid()`) | Passed (policy lint) / Not tested (live) |
| B4 | Customer B cannot read A's orders | Passed |
| B5 | Customer B cannot read A's order even with the token while signed in as B | Passed |
| B6 | Customer B cannot submit payment proof for A's order | Passed (`forbidden`) |
| B7 | Customer B cannot look up A's order by reference + phone | Passed (`forbidden`) |
| B8 | Customer B sees only their own (empty) history | Passed |
| B9 | Ordinary user cannot become an administrator | Passed (`Customer A is not an administrator`, admin RPCs refused) |
| B10 | Direct REST calls meet the same rules as the UI | Not tested | needs live REST requests with an anon JWT |

### Price and order manipulation

| # | Test | Result |
| --- | --- | --- |
| C1 | Fabricated product SKU rejected | Passed |
| C2 | Tampered `unitPrice`/`originalPrice`/`price` ignored (charged 7 500 pesewas) | Passed |
| C3 | Browser-supplied `customerId` ignored | Passed |
| C4 | Negative quantity rejected | Passed |
| C5 | Missing / past preferred date rejected | Passed |
| C6 | Unapproved cake size rejected | Passed |
| C7 | Unapproved cake add-on rejected | Passed |
| C8 | Approved custom cake re-priced server-side (GH₵ 230.00) | Passed |
| C9 | Fabricated class slug rejected | Passed |
| C10 | Single class earns no bundle discount; two classes do | Passed |
| C11 | Duplicate submission returns the same order (idempotency) | Passed |
| C12 | Partial order cannot survive a failure | Not tested | the SQL transaction guarantees it; no live DB to interrupt |

### Payment integrity

| # | Test | Result |
| --- | --- | --- |
| D1 | Submitting proof sets `payment_submitted`, never `payment_verified` | Passed |
| D2 | Duplicate proof submission blocked | Passed |
| D3 | Customer cannot mark a payment verified | Passed |
| D4 | Above GH₵ 700 cash order refused | Passed |
| D5 | Exactly GH₵ 700.00 is allowed; not flagged `advance_required` | Passed |
| D6 | GH₵ 710.00 is refused for cash and flagged for MoMo | Passed |
| D7 | Above-threshold order cannot be confirmed before verification | Passed (`payment_verification_required`) |
| D8 | Unknown order status rejected | Passed |
| D9 | Customer cannot use the admin status endpoint | Passed |
| D10 | Verified payment cannot be reverted | Not tested (live) | trigger logic reviewed; no live DB |
| D11 | False transaction reference / cross-order reuse refused | Partially passed | duplicate-reference path covered by JS + unique indexes in SQL; live test pending |

### Database and privilege

| # | Test | Result |
| --- | --- | --- |
| E1 | RLS enabled on all 13 exposed/private tables | Passed (static, 13 assertions) |
| E2 | `REVOKE ALL` on order/payment tables for anon + authenticated | Passed |
| E3 | Customer policy scoped to `auth.uid()` | Passed |
| E4 | Every `SECURITY DEFINER` function pins `search_path` | Passed (static) |
| E5 | No service-role key in frontend code | Passed |
| E6 | `config.js` has no committed key material | Passed |
| E7 | CSP present on all 11 pages | Passed |
| E8 | Migration structural lint (balanced `$$`, `BEGIN/COMMIT`, idempotent policy drops) | Passed (22 `$$`, 10 functions, 8 policies) |
| E9 | Effective grants/policies inspected on a live database | Not tested |
| E10 | Dependency CVE scan | Not applicable — the site has **no** npm/runtime dependencies |

### Regression

| # | Test | Result |
| --- | --- | --- |
| R1 | All 11 pages return HTTP 200 on the local server | Passed |
| R2 | Every `<img>` and `<script>` reference resolves on disk | Passed |
| R3 | No duplicate element ids in any page | Passed |
| R4 | Product catalogue, builder, cart, checkout, receipt, classes pages load | Passed (static + syntax check of all 16 JS files) |
| R5 | Admin dashboard sign-in and first-login password change | Passed (local fallback) |
| R6 | Manual visual QA of the new account page in a real browser | Not tested |

---

## 10. Unresolved risks and manual configuration

1. **The migration has not been applied to a live database from this environment.**
   Run it against a staging project first and re-run the SQL checks in §3.
2. **Live RLS/IDOR tests are still required.** "Two accounts" here means two
   *test* identities created purely to probe access boundaries — it is **not** a
   statement that customers need accounts. Guest ordering needs no account at all.
   The `curl` snippets in §11 give a starting point.
3. **Resolved: the two `20261022` migrations were merged.** They created the same
   tables with different shapes, so whichever ran first silently won:
   `orders.token` vs `token_hash`, `idempotency_key` vs `idem_key`,
   `orders.verified_by` TEXT vs UUID, `payment_submissions.id` UUID vs BIGSERIAL,
   `payment_submissions.reviewed_by` TEXT vs UUID, and incompatible
   `admin_users.role` vocabularies. The `verified_by` half was the dangerous one —
   `api_admin_verify()` assigns `auth.uid()` (a UUID), so on a database built from
   the production file every payment confirmation failed with
   `column "verified_by" is of type text but expression is of type uuid`, leaving
   the verification step of the money path unusable.

   There is now a single `20261022_canonical_schema_rbac_and_rls.sql` that
   replaces both. The decisions — plaintext `token`, `idempotency_key`,
   UUID `verified_by`/`reviewed_by`/`payment_submissions.id`, and the
   `super_admin`/`administrator`/`manager`/`viewer` role vocabulary — are
   documented in the file header with the reason for each. §7b-2 of 20261023
   still reconciles a database that already applied either predecessor, so an
   existing project converges rather than breaks.

   Verify with:

   ```sql
   SELECT table_name, column_name, data_type
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('verified_by', 'reviewed_by');
   -- expect three rows, all 'uuid'
   ```

   And confirm no stale columns survived:

   ```sql
   SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
      AND column_name IN ('token_hash', 'idem_key');   -- expect zero rows
   ```

4. **E-mail delivery is unverified.** Confirmation, recovery and resend all depend on
   Supabase SMTP. Test with a real inbox; check the spam folder.
5. **Supabase Auth's own rate limits** are the real brute-force defence; the
   client-side throttle is only a convenience. Confirm the dashboard limits.
6. **Admin convenience RPCs** (`api_admin_orders`, `api_admin_dashboard`,
   `api_admin_settings`, `api_admin_*` catalogue writes) were not re-created here;
   they exist in the live project and are `SECURITY DEFINER`. Review them once
   against the new permission helper — a function that trusts
   `session.user.role` from the browser instead of `is_verified_admin()` must be fixed.
7. **Account deletion / retention** is not automated. `customer_profiles` cascades
   from `auth.users`, while `orders.customer_id` is `SET NULL` so financial records
   survive. Define a retention period with the bakery before deleting anything.
8. **Offline fallback.** With an empty `MB_CONFIG` the site runs on `localStorage`,
   where e-mail verification is auto-satisfied because there is no mail provider.
   This is a preview convenience only; production must have `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` configured.
9. **Receipt PDF generation** runs in the browser for the customer's own order; it is
   not a financial ledger.

---

## 11. Manual attack checks to run against staging

```bash
# 1. Anonymous order attempt — expect {"ok": true, ...}.
#    Guest checkout is the intended behaviour, so a SUCCESS here is correct.
#    A failure with code "auth_required" means the live project is still running
#    the OLD api_place_order. Re-run migration 20261023 (or APPLY_ALL_MIGRATIONS.sql).
curl -s "$SUPABASE_URL/rest/v1/rpc/api_place_order" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"p_kind":"product","p_payload":{"items":[{"id":"milky-6","qty":1}],"paymentMethod":"cash_on_pickup","eventDate":"2030-01-01"},"p_idem":"probe-1"}'

# 2. Read someone else's order with a valid customer JWT — expect no rows
curl -s "$SUPABASE_URL/rest/v1/orders?select=ref,total" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $CUSTOMER_B_JWT"

# 3. Try to write an order directly — expect 401/403 from the grant layer
curl -s -o /dev/null -w '%{http_code}\n' "$SUPABASE_URL/rest/v1/orders" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $CUSTOMER_A_JWT" \
  -H "Content-Type: application/json" \
  -d '{"ref":"MB-HACK01","token":"0000000000000000","kind":"product","customer_name":"X","phone":"0550000000","payment_method":"momo","total":1}'

# 4. Try to promote yourself via the profile — expect 403 (column grant) 
curl -s -o /dev/null -w '%{http_code}\n' "$SUPABASE_URL/rest/v1/customer_profiles?user_id=eq.$CUSTOMER_A_UID" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $CUSTOMER_A_JWT" \
  -H "Content-Type: application/json" -X PATCH -d '{"email_verified":true}'
```

Record the observed status codes next to the "Not tested" rows in §9 and keep the
file with the project.
