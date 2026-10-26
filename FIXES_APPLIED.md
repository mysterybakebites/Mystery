# Fixes Applied — Arena Audit, 26 October 2026

This copy is `Mystery-Bakebite-Website-Backup.zip` with the code-level fixes
below. Everything else is byte-identical to the backup. Full findings, live
Supabase evidence and the go-live checklist are in
`Mystery-Bakebite-AUDIT-2026-10-26.md` (delivered alongside this zip).

| # | Fix | Files |
|---|---|---|
| F1 | GitHub Pages deploy no longer publishes `APPLY_ALL_MIGRATIONS.sql` (or any `*.sql`), `.gitignore`, or `assets/js/config.example.js` on the public website | `.github/workflows/deploy.yml` |
| F2 | Missing-database-function errors (`PGRST202`) now show shoppers a friendly "order on WhatsApp" message instead of a raw PostgREST error; the `PGRST202` code is preserved so pages still detect the state | `assets/js/supabase.js` (`failure()`) |
| F3 | Class bookings now alert the baker like product orders do: automatic `notify-order` call plus the one-tap WhatsApp fallback button on the confirmation screen | `assets/js/booking.js`, `booking.html` (`#booking-wa-fallback`) |
| F4 | Transactional/orphan pages carry `noindex, nofollow` (admin/receipt already did); added `robots.txt` | `account.html`, `booking.html`, `checkout.html`, `order.html`, `robots.txt` (new) |
| F5 | CSP hardened: `script-src` drops `'unsafe-inline'`; the one inline bootstrap script (identical on all pages) is allow-listed by its SHA-256 hash. `style-src 'unsafe-inline'` remains because the layout uses inline `style=` attributes. **Smoke-test in a real browser after deploy** (DevTools console should show no CSP violations) — jsdom tests cannot enforce CSP | all 11 HTML pages + `404.html` |
| F6 | Cache-bust stamps unified: every `?v=49`/`?v=50` → `?v=51` (receipt page previously loaded different versions of shared scripts) | all HTML pages |
| F7 | Branded `404.html` added (GitHub Pages serves it automatically), built from the home page header/footer so it passes the same audits | `404.html` (new) |
| F8 | Deploy is now gated on the test suite: the workflow runs `npm ci && npm test` before staging, and `tests/audit.mjs` fails (exit 1) instead of silently skipping when `jsdom` is missing | `.github/workflows/deploy.yml`, `tests/audit.mjs` |
| F9 | Corrected the live-verification note: RPCs with required named parameters also return `PGRST202` to empty-body probes | `DEPLOYMENT_AND_SETUP.md` §3b |

## Test results on this fixed copy

```
tests/audit.mjs          640 passed, 0 failed, 0 warnings   (was 596: 404.html adds a fully-audited page)
tests/security-tests.mjs 199 passed, 0 failed
tests/ui-tests.mjs        69 passed, 0 failed
tests/order-flow.mjs      41 passed, 0 failed
tests/sql-parse-check.py  54 parsed, 0 failed (pglast)
TOTAL                     949 passed, 0 failed
```

## NOT fixed here (needs your Supabase/GitHub accounts — see the audit report)

1. Run `APPLY_ALL_MIGRATIONS.sql` in the Supabase SQL Editor — as of
   2026-10-26 the live project only has migration `20261022` plus an **old**
   `20261023`, so guest checkout, classes, order lookup and the admin
   dashboard are broken live. The file is idempotent and runs in one
   transaction.
2. Deploy the Edge Functions (`admin-users`, `notify-order --no-verify-jwt`)
   and set the WhatsApp secrets for automatic baker alerts.
3. Create the Super Administrator auth user `mysterybakebites@gmail.com`
   (owner-confirmed 2026-10-26; the whole codebase + SQL were corrected
   from the old `mysterybakebite@gmail.com` spelling in v2.4 — see the
   section below and run `RUN_FIRST_email_correction_patch.sql` first).
4. Set Supabase Auth Site URL + redirect URLs to the real deployed URL,
   push to GitHub `main`, enable Pages (source: GitHub Actions), then run
   the end-to-end smoke test in the audit report.
5. Restrict the public "anyone with the link" sharing on the backup zip in
   Google Drive (it contains the full database schema and audit reports;
   no secret keys were found in it).

---

## v2.4 (26 Oct 2026, later the same day) — Super Administrator email correction

The owner confirmed the real inbox is **`mysterybakebites@gmail.com`**
(with "s" — same spelling as the Google account, GitHub user and
Instagram). Every occurrence of the old `mysterybakebite@gmail.com` was
corrected across JS, HTML, both SQL files, the test suites and the docs
(86 replacements; full suite re-run: 949 passed).

**Database run order is now:**

1. `RUN_FIRST_email_correction_patch.sql` — fixes the live
   `chk_super_admin_email` constraint created by the already-applied
   migration 20261022 (re-running APPLY_ALL alone cannot change a
   constraint on a table that already exists) and renames any existing
   admin row. Idempotent; one transaction.
2. `APPLY_ALL_MIGRATIONS.sql` (corrected in this package).
3. Verify no database function still mentions the old spelling:
   `SELECT proname FROM pg_proc WHERE prosrc ILIKE '%mysterybakebite@gmail.com%';`
   must return **0 rows**.
4. Only then create the Auth user `mysterybakebites@gmail.com` — the
   auto-provision trigger enrols it as primary Super Administrator.

WhatsApp strategy (owner decision): launch with the one-tap WhatsApp
fallback button, add Meta Cloud API automation later. With the fallback,
neither Edge Function blocks launch; `admin-users` is only needed when
staff accounts are added.
