# Final Audit Report — Mystery Bakebite

**Date:** 25 October 2026
**Scope:** automatic order notifications, Supabase readiness, full application audit.

**Bottom line:** the application code is complete and audited — **898 assertions
pass locally**. It is **not yet live**: four migrations are unapplied, both Edge
Functions are undeployed, and no WhatsApp credential exists. Nothing in this
report claims otherwise.

---

## 1. Completed

### 1.1 Automatic order notifications

**Database side (already built, now verified end to end).** Every submitted order
is written in a single transaction before any notification is attempted. If the
alert fails, the order still exists; `notified_at` stays `NULL` so a retry can
still deliver it. Verified by `tests/order-flow.mjs`.

**Admin visibility.** `order_admin_json()` returns every field the brief lists —
reference, customer name, phone, email, fulfilment, address, `items` (each with
`qty`), subtotal, discount, **total**, payment method, payment status, order
status, proof metadata and `notifiedAt`. Confirmed field by field in the test.

**Baker WhatsApp alert.** `supabase/functions/notify-order/index.ts`, rewritten
this pass:

| Change | Why |
|---|---|
| Message now carries phone, items, **total**, delivery/collection, payment method, payment status, notes | It previously carried only name, ref, summary, date, status — the baker could not see what was owed or where it went |
| Recipient now falls back `BAKER_WHATSAPP_NUMBER → settings.whatsapp_number → settings.whatsapp_contact` | `whatsapp_number` defaults to empty, so the alert would have had **no recipient at all** |
| Webhook branch **fails closed** (503) when `NOTIFY_WEBHOOK_SECRET` is unset | The function runs with `--no-verify-jwt`; otherwise anyone could force a notification for any guessed reference |
| Browser and server message text made byte-identical | The one-tap fallback and the automatic send can no longer drift |

**Verified:** `tests/security-tests.mjs` fails if the browser and server field
lists differ. I proved this by renaming one label server-side — it failed with
`Edge Function alert carries the same fields — missing: Total`, then passed on
revert. The two messages were also compared string-for-string on a realistic
order and came out identical.

### 1.2 Supabase preparation

- `assets/js/config.js` holds the live project URL and publishable key already
  supplied — reused, not re-requested.
- 6 migrations, all syntax-checked (54 statements, PL/pgSQL bodies included).
- RLS on every table; `settings` is not readable by `anon` (`42501` confirmed live);
  contact details are published only through the `SECURITY DEFINER` allow-list in
  `api_config()`.
- Guest checkout with no registration; baker login and RBAC untouched.
- Privileged work stays server-side. `SUPABASE_SERVICE_ROLE_KEY` appears nowhere in
  shipped files — audited, not assumed.

### 1.3 Fixed during this pass

| Issue | Fix |
|---|---|
| **`products.html` quoted hardcoded prices** (39 rows, no `data-sku`). A price edited in the dashboard never reached the shop page, so the customer could read one price and be charged another | Added `data-sku` to all 39 rows + `assets/js/catalogue-sync.js`, which rewrites only the price from the live catalogue. Names, notes, images and layout untouched; keeps static values if the fetch fails; marks an unpublished SKU "Unavailable" instead of quoting it |
| Deploy workflow published the **whole repository** — migrations, tests, CI config, the 15 MB ZIP | Stages only the site into `_site/` (182 files) |
| `notify-order` could not be called at all with a publishable key (not a JWT) | Documented `--no-verify-jwt` + the function's own authorisation |
| 10 pages had a `<button>` with no `type` | Added `type="button"` |
| Two security assertions pinned exact alert wording | Rewritten to assert required *fields*, enabling the message improvement above without weakening the check |

---

## 2. Passed

All run locally, offline, against the real page HTML and scripts.

| Suite | Result | Covers |
|---|---|---|
| `tests/audit.mjs` | **596 passed, 0 failed, 0 warnings** | JS syntax, page titles, viewport, CSP (incl. Supabase origin, no `unsafe-eval`), duplicate ids, every asset, every internal link and `#fragment`, `getElementById` targets, credential exposure, relative paths, `.nojekyll` |
| `tests/security-tests.mjs` | **192 passed, 0 failed** | RPC coverage, admin permission checks, RLS invariants, token leakage, guest-checkout rules, contact-hardcoding guard, alert parity |
| `tests/ui-tests.mjs` | **69 passed, 0 failed** | Every page loads with all real scripts and no script error; contact profile renders; six course failure/success modes + retry; catalogue price sync |
| `tests/order-flow.mjs` | **41 passed, 0 failed** | Guest order → persist → idempotency → baker alert → admin list → payment verification → signed-out denial |
| `tests/sql-parse-check.py` | **54 parsed, 0 failed** | Every migration incl. PL/pgSQL bodies |

### Verified behaviour, specifically

- Guest order created with **no session**; reference and owner token returned.
- New order is `awaiting_payment` / `submitted` — **never auto-paid, never auto-confirmed**.
- Replaying the idempotency key returns the original order instead of a duplicate.
- Notification failure does not disturb the stored order, which stays readable.
- Admin sees reference, contact, items, quantity, total, fulfilment, method, status.
- Payment verification moves status to `payment_verified`.
- A signed-out caller cannot list orders.
- Two courses = −15%, three courses = −25%.
- Class page: missing RPC, empty catalogue, network failure, success, and **retry**
  after failure all behave correctly and never leave a half-blank page.
- Offline, the site still renders contact details instead of blank space.

---

## 3. Needs fixing

Nothing outstanding in code. Three things are **not** verified, and I will not
present them as verified:

1. **No migration has ever executed against a real PostgreSQL server.** `pglast`
   parses plain SQL and PL/pgSQL bodies, but syntax-clean ≠ execution-clean. The
   first run on your project is the real test. Every file is wrapped in
   `BEGIN`/`COMMIT`, so a failure rolls back.
2. **The deployed GitHub Pages site has never been loaded.** No remote or CNAME
   exists in the workspace, so the URL is not discoverable from here.
3. **The WhatsApp Cloud API has never been called.** No credential exists.

Two known limitations, recorded deliberately:

- `account.html` is still on disk, unlinked from every page. Reachable only by
  typing the URL. Delete it if you want it gone.
- `booking.js` (class bookings) does not call `notifyBaker`. Product orders do.
  If class bookings should alert the baker too, that is a small follow-up.

---

## 4. Supabase setup required

### 4.1 Migrations — run in this order

```
20261022 → 20261023 → 20261024 → 20261025 → 20261026 → 20261027
```

Live state measured today:

| Function | Live |
|---|---|
| `api_place_order` | present but **old `auth_required`** version — guest checkout fails |
| `api_config`, `api_catalogue`, `api_price` | **missing** (`PGRST202`) |
| `api_admin_orders` / `_settings` / `_dashboard`, `api_lookup_order` | **missing** |

Only `20261022` and an older `20261023` were ever applied.

### 4.2 Edge Functions

```bash
supabase functions deploy admin-users
supabase functions deploy notify-order --no-verify-jwt
```

### 4.3 Database Webhook (recommended)

Dashboard → Database → Webhooks → Create: table `orders`, event `INSERT`, type
Edge Function, function `notify-order`, header `x-notify-secret: <value>` matching
the `NOTIFY_WEBHOOK_SECRET` secret. Without the secret the webhook path returns
503 by design.

### 4.4 Storage

`proofs` bucket private, admin-only read policies applied by `20261022`.

---

## 5. External integrations required

**WhatsApp Cloud API — credentials do not exist yet.** Until both are set, **no
message is sent automatically.**

| Secret | Required | Source |
|---|---|---|
| `WHATSAPP_TOKEN` | **yes** | Meta Business → WhatsApp → permanent system-user token |
| `WHATSAPP_PHONE_NUMBER_ID` | **yes** | Meta Business → WhatsApp → Phone numbers |
| `WHATSAPP_TEMPLATE_NAME` | strongly advised | Required to message outside a 24-hour window |
| `NOTIFY_WEBHOOK_SECRET` | if using a webhook | Any long random string |
| `BAKER_WHATSAPP_NUMBER` | optional | Defaults to settings; `233554520532` is already configured |

**Automatic vs manual — stated plainly:**

| Path | Actually sends? |
|---|---|
| Function deployed + both credentials set | **Yes, automatically** |
| Deployed, credentials missing | **No** — returns `sent:false` |
| Not deployed (today) | **No** |
| One-tap `wa.me` link | **No** — opens a pre-filled chat; **a human presses Send** |

The confirmation page labels that button "Send the order alert to the baker on
WhatsApp". It does not claim the alert was already sent.

The baker number requested — **+233 55 452 0532 / `233554520532`** — is already the
configured public WhatsApp line and the default alert recipient.

---

## 6. Deployment readiness

**Ready to publish:** yes, with the caveat that the site will look alive while
being unable to take an order until §4.1 is done.

| Item | Status |
|---|---|
| Static site, relative paths, subpath-safe | ✅ 596 audit checks |
| `.nojekyll` | ✅ |
| CSP allows `https://*.supabase.co`, no `unsafe-eval` | ✅ |
| Deploy workflow stages only the site | ✅ fixed this pass |
| No credentials in shipped files | ✅ audited |
| Migrations applied | ❌ 4 of 6 outstanding |
| Edge Functions deployed | ❌ both 404 |
| WhatsApp credentials | ❌ none |

### Go-live order

1. Run the six migrations.
2. Deploy both functions; set the WhatsApp secrets.
3. Create the Database Webhook.
4. Push to `main`; enable Pages → GitHub Actions.
5. Test on the deployed URL: menu loads → add to cart → checkout shows MoMo
   details → place an order → confirm it is **not** marked paid → sign in at
   `admin.html` → the order appears → the baker alert arrives → approve payment.

Step 5 is the only thing that can prove readiness, and it cannot be done from this
environment. Send me the deployed URL and I will run that pass against it.
