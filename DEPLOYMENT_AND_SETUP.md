# Mystery Bakebite — Production Setup, Supabase Integration & GitHub Pages Deployment Guide

This document covers the complete production setup for the **Mystery Bakebite** web application, including **Super Administrator (`mysterybakebite@gmail.com`) provisioning**, **User & Role Management (RBAC)**, **Supabase database & Edge Function deployment**, and **GitHub Pages hosting**.

---

## 1. Super Administrator Account (`mysterybakebite@gmail.com`)

### Exclusive Super Administrator Authority
- **`mysterybakebite@gmail.com`** is configured as the primary **Super Administrator** (`role = 'super_admin'`, `is_primary_super_admin = TRUE`).
- **No Hard-Coded Passwords**: Zero passwords or password digests are hard-coded in frontend code, configuration files, or Git history. All legacy demo accounts (`demo.admin@mysterybakebite.com`) and sample transactions have been permanently removed.
- **Database-Level Immutability Protection**:
  - PostgreSQL trigger `public.trg_protect_primary_super_admin` and backend checks in `api_admin_team` and `supabase/functions/admin-users/index.ts` guarantee that `mysterybakebite@gmail.com` **cannot** be removed, deactivated, or demoted to a lower role, and no other user can be assigned `super_admin`.

### First-Login Provisioning & Mandatory Password Change
1. **With Supabase Auth Connected**:
   - Create the user `mysterybakebite@gmail.com` in **Supabase Dashboard → Authentication → Users → Add User** with a one-time temporary password (or via the First-Time Setup card on `admin.html`).
   - Database trigger `public.trg_auto_provision_super_admin` automatically registers `mysterybakebite@gmail.com` in `public.admin_users` with:
     - `role = 'super_admin'`
     - `is_primary_super_admin = TRUE`
     - `active = TRUE`
     - `must_change_password = TRUE`
2. **Standalone / First-Time Browser Provisioning**:
   - Open `admin.html`. When `mysterybakebite@gmail.com` has not yet been initialized, the **First-Time Super Administrator Setup** card appears automatically.
   - Click **Generate Temporary First-Login Password** to generate a cryptographically random one-time temporary password (`MB-...`).
3. **Mandatory First-Login Password Change Gate**:
   - Sign in on `admin.html` as `mysterybakebite@gmail.com` using the temporary password.
   - The application immediately routes to the **Mandatory First-Login Password Change** screen (`#admin-first-login`) and blocks all dashboard data RPCs (`code: 'password_change_required'`) until a strong personal password (minimum 10 characters with uppercase, lowercase, number, and symbol) is saved.

---

## 2. Administrator & User Management (RBAC)

Once signed in and after completing the mandatory first-login password change, `mysterybakebite@gmail.com` can manage all staff accounts from **Admin Dashboard → Team & Access Control**:

| Role | Slug | Permissions |
| :--- | :--- | :--- |
| **Super Administrator** | `super_admin` | Exclusive to `mysterybakebite@gmail.com`. Full access to all sections + exclusive authority to create, invite, assign roles, reset passwords, activate/deactivate, and remove users, plus view the Security Audit Log. |
| **Administrator** | `administrator` | Full operational access to Overview, Orders & Bookings, Payment Verification, Products, Classes, Cake Pricing, Discounts, Notifications, and Payout Settings. Read-only view of Team roster. |
| **Order & Kitchen Manager** | `manager` | Operational access to Overview, Orders & Bookings, Payment Verification, Products, Classes, Cake Pricing, Discounts, and Notifications. Cannot modify bank/MoMo payout settings or manage Team accounts. |
| **Read-Only Viewer** | `viewer` | Read-only access to Overview, Orders & Bookings, Receipts, and Notifications. Cannot modify orders, verify payments, edit catalogue/settings, or manage users. |

Every newly created or password-reset user receives a one-time temporary password with `mustChangePassword = true` and is required to set their own personal password upon first login.

---

## 3. Supabase Backend Setup

### Step 1: Run Database Migrations
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
   access matrix, the account-required `api_place_order`, and the
   GH₵ 700.00 confirmation gate. See `CUSTOMER_ACCOUNTS_AND_SECURITY.md` §3 for
   verification queries and rollback.

**The order of steps 1 and 2 does not matter** — both files use
`CREATE TABLE IF NOT EXISTS`, and step 3 reconciles whichever ran first. In
particular it converts `orders.verified_by` / `payment_submissions.reviewed_by`
from `TEXT` to `UUID` if an earlier run created them the wrong way round, which
would otherwise make payment confirmation fail.

Before applying anything, you can syntax-check all three files locally without a
database:

```bash
pip install pglast
python3 tests/sql-parse-check.py     # expect: 30 parsed, 0 failed
```

After applying, confirm the column types are uniform:

```sql
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND column_name IN ('verified_by', 'reviewed_by');
-- expect three rows, all 'uuid'
```

### Step 2: Deploy the User-Management Edge Function
The `admin-users` Edge Function (`supabase/functions/admin-users/index.ts`) executes `auth.admin.*` operations server-side so the `SUPABASE_SERVICE_ROLE_KEY` is never exposed to the browser:

```bash
supabase functions deploy admin-users
```

### Step 3: Configure Supabase Authentication URLs
In **Supabase Dashboard → Authentication → URL Configuration**:
- **Site URL**: `https://<your-github-username>.github.io/<your-repo-name>/` (or your custom domain)
- **Redirect URLs**:
  - `https://<your-github-username>.github.io/<your-repo-name>/admin.html`
  - `https://<your-github-username>.github.io/<your-repo-name>/account.html`
  - `https://<your-github-username>.github.io/<your-repo-name>/account.html?mode=reset`
  - `https://<your-github-username>.github.io/<your-repo-name>/checkout.html`
  - `https://<your-github-username>.github.io/<your-repo-name>/booking.html`
- **Email provider**: enable *Confirm email* under Authentication → Providers →
  Email, or customers cannot place orders (the database rejects unverified addresses).

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

## 5. Customer Accounts — Quick Start

1. Apply migration `20261023_customer_accounts_secure_ordering_and_rls.sql`.
2. In **Authentication → URL Configuration**, add the redirect URLs listed in §3,
   Step 3 (including `account.html` and `account.html?mode=reset`).
3. Keep **Confirm email** switched on; the order RPC refuses unverified addresses.
4. Deploy. Customers now sign in at `account.html`; checkout and class booking
   redirect there automatically and return with the cart intact.
5. Run the automated checks before every release:

```bash
node tests/security-tests.mjs      # 77 assertions, no dependencies
```

6. Run the live SQL/IDOR probes in `CUSTOMER_ACCOUNTS_AND_SECURITY.md` §11 against a
   **staging** project, not production data.
