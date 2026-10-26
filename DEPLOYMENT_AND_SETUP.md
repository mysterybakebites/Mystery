# Mystery Bakebite — Production Setup, Supabase Integration & GitHub Pages Deployment Guide

This document covers the complete production setup for the **Mystery Bakebite** web application, including **Super Administrator (`mysterybakebites@gmail.com`) provisioning**, **User & Role Management (RBAC)**, **Supabase database & Edge Function deployment**, and **GitHub Pages hosting**.

---

## 1. Super Administrator Account (`mysterybakebites@gmail.com`)

### Exclusive Super Administrator Authority
- **`mysterybakebites@gmail.com`** is configured as the primary **Super Administrator** (`role = 'super_admin'`, `is_primary_super_admin = TRUE`).
- **No Hard-Coded Passwords**: Zero passwords or password digests are hard-coded in frontend code, configuration files, or Git history. All legacy demo accounts (`demo.admin@mysterybakebite.com`) and sample transactions have been permanently removed.
- **Database-Level Immutability Protection**:
  - PostgreSQL trigger `public.trg_protect_primary_super_admin` and backend checks in `api_admin_team` and `supabase/functions/admin-users/index.ts` guarantee that `mysterybakebites@gmail.com` **cannot** be removed, deactivated, or demoted to a lower role, and no other user can be assigned `super_admin`.

### First-Login Provisioning & Mandatory Password Change
1. **With Supabase Auth Connected**:
   - Create the user `mysterybakebites@gmail.com` in **Supabase Dashboard → Authentication → Users → Add User** with a one-time temporary password (or via the First-Time Setup card on `admin.html`).
   - Database trigger `public.trg_auto_provision_super_admin` automatically registers `mysterybakebites@gmail.com` in `public.admin_users` with:
     - `role = 'super_admin'`
     - `is_primary_super_admin = TRUE`
     - `active = TRUE`
     - `must_change_password = TRUE`
2. **Standalone / First-Time Browser Provisioning**:
   - Open `admin.html`. When `mysterybakebites@gmail.com` has not yet been initialized, the **First-Time Super Administrator Setup** card appears automatically.
   - Click **Generate Temporary First-Login Password** to generate a cryptographically random one-time temporary password (`MB-...`).
3. **Mandatory First-Login Password Change Gate**:
   - Sign in on `admin.html` as `mysterybakebites@gmail.com` using the temporary password.
   - The application immediately routes to the **Mandatory First-Login Password Change** screen (`#admin-first-login`) and blocks all dashboard data RPCs (`code: 'password_change_required'`) until a strong personal password (minimum 10 characters with uppercase, lowercase, number, and symbol) is saved.

---

## 2. Administrator & User Management (RBAC)

Once signed in and after completing the mandatory first-login password change, `mysterybakebites@gmail.com` can manage all staff accounts from **Admin Dashboard → Team & Access Control**:

| Role | Slug | Permissions |
| :--- | :--- | :--- |
| **Super Administrator** | `super_admin` | Exclusive to `mysterybakebites@gmail.com`. Full access to all sections + exclusive authority to create, invite, assign roles, reset passwords, activate/deactivate, and remove users, plus view the Security Audit Log. |
| **Administrator** | `administrator` | Full operational access to Overview, Orders & Bookings, Payment Verification, Products, Classes, Cake Pricing, Discounts, Notifications, and Payout Settings. Read-only view of Team roster. |
| **Order & Kitchen Manager** | `manager` | Operational access to Overview, Orders & Bookings, Payment Verification, Products, Classes, Cake Pricing, Discounts, and Notifications. Cannot modify bank/MoMo payout settings or manage Team accounts. |
| **Read-Only Viewer** | `viewer` | Read-only access to Overview, Orders & Bookings, Receipts, and Notifications. Cannot modify orders, verify payments, edit catalogue/settings, or manage users. |

Every newly created or password-reset user receives a one-time temporary password with `mustChangePassword = true` and is required to set their own personal password upon first login.

---

## 3. Supabase Backend Setup

### Step 1: Run Database Migrations

> **Fastest path — one paste.** Open **SQL Editor → New query**, paste
> `APPLY_ALL_MIGRATIONS.sql`, press **Run**. That single file contains all six
> migrations in the correct order inside one transaction, sends the PostgREST
> schema reload, and finishes with verification queries that show you the row
> counts and the list of RPCs. If any statement fails the whole thing rolls back
> and nothing is applied.
>
> The per-file instructions below are the manual equivalent, for review.

Apply the SQL migrations in `/supabase/migrations/` in your **Supabase SQL Editor** (or via the Supabase CLI):

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Or run the migration files in order in the Supabase SQL Editor:
1. `supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql`
   — the schema, catalogue, administrator roster, RBAC helpers, RLS policies and
   the private `proofs` bucket. This single file replaces the two earlier
   `20261022_*` migrations, which were merged because they disagreed on
   `orders.token` vs `token_hash`, `idempotency_key` vs `idem_key`,
   `payment_submissions.id` (`UUID` vs `BIGSERIAL`) and the `admin_users` role
   vocabulary. The merge decisions are documented in the file header.
2. `supabase/migrations/20261023_customer_accounts_secure_ordering_and_rls.sql`
   — customer profiles, `order_items`, `payments`, `class_bookings`, the RLS
   access matrix, the guest-capable `api_place_order`, and the GH₵ 700.00
   confirmation gate. Re-run this file whenever it changes: it REPLACES the
   functions it defines, so an older copy left in the database stays in force
   until you do.
3. `supabase/migrations/20261024_public_read_layer.sql`
   — `api_config()`, `api_catalogue()` and `api_price()`. **Required.** The
   browser calls these on every page; without them the menu, classes, cake
   builder and checkout payment instructions cannot load.
4. `supabase/migrations/20261025_admin_and_lookup_rpcs.sql`
   — the dashboard and the "find my order" form: `api_lookup_order`,
   `api_admin_orders`, `api_admin_order`, `api_admin_dashboard`,
   `api_admin_settings`, `api_admin_catalogue`, `api_admin_discounts`,
   `api_admin_notifications`, and the `api_admin_product` / `_class` /
   `_category` / `_option` write RPCs. **Required for the dashboard** — without
   this file no order can be listed and therefore no payment can be approved.
5. `supabase/migrations/20261026_business_contact_profile.sql`
   — the editable business contact profile. Adds the contact columns to
   `settings`, extends `api_config()` to publish a `contact` object, and extends
   `api_admin_settings()` to validate and save them. **Required for the
   Business profile panel** in the dashboard; without it the site falls back to
   the built-in defaults and the panel's save button reports an error.
6. `supabase/migrations/20261027_catalogue_repair_and_seed.sql`
   — **required for the classes page to show anything.** Adds
   `classes.bring_note`, redefines `api_catalogue()` to emit `bringNote`, and
   seeds the catalogue (9 categories, 53 products, 6 courses, 45 cake options)
   from the bakery's own published data. It is idempotent and will never
   overwrite a price you have since edited in the dashboard.

**Steps 3, 5 and 6 depend on the tables from steps 1–2**, so run the numbered
order: **1 → 2 → 3 → 4 → 5 → 6**. If they are out of order, re-run from the
earliest missing step; every file is safe to run twice.

**The order of steps 1 and 2 does not matter** — both use
`CREATE TABLE IF NOT EXISTS`, and step 2 reconciles whichever ran first. In
particular it converts `orders.verified_by` / `payment_submissions.reviewed_by`
from `TEXT` to `UUID` if an earlier run created them the wrong way round, which
would otherwise make payment confirmation fail. Step 3 only defines functions,
so it can be applied at any point.

Before applying anything, you can syntax-check all three files locally without a
database:

```bash
pip install pglast
python3 tests/sql-parse-check.py     # expect: 54 parsed, 0 failed
```

After applying, confirm the column types are uniform:

```sql
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND column_name IN ('verified_by', 'reviewed_by');
-- expect three rows, all 'uuid'
```

### Step 2: Deploy the Edge Functions

**`admin-users`** (`supabase/functions/admin-users/index.ts`) executes `auth.admin.*`
operations server-side so the `SUPABASE_SERVICE_ROLE_KEY` is never exposed to the browser.

**`notify-order`** (`supabase/functions/notify-order/index.ts`) sends the baker a
WhatsApp message when an order arrives. It holds the WhatsApp API token server-side.

```bash
supabase functions deploy admin-users
supabase functions deploy notify-order --no-verify-jwt
```

**Why `--no-verify-jwt` on `notify-order`:** the browser calls it with the
publishable key (`sb_publishable_…`), which is **not** a JWT. With gateway JWT
verification left on, every call fails with 401. The function authorises each
request itself — a browser call must present the order's secret token, and a
webhook call must present `NOTIFY_WEBHOOK_SECRET` (it fails closed with 503 if
that secret is unset). `admin-users` keeps JWT verification on, because it should
only ever be reachable by a signed-in administrator.

Then set the WhatsApp secrets (Dashboard → **Edge Functions → Secrets**, or
`supabase secrets set`):

| Secret | Required | Purpose |
|---|---|---|
| `WHATSAPP_TOKEN` | yes | Permanent WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | Business phone-number id that sends the alert |
| `BAKER_WHATSAPP_NUMBER` | yes* | Recipient in digits form, e.g. `233554520532` |
| `WHATSAPP_TEMPLATE_NAME` | no | Approved template name (see the note below) |
| `NOTIFY_WEBHOOK_SECRET` | if using a webhook | Required by the webhook branch; without it that path refuses to run |

\* `BAKER_WHATSAPP_NUMBER` is optional: the function falls back to
`settings.whatsapp_number`, then to the public `settings.whatsapp_contact` line
(section 5 of the Business profile panel). Keep `WHATSAPP_TOKEN` **out of**
`config.js` and git.

#### Making the alert fully automatic

The checkout page already calls `notify-order` right after an order is saved, using
the order token to prove ownership. For a server-side guarantee that cannot be
skipped by a closed browser tab, also add a **Database Webhook**:

Dashboard → **Database → Webhooks → Create**:
- Table: `orders` · Events: `INSERT` · Type: `Supabase Edge Function` · Function: `notify-order`
- If you set `NOTIFY_WEBHOOK_SECRET`, add header `x-notify-secret: <value>`

Both paths are idempotent — `orders.notified_at` is set on the first success, so the
baker never receives the same order twice. A failed send leaves `notified_at`
NULL and never rolls back the order itself.

**Automatic means automatic only with credentials.** If `WHATSAPP_TOKEN` /
`WHATSAPP_PHONE_NUMBER_ID` are not set, or the function is not deployed, nothing
is sent: the confirmation page shows a one-tap `wa.me` link that a human must
press Send on. Do not describe that fallback as an automatic notification.

> **WhatsApp 24-hour rule.** WhatsApp only allows free-form text to a number that
> has messaged your business within the last 24 hours. Outside that window the send
> fails and the function returns the message text, which the checkout page turns
> into a one-tap "Send the order alert to the baker on WhatsApp" link. For
> unattended delivery, create and approve a template and set
> `WHATSAPP_TEMPLATE_NAME`.

### Step 3: Configure Supabase Authentication URLs
In **Supabase Dashboard → Authentication → URL Configuration**:
- **Site URL**: `https://<your-github-username>.github.io/<your-repo-name>/` (or your custom domain)
- **Redirect URLs**:
  - `https://<your-github-username>.github.io/<your-repo-name>/admin.html`
  - `https://<your-github-username>.github.io/<your-repo-name>/account.html` *(legacy — the page is
    unlinked, but keep the redirect configured if you plan to re-enable customer accounts)*
  - `https://<your-github-username>.github.io/<your-repo-name>/account.html?mode=reset` *(legacy, same note)*
  - `https://<your-github-username>.github.io/<your-repo-name>/checkout.html`
  - `https://<your-github-username>.github.io/<your-repo-name>/booking.html`
- **Email provider**: *Confirm email* applies to **administrator accounts only**.
  There is no customer sign-up, so there is no customer address to confirm and no
  verification step anywhere in the ordering path.

---

## 3b. Verifying a live project

After applying the migrations, this should return HTTP 200 for every row. A
`404` with `"code":"PGRST202"` means that function is **not** in the database —
it has not been deployed, or a later migration was skipped.

> **Corrected 2026-10-26:** RPCs with required named parameters
> (`api_lookup_order`, `api_place_order`, `api_order`) also return
> `PGRST202` when probed with an empty `{}` body, even when installed.
> Probe those with their parameter names, e.g.
> `-d '{"p_ref":"MB-PROBE","p_phone":"0000000"}'` for `api_lookup_order`
> (a `200` with `{"ok": false, ...}` means the function exists).

```bash
export K="<your publishable key>"
export U="https://<project-ref>.supabase.co"

for fn in api_config api_catalogue api_price api_order api_customer_whoami \
          api_lookup_order api_admin_orders api_admin_order api_admin_dashboard \
          api_admin_settings api_admin_catalogue api_admin_discounts \
          api_admin_notifications; do
  printf '%-24s ' "$fn"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$U/rest/v1/rpc/$fn" \
    -H "apikey: $K" -H "Authorization: Bearer $K" \
    -H "Content-Type: application/json" -d '{}'
done
```

Confirm the browser is talking to the right project — open the site, then in the
console:

```js
MB.remoteConfigured   // true when a URL + key are loaded
MB.localMode          // must be false; true means it is running on browser-only data
```

`MB.localMode === true` with a key configured means the key or URL failed to
load, and every order is being written to `localStorage` instead of your database.

---

## 4. Environment Configuration & GitHub Pages Deployment

### Option A: Automated Deployment via GitHub Actions (Recommended)
1. Push this repository to GitHub on the `main` branch.
2. In your GitHub repository, open **Settings → Secrets and variables → Actions** and add two Repository Secrets:
   - `SUPABASE_URL`: `https://YOUR_PROJECT_REF.supabase.co`
   - `SUPABASE_ANON_KEY`: `YOUR_PUBLIC_ANON_KEY`
3. Open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. On every push to `main` (or manual trigger in the **Actions** tab), `.github/workflows/deploy.yml` injects `SUPABASE_URL` and `SUPABASE_ANON_KEY` into `assets/js/config.js` and deploys the site to GitHub Pages.

### Option B: Direct Static Configuration
Edit `assets/js/config.js` directly (using `assets/js/config.example.js` as a reference) and set your project's `url` and public `anonKey`. Never place the `service_role` key in `assets/js/config.js`.

---

## 5. Ordering, Payments & WhatsApp — Quick Start

1. Apply `20261022_canonical_schema_rbac_and_rls.sql`, then
   `20261023_customer_accounts_secure_ordering_and_rls.sql`.
2. Deploy both Edge Functions (§3, Step 2) and set the WhatsApp secrets.
3. In **Admin → Settings**, set **WhatsApp number** (digits, e.g. `233554520532`)
   and confirm the MoMo / bank details customers are told to pay into.
4. Place one test order as a guest, end to end: submit → pay → upload proof →
   confirm the order shows **Pending Review** and **Pending Verification** →
   approve or reject it from the dashboard.
5. Check the baker's phone received the WhatsApp alert.

Customer accounts are **not** part of the product: there is no registration, no
sign-in and no account page linked from anywhere. The customer RPCs still exist in
the database but are unreachable from the UI. See the **ORDERING RULE** block at the
top of `CUSTOMER_ACCOUNTS_AND_SECURITY.md`, which is authoritative.

Full detail of the ordering/payment/alert workflow:
`ORDERING_PAYMENT_AND_WHATSAPP.md`.
3. **Confirm email** only affects administrator accounts now. The order RPC does
   **not** require a verified address, because there is no customer sign-up step.
   Leave it on for admins and treat customers as guests.
4. Deploy. There is **no customer sign-in**. Visitors browse, add to cart and order
   straight from `checkout.html` / `booking.html` with a name and phone number. Do
   not tell customers to "create an account" — no such entry point exists. The only
   sign-in surface is the **Baker Login** (`admin.html`), which stays as it is.
5. Run the automated checks before every release:

```bash
node tests/security-tests.mjs      # 192+ assertions, no dependencies
```

6. Run the live SQL/IDOR probes in `CUSTOMER_ACCOUNTS_AND_SECURITY.md` §11 against a
   **staging** project, not production data.
