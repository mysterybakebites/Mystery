# Mystery Bakebite — Comprehensive Website Security Audit & Hardening Report

**Audit Date:** 2026-10-22  
**Scope:** Full-stack audit covering all 10 HTML pages, 13 JavaScript modules (`assets/js/*.js`), payment submission workflow, file upload pipeline, authentication & RBAC, Supabase database schema / Row Level Security (RLS) / Storage policies (`supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql`), and network / deployment configuration.

---

## 1. Executive Summary

A full security audit of the Mystery Bakebite web application identified **8 high/critical vulnerabilities and architectural loopholes** across payment proof submission, order lookup, token validation, file upload verification, order placement idempotency, authentication rate limiting, and browser security headers.

All 8 issues have been remediated in code and verified with automated tests, alongside a production-ready Supabase PostgreSQL migration (`supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql`) that enforces Row Level Security (RLS), row-level locking (`SELECT ... FOR UPDATE`), partial unique indexes, and payment state-machine triggers at the database layer.

---

## 2. Vulnerabilities Identified & Fixes Applied

### V-01 (Critical): Duplicate Payment Submissions Allowed on Frontend & Backend
- **Root Cause:**
  1. In `assets/js/order.js` (line 102), `canUpload` explicitly included `'payment_submitted'` (`['awaiting_payment', 'payment_rejected', 'payment_submitted'].indexOf(o.paymentStatus) !== -1`), keeping the payment submission form and upload button active even after a successful submission.
  2. In `assets/js/supabase.js`, `api_begin_proof_upload` and `api_submit_proof` did not check `paymentStatus` or `proofLocked`, did not verify `p_token`, did not block reuse of the same transaction reference across orders, and had no in-flight concurrency lock.
- **Fixes Applied:**
  - **Backend / Database Enforcement (`assets/js/supabase.js` & `supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql`):**
    - Added `validateProofEligibility(db, ref, token)` in `supabase.js` and `SELECT ... FOR UPDATE` row locking + `trg_enforce_order_payment_state_machine` trigger in PostgreSQL.
    - Once a payment reference or screenshot is recorded, `paymentStatus` transitions to `'payment_submitted'` (Pending Verification — **never** automatically marked as `'payment_verified'` or `'paid'`), `proofLocked` is set to `true`, and `submissionCount` is incremented.
    - Any subsequent call to `/api/orders/:ref/proof`, `api_submit_proof`, or `api_begin_proof_upload` while `paymentStatus === 'payment_submitted'` is rejected with `{ ok: false, code: 'duplicate_submission' }`.
    - Any submission after `paymentStatus === 'payment_verified'` is rejected with `{ ok: false, code: 'already_verified' }`.
    - Added unique payment reference checks (`idx_payment_submissions_unique_ref`, `idx_orders_unique_payment_ref`, and `duplicate_reference` validation in `supabase.js`) so the same Mobile Money or Bank transaction reference ID cannot be reused across multiple orders or resubmitted after rejection.
    - Added an in-flight concurrency lock (`IN_FLIGHT_PROOFS[ref]`) to block rapid double-clicks and parallel requests (`code: 'duplicate_in_flight'`).
    - Resubmission is only unlocked if a verified administrator explicitly executes `reject` (with a required reason note `>= 3` characters), which transitions `paymentStatus` to `'payment_rejected'` and sets `proofLocked = false` for one corrected submission.
  - **Frontend UI & Cross-Tab Synchronization (`assets/js/order.js`, `assets/js/checkout.js`, `assets/js/booking.js`):**
    - When `paymentStatus === 'payment_submitted'` (or `proofLocked === true`), `order.js`, `checkout.js`, and `booking.js` completely hide/remove the upload input and submit button and render a locked **Payment Details Received — Pending Baker Verification** confirmation card (`data-proof-state="locked"`).
    - Added `storage` (`mb-proof-sync-v1`, `mb-local-db-v1`) and `CustomEvent('mb-proof-submitted')` listeners so submitting payment details in one browser tab immediately locks the form in any other open tab.

---

### V-02 (Critical): Order Lookup Phone Verification Bypass & Reference Enumeration
- **Root Cause:**
  - In `assets/js/supabase.js` (`api_lookup_order`), the filter condition was `o.ref.toUpperCase() === qRef && (!qPhone || normPhone(o.phone) === qPhone)`. Passing an empty `phone: ""` evaluated `!qPhone` to `true`, allowing anyone who guessed an order reference (`MB-XXXXXX`) to retrieve the full order and its private `token` without knowing the customer's phone number.
- **Fixes Applied:**
  - Removed the `!qPhone` bypass: `api_lookup_order` now strictly requires both a valid reference matching `/^M[BC]-[A-Z0-9]{4,12}$/` and a valid phone number (`normPhone(p_phone).length >= 7`) matching the order's recorded phone number.
  - Added rate limiting (`checkRateLimit('lookup', qRef, 8, 5 * 60 * 1000)`) to block automated enumeration of order references.

---

### V-03 (High): Order Fetch (`api_order`) Token Omission Bypass & Secret Field Exposure
- **Root Cause:**
  - In `assets/js/supabase.js` (`api_order`), the token check used `if (ord.token && args.p_token !== undefined && String(args.p_token || '') !== String(ord.token))`. Calling `MB.rpc('api_order', { p_ref: 'MB-XXXXXX' })` with `p_token` omitted (`undefined`) bypassed the check completely. Additionally, returned order objects included the raw `ord.token` field.
- **Fixes Applied:**
  - Changed the guard to `if (!ord.token || String(args.p_token || '') !== String(ord.token))` so `p_token` is mandatory on every customer order fetch.
  - Added `sanitizeOrderForClient(ord)` to strip the internal `token` property from order payloads returned to client callers.

---

### V-04 (High): Unsafe File Uploads (MIME Spoofing / Missing Magic-Byte Verification)
- **Root Cause:**
  - File upload handlers in `order.js`, `checkout.js`, `booking.js`, and `supabase.js` checked only `file.type` or the `data:image/...` prefix, which can be spoofed by renaming an `.html`, `.svg`, or script file to `.png`.
- **Fixes Applied:**
  - Implemented `MB.checkMagicBytes`, `MB.verifyImageDataUrl`, and `MB.validateImageFile` in `assets/js/supabase.js`:
    - Inspects the binary header (magic bytes) of every image before preview and before upload:
      - **PNG:** `89 50 4E 47 0D 0A 1A 0A`
      - **JPEG:** `FF D8 FF`
      - **WebP:** `52 49 46 46 .... 57 45 42 50`
    - Scans the decoded binary payload for embedded `<script`, `<svg`, `<html`, `<iframe`, `<object`, or `<embed` tags (`code: 'unsafe_image_content'`).
    - Enforces a strict `5 MB` maximum byte limit (`MAX_PROOF_BYTES = 5 * 1024 * 1024`) and blocks dangerous file extensions.
    - Configured the Supabase Storage `proofs` bucket in `supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql` with `public = FALSE`, `file_size_limit = 5242880`, and `allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp']`, restricting `SELECT` access exclusively to verified administrators.

---

### V-05 (High): Missing Backend Enforcement of Advance-Payment Threshold & Order Idempotency
- **Root Cause:**
  - `api_place_order` in `assets/js/supabase.js` ignored `p_idem` (`Idempotency-Key`) and did not verify on the backend whether a cash order (`cash_on_pickup` / `cash_on_delivery`) exceeded the GH₵ 700.00 advance-payment threshold (`cfg.advance_threshold`) or contained quote-only items (`priced.has_quote`), nor did it validate negative/excessive item quantities.
- **Fixes Applied:**
  - Added `Idempotency-Key` deduplication (`o.idemKey === idemKey`) and an in-flight lock (`IN_FLIGHT_ORDERS[idemKey]`) so repeated clicks or network retries return the existing order (`deduplicated: true`) rather than creating duplicate orders.
  - Enforced backend validation of customer fields, line-item count (`1..50`), integer item quantities (`1..100`), payment method allowlist, and the GH₵ 700.00 advance-payment threshold (`code: 'advance_required'`).

---

### V-06 (High): Admin Sign-In Brute-Force Exposure & Service-Role Key Guard
- **Root Cause:**
  - `MB.signIn` allowed unlimited rapid password guesses without rate limiting. Additionally, if a site operator accidentally pasted a Supabase `service_role` secret key into `assets/js/config.js`, the browser would transmit it.
- **Fixes Applied:**
  - Added brute-force rate limiting on `MB.signIn` (`checkRateLimit('signin', email, 5, 5 * 60 * 1000)`), locking the account for 5 minutes after 5 failed attempts (`code: 'rate_limited'`).
  - Added a startup JWT claim guard (`guardAnonKey()`) in `assets/js/supabase.js` that inspects `MB_CONFIG.anonKey` and immediately neutralizes it if `"role":"service_role"` is detected, alongside automatic `http://` -> `https://` upgrading for non-localhost Supabase URLs.

---

### V-07 (Medium): Missing Referrer Policy & Content Security Policy (Token Leakage via `Referer`)
- **Root Cause:**
  - `order.html?ref=MB-XXXX&token=SECRET` and `receipt.html?ref=MB-XXXX&token=SECRET` contain the order's private token in the URL query string and include external links to WhatsApp (`https://wa.me/...`) and Instagram. Without `<meta name="referrer" content="no-referrer">`, clicking an external link could leak the full URL (including the secret token) in the HTTP `Referer` header.
- **Fixes Applied:**
  - Added `<meta name="referrer" content="no-referrer">`, `<meta http-equiv="X-Content-Type-Options" content="nosniff">`, and `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.supabase.co; font-src 'self' data:; connect-src 'self' https://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'self';">` across all 10 HTML pages.
  - Standardized all external `target="_blank"` links across all HTML pages to include `rel="noopener noreferrer"`.

---

### V-08 (Low/Medium): DOM Attribute & Error Message Escaping in `admin.js` and `classes.js`
- **Root Cause:**
  - In `assets/js/admin.js`, `state.filters.q` used `.replace(/"/g, '&quot;')` instead of full HTML entity escaping `esc()`, and product thumbnail filenames `p.image` were interpolated without stripping path-traversal characters. In `assets/js/classes.js`, the fallback error string `message` was inserted into `innerHTML` without `esc()`.
- **Fixes Applied:**
  - Wrapped `state.filters.q` in `esc()` and sanitized `p.image` with `.replace(/[^a-zA-Z0-9._-]/g, '')` in `assets/js/admin.js`.
  - Wrapped `message` in `esc(message)` in `assets/js/classes.js`.

---

## 3. Network Connections, Exposed Ports & Hosting Architecture

### A. Production Hosting Architecture (GitHub Pages + Supabase)
- **GitHub Pages (Static Frontend):**
  - Serves static HTML, CSS, fonts, WebP images, and client-side JS over TLS (`HTTPS` on port `443`).
  - Server-level TCP/UDP ports cannot be opened or closed via static repository files; GitHub's edge CDN manages port exposure (`80` redirect to `443`).
  - Recommended repository settings: enable **"Enforce HTTPS"** in GitHub Pages settings.
- **Supabase Managed Infrastructure (Database, Auth, Storage):**
  - All browser communication with Supabase uses HTTPS (`port 443`) to `https://<project-ref>.supabase.co/rest/v1/rpc/...`, `/auth/v1/...`, and `/storage/v1/...`.
  - Direct PostgreSQL port (`5432` / `6543`) is never used by the frontend and should remain restricted to trusted backend/migration IP addresses via Supabase Network Restrictions if supported on the project's plan.

### B. Local Workspace / Preview Environment Inspection
- Inspected active sockets in the sandbox via `ss -tulnp`:
  - `0.0.0.0:8000`: Python static HTTP server (`python3 -m http.server 8000 --bind 0.0.0.0`), required for the live workspace preview proxy (`https://8000-{sandboxId}.e2b.app`).
  - System/sandbox management daemons (`127.0.0.1` internal loopback services and sandbox control ports) are managed by the container runtime. No unauthorized database or admin services are exposed by the application.

---

## 4. Residual Risks & Required Manual Deployment Actions

1. **Apply the Supabase SQL Migration in Production:**
   - When connecting a live Supabase project in `assets/js/config.js`, run `supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql` in the Supabase SQL Editor so all database-level RLS policies, unique indexes, triggers, and `SECURITY DEFINER` RPCs are active in PostgreSQL.
2. **Server-Side Rate Limiting & WAF:**
   - In `localMode` (when `MB_CONFIG.url` is blank), rate limiting and state storage reside in the browser's storage/memory context, which a determined local attacker can clear in their own browser. In production with Supabase connected, PostgreSQL triggers, RLS policies, and Supabase Auth rate limits enforce these restrictions server-side across all clients.
3. **HTTP Response Headers on Static Hosts:**
   - While `<meta http-equiv="Content-Security-Policy">`, `<meta name="referrer" content="no-referrer">`, and `<meta http-equiv="X-Content-Type-Options" content="nosniff">` are embedded in all 10 HTML files, headers such as `Strict-Transport-Security` (HSTS) and `X-Frame-Options` are delivered at the CDN/HTTP layer (GitHub Pages automatically sends HSTS when "Enforce HTTPS" is enabled).

---

## 5. Customer Accounts Release — Findings & Evidence (23 Oct 2026)

A full customer-account, trusted-ordering and RLS review followed this audit. The
complete implementation notes, access matrix, test report and remaining manual
steps live in **`CUSTOMER_ACCOUNTS_AND_SECURITY.md`**. Summary of the most relevant
new findings and fixes:

| Severity | Finding | Status |
| --- | --- | --- |
| Critical | Anonymous order creation: the order RPC accepted a payload with no session, so any script could create unlimited orders and fill the kitchen queue | **Reopened by design, then re-contained** — see §6. Anonymous order creation is now an accepted product requirement; mitigations are server-side re-pricing, a per-phone hourly cap, and an idempotency key. Residual risk documented |
| Critical | Client-trusted prices: `unitPrice`, `lineTotal`, `discount` and `customerId` were taken from the browser; unknown SKUs fell back to the browser price | Fixed — prices are re-read from `products` / `classes`, unknown SKUs are rejected, and the order total is computed server-side |
| Critical | Custom-cake pricing existed only in the browser, so a crafted `spec` could request any amount | Fixed — server-side allow-list for type, variety, size, decoration, flavour and add-ons |
| High | No `customer_id` on orders → order history could not be scoped to a person, and IDOR protection did not exist | Fixed — `orders.customer_id`, `order_items.customer_id`, `payments.customer_id`, RLS scoped to `auth.uid()` |
| High | Customer could reach the admin status endpoint and change an order to `confirmed`/`completed` | Fixed — RBAC check plus allowed-status list, immutability of totals/owner, and a GH₵ 700 verification gate |
| High | `advance_threshold` default of GH₵ 150.00 contradicted the confirmed >GH₵ 700.00 rule | Fixed in both the migration default and a corrective `UPDATE` |
| Medium | No customer account page, no password recovery, no verified-email requirement | **Closed as won't-fix** — customer accounts were removed from the product on 25 Oct 2026. There is no sign-up, no password and therefore no recovery flow to build. `account.html` is an unlinked orphan; the customer RPCs remain defined and session-gated |
| Medium | Two migration files disagreed on column names and types | Contained — compatibility shim added; still requires a human decision (see §10.3 of the new document) |
| Low | `order_status` lacked a `ready` value used by the dashboard UI | Fixed — constraint now includes `ready` |

---

## 6. Guest Checkout — Accepted Risk & Compensating Controls (25 Oct 2026)

The 23 Oct review closed anonymous order creation by requiring a session plus a
confirmed e-mail. On 25 Oct the product decision was reversed: **customers must be
able to order without registering or signing in**, and every customer-facing sign-in
entry point was removed from the site. This section records what replaced the gate,
so the reversal is a documented decision rather than a silent regression.

### What is no longer enforced

- `auth.uid()` may be `NULL`. Orders are stored with `customer_id = NULL`.
- There is no verified-e-mail precondition. `api_place_order` no longer returns
  `auth_required` or `email_not_verified`.
- `account.html` and the customer RPCs are unreachable from the UI. Nothing was
  deleted, so re-enabling accounts later is a UI change, not a rewrite.

### Compensating controls (all server-side, none trusted from the browser)

| Control | Where | What it stops |
|---|---|---|
| Catalogue re-read and re-price | `api_place_order` steps 4–5 | A crafted payload naming a low price, an unknown SKU, or an unpublished item |
| Custom-cake allow-list + server recompute | `api_place_order` step 6 | Arbitrary custom-spec pricing |
| Order-date validation against max `prep_days` | `api_place_order` step 7 | Back-dated or impossible orders |
| Advance-payment threshold, enforced in SQL | `api_place_order` step 8 | Cash methods above GH₵ 700 / quoted cakes |
| Idempotency key, unique index, phone match on replay | `orders.idempotency_key` | Double-submits; handing a guessed key back to a *different* guest |
| Guest throttle: 5 orders/hour per normalised phone | `api_place_order` | Casual flooding from one number |
| `pg_sleep(0.35)` on failed lookup | `api_lookup_order` | Reference enumeration |
| Admin-only reads; proofs in Storage with admin-only read | RLS + Storage policy | Guests reading anyone else's order or evidence |
| Payment stays `pending_verification` until an admin confirms | `api_admin_verify` | Self-declared payment |

### Residual risk — stated plainly

1. **The guest throttle is keyed on a phone number the attacker controls.** Rotating
   numbers defeats it. A script can still fill the kitchen queue with pending orders.
   The cost is bounded (each order is real in the DB and visible to the admin, who
   rejects it) but it is not prevented.
2. **No CAPTCHA or proof-of-work.** Adding one changes the checkout flow the user
   asked to keep "as few steps as possible", so it was not added unilaterally.
3. **Guest orders have no owner to notify.** If a guest mistypes their phone, the
   order is unreachable except via the confirmation token. The kitchen sees it and
   can act, but the customer may not.

**Recommendation if abuse is observed:** enable Supabase's built-in rate limiting on
the `/rest/v1/rpc/api_place_order` path at the edge, or add a Cloudflare Turnstile
token to the checkout form and verify it in an Edge Function before calling the RPC.
Neither is implemented here. This document does **not** claim the site is free of
order-spam risk.
