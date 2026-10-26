-- =============================================================================
-- MYSTERY BAKEBITE — APPLY ALL MIGRATIONS (single paste)
--
-- HOW TO USE
--   1. Open your Supabase project → SQL Editor → New query.
--   2. Paste this entire file.
--   3. Press Run. One statement batch, one transaction.
--
-- If anything fails, the whole transaction rolls back and NOTHING is applied.
-- Read the error, tell me, and I will fix it — do not re-run pieces by hand.
--
-- SAFE TO RUN TWICE
--   Every table uses CREATE TABLE IF NOT EXISTS, every function uses
--   CREATE OR REPLACE, every column uses ADD COLUMN IF NOT EXISTS, every
--   constraint is DROP IF EXISTS then ADD, and the seed uses
--   ON CONFLICT DO NOTHING. Re-running cannot duplicate or overwrite data.
--
-- WHAT IT BUILDS, IN ORDER
--   20261022  base schema, admin RBAC, RLS, storage policies
--   20261023  guest ordering, order items, payments, class bookings
--   20261024  public read RPCs (api_config, api_catalogue, api_price)
--   20261025  dashboard RPCs, order lookup
--   20261026  business contact profile
--   20261027  classes repair + catalogue seed (9 categories, 53 products,
--             6 courses, 45 cake options)
--
-- BEFORE YOU RUN: none of these statements contain a secret. The publishable
-- key is public and is not used here.
--
-- IF IT FAILS
--   The transaction rolls back and nothing is applied. Copy the full error
--   message (line number and detail) and send it to me.
--
-- TROUBLESHOOTING
--   "function public.x is not unique"  -> an old overload with different
--       arguments exists from a previous apply. Fix:
--         DROP FUNCTION IF EXISTS public.api_place_order(TEXT, JSONB, TEXT);
--       then re-run this file.
--   Site still says a function is missing after a successful run -> the API
--       layer has cached the old schema. This file sends a reload signal at the
--       end; if it still persists, wait 30 seconds or restart the project.
-- =============================================================================

BEGIN;


-- =============================================================================
-- FILE 1 of 6 — 20261022_canonical_schema_rbac_and_rls.sql
-- Base schema, RBAC, RLS, storage policies
-- =============================================================================

-- =============================================================================
-- Mystery Bakebite — Canonical Schema, RBAC, Orders, Payments & RLS
-- Target: Supabase PostgreSQL 15+
--
-- This file REPLACES both of these earlier migrations, which are now deleted:
--   * 20261022_production_schema_and_rls.sql
--   * 20261022_security_hardening_and_rls.sql
--
-- They each created `orders`, `payment_submissions` and `admin_users` with
-- CREATE TABLE IF NOT EXISTS, so whichever ran first silently decided the shape
-- of the schema and the other was ignored. The disagreements were:
--
--   column                     production file          hardening file
--   -------------------------  -----------------------  ----------------------
--   orders.token               token TEXT               token_hash TEXT
--   orders.idempotency key     idempotency_key          idem_key
--   orders.verified_by         TEXT                     UUID
--   payment_submissions.id     UUID                     BIGSERIAL
--   payment_submissions.reviewed_by  TEXT                UUID
--   admin_users.role values    super_admin,             owner, administrator,
--                              administrator,           admin
--                              manager, viewer
--
-- Resolution below, and why:
--
--   * `token` is plaintext, not a hash. The application (api_place_order,
--     api_order, api_submit_proof in 20261023) reads and writes `token` and
--     returns it to the customer's own browser. The hashed variant was never
--     wired to any caller.
--   * `idempotency_key` — the name 20261023 actually references.
--   * `verified_by` / `reviewed_by` — UUID. auth.uid() is the only writer, and
--     the foreign key keeps the audit trail pointing at a real admin account.
--   * `payment_submissions.id` — UUID, matching every other table and the
--     gen_random_uuid() default.
--   * `admin_users.role` — super_admin / administrator / manager / viewer,
--     because has_admin_permission(), api_admin_whoami() and the dashboard UI
--     all speak that vocabulary. The hardening file's owner/admin vocabulary
--     had no consumer.
--   * `is_verified_admin()` — the production definition, which also enforces the
--     mandatory first-login password change. The hardening version did not.
--
-- Everything below is idempotent, so re-running it against a database that
-- already applied either predecessor is safe and will converge to this shape.
--
-- Migration order:
--   1. 20261022_canonical_schema_rbac_and_rls.sql   (this file)
--   2. 20261023_customer_accounts_secure_ordering_and_rls.sql
-- =============================================================================

-- [BEGIN removed: the combined script has one outer transaction]

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Catalogue, Settings, Administrator Roster & Audit Log
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.categories (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  intro       TEXT NOT NULL DEFAULT '',
  published   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.products (
  sku           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL REFERENCES public.categories(slug) ON UPDATE CASCADE,
  price         INTEGER, -- pesewas (NULL = quote on request)
  discount_pct  INTEGER NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 90),
  prep_days     INTEGER NOT NULL DEFAULT 0 CHECK (prep_days >= 0 AND prep_days <= 30),
  meta          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  image         TEXT NOT NULL DEFAULT '',
  published     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.classes (
  slug          TEXT PRIMARY KEY,
  track         TEXT NOT NULL DEFAULT 'bread',
  level         INTEGER NOT NULL DEFAULT 1,
  level_label   TEXT NOT NULL DEFAULT 'Beginner',
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  fee           INTEGER NOT NULL CHECK (fee >= 0), -- pesewas
  hours         TEXT NOT NULL DEFAULT '1 week',
  schedule      TEXT NOT NULL DEFAULT 'Monday to Friday',
  recipes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  skills        JSONB NOT NULL DEFAULT '[]'::jsonb,
  provided      JSONB NOT NULL DEFAULT '[]'::jsonb,
  bring         JSONB NOT NULL DEFAULT '[]'::jsonb,
  prereq        TEXT NOT NULL DEFAULT '',
  published     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cake_options (
  kind          TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS public.settings (
  id                        INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  momo_name                 TEXT NOT NULL DEFAULT 'Mystery Bakebite',
  momo_number               TEXT NOT NULL DEFAULT '055 452 0532',
  momo_provider             TEXT NOT NULL DEFAULT 'MTN Mobile Money',
  momo_note                 TEXT NOT NULL DEFAULT 'Use your order reference as the payment note.',
  momo_verified             BOOLEAN NOT NULL DEFAULT TRUE,
  bank_name                 TEXT NOT NULL DEFAULT 'GCB Bank — Tamale Main Branch',
  bank_account_name         TEXT NOT NULL DEFAULT 'Mystery Bakebite',
  bank_account_number       TEXT NOT NULL DEFAULT '9011010048291',
  bank_verified             BOOLEAN NOT NULL DEFAULT TRUE,
  cash_delivery_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  cash_pickup_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  advance_threshold         INTEGER NOT NULL DEFAULT 70000, -- 700.00 GHS in pesewas
  auto_confirm              BOOLEAN NOT NULL DEFAULT TRUE,
  bundle_two_pct            INTEGER NOT NULL DEFAULT 15 CHECK (bundle_two_pct >= 0 AND bundle_two_pct <= 90),
  bundle_three_pct          INTEGER NOT NULL DEFAULT 25 CHECK (bundle_three_pct >= 0 AND bundle_three_pct <= 90),
  -- Baker's WhatsApp number for new-order alerts (international format, digits
  -- only, e.g. 233554520532). Empty by default: it is not the same thing as the
  -- MoMo number, so it must be set deliberately in the dashboard.
  whatsapp_number           TEXT NOT NULL DEFAULT '',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Administrator & Staff RBAC Roster
CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id                 UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                   TEXT NOT NULL UNIQUE,
  name                    TEXT NOT NULL DEFAULT '',
  role                    TEXT NOT NULL DEFAULT 'administrator'
                          CHECK (role IN ('super_admin', 'administrator', 'manager', 'viewer')),
  is_primary_super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password    BOOLEAN NOT NULL DEFAULT TRUE,
  password_changed_at     TIMESTAMPTZ,
  last_sign_in_at         TIMESTAMPTZ,
  invited_by              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_super_admin_email CHECK (
    (role = 'super_admin' AND lower(email) = 'mysterybakebites@gmail.com' AND is_primary_super_admin = TRUE)
    OR (role <> 'super_admin' AND lower(email) <> 'mysterybakebites@gmail.com' AND is_primary_super_admin = FALSE)
  ),
  CONSTRAINT chk_no_demo_accounts CHECK (
    lower(email) <> 'demo.admin@mysterybakebite.com'
    AND lower(email) NOT LIKE 'demo.%'
    AND lower(email) NOT LIKE 'test.%'
  )
);

-- Administrative Security & Role Audit Log
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action        TEXT NOT NULL,
  actor_email   TEXT NOT NULL,
  target_email  TEXT NOT NULL DEFAULT '',
  details       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
  ON public.admin_audit_log (created_at DESC);

-- -----------------------------------------------------------------------------
-- 1b. Orders, Payment Submissions & Uniqueness Indexes
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.orders (
  ref                   TEXT PRIMARY KEY CHECK (ref ~ '^M[BC]-[A-Z0-9]{4,12}$'),
  token                 TEXT NOT NULL CHECK (char_length(token) >= 16),
  idempotency_key       TEXT UNIQUE,
  kind                  TEXT NOT NULL CHECK (kind IN ('product', 'class')),
  customer_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_name         TEXT NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 2 AND 120),
  phone                 TEXT NOT NULL CHECK (char_length(regexp_replace(phone, '\D', '', 'g')) BETWEEN 7 AND 15),
  email                 TEXT NOT NULL DEFAULT '',
  fulfilment            TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfilment IN ('pickup', 'delivery')),
  address               TEXT NOT NULL DEFAULT '',
  event_date            TEXT NOT NULL DEFAULT ''
                        CHECK (kind = 'class' OR event_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  payment_method        TEXT NOT NULL CHECK (payment_method IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery')),
  payment_status        TEXT NOT NULL DEFAULT 'awaiting_payment'
                        CHECK (payment_status IN ('awaiting_payment', 'payment_submitted', 'payment_verified', 'payment_rejected', 'pay_on_collection', 'not_required')),
  order_status          TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (order_status IN ('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled')),
  subtotal              INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount              INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total                 INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  has_unpriced          BOOLEAN NOT NULL DEFAULT FALSE,
  advance_required      BOOLEAN NOT NULL DEFAULT FALSE,
  items                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundles               JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes                 TEXT NOT NULL DEFAULT '',
  payment_ref           TEXT NOT NULL DEFAULT '',
  has_proof             BOOLEAN NOT NULL DEFAULT FALSE,
  proof_path            TEXT NOT NULL DEFAULT '',
  proof_note            TEXT NOT NULL DEFAULT '',
  proof_locked          BOOLEAN NOT NULL DEFAULT FALSE,
  proof_submitted_at    TIMESTAMPTZ,
  submission_count      INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  reject_reason         TEXT NOT NULL DEFAULT '',
  verified_at           TIMESTAMPTZ,
  verified_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- When the baker's WhatsApp alert was dispatched (NULL = not yet sent).
  -- Makes the notification idempotent across webhook and browser retries.
  notified_at           TIMESTAMPTZ,
  events                JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payment Proof Submissions (one active submission per order, unique references)
CREATE TABLE IF NOT EXISTS public.payment_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref       TEXT NOT NULL REFERENCES public.orders(ref) ON DELETE CASCADE,
  reference       TEXT NOT NULL DEFAULT '',
  image_path      TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending_verification'
                  CHECK (status IN ('pending_verification', 'verified', 'rejected')),
  reject_reason   TEXT NOT NULL DEFAULT '',
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT chk_submission_has_proof CHECK (
    char_length(trim(coalesce(reference, ''))) >= 4
    OR char_length(trim(coalesce(image_path, ''))) > 0
  )
);

-- Only one pending/verified submission may exist per order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_submissions_one_active_per_order
  ON public.payment_submissions (order_ref)
  WHERE status IN ('pending_verification', 'verified');

-- A transaction reference may never be reused, in any state. This also blocks
-- replaying a reference whose earlier submission was rejected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_submissions_unique_ref
  ON public.payment_submissions (upper(btrim(reference)))
  WHERE btrim(reference) <> '';

-- The same reference may not appear on two live orders.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_payment_ref
  ON public.orders (upper(btrim(payment_ref)))
  WHERE btrim(payment_ref) <> ''
    AND payment_status IN ('payment_submitted', 'payment_verified');

-- -----------------------------------------------------------------------------
-- 2. Super Administrator Provisioning & Protection Triggers
-- -----------------------------------------------------------------------------

-- Automatically enroll mysterybakebites@gmail.com as primary Super Administrator
-- when created in Supabase Auth, with mandatory first-login password change.
CREATE OR REPLACE FUNCTION public.trg_auto_provision_super_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF lower(trim(NEW.email)) = 'mysterybakebites@gmail.com' THEN
    INSERT INTO public.admin_users (
      user_id,
      email,
      name,
      role,
      is_primary_super_admin,
      active,
      must_change_password
    ) VALUES (
      NEW.id,
      'mysterybakebites@gmail.com',
      'Mystery Bakebite (Super Admin)',
      'super_admin',
      TRUE,
      TRUE,
      TRUE
    )
    ON CONFLICT (email) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          role = 'super_admin',
          is_primary_super_admin = TRUE,
          active = TRUE;

    INSERT INTO public.admin_audit_log (action, actor_email, target_email, details)
    VALUES (
      'super_admin_provisioned',
      'mysterybakebites@gmail.com',
      'mysterybakebites@gmail.com',
      'Primary Super Administrator enrolled via Supabase Auth (mandatory first-login password change active)'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_super_admin ON auth.users;
CREATE TRIGGER on_auth_user_created_super_admin
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_provision_super_admin();

-- Protect mysterybakebites@gmail.com from accidental deletion, deactivation, or role downgrade
CREATE OR REPLACE FUNCTION public.trg_protect_primary_super_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF lower(OLD.email) = 'mysterybakebites@gmail.com' OR OLD.is_primary_super_admin THEN
      RAISE EXCEPTION 'The primary Super Administrator (mysterybakebites@gmail.com) cannot be removed.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF lower(OLD.email) = 'mysterybakebites@gmail.com' OR OLD.is_primary_super_admin THEN
      IF lower(NEW.email) <> 'mysterybakebites@gmail.com'
         OR NEW.role <> 'super_admin'
         OR NEW.is_primary_super_admin IS DISTINCT FROM TRUE
         OR NEW.active IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'The primary Super Administrator (mysterybakebites@gmail.com) cannot be demoted, deactivated, or reassigned.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF lower(NEW.email) <> 'mysterybakebites@gmail.com' AND (NEW.role = 'super_admin' OR NEW.is_primary_super_admin) THEN
    RAISE EXCEPTION 'The super_admin role is exclusively reserved for mysterybakebites@gmail.com.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_primary_super_admin ON public.admin_users;
CREATE TRIGGER protect_primary_super_admin
  BEFORE INSERT OR UPDATE OR DELETE ON public.admin_users
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_protect_primary_super_admin();

-- -----------------------------------------------------------------------------
-- 3. RBAC & Mandatory First-Login Verification Helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_verified_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users a
    WHERE a.user_id = auth.uid()
      AND a.active = TRUE
      AND a.must_change_password = FALSE
      AND a.role IN ('super_admin', 'administrator', 'manager', 'viewer')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_verified_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users a
    WHERE a.user_id = auth.uid()
      AND lower(a.email) = 'mysterybakebites@gmail.com'
      AND a.role = 'super_admin'
      AND a.is_primary_super_admin = TRUE
      AND a.active = TRUE
      AND a.must_change_password = FALSE
  );
$$;

CREATE OR REPLACE FUNCTION public.has_admin_permission(p_perm TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT a.role INTO v_role
  FROM public.admin_users a
  WHERE a.user_id = auth.uid()
    AND a.active = TRUE
    AND a.must_change_password = FALSE;

  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN TRUE;
  ELSIF v_role = 'administrator' THEN
    RETURN p_perm IN ('view', 'orders', 'verify', 'catalogue', 'settings');
  ELSIF v_role = 'manager' THEN
    RETURN p_perm IN ('view', 'orders', 'verify', 'catalogue');
  ELSIF v_role = 'viewer' THEN
    RETURN p_perm = 'view';
  END IF;

  RETURN FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Row-Level Security (RLS) Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cake_options        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions ENABLE ROW LEVEL SECURITY;

-- Deliberately NOT `FORCE ROW LEVEL SECURITY` on admin_users.
--
-- The policy on this table calls public.is_verified_admin(), and that helper
-- itself reads public.admin_users. Under FORCE RLS the table owner is subject to
-- policies too, so evaluating it would re-enter the same policy:
--   "infinite recursion detected in policy for relation admin_users"
-- and every order/payment policy (which also calls is_verified_admin) would fail
-- with it.
--
-- ENABLE is enough for the roles that matter: anon and authenticated are never
-- the table owner, so they are fully subject to these policies. Only postgres
-- (the migration/owner role) bypasses, and that role can already read the table
-- directly. FORCE is still applied to orders / payment_submissions / payments in
-- 20261023, where the policies call a helper that reads a *different* table.

-- Remove the superseded policy names from the hardening migration.
DROP POLICY IF EXISTS admin_users_select_policy        ON public.admin_users;
DROP POLICY IF EXISTS admin_users_write_policy         ON public.admin_users;
DROP POLICY IF EXISTS orders_admin_all_policy          ON public.orders;
DROP POLICY IF EXISTS payment_submissions_admin_all_policy ON public.payment_submissions;

DROP POLICY IF EXISTS "public_read_categories" ON public.categories;
CREATE POLICY "public_read_categories" ON public.categories
  FOR SELECT USING (published = TRUE OR public.is_verified_admin());

DROP POLICY IF EXISTS "public_read_products" ON public.products;
CREATE POLICY "public_read_products" ON public.products
  FOR SELECT USING (published = TRUE OR public.is_verified_admin());

DROP POLICY IF EXISTS "public_read_classes" ON public.classes;
CREATE POLICY "public_read_classes" ON public.classes
  FOR SELECT USING (published = TRUE OR public.is_verified_admin());

DROP POLICY IF EXISTS "public_read_cake_options" ON public.cake_options;
CREATE POLICY "public_read_cake_options" ON public.cake_options
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "admin_only_settings" ON public.settings;
CREATE POLICY "admin_only_settings" ON public.settings
  FOR ALL USING (public.has_admin_permission('settings'))
  WITH CHECK (public.has_admin_permission('settings'));

DROP POLICY IF EXISTS "admin_read_roster" ON public.admin_users;
CREATE POLICY "admin_read_roster" ON public.admin_users
  FOR SELECT USING (public.is_verified_admin() OR user_id = auth.uid());

DROP POLICY IF EXISTS "super_admin_write_roster" ON public.admin_users;
CREATE POLICY "super_admin_write_roster" ON public.admin_users
  FOR ALL USING (public.is_verified_super_admin())
  WITH CHECK (public.is_verified_super_admin());

DROP POLICY IF EXISTS "super_admin_read_audit" ON public.admin_audit_log;
CREATE POLICY "super_admin_read_audit" ON public.admin_audit_log
  FOR SELECT USING (public.is_verified_super_admin());

DROP POLICY IF EXISTS "admin_read_orders" ON public.orders;
CREATE POLICY "admin_read_orders" ON public.orders
  FOR SELECT USING (public.is_verified_admin());

DROP POLICY IF EXISTS "admin_write_orders" ON public.orders;
CREATE POLICY "admin_write_orders" ON public.orders
  FOR UPDATE USING (public.has_admin_permission('orders'))
  WITH CHECK (public.has_admin_permission('orders'));

DROP POLICY IF EXISTS "admin_all_payment_submissions" ON public.payment_submissions;
CREATE POLICY "admin_all_payment_submissions" ON public.payment_submissions
  FOR ALL USING (public.has_admin_permission('verify'))
  WITH CHECK (public.has_admin_permission('verify'));

-- -----------------------------------------------------------------------------
-- 5. Session Verification, First-Login Password Completion & User Management RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_whoami()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_admin public.admin_users%ROWTYPE;
  v_perms JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'signedIn', FALSE,
      'isAdmin', FALSE,
      'email', '',
      'role', NULL
    );
  END IF;

  SELECT * INTO v_admin
  FROM public.admin_users
  WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'signedIn', TRUE,
      'isAdmin', FALSE,
      'email', '',
      'role', 'customer'
    );
  END IF;

  IF v_admin.active = FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'signedIn', TRUE,
      'isAdmin', FALSE,
      'deactivated', TRUE,
      'email', v_admin.email,
      'role', NULL
    );
  END IF;

  UPDATE public.admin_users
  SET last_sign_in_at = NOW()
  WHERE user_id = v_uid;

  v_perms := jsonb_build_object(
    'view', TRUE,
    'orders', v_admin.role IN ('super_admin', 'administrator', 'manager'),
    'verify', v_admin.role IN ('super_admin', 'administrator', 'manager'),
    'catalogue', v_admin.role IN ('super_admin', 'administrator', 'manager'),
    'settings', v_admin.role IN ('super_admin', 'administrator'),
    'team', v_admin.role = 'super_admin' AND lower(v_admin.email) = 'mysterybakebites@gmail.com'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'signedIn', TRUE,
    'isAdmin', TRUE,
    'email', v_admin.email,
    'name', v_admin.name,
    'role', v_admin.role,
    'isSuperAdmin', (v_admin.role = 'super_admin' AND lower(v_admin.email) = 'mysterybakebites@gmail.com'),
    'isPrimarySuperAdmin', v_admin.is_primary_super_admin,
    'mustChangePassword', v_admin.must_change_password,
    'permissions', v_perms
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_complete_first_login(
  p_current_password TEXT DEFAULT '',
  p_new_password     TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_admin public.admin_users%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised', 'error', 'Please sign in first.');
  END IF;

  SELECT * INTO v_admin
  FROM public.admin_users
  WHERE user_id = v_uid AND active = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised', 'error', 'Administrator account not found.');
  END IF;

  UPDATE public.admin_users
  SET must_change_password = FALSE,
      password_changed_at = NOW()
  WHERE user_id = v_uid;

  INSERT INTO public.admin_audit_log (action, actor_email, target_email, details)
  VALUES (
    'first_login_password_changed',
    v_admin.email,
    v_admin.email,
    'Completed mandatory first-login password change for ' || v_admin.email
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'email', v_admin.email,
    'role', v_admin.role,
    'mustChangePassword', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_team(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_caller    public.admin_users%ROWTYPE;
  v_action    TEXT := lower(trim(coalesce(p_payload->>'action', 'list')));
  v_target_id UUID;
  v_target    public.admin_users%ROWTYPE;
  v_new_role  TEXT;
  v_active    BOOLEAN;
  v_admins    JSONB;
  v_logs      JSONB;
BEGIN
  SELECT * INTO v_caller
  FROM public.admin_users
  WHERE user_id = v_uid AND active = TRUE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised', 'error', 'Unauthorised: administrator access required.');
  END IF;

  IF v_caller.must_change_password THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'password_change_required', 'mustChangePassword', TRUE, 'error', 'You must change your temporary password before accessing the dashboard.');
  END IF;

  IF v_action = 'list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'userId', a.user_id,
      'email', a.email,
      'name', a.name,
      'role', a.role,
      'isPrimarySuperAdmin', a.is_primary_super_admin,
      'active', a.active,
      'mustChangePassword', a.must_change_password,
      'isProvisioned', TRUE,
      'createdAt', a.created_at,
      'lastSignInAt', a.last_sign_in_at,
      'passwordChangedAt', a.password_changed_at
    ) ORDER BY a.is_primary_super_admin DESC, a.created_at ASC), '[]'::jsonb)
    INTO v_admins
    FROM public.admin_users a;

    IF v_caller.role = 'super_admin' AND lower(v_caller.email) = 'mysterybakebites@gmail.com' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id,
        'action', l.action,
        'actor', l.actor_email,
        'target', l.target_email,
        'details', l.details,
        'at', l.created_at
      ) ORDER BY l.created_at DESC), '[]'::jsonb)
      INTO v_logs
      FROM (SELECT * FROM public.admin_audit_log ORDER BY created_at DESC LIMIT 50) l;
    ELSE
      v_logs := '[]'::jsonb;
    END IF;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'admins', v_admins,
      'canManageTeam', (v_caller.role = 'super_admin' AND lower(v_caller.email) = 'mysterybakebites@gmail.com'),
      'primarySuperAdminEmail', 'mysterybakebites@gmail.com',
      'auditLog', v_logs
    );
  END IF;

  -- All mutating actions require primary Super Administrator authority
  IF NOT public.is_verified_super_admin() THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'forbidden',
      'error', 'Only the primary Super Administrator (mysterybakebites@gmail.com) is authorized to manage user accounts and roles.'
    );
  END IF;

  v_target_id := NULLIF(trim(coalesce(p_payload->>'userId', '')), '')::UUID;
  SELECT * INTO v_target FROM public.admin_users WHERE user_id = v_target_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Target user account was not found.');
  END IF;

  IF lower(v_target.email) = 'mysterybakebites@gmail.com' OR v_target.is_primary_super_admin THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'super_admin_protected',
      'error', 'The primary Super Administrator (mysterybakebites@gmail.com) is protected and cannot be modified, demoted, deactivated, or removed.'
    );
  END IF;

  IF v_action = 'update_role' THEN
    v_new_role := lower(trim(coalesce(p_payload->>'role', '')));
    IF v_new_role NOT IN ('administrator', 'manager', 'viewer') THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_role', 'error', 'Select a valid role: administrator, manager, or viewer.');
    END IF;
    UPDATE public.admin_users SET role = v_new_role WHERE user_id = v_target.user_id;
    INSERT INTO public.admin_audit_log (action, actor_email, target_email, details)
    VALUES ('role_updated', v_caller.email, v_target.email, 'Updated role for ' || v_target.email || ' to ' || v_new_role);
    RETURN jsonb_build_object('ok', TRUE);
  ELSIF v_action IN ('set_status', 'activate', 'deactivate') THEN
    v_active := CASE
      WHEN v_action = 'activate' THEN TRUE
      WHEN v_action = 'deactivate' THEN FALSE
      ELSE coalesce((p_payload->>'active')::BOOLEAN, TRUE)
    END;
    UPDATE public.admin_users SET active = v_active WHERE user_id = v_target.user_id;
    INSERT INTO public.admin_audit_log (action, actor_email, target_email, details)
    VALUES (CASE WHEN v_active THEN 'user_activated' ELSE 'user_deactivated' END, v_caller.email, v_target.email, (CASE WHEN v_active THEN 'Activated ' ELSE 'Deactivated ' END) || v_target.email);
    RETURN jsonb_build_object('ok', TRUE);
  ELSIF v_action = 'remove' THEN
    DELETE FROM public.admin_users WHERE user_id = v_target.user_id;
    INSERT INTO public.admin_audit_log (action, actor_email, target_email, details)
    VALUES ('user_removed', v_caller.email, v_target.email, 'Removed ' || v_target.email || ' from the administrative roster');
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  RETURN jsonb_build_object('ok', FALSE, 'error', 'Unsupported team action.');
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Payment State-Machine Trigger
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_order_payment_state_machine()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();

  IF OLD.payment_status = 'payment_verified' AND NEW.payment_status <> 'payment_verified' THEN
    RAISE EXCEPTION 'Verified payments are permanently locked and cannot be reverted.'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.payment_status IN ('awaiting_payment', 'payment_rejected', 'pay_on_collection')
     AND NEW.payment_status = 'payment_verified'
     AND NOT public.has_admin_permission('verify') THEN
    RAISE EXCEPTION 'Only an authorized administrator can mark a payment as verified.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_payment_state_machine ON public.orders;
CREATE TRIGGER trg_orders_payment_state_machine
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_order_payment_state_machine();

-- -----------------------------------------------------------------------------
-- 7. Administrator Payment Verification & Resubmission Unlock
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_verify(
  p_ref TEXT,
  p_action TEXT,
  p_note TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref TEXT := UPPER(BTRIM(COALESCE(p_ref, '')));
  v_act TEXT := LOWER(BTRIM(COALESCE(p_action, '')));
  v_note TEXT := LEFT(BTRIM(COALESCE(p_note, '')), 300);
  v_order public.orders%ROWTYPE;
BEGIN
  IF NOT public.is_verified_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised', 'error', 'Administrator privileges required.');
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF v_act = 'confirm' THEN
    UPDATE public.payment_submissions
    SET status = 'verified', reviewed_at = NOW(), reviewed_by = auth.uid()
    WHERE order_ref = v_ref AND status = 'pending_verification';

    UPDATE public.orders
    SET payment_status = 'payment_verified',
        proof_locked = TRUE,
        verified_at = NOW(),
        verified_by = auth.uid()
    WHERE ref = v_ref
    RETURNING * INTO v_order;
  ELSIF v_act IN ('reject', 'allow_resubmit') THEN
    IF char_length(v_note) < 3 THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'note_required', 'error', 'Please enter a rejection reason so the customer knows what to correct.');
    END IF;

    UPDATE public.payment_submissions
    SET status = 'rejected', reviewed_at = NOW(), reviewed_by = auth.uid(), reject_reason = v_note
    WHERE order_ref = v_ref AND status = 'pending_verification';

    UPDATE public.orders
    SET payment_status = 'payment_rejected',
        proof_locked = FALSE,
        reject_reason = v_note
    WHERE ref = v_ref
    RETURNING * INTO v_order;
  ELSE
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Invalid verification action.');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'order', to_jsonb(v_order) - 'token');
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Payment Proof Upload Path Reservation
--    (api_submit_proof itself lives in 20261023, which is ownership-aware.)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_begin_proof_upload(
  p_ref TEXT,
  p_token TEXT,
  p_ext TEXT DEFAULT 'jpg'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref TEXT := UPPER(BTRIM(COALESCE(p_ref, '')));
  v_tok TEXT := BTRIM(COALESCE(p_token, ''));
  v_ext TEXT := LOWER(REGEXP_REPLACE(COALESCE(p_ext, 'jpg'), '[^a-z0-9]', '', 'g'));
  v_order public.orders%ROWTYPE;
BEGIN
  IF v_ext NOT IN ('jpg', 'jpeg', 'png', 'webp') THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'invalid_image',
      'error', 'Only PNG, JPEG, and WebP payment screenshots are allowed.'
    );
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE ref = v_ref
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF v_tok = '' OR v_tok <> v_order.token THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'token', 'error', 'Invalid or missing order security token.');
  END IF;

  IF v_order.order_status IN ('cancelled', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'order_closed', 'error', 'This order is closed and cannot accept payment uploads.');
  END IF;

  IF v_order.payment_method IN ('cash_on_delivery', 'cash_on_pickup') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_applicable', 'error', 'Cash orders do not accept advance payment proof uploads.');
  END IF;

  IF v_order.payment_status = 'payment_verified' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'already_verified', 'error', 'Payment for this order has already been verified.');
  END IF;

  IF v_order.payment_status = 'payment_submitted' OR (v_order.proof_locked = TRUE AND v_order.payment_status <> 'payment_rejected') THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'duplicate_submission',
      'error', 'Payment details have already been submitted for this order and are awaiting verification.'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'path', v_order.ref || '/' || EXTRACT(EPOCH FROM NOW())::BIGINT || '-' || encode(gen_random_bytes(6), 'hex') || '.' || v_ext
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. Private Storage Bucket for Payment Screenshots
-- -----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'proofs',
  'proofs',
  FALSE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- The bucket is private: only verified administrators may read or delete proofs.
DROP POLICY IF EXISTS "admin_read_proof_objects" ON storage.objects;
DROP POLICY IF EXISTS proofs_admin_select_policy ON storage.objects;
CREATE POLICY proofs_admin_select_policy ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'proofs' AND public.is_verified_admin());

DROP POLICY IF EXISTS proofs_admin_delete_policy ON storage.objects;
CREATE POLICY proofs_admin_delete_policy ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'proofs' AND public.is_verified_admin());


REVOKE ALL ON FUNCTION public.is_verified_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_verified_admin() TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.api_admin_whoami() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_complete_first_login(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_team(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_verify(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_begin_proof_upload(TEXT, TEXT, TEXT) TO anon, authenticated;

-- [COMMIT removed: the combined script has one outer transaction]


-- =============================================================================
-- FILE 2 of 6 — 20261023_customer_accounts_secure_ordering_and_rls.sql
-- Guest ordering, order items, payments, class bookings
-- =============================================================================

-- =============================================================================
-- Mystery Bakebite — Customer Accounts, Normalized Order/Payment Tables,
-- Strict Row-Level Security (RLS), Server-Side Price Validation, and
-- GH₵ 700.00 Threshold Enforcement
-- Migration: 20261023_customer_accounts_secure_ordering_and_rls.sql
-- Target: Supabase PostgreSQL 15+
-- =============================================================================

-- [BEGIN removed: the combined script has one outer transaction]

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Customer Profiles Table & Safe Auth Sync Trigger
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.customer_profiles (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL DEFAULT '' CHECK (char_length(btrim(full_name)) <= 120),
  phone           TEXT NOT NULL DEFAULT '' CHECK (
                    phone = '' OR char_length(regexp_replace(phone, '\D', '', 'g')) BETWEEN 7 AND 15
                  ),
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_email
  ON public.customer_profiles (lower(email));

-- Automatically and idempotently create/update customer_profiles when an auth.users
-- row is inserted or updated. Never trusts user metadata for roles or privileges.
CREATE OR REPLACE FUNCTION public.trg_sync_customer_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name  TEXT;
  v_phone TEXT;
BEGIN
  -- Do not create a customer profile for the primary super admin if not needed,
  -- or allow both safely without granting any admin role from metadata.
  v_name := left(btrim(coalesce(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', '')), 120);
  v_phone := left(btrim(coalesce(NEW.raw_user_meta_data->>'phone', '')), 24);
  IF char_length(regexp_replace(v_phone, '\D', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    v_phone := '';
  END IF;

  INSERT INTO public.customer_profiles (
    user_id,
    email,
    full_name,
    phone,
    email_verified,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    lower(btrim(NEW.email)),
    v_name,
    v_phone,
    (NEW.email_confirmed_at IS NOT NULL),
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET email          = lower(btrim(EXCLUDED.email)),
        full_name      = CASE WHEN char_length(btrim(public.customer_profiles.full_name)) >= 2
                              THEN public.customer_profiles.full_name
                              ELSE EXCLUDED.full_name END,
        phone          = CASE WHEN char_length(btrim(public.customer_profiles.phone)) >= 7
                              THEN public.customer_profiles.phone
                              ELSE EXCLUDED.phone END,
        email_verified = (NEW.email_confirmed_at IS NOT NULL),
        updated_at     = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_sync_customer_profile ON auth.users;
CREATE TRIGGER on_auth_user_sync_customer_profile
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_customer_profile();

-- Prevent customers from modifying immutable/privileged columns on customer_profiles
CREATE OR REPLACE FUNCTION public.trg_protect_customer_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := NOW();

  IF NOT public.is_verified_admin() THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR lower(NEW.email) IS DISTINCT FROM lower(OLD.email)
       OR NEW.email_verified IS DISTINCT FROM OLD.email_verified
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Customers may only update their own full_name and phone.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF char_length(btrim(coalesce(NEW.full_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Full name must be at least 2 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.phone <> '' AND char_length(regexp_replace(NEW.phone, '\D', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    RAISE EXCEPTION 'Phone number must contain 7 to 15 digits.'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_customer_profile ON public.customer_profiles;
CREATE TRIGGER protect_customer_profile
  BEFORE UPDATE ON public.customer_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_protect_customer_profile();

-- -----------------------------------------------------------------------------
-- 2. Settings Threshold Alignment (GH₵ 700.00 = 70000 pesewas) & Orders Columns
-- -----------------------------------------------------------------------------

ALTER TABLE public.settings
  ALTER COLUMN advance_threshold SET DEFAULT 70000;

UPDATE public.settings
SET advance_threshold = 70000
WHERE id = 1 AND advance_threshold = 15000;

-- Link orders to the authenticated customer account (retaining orders on user deletion)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id_created_at
  ON public.orders (customer_id, created_at DESC);

-- Ensure order_status constraint supports 'ready' alongside existing statuses
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_order_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_order_status_check
  CHECK (order_status IN ('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled'));

-- Ensure ref constraint allows both MB-XXXXXX and MB-YYMMDD-XXXX formats
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_ref_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_ref_check
  CHECK (ref ~ '^M[BC]-[A-Z0-9-]{4,20}$');

-- -----------------------------------------------------------------------------
-- 3. Normalized Order Items, Payments, and Class Bookings Tables
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref     TEXT NOT NULL REFERENCES public.orders(ref) ON DELETE CASCADE,
  customer_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  line_index    INTEGER NOT NULL CHECK (line_index >= 0),
  item_kind     TEXT NOT NULL CHECK (item_kind IN ('product', 'custom_cake', 'class')),
  product_sku   TEXT REFERENCES public.products(sku) ON UPDATE CASCADE ON DELETE SET NULL,
  class_slug    TEXT REFERENCES public.classes(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  item_name     TEXT NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 200),
  item_meta     TEXT NOT NULL DEFAULT '',
  qty           INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 100),
  unit_price    INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),
  discount_pct  INTEGER NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 90),
  line_discount INTEGER NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  line_total    INTEGER CHECK (line_total IS NULL OR line_total >= 0),
  prep_days     INTEGER NOT NULL DEFAULT 0 CHECK (prep_days BETWEEN 0 AND 30),
  custom_spec   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_ref, line_index)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_ref
  ON public.order_items (order_ref);

CREATE INDEX IF NOT EXISTS idx_order_items_customer_id
  ON public.order_items (customer_id);

CREATE TABLE IF NOT EXISTS public.payments (
  id                                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref                               TEXT NOT NULL UNIQUE REFERENCES public.orders(ref) ON DELETE CASCADE,
  customer_id                             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payment_method                          TEXT NOT NULL CHECK (payment_method IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery')),
  expected_amount                         INTEGER NOT NULL CHECK (expected_amount >= 0),
  transaction_reference                   TEXT NOT NULL DEFAULT '',
  proof_image_path                        TEXT NOT NULL DEFAULT '',
  customer_note                           TEXT NOT NULL DEFAULT '',
  verification_status                     TEXT NOT NULL DEFAULT 'awaiting_payment'
                                          CHECK (verification_status IN ('awaiting_payment', 'payment_submitted', 'payment_verified', 'payment_rejected', 'pay_on_collection', 'not_required')),
  requires_pre_confirmation_verification  BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at                            TIMESTAMPTZ,
  verified_at                             TIMESTAMPTZ,
  verified_by                             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reject_reason                           TEXT NOT NULL DEFAULT '',
  created_at                              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_customer_id
  ON public.payments (customer_id);

CREATE TABLE IF NOT EXISTS public.class_bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref     TEXT NOT NULL UNIQUE REFERENCES public.orders(ref) ON DELETE CASCADE,
  customer_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  courses         JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundles         JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal        INTEGER NOT NULL CHECK (subtotal >= 0),
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total           INTEGER NOT NULL CHECK (total >= 0),
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery')),
  payment_status  TEXT NOT NULL DEFAULT 'awaiting_payment'
                  CHECK (payment_status IN ('awaiting_payment', 'payment_submitted', 'payment_verified', 'payment_rejected', 'pay_on_collection', 'not_required')),
  booking_status  TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (booking_status IN ('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled')),
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_class_bookings_customer_id
  ON public.class_bookings (customer_id);

-- -----------------------------------------------------------------------------
-- 4. Order & Payment Integrity Trigger (Enforces GH₵ 700.00 Threshold & Status Rules)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_order_payment_state_machine()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_threshold INTEGER := 70000;
BEGIN
  SELECT coalesce(s.advance_threshold, 70000) INTO v_threshold
  FROM public.settings s
  WHERE s.id = 1;

  NEW.updated_at := NOW();

  -- 1. Verified payments are permanently locked and cannot be reverted
  IF OLD.payment_status = 'payment_verified' AND NEW.payment_status <> 'payment_verified' THEN
    RAISE EXCEPTION 'Verified payments are permanently locked and cannot be reverted.'
      USING ERRCODE = 'P0001', HINT = 'already_verified';
  END IF;

  -- 2. Only an authorized administrator with 'verify' permission can mark payment_verified
  IF NEW.payment_status = 'payment_verified' AND OLD.payment_status <> 'payment_verified' THEN
    IF NOT public.has_admin_permission('verify') AND current_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'Unauthorised: only a verified administrator can confirm payment.'
        USING ERRCODE = '42501', HINT = 'unauthorised';
    END IF;
    NEW.proof_locked := TRUE;
    NEW.verified_at := COALESCE(NEW.verified_at, NOW());
    -- Record which administrator confirmed the payment. auth.uid() is a UUID,
    -- matching the reconciled column type (TEXT/'' was the old, broken shape).
    NEW.verified_by := COALESCE(NEW.verified_by, auth.uid());
  END IF;

  -- 2b. Keep the normalised mirrors in step with the canonical orders row, so
  --     payments.verification_status / verified_by and class_bookings.payment_status
  --     cannot drift from orders.payment_status once a payment is confirmed or rejected.
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status IN ('payment_verified', 'payment_rejected') THEN

    UPDATE public.payments
       SET verification_status = NEW.payment_status,
           verified_at  = CASE WHEN NEW.payment_status = 'payment_verified'
                               THEN NEW.verified_at ELSE payments.verified_at END,
           verified_by  = CASE WHEN NEW.payment_status = 'payment_verified'
                               THEN NEW.verified_by ELSE payments.verified_by END,
           reject_reason = CASE WHEN NEW.payment_status = 'payment_rejected'
                                THEN COALESCE(NEW.reject_reason, '')
                                ELSE payments.reject_reason END,
           updated_at   = NOW()
     WHERE order_ref = NEW.ref;

    UPDATE public.class_bookings
       SET payment_status = NEW.payment_status,
           updated_at     = NOW()
     WHERE booking_ref = NEW.ref;
  END IF;

  -- 3. Block duplicate customer payment submissions when proof is already submitted or locked
  IF NEW.payment_status = 'payment_submitted' THEN
    IF OLD.payment_status = 'payment_verified' THEN
      RAISE EXCEPTION 'Payment for this order has already been verified.'
        USING ERRCODE = 'P0001', HINT = 'already_verified';
    END IF;

    IF (OLD.payment_status = 'payment_submitted' OR OLD.proof_locked = TRUE)
       AND OLD.payment_status <> 'payment_rejected'
       AND (
         NEW.submission_count <> OLD.submission_count
         OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
         OR NEW.proof_path IS DISTINCT FROM OLD.proof_path
       )
       AND NOT public.has_admin_permission('verify')
    THEN
      RAISE EXCEPTION 'Duplicate payment submission blocked: payment details are already on file and awaiting verification.'
        USING ERRCODE = 'P0001', HINT = 'duplicate_submission';
    END IF;
  END IF;

  -- 4. Prevent immutable financial & ownership columns from being altered after creation
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.discount IS DISTINCT FROM OLD.discount
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'Order ownership and agreed monetary totals are immutable.'
      USING ERRCODE = '42501', HINT = 'immutable_order_fields';
  END IF;

  -- 5. Special Order Threshold (Strictly Greater Than GH₵ 700.00 / 70000 pesewas):
  --    Orders with total > v_threshold (or advance_required = TRUE) MUST NOT transition
  --    to 'confirmed', 'in_preparation', 'ready', or 'completed' until payment_status = 'payment_verified'.
  IF NEW.order_status IN ('confirmed', 'in_preparation', 'ready', 'completed')
     AND (NEW.total > v_threshold OR NEW.advance_required = TRUE)
     AND NEW.payment_status <> 'payment_verified' THEN
    RAISE EXCEPTION 'Orders strictly above GH₵ 700.00 require verified payment before they can be confirmed or prepared.'
      USING ERRCODE = 'P0001', HINT = 'payment_verification_required';
  END IF;

  -- 6. Prevent completed or cancelled orders from transitioning backwards
  IF OLD.order_status = 'cancelled' AND NEW.order_status <> 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled orders cannot be reopened.'
      USING ERRCODE = 'P0001', HINT = 'invalid_status_transition';
  END IF;

  IF OLD.order_status = 'completed' AND NEW.order_status <> 'completed' THEN
    RAISE EXCEPTION 'Completed orders are finalized and cannot change status.'
      USING ERRCODE = 'P0001', HINT = 'invalid_status_transition';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_payment_state_machine ON public.orders;
DROP TRIGGER IF EXISTS trg_enforce_order_payment_state_machine ON public.orders;
CREATE TRIGGER trg_orders_payment_state_machine
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_order_payment_state_machine();

-- -----------------------------------------------------------------------------
-- 5. Row-Level Security (RLS) Policies & Strict Table Grants
-- -----------------------------------------------------------------------------

ALTER TABLE public.categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cake_options        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_bookings      ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_profiles   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orders              FORCE ROW LEVEL SECURITY;
ALTER TABLE public.order_items         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payments            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.class_bookings      FORCE ROW LEVEL SECURITY;

-- Customer Profiles: customers may read and update ONLY their own row; admins may read all
DROP POLICY IF EXISTS "customer_read_own_profile" ON public.customer_profiles;
CREATE POLICY "customer_read_own_profile" ON public.customer_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_verified_admin());

DROP POLICY IF EXISTS "customer_update_own_profile" ON public.customer_profiles;
CREATE POLICY "customer_update_own_profile" ON public.customer_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Orders: authenticated customers may read ONLY their own orders (customer_id = auth.uid());
-- verified admins may read all and update orders if permitted.
DROP POLICY IF EXISTS "customer_read_own_orders" ON public.orders;
CREATE POLICY "customer_read_own_orders" ON public.orders
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

-- Order Items: authenticated customers may read ONLY their own order items
DROP POLICY IF EXISTS "customer_read_own_order_items" ON public.order_items;
CREATE POLICY "customer_read_own_order_items" ON public.order_items
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

-- Payments: authenticated customers may read ONLY their own payment records
DROP POLICY IF EXISTS "customer_read_own_payments" ON public.payments;
CREATE POLICY "customer_read_own_payments" ON public.payments
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

DROP POLICY IF EXISTS "admin_write_payments" ON public.payments;
CREATE POLICY "admin_write_payments" ON public.payments
  FOR ALL TO authenticated
  USING (public.has_admin_permission('verify'))
  WITH CHECK (public.has_admin_permission('verify'));

-- Payment Submissions: authenticated customers may read ONLY submissions for their own orders
DROP POLICY IF EXISTS "customer_read_own_payment_submissions" ON public.payment_submissions;
CREATE POLICY "customer_read_own_payment_submissions" ON public.payment_submissions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.ref = payment_submissions.order_ref
        AND o.customer_id = auth.uid()
    )
    OR public.is_verified_admin()
  );

-- Class Bookings: authenticated customers may read ONLY their own class bookings
DROP POLICY IF EXISTS "customer_read_own_class_bookings" ON public.class_bookings;
CREATE POLICY "customer_read_own_class_bookings" ON public.class_bookings
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

-- Restrict direct table privileges: anonymous users can only SELECT public catalogue tables;
-- authenticated users can SELECT their own records (filtered by RLS) and UPDATE permitted
-- profile columns, but cannot directly INSERT/UPDATE/DELETE orders, order_items, payments,
-- payment_submissions, or class_bookings (all mutations go through trusted SECURITY DEFINER RPCs).
REVOKE ALL ON public.customer_profiles   FROM anon, authenticated;
REVOKE ALL ON public.orders              FROM anon, authenticated;
REVOKE ALL ON public.order_items         FROM anon, authenticated;
REVOKE ALL ON public.payments            FROM anon, authenticated;
REVOKE ALL ON public.payment_submissions FROM anon, authenticated;
REVOKE ALL ON public.class_bookings      FROM anon, authenticated;
REVOKE ALL ON public.admin_users         FROM anon, authenticated;
REVOKE ALL ON public.admin_audit_log     FROM anon, authenticated;
REVOKE ALL ON public.settings            FROM anon, authenticated;

GRANT SELECT ON public.categories, public.products, public.classes, public.cake_options TO anon, authenticated;
GRANT SELECT, UPDATE (full_name, phone, updated_at) ON public.customer_profiles TO authenticated;
GRANT SELECT ON public.orders, public.order_items, public.payments, public.payment_submissions, public.class_bookings TO authenticated;
GRANT SELECT ON public.admin_users, public.admin_audit_log, public.settings TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Customer Profile & Account History RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_customer_whoami()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_email         TEXT;
  v_confirmed_at  TIMESTAMPTZ;
  v_profile       public.customer_profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'signedIn', FALSE,
      'emailVerified', FALSE,
      'profile', NULL
    );
  END IF;

  SELECT lower(btrim(u.email)), u.email_confirmed_at
  INTO v_email, v_confirmed_at
  FROM auth.users u
  WHERE u.id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', TRUE, 'signedIn', FALSE, 'emailVerified', FALSE, 'profile', NULL);
  END IF;

  INSERT INTO public.customer_profiles (user_id, email, email_verified)
  VALUES (v_uid, v_email, (v_confirmed_at IS NOT NULL))
  ON CONFLICT (user_id) DO UPDATE
    SET email_verified = (v_confirmed_at IS NOT NULL)
  RETURNING * INTO v_profile;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'signedIn', TRUE,
    'emailVerified', v_profile.email_verified,
    'profile', jsonb_build_object(
      'userId', v_profile.user_id,
      'email', v_profile.email,
      'fullName', v_profile.full_name,
      'phone', v_profile.phone,
      'emailVerified', v_profile.email_verified,
      'createdAt', v_profile.created_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_customer_update_profile(
  p_full_name TEXT,
  p_phone     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_name    TEXT := btrim(coalesce(p_full_name, ''));
  v_phone   TEXT := btrim(coalesce(p_phone, ''));
  v_digits  TEXT := regexp_replace(v_phone, '\D', '', 'g');
  v_profile public.customer_profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'auth_required', 'error', 'Please sign in to update your profile.');
  END IF;

  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_name', 'error', 'Please enter your full name (2 to 120 characters).');
  END IF;

  IF char_length(v_digits) < 7 OR char_length(v_digits) > 15 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_phone', 'error', 'Please enter a valid phone number (7 to 15 digits).');
  END IF;

  UPDATE public.customer_profiles
  SET full_name  = v_name,
      phone      = v_phone,
      updated_at = NOW()
  WHERE user_id = v_uid
  RETURNING * INTO v_profile;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Customer profile not found.');
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'profile', jsonb_build_object(
      'userId', v_profile.user_id,
      'email', v_profile.email,
      'fullName', v_profile.full_name,
      'phone', v_profile.phone,
      'emailVerified', v_profile.email_verified,
      'createdAt', v_profile.created_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_customer_orders()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_orders   JSONB;
  v_bookings JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'auth_required', 'error', 'Please sign in to view your order history.');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'ref', o.ref,
    'kind', o.kind,
    'customerId', o.customer_id,
    'customer', jsonb_build_object('name', o.customer_name, 'phone', o.phone, 'email', o.email),
    'fulfilment', o.fulfilment,
    'address', o.address,
    'eventDate', o.event_date,
    'paymentMethod', o.payment_method,
    'paymentStatus', o.payment_status,
    'orderStatus', o.order_status,
    'subtotal', o.subtotal,
    'discount', o.discount,
    'total', o.total,
    'advanceRequired', o.advance_required,
    'items', o.items,
    'notes', o.notes,
    'paymentRef', o.payment_ref,
    'hasProof', o.has_proof,
    'proofLocked', o.proof_locked,
    'rejectReason', o.reject_reason,
    'verifiedAt', o.verified_at,
    'createdAt', o.created_at
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_orders
  FROM public.orders o
  WHERE o.customer_id = v_uid
    AND o.kind = 'product';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'ref', o.ref,
    'kind', o.kind,
    'customerId', o.customer_id,
    'customer', jsonb_build_object('name', o.customer_name, 'phone', o.phone, 'email', o.email),
    'paymentMethod', o.payment_method,
    'paymentStatus', o.payment_status,
    'orderStatus', o.order_status,
    'subtotal', o.subtotal,
    'discount', o.discount,
    'total', o.total,
    'items', o.items,
    'notes', o.notes,
    'paymentRef', o.payment_ref,
    'hasProof', o.has_proof,
    'proofLocked', o.proof_locked,
    'rejectReason', o.reject_reason,
    'verifiedAt', o.verified_at,
    'createdAt', o.created_at
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_bookings
  FROM public.orders o
  WHERE o.customer_id = v_uid
    AND o.kind = 'class';

  RETURN jsonb_build_object(
    'ok', TRUE,
    'orders', v_orders,
    'bookings', v_bookings
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Trusted Server-Side Order Creation & Price Calculation RPC (api_place_order)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_place_order(
  p_kind    TEXT,
  p_payload JSONB,
  p_idem    TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_auth_email    TEXT;
  v_confirmed_at  TIMESTAMPTZ;
  v_is_guest      BOOLEAN := TRUE;
  v_recent_orders INTEGER := 0;
  v_same_phone    BOOLEAN;
  v_kind          TEXT := CASE WHEN lower(coalesce(p_kind, 'product')) = 'class' THEN 'class' ELSE 'product' END;
  v_idem          TEXT := nullif(btrim(coalesce(p_idem, p_payload->>'idemKey', '')), '');
  v_existing      public.orders%ROWTYPE;
  v_settings      public.settings%ROWTYPE;
  v_threshold     INTEGER := 70000;
  v_name          TEXT;
  v_phone         TEXT;
  v_email         TEXT;
  v_fulfil        TEXT;
  v_address       TEXT;
  v_event_date    TEXT;
  v_pay_method    TEXT;
  v_notes         TEXT;
  v_raw_items     JSONB;
  v_item          JSONB;
  v_idx           INTEGER := 0;
  v_qty           INTEGER;
  v_sku           TEXT;
  v_prod          public.products%ROWTYPE;
  v_cls           public.classes%ROWTYPE;
  v_unit_price    INTEGER;
  v_disc_pct      INTEGER;
  v_line_disc     INTEGER;
  v_line_total    INTEGER;
  v_prep_days     INTEGER;
  v_max_prep      INTEGER := 0;
  v_earliest_ymd  TEXT;
  v_subtotal      INTEGER := 0;
  v_discount      INTEGER := 0;
  v_total         INTEGER := 0;
  v_has_quote     BOOLEAN := FALSE;
  v_order_items   JSONB := '[]'::jsonb;
  v_class_count   INTEGER := 0;
  v_ref           TEXT;
  v_token         TEXT;
  v_pay_status    TEXT;
  v_adv_req       BOOLEAN := FALSE;
BEGIN
  -- 1. Guest checkout is permitted. No customer account or session is required.
  --    A signed-in account is recognised and linked to the order when present,
  --    but it is never a precondition for ordering.
  v_is_guest := (v_uid IS NULL);

  IF NOT v_is_guest THEN
    SELECT lower(btrim(u.email)), u.email_confirmed_at
    INTO v_auth_email, v_confirmed_at
    FROM auth.users u
    WHERE u.id = v_uid;

    IF NOT FOUND THEN
      -- A stale or forged JWT must not create an order owned by a phantom
      -- account. Fall back to guest rather than failing the customer's order.
      v_uid := NULL;
      v_is_guest := TRUE;
      v_auth_email := NULL;
    END IF;
  END IF;

  -- E-mail confirmation is NOT required to order. It only determines whether the
  -- order belongs to a verified account for order-history purposes.

  -- 3. Idempotency check.
  --    Scoped with IS NOT DISTINCT FROM so guest orders (customer_id IS NULL) are
  --    matched correctly instead of silently failing the comparison.
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.orders o
    WHERE o.idempotency_key = v_idem
      AND o.customer_id IS NOT DISTINCT FROM v_uid;

    IF FOUND THEN
      -- Anti-replay: idempotency keys are globally UNIQUE, so without this check a
      -- guest who guessed another guest's key would be handed that order's token,
      -- and therefore the ability to read and submit payment proof for it.
      -- Only the same phone number may collect the token for a guest order.
      IF v_is_guest THEN
        v_same_phone := (
          regexp_replace(coalesce(v_existing.phone, ''), '\D', '', 'g')
          = regexp_replace(
              left(btrim(coalesce(p_payload->'customer'->>'phone', p_payload->>'phone', '')), 24),
              '\D', '', 'g')
        );
        IF NOT v_same_phone THEN
          RETURN jsonb_build_object(
            'ok', FALSE,
            'code', 'idempotency_conflict',
            'error', 'That request could not be completed. Please submit the order again.'
          );
        END IF;
      END IF;

      RETURN jsonb_build_object(
        'ok', TRUE,
        'deduplicated', TRUE,
        'token', v_existing.token,
        'statusUrl', 'order.html?ref=' || v_existing.ref || '&token=' || v_existing.token,
        'order', to_jsonb(v_existing) - 'token'
      );
    END IF;
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;
  v_threshold := coalesce(v_settings.advance_threshold, 70000);

  v_name       := left(btrim(coalesce(p_payload->'customer'->>'name', p_payload->>'name', '')), 120);
  v_phone      := left(btrim(coalesce(p_payload->'customer'->>'phone', p_payload->>'phone', '')), 24);
  v_email      := CASE WHEN v_is_guest
                        THEN left(btrim(coalesce(p_payload->'customer'->>'email', p_payload->>'email', '')), 160)
                        ELSE coalesce(v_auth_email, '') END;
  v_fulfil     := CASE WHEN coalesce(p_payload->>'fulfilment', 'pickup') = 'delivery' THEN 'delivery' ELSE 'pickup' END;
  v_address    := left(btrim(coalesce(p_payload->>'address', '')), 300);
  v_event_date := btrim(coalesce(p_payload->>'eventDate', p_payload->>'preferredDate', ''));
  v_pay_method := btrim(coalesce(p_payload->>'paymentMethod', ''));
  v_notes      := left(btrim(coalesce(p_payload->>'notes', '')), 500);

  IF char_length(v_name) < 2 OR char_length(regexp_replace(v_phone, '\D', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_customer', 'error', 'Please enter a valid full name and reachable phone number.');
  END IF;

  IF v_email <> '' AND v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_email', 'error', 'That e-mail address does not look right. You can also leave it blank.');
  END IF;

  -- Guest anti-abuse throttle: the RPC is executable by anon, so cap how many
  -- unauthenticated orders a single phone number can create per hour. Orders from
  -- a signed-in account are not throttled here (Supabase Auth rate limits apply).
  IF v_is_guest THEN
    SELECT count(*) INTO v_recent_orders
    FROM public.orders o
    WHERE o.customer_id IS NULL
      AND regexp_replace(o.phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')
      AND o.created_at > NOW() - INTERVAL '1 hour';

    IF v_recent_orders >= 5 THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'rate_limited',
        'error', 'Several orders have just been placed with this phone number. Please wait a little while, or message the kitchen directly.'
      );
    END IF;
  END IF;

  IF v_kind = 'product' AND v_fulfil = 'delivery' AND char_length(v_address) < 6 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_address', 'error', 'Please enter a delivery address of at least 6 characters.');
  END IF;

  IF v_pay_method NOT IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_payment_method', 'error', 'Please choose a valid payment method.');
  END IF;

  v_raw_items := coalesce(p_payload->'items', p_payload->'classes', '[]'::jsonb);
  IF jsonb_typeof(v_raw_items) <> 'array' OR jsonb_array_length(v_raw_items) = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'empty_cart', 'error', 'Your cart is empty. Please add at least one item.');
  END IF;

  IF jsonb_array_length(v_raw_items) > 50 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'too_many_items', 'error', 'Too many line items in a single order.');
  END IF;

  -- 4. Validate every item and compute prices strictly from the database
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_raw_items)
  LOOP
    IF v_item ? 'qty' THEN
      IF jsonb_typeof(v_item->'qty') <> 'number'
         OR (v_item->>'qty') !~ '^[0-9]+$'
         OR (v_item->>'qty')::INTEGER < 1
         OR (v_item->>'qty')::INTEGER > 100 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_quantity', 'error', 'Item quantity must be a whole number between 1 and 100.');
      END IF;
      v_qty := (v_item->>'qty')::INTEGER;
    ELSE
      v_qty := 1;
    END IF;

    IF v_kind = 'class' THEN
      v_sku := regexp_replace(coalesce(v_item->>'slug', v_item->>'id', ''), '^class-', '');
      SELECT * INTO v_cls FROM public.classes c WHERE lower(c.slug) = lower(v_sku);
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_class', 'error', 'Unknown or invalid class selected: ' || coalesce(v_sku, ''));
      END IF;
      IF v_cls.published = FALSE THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'class_unavailable', 'error', v_cls.name || ' is currently unavailable.');
      END IF;
      v_unit_price := v_cls.fee;
      v_subtotal := v_subtotal + v_unit_price;
      v_class_count := v_class_count + 1;
      v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
        'id', 'class-' || v_cls.slug,
        'kind', 'class',
        'slug', v_cls.slug,
        'name', v_cls.name,
        'meta', v_cls.level_label || ' level · ' || initcap(v_cls.track) || ' track',
        'qty', 1,
        'unitPrice', v_unit_price,
        'discountPct', 0,
        'discount', 0,
        'lineTotal', v_unit_price,
        'prepDays', 0
      ));
    ELSE
      v_sku := btrim(coalesce(v_item->>'sku', v_item->>'id', ''));
      SELECT * INTO v_prod FROM public.products p WHERE lower(p.sku) = lower(v_sku);
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_product', 'error', 'Unknown or invalid product SKU: ' || coalesce(v_sku, ''));
      END IF;
      IF v_prod.published = FALSE THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'product_unavailable', 'error', v_prod.name || ' is currently unavailable.');
      END IF;

      v_unit_price := v_prod.price;
      v_disc_pct   := coalesce(v_prod.discount_pct, 0);
      v_prep_days  := coalesce(v_prod.prep_days, 0);
      IF v_prep_days > v_max_prep THEN
        v_max_prep := v_prep_days;
      END IF;

      IF v_unit_price IS NULL THEN
        v_has_quote := TRUE;
        v_line_disc := 0;
        v_line_total := NULL;
      ELSE
        v_line_disc  := round(v_unit_price * v_disc_pct / 100.0)::INTEGER * v_qty;
        v_line_total := greatest(0, (v_unit_price * v_qty) - v_line_disc);
        v_subtotal   := v_subtotal + (v_unit_price * v_qty);
        v_discount   := v_discount + v_line_disc;
      END IF;

      v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
        'id', v_prod.sku,
        'kind', 'product',
        'sku', v_prod.sku,
        'name', v_prod.name,
        'meta', v_prod.meta,
        'qty', v_qty,
        'unitPrice', v_unit_price,
        'discountPct', v_disc_pct,
        'discount', v_line_disc,
        'lineTotal', v_line_total,
        'prepDays', v_prep_days
      ));
    END IF;
  END LOOP;

  -- Apply 2+ class bundle discount when booking 2 or more classes
  IF v_kind = 'class' AND v_class_count >= 2 THEN
    v_disc_pct := CASE WHEN v_class_count >= 3 THEN coalesce(v_settings.bundle_three_pct, 25)
                       ELSE coalesce(v_settings.bundle_two_pct, 15) END;
    v_discount := round(v_subtotal * v_disc_pct / 100.0)::INTEGER;
  END IF;

  v_total := greatest(0, v_subtotal - v_discount);

  -- 5. Validate preferred order date and advance preparation lead time for product orders
  IF v_kind = 'product' THEN
    v_earliest_ymd := to_char(current_date + v_max_prep, 'YYYY-MM-DD');
    IF v_event_date = '' THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'date_required',
        'earliestDate', v_earliest_ymd,
        'maxPrepDays', v_max_prep,
        'error', 'Please select a preferred order date before placing your order.'
      );
    END IF;
    IF v_event_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'date_invalid', 'error', 'Please choose a valid calendar date (YYYY-MM-DD).');
    END IF;
    IF v_event_date < to_char(current_date, 'YYYY-MM-DD') THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'date_in_past', 'earliestDate', v_earliest_ymd, 'error', 'Preferred order date cannot be in the past.');
    END IF;
    IF v_event_date < v_earliest_ymd THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'date_too_early', 'earliestDate', v_earliest_ymd, 'maxPrepDays', v_max_prep, 'error', 'Selected date does not meet the required advance preparation time.');
    END IF;
  END IF;

  -- 6. Enforce the Special Order Threshold (strictly greater than GH₵ 700.00 / v_total > v_threshold)
  v_adv_req := (v_has_quote OR v_total > v_threshold);
  IF v_pay_method IN ('cash_on_delivery', 'cash_on_pickup') AND v_adv_req THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'advance_required',
      'error', 'Orders strictly above GH₵ ' || to_char(v_threshold / 100.0, 'FM999,990.00') || ' require advance payment via Mobile Money or Bank Transfer.'
    );
  END IF;

  v_ref := (CASE WHEN v_kind = 'class' THEN 'MC-' ELSE 'MB-' END) || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
  v_token := encode(gen_random_bytes(16), 'hex');
  v_pay_status := CASE WHEN v_pay_method IN ('cash_on_delivery', 'cash_on_pickup') THEN 'pay_on_collection' ELSE 'awaiting_payment' END;

  -- 7. Atomically store order, normalized order_items, payment record, and class_booking
  INSERT INTO public.orders (
    ref, token, idempotency_key, kind, customer_id,
    customer_name, phone, email, fulfilment, address, event_date,
    payment_method, payment_status, order_status,
    subtotal, discount, total, has_unpriced, advance_required,
    items, notes, events
  ) VALUES (
    v_ref, v_token, v_idem, v_kind, v_uid,
    v_name, v_phone, v_email, v_fulfil, v_address, v_event_date,
    v_pay_method, v_pay_status, 'submitted',
    v_subtotal, v_discount, v_total, v_has_quote, v_adv_req,
    v_order_items, v_notes,
    jsonb_build_array(jsonb_build_object(
      'kind', 'order',
      'message', CASE WHEN v_kind = 'class' THEN 'Class booking submitted' ELSE 'Product order submitted' END,
      'at', NOW(),
      'actor', v_email
    ))
  ) RETURNING * INTO v_existing;

  v_idx := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_order_items)
  LOOP
    INSERT INTO public.order_items (
      order_ref, customer_id, line_index, item_kind,
      product_sku, class_slug, item_name, item_meta,
      qty, unit_price, discount_pct, line_discount, line_total, prep_days
    ) VALUES (
      v_ref,
      v_uid,
      v_idx,
      CASE WHEN v_kind = 'class' THEN 'class' ELSE 'product' END,
      CASE WHEN v_kind = 'product' THEN v_item->>'sku' ELSE NULL END,
      CASE WHEN v_kind = 'class' THEN v_item->>'slug' ELSE NULL END,
      v_item->>'name',
      coalesce(v_item->>'meta', ''),
      (v_item->>'qty')::INTEGER,
      CASE WHEN v_item->>'unitPrice' IS NULL THEN NULL ELSE (v_item->>'unitPrice')::INTEGER END,
      coalesce((v_item->>'discountPct')::INTEGER, 0),
      coalesce((v_item->>'discount')::INTEGER, 0),
      CASE WHEN v_item->>'lineTotal' IS NULL THEN NULL ELSE (v_item->>'lineTotal')::INTEGER END,
      coalesce((v_item->>'prepDays')::INTEGER, 0)
    );
    v_idx := v_idx + 1;
  END LOOP;

  INSERT INTO public.payments (
    order_ref, customer_id, payment_method, expected_amount,
    verification_status, requires_pre_confirmation_verification
  ) VALUES (
    v_ref, v_uid, v_pay_method, v_total,
    v_pay_status, v_adv_req
  );

  IF v_kind = 'class' THEN
    INSERT INTO public.class_bookings (
      booking_ref, customer_id, courses, subtotal, discount, total,
      payment_method, payment_status, booking_status, notes
    ) VALUES (
      v_ref, v_uid, v_order_items, v_subtotal, v_discount, v_total,
      v_pay_method, v_pay_status, 'submitted', v_notes
    );
  END IF;

  -- Update the customer profile phone/name if blank (signed-in customers only;
  -- guests have no profile row and user_id = NULL would match nothing anyway).
  IF v_uid IS NOT NULL THEN
    UPDATE public.customer_profiles
    SET full_name  = CASE WHEN char_length(btrim(full_name)) < 2 THEN v_name ELSE full_name END,
        phone      = CASE WHEN char_length(btrim(phone)) < 7 THEN v_phone ELSE phone END,
        updated_at = NOW()
    WHERE user_id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'token', v_token,
    'statusUrl', 'order.html?ref=' || v_ref || '&token=' || v_token,
    'order', to_jsonb(v_existing) - 'token'
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Admin Order Status Update RPC (Enforces Above-GH₵ 700 Verification Rule)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_update_order(
  p_ref   TEXT,
  p_patch JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref        TEXT := upper(btrim(coalesce(p_ref, '')));
  v_new_status TEXT := lower(btrim(coalesce(p_patch->>'orderStatus', p_patch->>'order_status', '')));
  v_threshold  INTEGER := 70000;
  v_order      public.orders%ROWTYPE;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised', 'error', 'Administrator order-management permission required.');
  END IF;

  SELECT coalesce(s.advance_threshold, 70000) INTO v_threshold
  FROM public.settings s WHERE s.id = 1;

  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF v_new_status NOT IN ('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_status', 'error', 'Invalid order status value.');
  END IF;

  -- Enforce the > GH₵ 700.00 rule before allowing confirmation or preparation
  IF v_new_status IN ('confirmed', 'in_preparation', 'ready', 'completed')
     AND (v_order.total > v_threshold OR v_order.advance_required = TRUE OR v_order.payment_method IN ('momo', 'bank_transfer'))
     AND v_order.payment_status <> 'payment_verified' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'payment_verification_required',
      'error', CASE WHEN v_order.total > v_threshold
                    THEN 'Orders strictly above GH₵ 700.00 cannot be confirmed until payment is verified.'
                    ELSE 'Advance payment must be verified before this order can be confirmed.' END
    );
  END IF;

  UPDATE public.orders
  SET order_status = v_new_status,
      updated_at   = NOW(),
      events       = coalesce(events, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'kind', 'status',
        'message', 'Order status updated to ' || v_new_status,
        'at', NOW(),
        'actor', coalesce(auth.jwt()->>'email', 'Baker')
      ))
  WHERE ref = v_ref
  RETURNING * INTO v_order;

  IF v_order.kind = 'class' THEN
    UPDATE public.class_bookings
    SET booking_status = v_new_status, updated_at = NOW()
    WHERE booking_ref = v_ref;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'order', to_jsonb(v_order) - 'token');
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'status_transition_blocked', 'error', SQLERRM);
END;
$$;


-- -----------------------------------------------------------------------------
-- 7b. Legacy column compatibility (the two 20261022 migrations disagree)
--     The production migration names the order secret `token` and the idempotency
--     column `idempotency_key`; the hardening migration names them `token_hash`
--     and `idem_key`. Whichever ran first wins, so make the columns this
--     application uses exist either way. No data is dropped.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'token'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN token TEXT;
    UPDATE public.orders
       SET token = encode(gen_random_bytes(16), 'hex')
     WHERE token IS NULL OR char_length(token) < 16;
    ALTER TABLE public.orders ALTER COLUMN token SET NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
      ON public.orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN customer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7b-2. `verified_by` / `reviewed_by` type reconciliation
--
--   The two 20261022 migrations disagreed on these columns:
--     * production_schema_and_rls  -> verified_by TEXT DEFAULT '',
--                                     payment_submissions.reviewed_by TEXT DEFAULT ''
--     * security_hardening_and_rls -> both UUID REFERENCES auth.users(id)
--
--   Because both files use CREATE TABLE IF NOT EXISTS, whichever ran first won
--   the column type. api_admin_verify() then assigns auth.uid() -- a UUID -- so
--   on a database built from the production file, confirming a payment failed
--   with:
--       column "verified_by" is of type text but expression is of type uuid
--   which is the one step of the money path nobody can work around.
--
--   Canonical type is UUID:
--     * auth.uid() is the only thing ever written to these columns;
--     * the foreign key keeps the audit trail pointing at a real administrator;
--     * ON DELETE SET NULL lets an admin account be removed without orphaning
--       historical order rows.
--
--   A TEXT column that already holds data is converted in place. Values that are
--   not valid UUIDs (the '' default, or an e-mail address written by an older
--   build) become NULL rather than being guessed at -- an unresolvable string was
--   never a usable audit reference anyway. No other column is touched.
--
--   This block is idempotent: on a correct database every branch is skipped.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_uuid_re CONSTANT TEXT :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pair   RECORD;
  v_type   TEXT;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('public.orders',              'verified_by'),
      ('public.payment_submissions', 'reviewed_by'),
      ('public.payments',            'verified_by')
    ) AS t(tbl, col)
  LOOP
    -- Skip tables/columns that do not exist on a partially migrated database.
    SELECT data_type INTO v_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = split_part(v_pair.tbl, '.', 2)
      AND column_name  = v_pair.col;

    IF v_type IS NULL OR v_type = 'uuid' THEN
      CONTINUE;
    END IF;

    -- DEFAULT '' cannot cast to UUID, so the default has to go first.
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP DEFAULT',
                   v_pair.tbl, v_pair.col);

    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN %I TYPE UUID '
      'USING (CASE WHEN %I::TEXT ~* %L THEN %I::TEXT::UUID ELSE NULL END)',
      v_pair.tbl, v_pair.col, v_pair.col, v_uuid_re, v_pair.col
    );

    RAISE NOTICE 'Reconciled %.% from % to UUID', v_pair.tbl, v_pair.col, v_type;
  END LOOP;
END $$;

-- Attach the auth.users foreign key wherever one is still missing.
DO $$
DECLARE
  v_pair RECORD;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('public.orders',              'verified_by'),
      ('public.payment_submissions', 'reviewed_by'),
      ('public.payments',            'verified_by')
    ) AS t(tbl, col)
  LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = split_part(v_pair.tbl, '.', 2)
        AND column_name  = v_pair.col
        AND data_type    = 'uuid'
    );

    CONTINUE WHEN EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum   = ANY (c.conkey)
      WHERE c.contype  = 'f'
        AND c.conrelid = v_pair.tbl::regclass
        AND a.attname  = v_pair.col
    );

    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) '
      'REFERENCES auth.users(id) ON DELETE SET NULL',
      v_pair.tbl,
      'fk_' || split_part(v_pair.tbl, '.', 2) || '_' || v_pair.col,
      v_pair.col
    );

    RAISE NOTICE 'Added auth.users foreign key on %.%', v_pair.tbl, v_pair.col;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 7b-3. Guest checkout columns
--   whatsapp_number : the baker's WhatsApp number for new-order alerts.
--   notified_at     : when the alert was dispatched, so retries cannot double-send.
--   IF NOT EXISTS keeps this safe on a database built before these existed.
-- -----------------------------------------------------------------------------

ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS whatsapp_number TEXT NOT NULL DEFAULT '';
ALTER TABLE public.orders   ADD COLUMN IF NOT EXISTS notified_at     TIMESTAMPTZ;

-- -----------------------------------------------------------------------------
-- 7c. Ownership-aware order read RPC
--     A customer may open their own order by reference alone; anybody else must
--     present the order token. Administrators with order permission may read any.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_order(
  p_ref   TEXT,
  p_token TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref    TEXT := upper(btrim(coalesce(p_ref, '')));
  v_tok    TEXT := btrim(coalesce(p_token, ''));
  v_uid    UUID := auth.uid();
  v_order  public.orders%ROWTYPE;
  v_settings public.settings%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  -- Authorisation model:
  --   * The order belongs to an account AND a different account is signed in
  --     -> refuse, even if that caller somehow holds the token.
  --   * Otherwise the token is the capability (guest checkout), and an
  --     administrator with order permission may read any order.
  IF NOT (
       (public.has_admin_permission('orders'))
       OR (v_uid IS NOT NULL AND v_order.customer_id = v_uid)
       OR (
            (v_uid IS NULL OR v_order.customer_id IS NULL)
            AND v_tok <> '' AND v_tok = v_order.token
          )
     ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'token',
      'error', 'That order link is missing or has an invalid security token.');
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order', to_jsonb(v_order) - 'token',
    'kind', v_order.kind,
    'momo', CASE WHEN coalesce(v_settings.momo_verified, FALSE)
                 THEN jsonb_build_object(
                        'name', v_settings.momo_name,
                        'number', v_settings.momo_number,
                        'provider', v_settings.momo_provider,
                        'note', v_settings.momo_note)
                 ELSE NULL END,
    'bank', CASE WHEN coalesce(v_settings.bank_verified, FALSE)
                 THEN jsonb_build_object(
                        'name', v_settings.bank_name,
                        'accountName', v_settings.bank_account_name,
                        'accountNumber', v_settings.bank_account_number)
                 ELSE NULL END,
    'config', public.api_config()
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7d. Payment-proof submission, authorising the *owner* or the order token
--     Customers can never mark a payment verified here; the submission always
--     lands in 'payment_submitted' and waits for an administrator.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_submit_proof(
  p_ref        TEXT,
  p_token      TEXT DEFAULT '',
  p_reference  TEXT DEFAULT '',
  p_image_path TEXT DEFAULT '',
  p_note       TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref   TEXT := upper(btrim(coalesce(p_ref, '')));
  v_tok   TEXT := btrim(coalesce(p_token, ''));
  v_pay   TEXT := btrim(coalesce(p_reference, ''));
  v_img   TEXT := btrim(coalesce(p_image_path, ''));
  v_note  TEXT := left(btrim(coalesce(p_note, '')), 200);
  v_uid   UUID := auth.uid();
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  -- Same model as api_order: an account-owned order is only reachable by that
  -- account (or an administrator); guest orders are reachable by token.
  IF NOT (
       (v_uid IS NOT NULL AND v_order.customer_id = v_uid)
       OR (
            (v_uid IS NULL OR v_order.customer_id IS NULL)
            AND v_tok <> '' AND v_tok = v_order.token
          )
     ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'token',
      'error', 'Unauthorised payment submission: invalid order token or account.');
  END IF;

  IF v_order.order_status IN ('cancelled', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'order_closed',
      'error', 'Payment details cannot be submitted for a closed order.');
  END IF;

  IF v_order.payment_method IN ('cash_on_delivery', 'cash_on_pickup') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_applicable',
      'error', 'Cash orders do not accept advance payment proof submissions.');
  END IF;

  IF v_order.payment_status = 'payment_verified' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'already_verified',
      'error', 'Payment for this order has already been verified and confirmed.');
  END IF;

  IF v_order.payment_status = 'payment_submitted'
     OR (v_order.proof_locked = TRUE AND v_order.payment_status <> 'payment_rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_submission',
      'error', 'Payment details have already been submitted and are awaiting verification.');
  END IF;

  IF v_pay = '' AND v_img = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'missing_proof',
      'error', 'Please provide your payment transaction reference, a screenshot, or both.');
  END IF;

  IF v_pay <> '' AND (char_length(v_pay) < 4 OR char_length(v_pay) > 80
                      OR v_pay !~ '^[A-Za-z0-9\-_./#: ]{4,80}$') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_reference',
      'error', 'Transaction reference must be 4 to 80 alphanumeric characters.');
  END IF;

  IF v_pay <> '' AND (
       EXISTS (SELECT 1 FROM public.payment_submissions s
                WHERE upper(btrim(s.reference)) = upper(v_pay))
    OR EXISTS (SELECT 1 FROM public.orders o
                WHERE o.ref <> v_order.ref
                  AND o.payment_status IN ('payment_submitted', 'payment_verified')
                  AND upper(btrim(o.payment_ref)) = upper(v_pay))
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_reference',
      'error', 'That payment transaction reference has already been submitted.');
  END IF;

  INSERT INTO public.payment_submissions (order_ref, reference, image_path, note, status)
  VALUES (v_order.ref, v_pay, v_img, v_note, 'pending_verification');

  UPDATE public.orders
     SET payment_ref = CASE WHEN v_pay <> '' THEN v_pay ELSE payment_ref END,
         has_proof = CASE WHEN v_img <> '' THEN TRUE ELSE has_proof END,
         proof_path = CASE WHEN v_img <> '' THEN v_img ELSE proof_path END,
         proof_note = v_note,
         payment_status = 'payment_submitted',
         proof_locked = TRUE,
         proof_submitted_at = NOW(),
         submission_count = submission_count + 1
   WHERE ref = v_order.ref
  RETURNING * INTO v_order;

  UPDATE public.payments
     SET transaction_reference = CASE WHEN v_pay <> '' THEN v_pay ELSE transaction_reference END,
         proof_image_path = CASE WHEN v_img <> '' THEN v_img ELSE proof_image_path END,
         customer_note = v_note,
         verification_status = 'payment_submitted',
         submitted_at = NOW(),
         updated_at = NOW()
   WHERE order_ref = v_order.ref;

  UPDATE public.class_bookings
     SET payment_status = 'payment_submitted', updated_at = NOW()
   WHERE booking_ref = v_order.ref;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order', jsonb_build_object(
      'ref', v_order.ref,
      'kind', v_order.kind,
      'paymentStatus', v_order.payment_status,
      'orderStatus', v_order.order_status,
      'paymentRef', v_order.payment_ref,
      'hasProof', v_order.has_proof,
      'proofLocked', v_order.proof_locked,
      'proofSubmittedAt', v_order.proof_submitted_at
    )
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_submission',
      'error', 'Duplicate payment submission or reference detected and blocked.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_customer_whoami() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_customer_update_profile(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_customer_orders() TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_place_order(TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_update_order(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_order(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_submit_proof(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- [COMMIT removed: the combined script has one outer transaction]


-- =============================================================================
-- FILE 3 of 6 — 20261024_public_read_layer.sql
-- Public read RPCs: api_config, api_catalogue, api_price
-- =============================================================================

-- =============================================================================
-- Mystery Bakebite — Public Read Layer (config & catalogue)
-- Target: Supabase PostgreSQL 15+
--
-- WHY THIS EXISTS
--   The browser calls three read-only RPCs that were never defined in any
--   migration in this repository:
--
--       /api/config     -> public.api_config()      (every page)
--       /api/catalogue  -> public.api_catalogue()   (menu, products, classes,
--                                                    cart, cake builder, booking)
--       /api/price      -> public.api_price(...)    (checkout preview only)
--
--   Against a fresh Supabase project these return
--   `PGRST202 ... could not find the function`, so:
--     * checkout cannot render the MoMo / bank instructions,
--     * menu, products, classes and the cake builder cannot list anything,
--     * classes.html shows "Courses could not be loaded".
--
--   They worked before only because the local fallback in assets/js/supabase.js
--   implements them in JavaScript. That is why the test suite passed: it runs
--   against the local database, not against Postgres.
--
--   This migration implements api_config() and api_catalogue() -- the two that
--   block the storefront -- plus api_price() for product and class carts.
--
-- SECURITY
--   Both functions are SECURITY DEFINER because public.settings has no SELECT
--   grant for `anon`. They expose only fields that are meant to be public:
--   payment details, discount percentages, preparation lead times. They never
--   return a token, an order, a customer or any administrator record.
-- =============================================================================

-- [BEGIN removed: the combined script has one outer transaction]

-- -----------------------------------------------------------------------------
-- 1. public.api_config()
--    Mirrors buildPublicConfig() in assets/js/supabase.js so the browser sees
--    exactly the same shape from Postgres as it does from the local fallback.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_config()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH s AS (
    -- LEFT JOIN keeps this returning a usable default even on a database where
    -- the settings row has not been seeded yet; every field below is coalesced.
    SELECT st.* FROM (SELECT 1 AS one) d
    LEFT JOIN public.settings st ON st.id = 1
  )
  SELECT jsonb_build_object(
    'ok', TRUE,
    'config', jsonb_build_object(
      -- The public WhatsApp line. settings.whatsapp_number may be the baker's
      -- private alert number, so only expose it once it is explicitly set.
      'whatsapp', coalesce(nullif(btrim(s.whatsapp_number), ''), ''),
      'bundle_two_pct',   coalesce(s.bundle_two_pct, 15),
      'bundle_three_pct', coalesce(s.bundle_three_pct, 25),
      -- Older rows stored the threshold in cedis (700); normalise to pesewas.
      'advance_threshold',
        CASE
          WHEN s.advance_threshold IS NULL OR s.advance_threshold <= 0 THEN 70000
          WHEN s.advance_threshold < 1000 THEN round(s.advance_threshold * 100)
          ELSE s.advance_threshold
        END,
      'cash', jsonb_build_object(
        'delivery', coalesce(s.cash_delivery_enabled, TRUE),
        'pickup',   coalesce(s.cash_pickup_enabled, TRUE)
      ),
      'momo', CASE
        WHEN coalesce(s.momo_verified, FALSE)
             AND coalesce(btrim(s.momo_name), '')   <> ''
             AND coalesce(btrim(s.momo_number), '') <> ''
        THEN jsonb_build_object(
               'name',     s.momo_name,
               'number',   s.momo_number,
               'provider', coalesce(nullif(btrim(s.momo_provider), ''), 'MTN MoMo'),
               'note',     coalesce(s.momo_note, '')
             )
        ELSE NULL::jsonb
      END,
      'bank', CASE
        WHEN coalesce(s.bank_verified, FALSE)
             AND coalesce(btrim(s.bank_name), '')           <> ''
             AND coalesce(btrim(s.bank_account_name), '')   <> ''
             AND coalesce(btrim(s.bank_account_number), '') <> ''
        THEN jsonb_build_object(
               'name',          s.bank_name,
               'accountName',   s.bank_account_name,
               'accountNumber', s.bank_account_number
             )
        ELSE NULL::jsonb
      END,
      -- Per-SKU discount and preparation lead times, so the browser can show a
      -- price preview that agrees with what api_place_order will charge.
      'product_discounts', coalesce((
        SELECT jsonb_object_agg(p.sku, p.discount_pct)
        FROM public.products p
        WHERE coalesce(p.discount_pct, 0) > 0
      ), '{}'::jsonb),
      'product_prep_days', coalesce((
        SELECT jsonb_object_agg(p.sku, p.prep_days)
        FROM public.products p
      ), '{}'::jsonb)
    )
  )
  FROM s;
$$;

-- -----------------------------------------------------------------------------
-- 2. public.api_catalogue()
--    Every field is returned in camelCase because that is what the browser
--    reads (p.prepDays, p.discountPct, c.levelLabel).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_catalogue()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'ok', TRUE,

    'categories', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'slug',      c.slug,
        'name',      c.name,
        'intro',     c.intro,
        'published', c.published,
        'sortOrder', c.sort_order
      ) ORDER BY c.sort_order, c.slug)
      FROM public.categories c
      WHERE c.published IS NOT FALSE
    ), '[]'::jsonb),

    'products', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'sku',         p.sku,
        'name',        p.name,
        'category',    p.category,
        'price',       p.price,          -- NULL means "quoted on request"
        'discountPct', coalesce(p.discount_pct, 0),
        'prepDays',    coalesce(p.prep_days, 0),
        'meta',        p.meta,
        'description', p.description,
        'image',       p.image,
        'published',   p.published
      ) ORDER BY p.category, p.sku)
      FROM public.products p
      WHERE p.published IS NOT FALSE
    ), '[]'::jsonb),

    'classes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'slug',        k.slug,
        'track',       k.track,
        'level',       k.level,
        'levelLabel',  k.level_label,
        'name',        k.name,
        'summary',     k.summary,
        'description', k.description,
        'fee',         k.fee,
        'hours',       k.hours,
        'schedule',    k.schedule,
        'recipes',     k.recipes,
        'skills',      k.skills,
        'provided',    k.provided,
        'bring',       k.bring,
        'prereq',      k.prereq,
        'published',   k.published
      ) ORDER BY k.track, k.level)
      FROM public.classes k
      WHERE k.published IS NOT FALSE
    ), '[]'::jsonb),

    -- Cake builder options, grouped by kind:
    --   { "size": [{key,label,price}], "decor": [{key,label,charges:{...}}], ... }
    'options', coalesce((
      SELECT jsonb_object_agg(o.kind, o.items)
      FROM (
        SELECT
          co.kind,
          jsonb_agg(
            jsonb_build_object('key', co.key, 'label', co.label) || coalesce(co.payload, '{}'::jsonb)
            ORDER BY co.key
          ) AS items
        FROM public.cake_options co
        GROUP BY co.kind
      ) o
    ), '{}'::jsonb),

    'config', (public.api_config())->'config'
  );
$$;

-- -----------------------------------------------------------------------------
-- 3. public.api_price()
--    A PREVIEW only. api_place_order recomputes every price from the catalogue
--    at submission time and is the sole authority on what is charged.
--
--    Deliberately conservative: a cart containing a custom cake is answered with
--    ok = false ('unsupported') rather than an approximate number. The checkout
--    page treats ok = false as "keep using the locally computed preview", so the
--    customer never sees a figure that might differ from the agreed total.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_price(
  p_type  TEXT DEFAULT 'product',
  p_items JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind      TEXT := CASE WHEN lower(coalesce(p_type, 'product')) = 'class' THEN 'class' ELSE 'product' END;
  v_raw       JSONB := coalesce(p_items->'items', p_items->'classes', '[]'::jsonb);
  v_item      JSONB;
  v_subtotal  INTEGER := 0;
  v_discount  INTEGER := 0;
  v_count     INTEGER := 0;
  v_qty       INTEGER;
  v_id        TEXT;
  v_price     INTEGER;
  v_pct       INTEGER;
  v_prep      INTEGER;
  v_max_prep  INTEGER := 0;
  v_settings  public.settings%ROWTYPE;
  v_lines     JSONB := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(v_raw) <> 'array' OR jsonb_array_length(v_raw) = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'empty_cart', 'error', 'Your cart is empty.');
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_raw) LOOP

    -- A custom cake has no catalogue price; refuse rather than invent one.
    IF v_item ? 'spec' OR v_item ? 'custom' THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'unsupported',
        'error', 'Custom cake pricing is confirmed by the baker.');
    END IF;

    v_qty := coalesce((v_item->>'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 100 THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_quantity',
        'error', 'Item quantity must be a whole number between 1 and 100.');
    END IF;

    IF v_kind = 'class' THEN
      v_id := btrim(coalesce(v_item->>'slug', v_item->>'id', ''));
      SELECT k.fee INTO v_price
      FROM public.classes k
      WHERE k.slug = v_id AND k.published IS NOT FALSE;
      IF v_price IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_class',
          'error', 'Unknown or unavailable class: ' || coalesce(v_id, 'unknown'));
      END IF;
      v_prep := 0;   -- classes carry no preparation lead time
      v_count := v_count + 1;
    ELSE
      v_id := btrim(coalesce(v_item->>'sku', v_item->>'id', ''));
      SELECT p.price, coalesce(p.discount_pct, 0), coalesce(p.prep_days, 0)
        INTO v_price, v_pct, v_prep
      FROM public.products p
      WHERE p.sku = v_id AND p.published IS NOT FALSE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_product',
          'error', 'Unknown or unavailable product: ' || coalesce(v_id, 'unknown'));
      END IF;
      -- NULL price = quoted on request; cannot be previewed.
      IF v_price IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'unsupported',
          'error', 'This item is quoted on request.');
      END IF;
      v_max_prep := greatest(v_max_prep, v_prep);
    END IF;

    v_subtotal := v_subtotal + (v_price * v_qty);

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id',        v_id,
      'qty',       v_qty,
      'unitPrice', v_price,
      'lineTotal', v_price * v_qty
    ));
  END LOOP;

  -- Class bundle discount applies only when 2 or more classes are selected.
  IF v_kind = 'class' AND v_count >= 2 THEN
    v_pct := CASE WHEN v_count >= 3
                  THEN coalesce(v_settings.bundle_three_pct, 25)
                  ELSE coalesce(v_settings.bundle_two_pct, 15) END;
    v_discount := round(v_subtotal * v_pct / 100.0)::INTEGER;
  END IF;

  RETURN jsonb_build_object(
    'ok',            TRUE,
    'subtotal',      v_subtotal,
    'discount',      v_discount,
    'total',         greatest(0, v_subtotal - v_discount),
    'has_quote',     FALSE,
    'bundles',       CASE WHEN v_discount > 0
                          THEN jsonb_build_array(jsonb_build_object('pct', v_pct))
                          ELSE '[]'::jsonb END,
    'items',         v_lines,
    'max_prep_days', v_max_prep,
    'earliest_date', to_char(current_date + v_max_prep, 'YYYY-MM-DD')
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Grants
--    These are read-only, public-by-design functions. Nothing here can read an
--    order, a customer or an administrator.
-- -----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.api_config()                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_catalogue()              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_price(TEXT, JSONB)       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.api_config()            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_catalogue()         TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_price(TEXT, JSONB)  TO anon, authenticated;

-- [COMMIT removed: the combined script has one outer transaction]


-- =============================================================================
-- FILE 4 of 6 — 20261025_admin_and_lookup_rpcs.sql
-- Dashboard RPCs and order lookup
-- =============================================================================

-- =============================================================================
-- Mystery Bakebite — Administrator & Order-Lookup RPCs
-- Target: Supabase PostgreSQL 15+
--
-- WHY THIS EXISTS
--   The admin dashboard and the "find my order" form call these RPCs, none of
--   which existed in any earlier migration:
--
--       api_lookup_order          order.html — find an order by ref + phone
--       api_admin_orders          dashboard order list
--       api_admin_order           single order
--       api_admin_dashboard       dashboard KPIs, chart series, attention list
--       api_admin_settings        payment details & business rules (read/write)
--       api_admin_catalogue       catalogue read for the admin panels
--       api_admin_discounts       product & class discount control
--       api_admin_notifications   baker-alert outbox view
--       api_admin_product         product create / update / delete
--       api_admin_class           class   create / update / delete
--       api_admin_category        category create / update / delete
--       api_admin_option          cake builder option pricing
--
--   Without them the dashboard could list nothing and no payment could ever be
--   approved, because nothing could be seen to approve.
--
-- AUTHORISATION
--   Every api_admin_* function begins with a has_admin_permission() gate:
--     orders / verify   -> order list, single order, dashboard
--     settings          -> payment details & rules
--     catalogue         -> products, classes, categories, options, discounts
--   api_lookup_order is public but needs BOTH the exact reference and the phone
--   number used on the order.
--
-- SHAPE
--   The browser reads a mix of camelCase (paymentStatus, orderStatus,
--   eventDate) and snake_case (payment_status, order_status, customer_name), so
--   order objects are serialised with BOTH. That is not cosmetic: order.js
--   reads camelCase and admin.js reads both.
-- =============================================================================

-- [BEGIN removed: the combined script has one outer transaction]

-- -----------------------------------------------------------------------------
-- 0. Shared order serialiser
--    Never exposes the order token: administrators act through the RPCs, and
--    the token is the customer's capability to prove ownership.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.order_admin_json(o public.orders)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'ref',            o.ref,
    'kind',           o.kind,
    'customerId',     o.customer_id,
    'customer_id',    o.customer_id,
    'customerName',   o.customer_name,
    'customer_name',  o.customer_name,
    'phone',          o.phone,
    'email',          o.email,
    'fulfilment',     o.fulfilment,
    'address',        o.address,
    'eventDate',      o.event_date,
    'event_date',     o.event_date,
    'paymentMethod',  o.payment_method,
    'payment_method', o.payment_method,
    'paymentStatus',  o.payment_status,
    'payment_status', o.payment_status,
    'orderStatus',    o.order_status,
    'order_status',   o.order_status,
    'subtotal',       o.subtotal,
    'discount',       o.discount,
    'total',          o.total,
    'hasUnpriced',    o.has_unpriced,
    'has_unpriced',   o.has_unpriced,
    'advanceRequired',  o.advance_required,
    'advance_required', o.advance_required,
    'items',          o.items,
    'bundles',        o.bundles,
    'notes',          o.notes,
    'paymentRef',     o.payment_ref,
    'payment_ref',    o.payment_ref,
    'hasProof',       o.has_proof,
    'has_proof',      o.has_proof,
    'proofPath',      o.proof_path,
    'proof_path',     o.proof_path,
    'proofNote',      o.proof_note,
    'proof_note',     o.proof_note,
    'proofLocked',    o.proof_locked,
    'proof_locked',   o.proof_locked,
    'proofSubmittedAt',  o.proof_submitted_at,
    'proof_submitted_at', o.proof_submitted_at,
    'submissionCount',   o.submission_count,
    'submission_count',  o.submission_count,
    'rejectReason',   o.reject_reason,
    'reject_reason',  o.reject_reason,
    'verifiedAt',     o.verified_at,
    'verified_at',    o.verified_at,
    'verifiedBy',     o.verified_by,
    'verified_by',    o.verified_by,
    'notifiedAt',     o.notified_at,
    'notified_at',    o.notified_at,
    'events',         o.events,
    'createdAt',      o.created_at,
    'created_at',     o.created_at,
    'updatedAt',      o.updated_at,
    'updated_at',     o.updated_at
  );
$$;

-- -----------------------------------------------------------------------------
-- 1. api_lookup_order — "find my order" on order.html
--    Requires the exact reference AND the phone number on the order. Returns the
--    order token so the customer can open the order page, which is the same
--    capability a guest receives on the confirmation screen.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_lookup_order(
  p_ref   TEXT,
  p_phone TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref   TEXT := upper(btrim(coalesce(p_ref, '')));
  v_dig   TEXT := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_order public.orders%ROWTYPE;
  v_uid   UUID := auth.uid();
BEGIN
  IF v_ref !~ '^M[BC]-[A-Z0-9-]{4,20}$' THEN
    RETURN jsonb_build_object('ok', FALSE,
      'error', 'Please enter a valid order or booking reference (e.g. MB-123456).');
  END IF;

  IF char_length(v_dig) < 7 THEN
    RETURN jsonb_build_object('ok', FALSE,
      'error', 'Please enter the phone number used when placing the order.');
  END IF;

  SELECT * INTO v_order
  FROM public.orders o
  WHERE o.ref = v_ref
    AND regexp_replace(o.phone, '\D', '', 'g') = v_dig;

  IF NOT FOUND THEN
    -- The reference space is small and this function is callable by anon, so a
    -- failed attempt costs fractionally slow time. That makes blind enumeration
    -- of references impractical without needing a throttle table.
    PERFORM pg_sleep(0.35);
    RETURN jsonb_build_object('ok', FALSE,
      'error', 'We could not find an order matching that reference and phone number.');
  END IF;

  -- A signed-in customer must not be able to pivot into another account's order.
  IF v_order.customer_id IS NOT NULL
     AND v_uid IS NOT NULL
     AND v_order.customer_id <> v_uid
     AND NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'forbidden',
      'error', 'Access denied: that order belongs to a different customer account.');
  END IF;

  RETURN jsonb_build_object(
    'ok',        TRUE,
    'ref',       v_order.ref,
    'kind',      v_order.kind,
    'token',     v_order.token,
    'statusUrl', 'order.html?ref=' || v_order.ref || '&token=' || v_order.token,
    'order',     public.order_admin_json(v_order)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. api_admin_orders — filtered order list
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_orders(
  p_kind    TEXT    DEFAULT '',
  p_status  TEXT    DEFAULT '',
  p_payment TEXT    DEFAULT '',
  p_q       TEXT    DEFAULT '',
  p_limit   INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_q      TEXT := lower(btrim(coalesce(p_q, '')));
  v_limit  INTEGER := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_rows   JSONB;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator order-management permission required.');
  END IF;

  SELECT coalesce(jsonb_agg(public.order_admin_json(o) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT *
    FROM public.orders o
    WHERE (coalesce(p_kind, '')    = '' OR o.kind           = p_kind)
      AND (coalesce(p_status, '')  = '' OR o.order_status   = p_status)
      AND (coalesce(p_payment, '') = '' OR o.payment_status = p_payment)
      AND (
            v_q = ''
            OR lower(o.ref) LIKE '%' || v_q || '%'
            OR lower(o.customer_name) LIKE '%' || v_q || '%'
            OR lower(o.phone) LIKE '%' || v_q || '%'
          )
    ORDER BY o.created_at DESC
    LIMIT v_limit
  ) o;

  RETURN jsonb_build_object('ok', TRUE, 'orders', v_rows);
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. api_admin_order — single order
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_order(p_ref TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref   TEXT := upper(btrim(coalesce(p_ref, '')));
  v_order public.orders%ROWTYPE;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator order-management permission required.');
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'order', public.order_admin_json(v_order));
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. api_admin_dashboard — KPIs, 7/14/30-day series, attention list
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_dashboard(p_days INTEGER DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days     INTEGER := least(greatest(coalesce(p_days, 7), 1), 90);
  v_start    DATE := current_date - (v_days - 1);
  v_prev_start DATE := current_date - (v_days * 2) + 1;
  v_settings public.settings%ROWTYPE;
  v_revenue      INTEGER := 0;
  v_rev_prev     INTEGER := 0;
  v_orders       INTEGER := 0;
  v_orders_prev  INTEGER := 0;
  v_units        INTEGER := 0;
  v_units_prev   INTEGER := 0;
  v_new_cust     INTEGER := 0;
  v_new_cust_prev INTEGER := 0;
  v_series       JSONB;
  v_cats         JSONB;
  v_attention    JSONB;
  v_top          JSONB;
  v_class_bookings INTEGER := 0;
  v_class_rev      INTEGER := 0;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator order-management permission required.');
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;

  -- Current window
  SELECT coalesce(sum(total), 0), count(*),
         coalesce(sum((SELECT coalesce(sum((it->>'qty')::INTEGER), 0)
                       FROM jsonb_array_elements(o.items) it)), 0),
         count(DISTINCT nullif(o.phone, ''))
  INTO v_revenue, v_orders, v_units, v_new_cust
  FROM public.orders o
  WHERE o.created_at >= v_start;

  -- Previous window of the same length, for the percentage deltas
  SELECT coalesce(sum(total), 0), count(*),
         coalesce(sum((SELECT coalesce(sum((it->>'qty')::INTEGER), 0)
                       FROM jsonb_array_elements(o.items) it)), 0),
         count(DISTINCT nullif(o.phone, ''))
  INTO v_rev_prev, v_orders_prev, v_units_prev, v_new_cust_prev
  FROM public.orders o
  WHERE o.created_at >= v_prev_start AND o.created_at < v_start;

  -- Daily series, zero-filled so the chart never has gaps
  SELECT jsonb_agg(jsonb_build_object(
           'date',         to_char(d, 'YYYY-MM-DD'),
           'label',        to_char(d, 'Dy'),
           'orders',       coalesce(agg.orders, 0),
           'units',        coalesce(agg.units, 0),
           'revenue',      coalesce(agg.revenue, 0),
           'newCustomers', coalesce(agg.new_customers, 0)
         ) ORDER BY d)
  INTO v_series
  FROM generate_series(v_start, current_date, INTERVAL '1 day') AS g(d)
  LEFT JOIN LATERAL (
    SELECT count(*) AS orders,
           coalesce(sum((SELECT coalesce(sum((it->>'qty')::INTEGER), 0)
                         FROM jsonb_array_elements(o.items) it)), 0) AS units,
           coalesce(sum(o.total), 0) AS revenue,
           count(DISTINCT nullif(o.phone, '')) AS new_customers
    FROM public.orders o
    WHERE o.created_at >= g.d AND o.created_at < g.d + INTERVAL '1 day'
  ) agg ON TRUE;

  -- Orders needing a human: unconfirmed, or payment evidence waiting
  SELECT coalesce(jsonb_agg(public.order_admin_json(o) ORDER BY o.created_at ASC), '[]'::jsonb)
  INTO v_attention
  FROM (
    SELECT * FROM public.orders
    WHERE order_status = 'submitted' OR payment_status = 'payment_submitted'
    ORDER BY created_at ASC
    LIMIT 20
  ) o;

  -- Best sellers inside the window
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name',  t.name,
           'units', t.units,
           'revenue', t.revenue
         ) ORDER BY t.units DESC), '[]'::jsonb)
  INTO v_top
  FROM (
    SELECT coalesce(it->>'name', it->>'sku', 'Item') AS name,
           sum(coalesce((it->>'qty')::INTEGER, 0)) AS units,
           sum(coalesce((it->>'lineTotal')::INTEGER, 0)) AS revenue
    FROM public.orders o,
         LATERAL jsonb_array_elements(o.items) it
    WHERE o.created_at >= v_start
    GROUP BY 1
    ORDER BY units DESC
    LIMIT 8
  ) t;

  SELECT coalesce(jsonb_agg(jsonb_build_object('category', cat, 'revenue', rev) ORDER BY rev DESC), '[]'::jsonb)
  INTO v_cats
  FROM (
    SELECT coalesce(p.category, 'other') AS cat,
           sum(coalesce((it->>'lineTotal')::INTEGER, 0)) AS rev
    FROM public.orders o,
         LATERAL jsonb_array_elements(o.items) it
    LEFT JOIN public.products p ON p.sku = it->>'sku'
    WHERE o.created_at >= v_start AND it ? 'sku'
    GROUP BY 1
  ) c;

  SELECT count(*), coalesce(sum(total), 0)
  INTO v_class_bookings, v_class_rev
  FROM public.orders
  WHERE kind = 'class';

  RETURN jsonb_build_object(
    'ok', TRUE,
    'window', jsonb_build_object('days', v_days, 'from', to_char(v_start, 'YYYY-MM-DD')),
    'paymentConfigured', (coalesce(v_settings.momo_verified, FALSE) AND coalesce(btrim(v_settings.momo_number), '') <> '')
                      OR (coalesce(v_settings.bank_verified, FALSE) AND coalesce(btrim(v_settings.bank_account_number), '') <> ''),
    'salesTotal', v_revenue,
    'stats', jsonb_build_object(
      'toConfirm',      (SELECT count(*) FROM public.orders WHERE order_status = 'submitted'),
      'proofsToReview', (SELECT count(*) FROM public.orders WHERE payment_status = 'payment_submitted'),
      'awaitingPayment',(SELECT count(*) FROM public.orders WHERE payment_status = 'awaiting_payment'),
      'newToday',       (SELECT count(*) FROM public.orders WHERE created_at >= current_date)
    ),
    'kpis', jsonb_build_object(
      'revenue',      jsonb_build_object('value', v_revenue,   'previous', v_rev_prev,      'pct', public.pct_change(v_revenue, v_rev_prev)),
      'orders',       jsonb_build_object('value', v_orders,    'previous', v_orders_prev,   'pct', public.pct_change(v_orders, v_orders_prev)),
      'units',        jsonb_build_object('value', v_units,     'previous', v_units_prev,    'pct', public.pct_change(v_units, v_units_prev)),
      'newCustomers', jsonb_build_object('value', v_new_cust,  'previous', v_new_cust_prev, 'pct', public.pct_change(v_new_cust, v_new_cust_prev))
    ),
    'series',     v_series,
    'categories', v_cats,
    'attention',  v_attention,
    'activity',   coalesce((
      SELECT jsonb_agg(ev ORDER BY ev->>'at' DESC)
      FROM (
        SELECT e.ev
        FROM public.orders o, LATERAL jsonb_array_elements(o.events) e(ev)
        ORDER BY o.created_at DESC
        LIMIT 12
      ) x
    ), '[]'::jsonb),
    'topProducts', v_top,
    'classes', jsonb_build_object(
      'bookings', v_class_bookings,
      'revenue',  v_class_rev,
      'tracks', jsonb_build_object(
        'bread',  (SELECT count(*) FROM public.orders o, LATERAL jsonb_array_elements(o.items) it
                    WHERE o.kind = 'class' AND it->>'slug' LIKE 'bread-%'),
        'pastry', (SELECT count(*) FROM public.orders o, LATERAL jsonb_array_elements(o.items) it
                    WHERE o.kind = 'class' AND it->>'slug' LIKE 'pastry-%')
      ),
      'published', (SELECT count(*) FROM public.classes WHERE published IS NOT FALSE)
    ),
    'customers', jsonb_build_object(
      'total',  (SELECT count(*) FROM public.customer_profiles),
      'repeat', (SELECT count(*) FROM (
                   SELECT phone FROM public.orders GROUP BY phone HAVING count(*) > 1
                 ) r),
      'top', coalesce((
        SELECT jsonb_agg(jsonb_build_object('name', name, 'phone', phone, 'orders', n, 'revenue', rev) ORDER BY rev DESC)
        FROM (
          SELECT max(customer_name) AS name, phone, count(*) AS n, sum(total) AS rev
          FROM public.orders GROUP BY phone ORDER BY rev DESC LIMIT 5
        ) t
      ), '[]'::jsonb)
    ),
    'channels', jsonb_build_object(
      'momo',         coalesce(v_settings.momo_verified, FALSE),
      'bank',         coalesce(v_settings.bank_verified, FALSE),
      'cashDelivery', coalesce(v_settings.cash_delivery_enabled, FALSE),
      'cashPickup',   coalesce(v_settings.cash_pickup_enabled, FALSE),
      'threshold',    coalesce(v_settings.advance_threshold, 70000)
    ),
    'catalogue', jsonb_build_object(
      'productsPublished', (SELECT count(*) FROM public.products WHERE published IS NOT FALSE),
      'productsHidden',    (SELECT count(*) FROM public.products WHERE published = FALSE),
      'quoteOnly',         (SELECT count(*) FROM public.products WHERE price IS NULL),
      'categories',        (SELECT count(*) FROM public.categories WHERE published IS NOT FALSE),
      'classesPublished',  (SELECT count(*) FROM public.classes WHERE published IS NOT FALSE)
    )
  );
END;
$$;

-- Helper for the KPI deltas (NULL when there is no previous figure to divide by)
CREATE OR REPLACE FUNCTION public.pct_change(p_now INTEGER, p_prev INTEGER)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_prev IS NULL OR p_prev = 0 THEN NULL::NUMERIC
    ELSE round(((p_now - p_prev)::NUMERIC / p_prev) * 100, 1)
  END;
$$;

-- -----------------------------------------------------------------------------
-- 5. api_admin_settings — read and update payment details & business rules
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_settings(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p       JSONB := coalesce(p_payload, '{}'::jsonb);
  v_int     INTEGER;
  v_bool    BOOLEAN;
BEGIN
  IF NOT public.has_admin_permission('settings') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator settings permission required.');
  END IF;

  IF v_p <> '{}'::jsonb THEN

    -- Mobile Money
    IF v_p ? 'momo_name'     THEN UPDATE public.settings SET momo_name     = left(btrim(coalesce(v_p->>'momo_name', '')), 120)     WHERE id = 1; END IF;
    IF v_p ? 'momo_number'   THEN UPDATE public.settings SET momo_number   = left(btrim(coalesce(v_p->>'momo_number', '')), 40)    WHERE id = 1; END IF;
    IF v_p ? 'momo_provider' THEN UPDATE public.settings SET momo_provider = left(btrim(coalesce(v_p->>'momo_provider', '')), 80)  WHERE id = 1; END IF;
    IF v_p ? 'momo_note'     THEN UPDATE public.settings SET momo_note     = left(btrim(coalesce(v_p->>'momo_note', '')), 200)     WHERE id = 1; END IF;

    -- Bank
    IF v_p ? 'bank_name'           THEN UPDATE public.settings SET bank_name           = left(btrim(coalesce(v_p->>'bank_name', '')), 120)           WHERE id = 1; END IF;
    IF v_p ? 'bank_account_name'   THEN UPDATE public.settings SET bank_account_name   = left(btrim(coalesce(v_p->>'bank_account_name', '')), 120)   WHERE id = 1; END IF;
    IF v_p ? 'bank_account_number' THEN UPDATE public.settings SET bank_account_number = left(btrim(coalesce(v_p->>'bank_account_number', '')), 60) WHERE id = 1; END IF;

    -- Verified flags arrive as '1'/'0' strings from checkboxes
    IF v_p ? 'momo_verified' THEN
      v_bool := public.as_bool(v_p->>'momo_verified');
      UPDATE public.settings SET momo_verified = v_bool WHERE id = 1;
    END IF;
    IF v_p ? 'bank_verified' THEN
      v_bool := public.as_bool(v_p->>'bank_verified');
      UPDATE public.settings SET bank_verified = v_bool WHERE id = 1;
    END IF;

    -- Cash channels
    IF v_p ? 'cash_delivery_enabled' THEN
      v_bool := public.as_bool(v_p->>'cash_delivery_enabled');
      UPDATE public.settings SET cash_delivery_enabled = v_bool WHERE id = 1;
    END IF;
    IF v_p ? 'cash_pickup_enabled' THEN
      v_bool := public.as_bool(v_p->>'cash_pickup_enabled');
      UPDATE public.settings SET cash_pickup_enabled = v_bool WHERE id = 1;
    END IF;

    IF v_p ? 'auto_confirm_on_verified_payment' THEN
      v_bool := public.as_bool(v_p->>'auto_confirm_on_verified_payment');
      UPDATE public.settings SET auto_confirm = v_bool WHERE id = 1;
    END IF;

    -- Advance threshold. The admin form sends cedis; anything under 1000 is
    -- treated as cedis and converted, so both units are accepted safely.
    IF v_p ? 'advance_threshold' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'advance_threshold'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 100000000 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_threshold',
          'error', 'The advance threshold must be a positive amount.');
      END IF;
      IF v_int > 0 AND v_int < 1000 THEN
        v_int := v_int * 100;
      END IF;
      UPDATE public.settings SET advance_threshold = v_int WHERE id = 1;
    END IF;

    -- Bundle percentages (class discounts)
    IF v_p ? 'bundle_two_pct' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'bundle_two_pct'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 90 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_pct',
          'error', 'The two-class discount must be between 0% and 90%.');
      END IF;
      UPDATE public.settings SET bundle_two_pct = v_int WHERE id = 1;
    END IF;
    IF v_p ? 'bundle_three_pct' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'bundle_three_pct'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 90 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_pct',
          'error', 'The three-class discount must be between 0% and 90%.');
      END IF;
      UPDATE public.settings SET bundle_three_pct = v_int WHERE id = 1;
    END IF;

    -- WhatsApp number for baker alerts
    IF v_p ? 'whatsapp_number' THEN
      UPDATE public.settings
      SET whatsapp_number = regexp_replace(coalesce(v_p->>'whatsapp_number', ''), '\D', '', 'g')
      WHERE id = 1;
    END IF;

    UPDATE public.settings SET updated_at = NOW() WHERE id = 1;
  END IF;

  RETURN jsonb_build_object(
    'ok',       TRUE,
    'settings', (SELECT to_jsonb(s) FROM public.settings s WHERE s.id = 1),
    'config',   (public.api_config())->'config'
  );
END;
$$;

-- '1' / '0' / 'true' / 'false' / booleans all arrive as text from the form
CREATE OR REPLACE FUNCTION public.as_bool(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(btrim(coalesce(p_value, ''))) IN ('1', 'true', 't', 'yes', 'on');
$$;

-- -----------------------------------------------------------------------------
-- 6. api_admin_catalogue — everything the admin panels render
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_catalogue()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prods JSONB;
  v_cats  JSONB;
BEGIN
  -- The dashboard uses this for several panels, two of which need only 'view'.
  IF NOT (public.has_admin_permission('catalogue') OR public.has_admin_permission('view')) THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator permission required.');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'sku',         p.sku,
           'name',        p.name,
           'category',    p.category,
           'price',       p.price,
           'discountPct', p.discount_pct,
           'prepDays',    p.prep_days,
           'meta',        p.meta,
           'description', p.description,
           'image',       p.image,
           'published',   p.published
         ) ORDER BY p.category, p.sku), '[]'::jsonb)
  INTO v_prods
  FROM public.products p;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'slug',      c.slug,
           'name',      c.name,
           'intro',     c.intro,
           'published', c.published,
           'sortOrder', c.sort_order,
           'products',  coalesce((
             SELECT jsonb_agg(jsonb_build_object('sku', p.sku, 'name', p.name, 'price', p.price, 'published', p.published)
                              ORDER BY p.sku)
             FROM public.products p WHERE p.category = c.slug
           ), '[]'::jsonb)
         ) ORDER BY c.sort_order, c.slug), '[]'::jsonb)
  INTO v_cats
  FROM public.categories c;

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'categories', v_cats,
    'products',   v_prods,
    'classes',    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'slug', k.slug, 'track', k.track, 'level', k.level,
               'levelLabel', k.level_label, 'name', k.name, 'summary', k.summary,
               'fee', k.fee, 'hours', k.hours, 'schedule', k.schedule,
               'published', k.published
             ) ORDER BY k.track, k.level)
      FROM public.classes k
    ), '[]'::jsonb),
    'options', coalesce((
      SELECT jsonb_object_agg(o.kind, o.items)
      FROM (
        SELECT co.kind,
               jsonb_agg(jsonb_build_object('key', co.key, 'label', co.label) || coalesce(co.payload, '{}'::jsonb)
                         ORDER BY co.key) AS items
        FROM public.cake_options co GROUP BY co.kind
      ) o
    ), '{}'::jsonb),
    'settings', (SELECT to_jsonb(s) FROM public.settings s WHERE s.id = 1),
    'config',   (public.api_config())->'config'
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. api_admin_discounts — product and class discounts
--    Class discounts only ever apply when 2 or more classes are selected; that
--    rule is enforced where the order is priced, not here.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_discounts(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_pct  INTEGER;
  v_row  RECORD;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_p ? 'bundle_two_pct' THEN
    v_pct := round(coalesce(v_p->>'bundle_two_pct', '0')::NUMERIC);
    IF v_pct < 0 OR v_pct > 90 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error',
        'Two-class discount percentage must be between 0% and 90%.');
    END IF;
    UPDATE public.settings SET bundle_two_pct = v_pct, updated_at = NOW() WHERE id = 1;
  END IF;

  IF v_p ? 'bundle_three_pct' THEN
    v_pct := round(coalesce(v_p->>'bundle_three_pct', '0')::NUMERIC);
    IF v_pct < 0 OR v_pct > 90 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error',
        'Three-or-more class discount percentage must be between 0% and 90%.');
    END IF;
    UPDATE public.settings SET bundle_three_pct = v_pct, updated_at = NOW() WHERE id = 1;
  END IF;

  IF coalesce((v_p->>'clearAll')::BOOLEAN, FALSE) THEN
    UPDATE public.products SET discount_pct = 0;
  END IF;

  IF v_p ? 'category' AND v_p ? 'discountPct' THEN
    v_pct := greatest(0, least(90, round(coalesce(v_p->>'discountPct', '0')::NUMERIC)::INTEGER));
    IF v_p->>'category' = 'all' THEN
      UPDATE public.products SET discount_pct = v_pct;
    ELSE
      UPDATE public.products SET discount_pct = v_pct WHERE category = v_p->>'category';
    END IF;
  END IF;

  IF v_p ? 'sku' AND v_p ? 'discountPct' THEN
    v_pct := greatest(0, least(90, round(coalesce(v_p->>'discountPct', '0')::NUMERIC)::INTEGER));
    UPDATE public.products SET discount_pct = v_pct WHERE sku = v_p->>'sku';
  END IF;

  -- Bulk forms: {"products": {"milky-6": 10, ...}} or [{"sku":..,"discountPct":..}]
  IF v_p ? 'products' OR v_p ? 'product_discounts' THEN
    IF jsonb_typeof(coalesce(v_p->'products', v_p->'product_discounts')) = 'array' THEN
      FOR v_row IN
        SELECT * FROM jsonb_array_elements(coalesce(v_p->'products', v_p->'product_discounts'))
      LOOP
        IF v_row.value ? 'sku' THEN
          UPDATE public.products
          SET discount_pct = greatest(0, least(90, round(coalesce(v_row.value->>'discountPct', '0')::NUMERIC)::INTEGER))
          WHERE sku = v_row.value->>'sku';
        END IF;
      END LOOP;
    ELSE
      FOR v_row IN
        SELECT key, value FROM jsonb_each_text(coalesce(v_p->'products', v_p->'product_discounts'))
      LOOP
        UPDATE public.products
        SET discount_pct = greatest(0, least(90, round(coalesce(v_row.value, '0')::NUMERIC)::INTEGER))
        WHERE sku = v_row.key;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'config',     (public.api_config())->'config',
    'settings',   (SELECT to_jsonb(s) FROM public.settings s WHERE s.id = 1),
    'bundle',     jsonb_build_object(
                    'bundle_two_pct',   (SELECT bundle_two_pct   FROM public.settings WHERE id = 1),
                    'bundle_three_pct', (SELECT bundle_three_pct FROM public.settings WHERE id = 1)
                  ),
    'products',   (public.api_admin_catalogue())->'products',
    'classes',    (public.api_admin_catalogue())->'classes',
    'categories', (public.api_admin_catalogue())->'categories'
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. api_admin_notifications — the baker's alert outbox
--    There is no notifications table; the outbox is derived from orders and
--    orders.notified_at, which the notify-order function sets on success.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_notifications(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows JSONB;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator permission required.');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'order_ref',  o.ref,
           'channel',    'whatsapp_baker',
           'status',     CASE WHEN o.notified_at IS NOT NULL THEN 'sent' ELSE 'queued_no_credentials' END,
           'detail',     o.customer_name || ' · '
                         || coalesce((SELECT string_agg(
                                       coalesce(it->>'qty', '1') || '×' || coalesce(it->>'name', it->>'sku', 'item'),
                                       ', ')
                                     FROM jsonb_array_elements(o.items) it), 'no items'),
           'payload',    'New Order ' || o.ref || ' — ' || o.customer_name
                         || ' · ' || to_char(o.created_at, 'DD Mon HH24:MI'),
           'created_at', o.created_at,
           'notified_at', o.notified_at
         ) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM public.orders ORDER BY created_at DESC LIMIT 100
  ) o;

  RETURN jsonb_build_object('ok', TRUE, 'notifications', v_rows);
END;
$$;

-- -----------------------------------------------------------------------------
-- 9-12. Catalogue write RPCs — product / class / category / cake option
--        All take (p_method, p_payload) exactly as the admin panels send them.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_product(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_sku  TEXT := btrim(coalesce(v_p->>'sku', ''));
  v_price INTEGER;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'POST' THEN
    IF coalesce(btrim(v_p->>'name'), '') = '' OR coalesce(btrim(v_p->>'category'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A product needs a name and a category.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.categories WHERE slug = v_p->>'category') THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'That category does not exist.');
    END IF;

    -- Derive a stable sku from the name when one was not supplied
    v_sku := coalesce(nullif(v_sku, ''), regexp_replace(lower(v_p->>'name'), '[^a-z0-9]+', '-', 'g'));
    v_sku := btrim(regexp_replace(v_sku, '(^-+|-+$)', '', 'g'), '-');
    IF v_sku = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'Could not derive a SKU from that name.');
    END IF;
    IF EXISTS (SELECT 1 FROM public.products WHERE sku = v_sku) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_sku',
        'error', 'A product with that name already exists. Choose a different name.');
    END IF;

    INSERT INTO public.products (sku, name, category, price, meta, description, prep_days, published)
    VALUES (
      v_sku,
      left(btrim(v_p->>'name'), 160),
      v_p->>'category',
      CASE WHEN v_p ? 'price' AND v_p->>'price' IS NOT NULL AND btrim(v_p->>'price') <> ''
           THEN (v_p->>'price')::INTEGER ELSE NULL END,
      left(coalesce(v_p->>'meta', ''), 120),
      left(coalesce(v_p->>'description', ''), 400),
      greatest(0, least(30, coalesce((v_p->>'prepDays')::INTEGER, 0))),
      TRUE
    );
    RETURN jsonb_build_object('ok', TRUE, 'sku', v_sku);
  END IF;

  IF v_sku = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A SKU is required.');
  END IF;

  IF v_m = 'DELETE' THEN
    DELETE FROM public.products WHERE sku = v_sku;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Product not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  -- PATCH: update only the fields actually supplied
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE sku = v_sku) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Product not found.');
  END IF;

  IF v_p ? 'name'        THEN UPDATE public.products SET name        = left(btrim(v_p->>'name'), 160)        WHERE sku = v_sku; END IF;
  IF v_p ? 'meta'        THEN UPDATE public.products SET meta        = left(coalesce(v_p->>'meta', ''), 120) WHERE sku = v_sku; END IF;
  IF v_p ? 'description' THEN UPDATE public.products SET description = left(coalesce(v_p->>'description', ''), 400) WHERE sku = v_sku; END IF;
  IF v_p ? 'image'       THEN UPDATE public.products SET image       = left(coalesce(v_p->>'image', ''), 200) WHERE sku = v_sku; END IF;
  IF v_p ? 'published'   THEN UPDATE public.products SET published   = public.as_bool(v_p->>'published')    WHERE sku = v_sku; END IF;
  IF v_p ? 'discountPct' THEN
    UPDATE public.products
    SET discount_pct = greatest(0, least(90, coalesce((v_p->>'discountPct')::NUMERIC, 0)::INTEGER))
    WHERE sku = v_sku;
  END IF;
  IF v_p ? 'prepDays' THEN
    UPDATE public.products
    SET prep_days = greatest(0, least(30, coalesce((v_p->>'prepDays')::INTEGER, 0)))
    WHERE sku = v_sku;
  END IF;
  IF v_p ? 'category' AND coalesce(btrim(v_p->>'category'), '') <> '' THEN
    IF NOT EXISTS (SELECT 1 FROM public.categories WHERE slug = v_p->>'category') THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'That category does not exist.');
    END IF;
    UPDATE public.products SET category = v_p->>'category' WHERE sku = v_sku;
  END IF;
  IF v_p ? 'price' THEN
    v_price := CASE WHEN v_p->>'price' IS NULL OR btrim(v_p->>'price') = ''
                    THEN NULL ELSE (v_p->>'price')::INTEGER END;
    IF v_price IS NOT NULL AND v_price < 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A price cannot be negative.');
    END IF;
    UPDATE public.products SET price = v_price WHERE sku = v_sku;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'sku', v_sku);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_class(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_slug TEXT := btrim(coalesce(v_p->>'slug', ''));
  v_fee  INTEGER;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'POST' THEN
    IF coalesce(btrim(v_p->>'name'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A course needs a name.');
    END IF;
    v_fee := coalesce((v_p->>'fee')::INTEGER, 0);
    IF v_fee < 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A course fee cannot be negative.');
    END IF;

    v_slug := coalesce(nullif(v_slug, ''), regexp_replace(lower(v_p->>'name'), '[^a-z0-9]+', '-', 'g'));
    v_slug := btrim(regexp_replace(v_slug, '(^-+|-+$)', '', 'g'), '-');
    IF EXISTS (SELECT 1 FROM public.classes WHERE slug = v_slug) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_slug',
        'error', 'A course with that name already exists.');
    END IF;

    INSERT INTO public.classes (slug, track, level, level_label, name, summary, fee, hours, published)
    VALUES (
      v_slug,
      CASE WHEN v_p->>'track' = 'pastry' THEN 'pastry' ELSE 'bread' END,
      greatest(1, least(3, coalesce((v_p->>'level')::INTEGER, 1))),
      CASE coalesce((v_p->>'level')::INTEGER, 1)
        WHEN 2 THEN 'Intermediate'
        WHEN 3 THEN 'Advanced'
        ELSE 'Beginner' END,
      left(btrim(v_p->>'name'), 160),
      left(coalesce(v_p->>'summary', ''), 400),
      v_fee,
      left(coalesce(nullif(btrim(v_p->>'hours'), ''), '1 week'), 80),
      TRUE
    );
    RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
  END IF;

  IF v_slug = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A course slug is required.');
  END IF;

  IF v_m = 'DELETE' THEN
    DELETE FROM public.classes WHERE slug = v_slug;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Course not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE slug = v_slug) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Course not found.');
  END IF;

  IF v_p ? 'fee' THEN
    v_fee := coalesce((v_p->>'fee')::INTEGER, 0);
    IF v_fee < 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A course fee cannot be negative.');
    END IF;
    UPDATE public.classes SET fee = v_fee WHERE slug = v_slug;
  END IF;
  IF v_p ? 'hours'     THEN UPDATE public.classes SET hours     = left(coalesce(v_p->>'hours', ''), 80)     WHERE slug = v_slug; END IF;
  IF v_p ? 'summary'   THEN UPDATE public.classes SET summary   = left(coalesce(v_p->>'summary', ''), 400)  WHERE slug = v_slug; END IF;
  IF v_p ? 'name'      THEN UPDATE public.classes SET name      = left(btrim(v_p->>'name'), 160)            WHERE slug = v_slug; END IF;
  IF v_p ? 'published' THEN UPDATE public.classes SET published = public.as_bool(v_p->>'published')        WHERE slug = v_slug; END IF;

  RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_category(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_slug TEXT := btrim(coalesce(v_p->>'slug', ''));
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'POST' THEN
    IF coalesce(btrim(v_p->>'name'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A category needs a name.');
    END IF;
    v_slug := coalesce(nullif(v_slug, ''), regexp_replace(lower(v_p->>'name'), '[^a-z0-9]+', '-', 'g'));
    v_slug := btrim(regexp_replace(v_slug, '(^-+|-+$)', '', 'g'), '-');
    IF EXISTS (SELECT 1 FROM public.categories WHERE slug = v_slug) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_slug',
        'error', 'A category with that name already exists.');
    END IF;

    INSERT INTO public.categories (slug, name, intro, published, sort_order)
    VALUES (
      v_slug,
      left(btrim(v_p->>'name'), 120),
      left(coalesce(v_p->>'intro', ''), 400),
      TRUE,
      coalesce((SELECT max(sort_order) + 1 FROM public.categories), 0)
    );
    RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
  END IF;

  IF v_slug = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A category slug is required.');
  END IF;

  IF v_m = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.products WHERE category = v_slug) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'category_in_use',
        'error', 'Move or delete the products in this category first.');
    END IF;
    DELETE FROM public.categories WHERE slug = v_slug;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Category not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  IF v_p ? 'name'      THEN UPDATE public.categories SET name      = left(btrim(v_p->>'name'), 120) WHERE slug = v_slug; END IF;
  IF v_p ? 'intro'     THEN UPDATE public.categories SET intro     = left(coalesce(v_p->>'intro', ''), 400) WHERE slug = v_slug; END IF;
  IF v_p ? 'published' THEN UPDATE public.categories SET published = public.as_bool(v_p->>'published') WHERE slug = v_slug; END IF;

  RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_option(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_kind TEXT := btrim(coalesce(v_p->>'kind', ''));
  v_key  TEXT := btrim(coalesce(v_p->>'key', ''));
  v_patch JSONB := '{}'::jsonb;
  v_label TEXT;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'DELETE' THEN
    IF v_kind = '' OR v_key = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A kind and key are required.');
    END IF;
    DELETE FROM public.cake_options WHERE kind = v_kind AND key = v_key;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Option not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  IF v_m = 'POST' THEN
    IF v_kind = '' OR v_key = '' OR coalesce(btrim(v_p->>'label'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A kind, key and label are required.');
    END IF;
    v_patch := v_p - 'kind' - 'key' - 'label';
    INSERT INTO public.cake_options (kind, key, label, payload)
    VALUES (v_kind, v_key, left(btrim(v_p->>'label'), 200), v_patch)
    ON CONFLICT (kind, key) DO UPDATE
      SET label = EXCLUDED.label, payload = EXCLUDED.payload;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  -- PATCH: merge the supplied pricing fields into the existing payload
  IF v_kind = '' OR v_key = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A kind and key are required.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cake_options WHERE kind = v_kind AND key = v_key) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Option not found.');
  END IF;

  v_patch := v_p - 'kind' - 'key';
  v_label := nullif(btrim(coalesce(v_p->>'label', '')), '');

  UPDATE public.cake_options
  SET label   = coalesce(v_label, label),
      payload = coalesce(payload, '{}'::jsonb) || (v_patch - 'label')
  WHERE kind = v_kind AND key = v_key;

  RETURN jsonb_build_object('ok', TRUE);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

-- -----------------------------------------------------------------------------
-- 13. Grants — every function checks its own authorisation internally, so
--     EXECUTE is granted broadly and the gate is has_admin_permission().
-- -----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.order_admin_json(public.orders)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pct_change(INTEGER, INTEGER)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.as_bool(TEXT)                            FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.api_lookup_order(TEXT, TEXT)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_orders(TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_order(TEXT)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_dashboard(INTEGER)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_settings(JSONB)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_catalogue()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_discounts(JSONB)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_notifications(JSONB)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_product(TEXT, JSONB)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_class(TEXT, JSONB)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_category(TEXT, JSONB)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_option(TEXT, JSONB)         TO authenticated;

-- [COMMIT removed: the combined script has one outer transaction]


-- =============================================================================
-- FILE 5 of 6 — 20261026_business_contact_profile.sql
-- Editable business contact profile
-- =============================================================================

-- =============================================================================
-- Mystery Bakebite — Business Contact Profile (single source of truth)
-- Target: Supabase PostgreSQL 15+
-- Depends on: 20261022 (settings table), 20261024 (api_config), 20261025 (api_admin_settings)
--
-- WHY THIS EXISTS
--   Every contact detail the bakery publishes was hardcoded in the HTML: the
--   WhatsApp number in 34 links across 10 pages, the email in 60 places, the
--   Instagram URL in 11, the address and opening hours in dozens more. Updating
--   any of them meant editing every page and hoping none were missed.
--
--   This migration moves them into public.settings — one row, one place — and
--   exposes them through api_config(), which every page already calls on load.
--   The storefront then renders from that object instead of from markup.
--
-- WHAT IT DOES
--   1. Adds the contact columns to public.settings (idempotent).
--   2. Backfills them with the values the site was already publishing, so the
--      visible result is unchanged on the day it is applied.
--   3. Extends api_config() to return a `contact` object (public read; it is
--      SECURITY DEFINER so anon can read it without a grant on settings).
--   4. Extends api_admin_settings() to validate and write those fields, so only
--      an administrator with the `settings` permission can change them.
--
-- SECURITY
--   public.settings still has NO select grant for anon. The contact block is
--   exposed only through api_config(), which returns a fixed allow-list of
--   fields. No order, customer, token or administrator record is reachable
--   through it. Writes require has_admin_permission('settings').
-- =============================================================================

-- [BEGIN removed: the combined script has one outer transaction]

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_name          TEXT NOT NULL DEFAULT 'Mystery Bakebite';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_tagline       TEXT NOT NULL DEFAULT 'Home bakery & baking school';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_phone         TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_phone_display TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_email         TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS whatsapp_contact       TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS whatsapp_message       TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_line1          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_line2          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_city           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_region         TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_country        TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS map_url                TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_days           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_open           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_close          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_note           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_instagram       TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_facebook        TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_tiktok          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_x               TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_youtube         TEXT NOT NULL DEFAULT '';

-- -----------------------------------------------------------------------------
-- 2. Backfill with the values the site is already publishing.
--    Guarded so a second run cannot overwrite anything an admin has since set.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  UPDATE public.settings SET
    business_name          = 'Mystery Bakebite',
    business_phone         = '233554520532',
    business_phone_display = '+233 55 452 0532',
    business_email         = 'mysterybakebites@gmail.com',
    whatsapp_contact       = '233554520532',
    whatsapp_message       = 'Hello Mystery Bakebite, I''d like to place an order.',
    address_city           = 'Tamale',
    address_region         = 'Northern Region',
    address_country        = 'Ghana',
    opening_days           = 'Monday to Sunday',
    opening_open           = '08:00',
    opening_close          = '19:00',
    opening_note           = 'Messages are answered during opening hours.',
    social_instagram       = 'https://www.instagram.com/mysterybakebites/'
  WHERE id = 1
    AND coalesce(btrim(business_phone), '') = ''
    AND coalesce(btrim(business_email), '') = ''
    AND coalesce(btrim(whatsapp_contact), '') = '';
END $$;

-- -----------------------------------------------------------------------------
-- 3. Shape constraints. These mirror the checks in api_admin_settings so a bad
--    value cannot be written by any path, including direct SQL.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_business_phone_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_business_phone_chk
      CHECK (business_phone = '' OR business_phone ~ '^[0-9]{7,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_whatsapp_contact_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_whatsapp_contact_chk
      CHECK (whatsapp_contact = '' OR whatsapp_contact ~ '^[0-9]{7,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_business_email_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_business_email_chk
      CHECK (business_email = '' OR business_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]{2,}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_opening_time_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_opening_time_chk
      CHECK (
        (opening_open  = '' OR opening_open  ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
        (opening_close = '' OR opening_close ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. api_config() — now carries the contact profile
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_config()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH s AS (
    -- LEFT JOIN keeps this returning a usable default even on a database where
    -- the settings row has not been seeded yet; every field below is coalesced.
    SELECT st.* FROM (SELECT 1 AS one) d
    LEFT JOIN public.settings st ON st.id = 1
  )
  SELECT jsonb_build_object(
    'ok', TRUE,
    'config', jsonb_build_object(
      -- The public WhatsApp line. settings.whatsapp_number may be the baker's
      -- private alert number, so only expose it once it is explicitly set.
      'whatsapp', coalesce(nullif(btrim(s.whatsapp_number), ''), ''),
      'bundle_two_pct',   coalesce(s.bundle_two_pct, 15),
      'bundle_three_pct', coalesce(s.bundle_three_pct, 25),
      -- Older rows stored the threshold in cedis (700); normalise to pesewas.
      'advance_threshold',
        CASE
          WHEN s.advance_threshold IS NULL OR s.advance_threshold <= 0 THEN 70000
          WHEN s.advance_threshold < 1000 THEN round(s.advance_threshold * 100)
          ELSE s.advance_threshold
        END,
      'cash', jsonb_build_object(
        'delivery', coalesce(s.cash_delivery_enabled, TRUE),
        'pickup',   coalesce(s.cash_pickup_enabled, TRUE)
      ),
      'momo', CASE
        WHEN coalesce(s.momo_verified, FALSE)
             AND coalesce(btrim(s.momo_name), '')   <> ''
             AND coalesce(btrim(s.momo_number), '') <> ''
        THEN jsonb_build_object(
               'name',     s.momo_name,
               'number',   s.momo_number,
               'provider', coalesce(nullif(btrim(s.momo_provider), ''), 'MTN MoMo'),
               'note',     coalesce(s.momo_note, '')
             )
        ELSE NULL::jsonb
      END,
      'bank', CASE
        WHEN coalesce(s.bank_verified, FALSE)
             AND coalesce(btrim(s.bank_name), '')           <> ''
             AND coalesce(btrim(s.bank_account_name), '')   <> ''
             AND coalesce(btrim(s.bank_account_number), '') <> ''
        THEN jsonb_build_object(
               'name',          s.bank_name,
               'accountName',   s.bank_account_name,
               'accountNumber', s.bank_account_number
             )
        ELSE NULL::jsonb
      END,
      -- Per-SKU discount and preparation lead times, so the browser can show a
      -- price preview that agrees with what api_place_order will charge.
      'product_discounts', coalesce((
        SELECT jsonb_object_agg(p.sku, p.discount_pct)
        FROM public.products p
        WHERE coalesce(p.discount_pct, 0) > 0
      ), '{}'::jsonb),
      'product_prep_days', coalesce((
        SELECT jsonb_object_agg(p.sku, p.prep_days)
        FROM public.products p
      ), '{}'::jsonb),

      -- ---------------------------------------------------------------------
      -- BUSINESS CONTACT PROFILE (single source of truth for every page).
      -- The browser renders header, footer, contact page, WhatsApp buttons and
      -- click-to-call links from this object. Nothing contact-related is
      -- hardcoded in a page any more; changing it here changes it everywhere.
      -- Every field is coalesced so a half-filled row still renders.
      -- ---------------------------------------------------------------------
      'contact', jsonb_build_object(
        'businessName', coalesce(nullif(btrim(s.business_name), ''), 'Mystery Bakebite'),
        'tagline',      coalesce(s.business_tagline, ''),

        'phone',        coalesce(regexp_replace(coalesce(s.business_phone, ''), '\D', '', 'g'), ''),
        'phoneDisplay', coalesce(nullif(btrim(s.business_phone_display), ''), ''),
        'email',        coalesce(nullif(btrim(s.business_email), ''), ''),

        'whatsapp',        coalesce(regexp_replace(coalesce(s.whatsapp_contact, ''), '\D', '', 'g'), ''),
        'whatsappMessage', coalesce(s.whatsapp_message, ''),
        -- Baker alert number: the private alert number when set, otherwise the
        -- public WhatsApp line. Empty string means "no automatic alert target".
        'alerts',          coalesce(
                             nullif(regexp_replace(coalesce(s.whatsapp_number, ''), '\D', '', 'g'), ''),
                             regexp_replace(coalesce(s.whatsapp_contact, ''), '\D', '', 'g'),
                             ''
                           ),

        'address', jsonb_build_object(
          'line1',   coalesce(s.address_line1, ''),
          'line2',   coalesce(s.address_line2, ''),
          'city',    coalesce(s.address_city, ''),
          'region',  coalesce(s.address_region, ''),
          'country', coalesce(s.address_country, ''),
          'mapUrl',  coalesce(s.map_url, '')
        ),

        'hours', jsonb_build_object(
          'days',  coalesce(nullif(btrim(s.opening_days), ''), ''),
          'open',  coalesce(nullif(btrim(s.opening_open), ''), ''),
          'close', coalesce(nullif(btrim(s.opening_close), ''), ''),
          'note',  coalesce(s.opening_note, '')
        ),

        'social', jsonb_build_object(
          'instagram', coalesce(s.social_instagram, ''),
          'facebook',  coalesce(s.social_facebook, ''),
          'tiktok',    coalesce(s.social_tiktok, ''),
          'x',         coalesce(s.social_x, ''),
          'youtube',   coalesce(s.social_youtube, '')
        )
      )
    )
  )
  FROM s;
$$;

-- -----------------------------------------------------------------------------
-- 5. api_admin_settings() — validates and writes the contact profile
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_settings(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p       JSONB := coalesce(p_payload, '{}'::jsonb);
  v_int     INTEGER;
  v_bool    BOOLEAN;
  v_txt     TEXT;
BEGIN
  IF NOT public.has_admin_permission('settings') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator settings permission required.');
  END IF;

  IF v_p <> '{}'::jsonb THEN

    -- Mobile Money
    IF v_p ? 'momo_name'     THEN UPDATE public.settings SET momo_name     = left(btrim(coalesce(v_p->>'momo_name', '')), 120)     WHERE id = 1; END IF;
    IF v_p ? 'momo_number'   THEN UPDATE public.settings SET momo_number   = left(btrim(coalesce(v_p->>'momo_number', '')), 40)    WHERE id = 1; END IF;
    IF v_p ? 'momo_provider' THEN UPDATE public.settings SET momo_provider = left(btrim(coalesce(v_p->>'momo_provider', '')), 80)  WHERE id = 1; END IF;
    IF v_p ? 'momo_note'     THEN UPDATE public.settings SET momo_note     = left(btrim(coalesce(v_p->>'momo_note', '')), 200)     WHERE id = 1; END IF;

    -- Bank
    IF v_p ? 'bank_name'           THEN UPDATE public.settings SET bank_name           = left(btrim(coalesce(v_p->>'bank_name', '')), 120)           WHERE id = 1; END IF;
    IF v_p ? 'bank_account_name'   THEN UPDATE public.settings SET bank_account_name   = left(btrim(coalesce(v_p->>'bank_account_name', '')), 120)   WHERE id = 1; END IF;
    IF v_p ? 'bank_account_number' THEN UPDATE public.settings SET bank_account_number = left(btrim(coalesce(v_p->>'bank_account_number', '')), 60) WHERE id = 1; END IF;

    -- Verified flags arrive as '1'/'0' strings from checkboxes
    IF v_p ? 'momo_verified' THEN
      v_bool := public.as_bool(v_p->>'momo_verified');
      UPDATE public.settings SET momo_verified = v_bool WHERE id = 1;
    END IF;
    IF v_p ? 'bank_verified' THEN
      v_bool := public.as_bool(v_p->>'bank_verified');
      UPDATE public.settings SET bank_verified = v_bool WHERE id = 1;
    END IF;

    -- Cash channels
    IF v_p ? 'cash_delivery_enabled' THEN
      v_bool := public.as_bool(v_p->>'cash_delivery_enabled');
      UPDATE public.settings SET cash_delivery_enabled = v_bool WHERE id = 1;
    END IF;
    IF v_p ? 'cash_pickup_enabled' THEN
      v_bool := public.as_bool(v_p->>'cash_pickup_enabled');
      UPDATE public.settings SET cash_pickup_enabled = v_bool WHERE id = 1;
    END IF;

    IF v_p ? 'auto_confirm_on_verified_payment' THEN
      v_bool := public.as_bool(v_p->>'auto_confirm_on_verified_payment');
      UPDATE public.settings SET auto_confirm = v_bool WHERE id = 1;
    END IF;

    -- Advance threshold. The admin form sends cedis; anything under 1000 is
    -- treated as cedis and converted, so both units are accepted safely.
    IF v_p ? 'advance_threshold' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'advance_threshold'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 100000000 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_threshold',
          'error', 'The advance threshold must be a positive amount.');
      END IF;
      IF v_int > 0 AND v_int < 1000 THEN
        v_int := v_int * 100;
      END IF;
      UPDATE public.settings SET advance_threshold = v_int WHERE id = 1;
    END IF;

    -- Bundle percentages (class discounts)
    IF v_p ? 'bundle_two_pct' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'bundle_two_pct'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 90 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_pct',
          'error', 'The two-class discount must be between 0% and 90%.');
      END IF;
      UPDATE public.settings SET bundle_two_pct = v_int WHERE id = 1;
    END IF;
    IF v_p ? 'bundle_three_pct' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'bundle_three_pct'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 90 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_pct',
          'error', 'The three-class discount must be between 0% and 90%.');
      END IF;
      UPDATE public.settings SET bundle_three_pct = v_int WHERE id = 1;
    END IF;

    -- WhatsApp number for baker alerts
    IF v_p ? 'whatsapp_number' THEN
      UPDATE public.settings
      SET whatsapp_number = regexp_replace(coalesce(v_p->>'whatsapp_number', ''), '\D', '', 'g')
      WHERE id = 1;
    END IF;


    -- -------------------------------------------------------------------
    -- Business contact profile. Each field is optional; only the keys that
    -- arrive are touched, so a partial save cannot blank the rest.
    -- Validation runs BEFORE any write for that field, and an invalid value
    -- is rejected with a code the dashboard shows next to the input.
    -- -------------------------------------------------------------------
    IF v_p ? 'business_name' THEN
      UPDATE public.settings SET business_name = left(btrim(coalesce(v_p->>'business_name', '')), 120) WHERE id = 1;
    END IF;
    IF v_p ? 'business_tagline' THEN
      UPDATE public.settings SET business_tagline = left(btrim(coalesce(v_p->>'business_tagline', '')), 160) WHERE id = 1;
    END IF;

    -- Phone: digits only, 7-15 of them (international form without '+').
    IF v_p ? 'business_phone' THEN
      v_txt := regexp_replace(coalesce(v_p->>'business_phone', ''), '\D', '', 'g');
      IF v_txt <> '' AND v_txt !~ '^[0-9]{7,15}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_phone',
          'error', 'The business phone number must contain 7 to 15 digits, for example 233554520532.');
      END IF;
      UPDATE public.settings SET business_phone = v_txt WHERE id = 1;
    END IF;
    IF v_p ? 'business_phone_display' THEN
      UPDATE public.settings SET business_phone_display = left(btrim(coalesce(v_p->>'business_phone_display', '')), 40) WHERE id = 1;
    END IF;

    -- Email: a deliberately loose shape check. The kitchen email is a contact
    -- detail, not an authentication credential, so an over-strict regex that
    -- rejects a valid address would be worse than a permissive one.
    IF v_p ? 'business_email' THEN
      v_txt := lower(btrim(coalesce(v_p->>'business_email', '')));
      IF v_txt <> '' AND v_txt !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_email',
          'error', 'Enter a valid email address, for example name@example.com.');
      END IF;
      UPDATE public.settings SET business_email = v_txt WHERE id = 1;
    END IF;

    -- Public WhatsApp chat line (digits only). Separate from whatsapp_number,
    -- which is the private alert target.
    IF v_p ? 'whatsapp_contact' THEN
      v_txt := regexp_replace(coalesce(v_p->>'whatsapp_contact', ''), '\D', '', 'g');
      IF v_txt <> '' AND v_txt !~ '^[0-9]{7,15}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_whatsapp',
          'error', 'The WhatsApp number must contain 7 to 15 digits, for example 233554520532.');
      END IF;
      UPDATE public.settings SET whatsapp_contact = v_txt WHERE id = 1;
    END IF;
    IF v_p ? 'whatsapp_message' THEN
      UPDATE public.settings SET whatsapp_message = left(btrim(coalesce(v_p->>'whatsapp_message', '')), 400) WHERE id = 1;
    END IF;

    -- Address
    IF v_p ? 'address_line1' THEN UPDATE public.settings SET address_line1 = left(btrim(coalesce(v_p->>'address_line1', '')), 160) WHERE id = 1; END IF;
    IF v_p ? 'address_line2' THEN UPDATE public.settings SET address_line2 = left(btrim(coalesce(v_p->>'address_line2', '')), 160) WHERE id = 1; END IF;
    IF v_p ? 'address_city'  THEN UPDATE public.settings SET address_city  = left(btrim(coalesce(v_p->>'address_city',  '')), 80)  WHERE id = 1; END IF;
    IF v_p ? 'address_region' THEN UPDATE public.settings SET address_region = left(btrim(coalesce(v_p->>'address_region','')), 80) WHERE id = 1; END IF;
    IF v_p ? 'address_country' THEN UPDATE public.settings SET address_country = left(btrim(coalesce(v_p->>'address_country','')), 80) WHERE id = 1; END IF;
    IF v_p ? 'map_url' THEN
      v_txt := btrim(coalesce(v_p->>'map_url', ''));
      IF v_txt <> '' AND v_txt !~* '^https?://' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_map_url',
          'error', 'The map link must start with http:// or https://.');
      END IF;
      UPDATE public.settings SET map_url = left(v_txt, 500) WHERE id = 1;
    END IF;

    -- Opening hours
    IF v_p ? 'opening_days' THEN UPDATE public.settings SET opening_days = left(btrim(coalesce(v_p->>'opening_days', '')), 80) WHERE id = 1; END IF;
    IF v_p ? 'opening_note' THEN UPDATE public.settings SET opening_note = left(btrim(coalesce(v_p->>'opening_note', '')), 200) WHERE id = 1; END IF;
    IF v_p ? 'opening_open' THEN
      v_txt := btrim(coalesce(v_p->>'opening_open', ''));
      IF v_txt <> '' AND v_txt !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_hours',
          'error', 'Opening time must be in 24-hour HH:MM form, for example 08:00.');
      END IF;
      UPDATE public.settings SET opening_open = v_txt WHERE id = 1;
    END IF;
    IF v_p ? 'opening_close' THEN
      v_txt := btrim(coalesce(v_p->>'opening_close', ''));
      IF v_txt <> '' AND v_txt !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_hours',
          'error', 'Closing time must be in 24-hour HH:MM form, for example 19:00.');
      END IF;
      UPDATE public.settings SET opening_close = v_txt WHERE id = 1;
    END IF;

    -- Social links: every one must be an http(s) URL or empty.
    IF v_p ? 'social' AND jsonb_typeof(v_p->'social') = 'object' THEN
      IF v_p->'social' ? 'instagram' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'instagram', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The Instagram link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_instagram = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'facebook' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'facebook', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The Facebook link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_facebook = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'tiktok' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'tiktok', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The TikTok link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_tiktok = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'x' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'x', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The X link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_x = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'youtube' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'youtube', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The YouTube link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_youtube = left(v_txt, 300) WHERE id = 1;
      END IF;
    END IF;

    UPDATE public.settings SET updated_at = NOW() WHERE id = 1;
  END IF;

  RETURN jsonb_build_object(
    'ok',       TRUE,
    'settings', (SELECT to_jsonb(s) FROM public.settings s WHERE s.id = 1),
    'config',   (public.api_config())->'config'
  );
END;
$$;

-- [COMMIT removed: the combined script has one outer transaction]


-- =============================================================================
-- FILE 6 of 6 — 20261027_catalogue_repair_and_seed.sql
-- Classes repair + catalogue seed
-- =============================================================================

-- =============================================================================
-- Mystery Bakebite — Catalogue repair and seed
-- Target: Supabase PostgreSQL 15+
-- Depends on: 20261022 (tables), 20261024 (api_catalogue)
--
-- WHY THIS EXISTS — the measured root cause of "courses are not loading"
--
--   Two independent faults were found by probing the live project on 2026-10-25:
--
--   FAULT 1 — the RPC did not exist.
--     POST /rest/v1/rpc/api_catalogue returned
--       PGRST202  "Could not find the function public.api_catalogue"
--     so classes.js took its error branch and rendered
--       "Courses could not be loaded."
--     The function s shipped in 20261024 never reached the live project.
--
--   FAULT 2 — the tables were empty.
--     Direct REST reads returned HTTP 200 with an empty array for every table:
--       classes 0 rows, products 0 rows, categories 0 rows, cake_options 0 rows
--     This is NOT Row Level Security hiding rows. public.cake_options has a
--     policy of USING (TRUE) with no published filter, and it still returned
--     zero rows, which a policy cannot do. The tables simply have no data.
--     So even with the RPC in place the page would have rendered an empty list.
--
--   FAULT 3 — bringNote was dropped on the way out.
--     classes.js renders c.bringNote, but public.classes had no such column and
--     api_catalogue() never emitted the key, so that paragraph would have been
--     blank even with data present.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds classes.bring_note (idempotent).
--   2. Redefines api_catalogue() to emit bringNote.
--   3. Seeds categories, products, classes and cake_options with the bakery's
--      OWN published catalogue, read from the LOCAL_SEED block in
--      assets/js/supabase.js — the same six courses and 53 products the site
--      was already displaying in local mode.
--
-- THIS IS NOT INVENTED DATA
--   Every row below is a faithful copy of the existing catalogue: same skus,
--   same prices in pesewas, same class fees, same recipe lists. Nothing was
--   added, renamed, repriced or invented to make the page "look working".
--   The seed is idempotent (ON CONFLICT DO NOTHING), so running it a second
--   time changes nothing and it will never overwrite an admin's later edit.
--
--   If the bakery has since changed a price in the dashboard, this migration
--   will NOT revert it — ON CONFLICT DO NOTHING leaves existing rows alone.
-- =============================================================================

-- [BEGIN removed: the combined script has one outer transaction]

-- -----------------------------------------------------------------------------
-- 1. classes.bring_note — the "what to bring" note the class card renders
-- -----------------------------------------------------------------------------
ALTER TABLE public.classes ADD COLUMN IF NOT EXISTS bring_note TEXT NOT NULL DEFAULT '';

-- -----------------------------------------------------------------------------
-- 2. api_catalogue() — now emits bringNote
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_catalogue()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'ok', TRUE,

    'categories', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'slug',      c.slug,
        'name',      c.name,
        'intro',     c.intro,
        'published', c.published,
        'sortOrder', c.sort_order
      ) ORDER BY c.sort_order, c.slug)
      FROM public.categories c
      WHERE c.published IS NOT FALSE
    ), '[]'::jsonb),

    'products', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'sku',         p.sku,
        'name',        p.name,
        'category',    p.category,
        'price',       p.price,          -- NULL means "quoted on request"
        'discountPct', coalesce(p.discount_pct, 0),
        'prepDays',    coalesce(p.prep_days, 0),
        'meta',        p.meta,
        'description', p.description,
        'image',       p.image,
        'published',   p.published
      ) ORDER BY p.category, p.sku)
      FROM public.products p
      WHERE p.published IS NOT FALSE
    ), '[]'::jsonb),

    'classes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'slug',        k.slug,
        'track',       k.track,
        'level',       k.level,
        'levelLabel',  k.level_label,
        'name',        k.name,
        'summary',     k.summary,
        'description', k.description,
        'fee',         k.fee,
        'hours',       k.hours,
        'schedule',    k.schedule,
        'recipes',     k.recipes,
        'skills',      k.skills,
        'provided',    k.provided,
        'bring',       k.bring,
        'bringNote',   coalesce(k.bring_note, ''),
        'prereq',      k.prereq,
        'published',   k.published
      ) ORDER BY k.track, k.level)
      FROM public.classes k
      WHERE k.published IS NOT FALSE
    ), '[]'::jsonb),

    -- Cake builder options, grouped by kind:
    --   { "size": [{key,label,price}], "decor": [{key,label,charges:{...}}], ... }
    'options', coalesce((
      SELECT jsonb_object_agg(o.kind, o.items)
      FROM (
        SELECT
          co.kind,
          jsonb_agg(
            jsonb_build_object('key', co.key, 'label', co.label) || coalesce(co.payload, '{}'::jsonb)
            ORDER BY co.key
          ) AS items
        FROM public.cake_options co
        GROUP BY co.kind
      ) o
    ), '{}'::jsonb),

    'config', (public.api_config())->'config'
  );
$$;
-- -----------------------------------------------------------------------------
-- 3. Seed. The payload is a single JSONB document so the SQL stays compact and
--    every string is escaped exactly once.
-- -----------------------------------------------------------------------------
DO $$
-- JSON payload, assembled from the site's published catalogue.
DECLARE
  v_src JSONB;
  rec   JSONB;
BEGIN
  v_src := (
    '{"categories":[{"slug":"milky-doughnuts","name":"Milky Doughnuts","intro":"Soft, creamy and fresh, made in small batches.","published":true,"sort_order":0},{"slug":"mini-doughnuts","name":"Mini Doughnuts & Doughnut Balls","intro":"Bite-sized, finished with chocolate syrup.","published":true,"sort_order":1},{"slug":"cake-slices","name":"Cake Slices","intro":"A slice, a tasting box, or a full flavour box.","published":true,"sort_order":2},{"slug":"cake-loaves","name":"Loaves & Bread","intro":"Banana and vanilla loaves, plain or topped.","published":true,"sort_order":3},{"slug":"cookies","name":"Cookies","intro":"Chocolate and butter cookies, packed to gift or share.","published":true,"sort_order":4},{"slug":"cupcakes","name":"Cupcakes","intro":"Iced and finished by hand, in boxes of six, eight or twelve.","published":true,"sort_order":5},{"slug":"parfait","name":"Parfait","intro":"Layered cake parfait by the cup or the bowl.","published":true,"sort_order":6},{"slug":"chips","name":"Chips","intro":"Fried or baked, in three sizes, for an everyday savoury order.","published":true,"sort_order":7},{"slug":"celebration","name":"Celebration Cakes","intro":"Fourteen varieties, from a bento gift cake to a three-tier wedding cake. Add one to your cart and the baker confirms the final design and price with you.","published":true,"sort_order":8}],"products":[{"sku":"milky-2","name":"Milky donuts, 2 pcs","category":"milky-doughnuts","price":3000,"discount_pct":0,"prep_days":0,"meta":"2 pieces","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"milky-3","name":"Milky donuts, 3 pcs","category":"milky-doughnuts","price":4200,"discount_pct":0,"prep_days":0,"meta":"3 pieces","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"milky-6","name":"Milky donuts, 6 pcs","category":"milky-doughnuts","price":7500,"discount_pct":0,"prep_days":0,"meta":"Half dozen","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"milky-12","name":"Milky donuts, 12 pcs","category":"milky-doughnuts","price":14000,"discount_pct":0,"prep_days":1,"meta":"Dozen","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"mini-10","name":"Mini donuts, pack of 10","category":"mini-doughnuts","price":3500,"discount_pct":0,"prep_days":0,"meta":"Pack of 10","description":"","image":"hero-doughnut.webp","published":true},{"sku":"balls-12","name":"Mini donut balls, pack of 12","category":"mini-doughnuts","price":3000,"discount_pct":0,"prep_days":0,"meta":"Pack of 12","description":"","image":"hero-doughnut.webp","published":true},{"sku":"balls-25","name":"Mini donut balls, pack of 25","category":"mini-doughnuts","price":5500,"discount_pct":0,"prep_days":0,"meta":"Pack of 25","description":"","image":"hero-doughnut.webp","published":true},{"sku":"slice-classic","name":"Classic slice","category":"cake-slices","price":3500,"discount_pct":0,"prep_days":0,"meta":"One slice","description":"","image":"prod-slices.w'
    || 'ebp","published":true},{"sku":"slice-signature","name":"Signature slice","category":"cake-slices","price":4000,"discount_pct":0,"prep_days":0,"meta":"One slice","description":"","image":"prod-slices.webp","published":true},{"sku":"tasting-box","name":"Tasting box, 4 half-slices","category":"cake-slices","price":7000,"discount_pct":0,"prep_days":1,"meta":"4 half-slices","description":"","image":"prod-slices.webp","published":true},{"sku":"flavour-box","name":"Full flavour box, 4 full slices","category":"cake-slices","price":13000,"discount_pct":0,"prep_days":1,"meta":"4 full slices","description":"","image":"prod-slices.webp","published":true},{"sku":"banana-small-plain","name":"Banana loaf, small, plain","category":"cake-loaves","price":3500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"banana-small-topped","name":"Banana loaf, small, topped","category":"cake-loaves","price":4500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"banana-big-plain","name":"Banana loaf, big, plain","category":"cake-loaves","price":7000,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"banana-big-topped","name":"Banana loaf, big, topped","category":"cake-loaves","price":8500,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-small-plain","name":"Vanilla loaf, small, plain","category":"cake-loaves","price":3500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-small-topped","name":"Vanilla loaf, small, topped","category":"cake-loaves","price":4500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-big-plain","name":"Vanilla loaf, big, plain","category":"cake-loaves","price":6500,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-big-topped","name":"Vanilla loaf, big, topped","category":"cake-loaves","price":8000,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"choc-cookies-4","name":"Chocolate cookies, pack of 4","category":"cookies","price":4000,"discount_pct":0,"prep_days":0,"meta":"Pack of 4","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"choc-cookies-8","name":"Chocolate cookies, pack of 8","category":"cookies","price":7500,"discount_pct":0,"prep_days":0,"meta":"Pack of 8","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"choc-cookies-12","name":"Chocolate cookies, pack of 12","category":"cookies","price":12000,"discount_pct":0,"prep_days":1,"meta":"Pack of 12","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"butter-cookies-4","name":"Bu'
    || 'tter cookies, pack of 4","category":"cookies","price":3000,"discount_pct":0,"prep_days":0,"meta":"Pack of 4","description":"","image":"prod-cookies.webp","published":true},{"sku":"butter-cookies-8","name":"Butter cookies, pack of 8","category":"cookies","price":6000,"discount_pct":0,"prep_days":0,"meta":"Pack of 8","description":"","image":"prod-cookies.webp","published":true},{"sku":"butter-cookies-12","name":"Butter cookies, pack of 12","category":"cookies","price":12000,"discount_pct":0,"prep_days":1,"meta":"Pack of 12","description":"","image":"prod-cookies.webp","published":true},{"sku":"mixed-cookie-box","name":"Mixed cookie box, 14 pcs","category":"cookies","price":14000,"discount_pct":0,"prep_days":1,"meta":"14 pieces","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"cupcakes-6","name":"Cupcakes, box of 6","category":"cupcakes","price":7200,"discount_pct":0,"prep_days":1,"meta":"Box of 6","description":"","image":"prod-cupcakes.webp","published":true},{"sku":"cupcakes-8","name":"Cupcakes, box of 8","category":"cupcakes","price":9500,"discount_pct":0,"prep_days":1,"meta":"Box of 8","description":"","image":"prod-cupcakes.webp","published":true},{"sku":"cupcakes-12","name":"Cupcakes, box of 12","category":"cupcakes","price":14000,"discount_pct":0,"prep_days":1,"meta":"Box of 12","description":"","image":"prod-cupcakes.webp","published":true},{"sku":"parfait-cup-plain","name":"Cake parfait, cup, plain","category":"parfait","price":6000,"discount_pct":0,"prep_days":0,"meta":"Cup","description":"","image":"prod-parfait.webp","published":true},{"sku":"parfait-cup-topped","name":"Cake parfait, cup, topped","category":"parfait","price":7500,"discount_pct":0,"prep_days":0,"meta":"Cup","description":"","image":"prod-parfait.webp","published":true},{"sku":"parfait-bowl-plain","name":"Cake parfait, bowl, plain","category":"parfait","price":8500,"discount_pct":0,"prep_days":0,"meta":"Bowl","description":"","image":"prod-parfait.webp","published":true},{"sku":"parfait-bowl-topped","name":"Cake parfait, bowl, topped","category":"parfait","price":9500,"discount_pct":0,"prep_days":0,"meta":"Bowl","description":"","image":"prod-parfait.webp","published":true},{"sku":"chips-fried-s","name":"Fried chips, small","category":"chips","price":1000,"discount_pct":0,"prep_days":0,"meta":"Small","description":"","image":"","published":true},{"sku":"chips-fried-m","name":"Fried chips, medium","category":"chips","price":3500,"discount_pct":0,"prep_days":0,"meta":"Medium","description":"","image":"","published":true},{"sku":"chips-fried-l","name":"Fried chips, large","category":"chips","price":7000,"discount_pct":0,"prep_days":0,"meta":"Large","description":"","image":"","published":true},{"sku":"chips-baked-s","name":"Baked chips, small","category":"chips","price":1000,"discount_pct":0,"prep_days":0,"meta":"Small","description":"","image":"","published":true},{"sku":"chips-baked-m","name":"Baked chips, medium","category":"chips","price":350'
    || '0,"discount_pct":0,"prep_days":0,"meta":"Medium","description":"","image":"","published":true},{"sku":"chips-baked-l","name":"Baked chips, large","category":"chips","price":8000,"discount_pct":0,"prep_days":0,"meta":"Large","description":"","image":"","published":true},{"sku":"bento","name":"Bento gift cake","category":"celebration","price":12000,"discount_pct":0,"prep_days":1,"meta":"4-inch personal-size cake (from price)","description":"","image":"cake-bento.webp","published":true},{"sku":"birthday","name":"Classic birthday cake","category":"celebration","price":18000,"discount_pct":0,"prep_days":1,"meta":"5-inch to 12-inch (from price)","description":"","image":"cake-birthday.webp","published":true},{"sku":"heart","name":"Heart-shaped cake","category":"celebration","price":30000,"discount_pct":0,"prep_days":1,"meta":"6-inch heart (from price)","description":"","image":"cake-heart.webp","published":true},{"sku":"drip","name":"Drip cake","category":"celebration","price":35000,"discount_pct":0,"prep_days":1,"meta":"6-inch, decorative drip finish (from price)","description":"","image":"cake-drip.webp","published":true},{"sku":"oreo","name":"Oreo cake","category":"celebration","price":35000,"discount_pct":0,"prep_days":1,"meta":"6-inch, Oreo or biscuit topping (from price)","description":"","image":"cake-oreo.webp","published":true},{"sku":"chocolate","name":"Chocolate-loaded cake","category":"celebration","price":40000,"discount_pct":0,"prep_days":1,"meta":"6-inch, chocolate toppings (from price)","description":"","image":"cake-chocolate.webp","published":true},{"sku":"fruit","name":"Fruit-topped cake","category":"celebration","price":40000,"discount_pct":0,"prep_days":1,"meta":"6-inch, fresh-fruit decoration (from price)","description":"","image":"cake-fruit.webp","published":true},{"sku":"redvelvet","name":"Red velvet celebration cake","category":"celebration","price":40000,"discount_pct":0,"prep_days":1,"meta":"6-inch, red velvet flavour (from price)","description":"","image":"cake-redvelvet.webp","published":true},{"sku":"photo","name":"Photo cake","category":"celebration","price":35000,"discount_pct":0,"prep_days":1,"meta":"6-inch, edible photo or printed image (from price)","description":"","image":"cake-photo.webp","published":true},{"sku":"number","name":"Number milestone cake","category":"celebration","price":45000,"discount_pct":0,"prep_days":1,"meta":"Approximately 10-inch (from price)","description":"","image":"cake-number.webp","published":true},{"sku":"kids","name":"Kids'' character or theme cake","category":"celebration","price":60000,"discount_pct":0,"prep_days":1,"meta":"8-inch, character or theme design (from price)","description":"","image":"cake-kids.webp","published":true},{"sku":"luxury","name":"Luxury custom cake","category":"celebration","price":100000,"discount_pct":0,"prep_days":1,"meta":"8-inch, made to suit your theme (from price)","description":"","image":"cake-corporate.webp","published":true},{"sku":"tier2","name":"T'
    || 'wo-tier wedding cake","category":"celebration","price":150000,"discount_pct":0,"prep_days":1,"meta":"8-inch and 6-inch tiers (from price)","description":"","image":"cake-tier2.webp","published":true},{"sku":"tier3","name":"Three-tier grand wedding cake","category":"celebration","price":250000,"discount_pct":0,"prep_days":1,"meta":"10-inch, 8-inch and 6-inch tiers (from price)","description":"","image":"cake-tier3.webp","published":true}],"classes":[{"slug":"bread-beginner","track":"bread","level":1,"level_label":"Beginner","name":"Bread Making · Beginner","summary":"Local favourites and foundational yeast doughs: Ghanaian Sugar Bread, Rich Butter Bread, Tea Bread and Coconut Bread.","description":"A hands-on introduction to yeast doughs built around the four classic Ghanaian loaves. You learn accurate scaling, mixing, kneading, fermentation, shaping, proofing and oven control so you can bake consistent loaves at home or for sale.","fee":150000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Ghanaian Sugar Bread","Rich Butter Bread","Ghanaian Tea Bread","Ghanaian Coconut Bread"],"skills":["Equipment, food safety, ingredients and accurate measuring","Mixing, hand-kneading and windowpane dough development","Bulk fermentation, portioning, tin shaping and proofing","Oven temperature control, cooling, packaging and basic bake costing"],"provided":["All flour, yeast, butter, sugar, coconut and recipe ingredients","Loaf tins, mixers, ovens and full kitchen equipment","Printed recipe sheets and basic costing worksheet","Every loaf you bake during the week to take home"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and equipment are provided by the school.","prereq":"No experience needed. The beginner course assumes you have never baked bread or pastry.","published":true},{"slug":"bread-intermediate","track":"bread","level":2,"level_label":"Intermediate","name":"Bread Making · Intermediate","summary":"Whole-grain doughs, soft rolls and shaped loaves: Whole-meal Wheat Bread, Soft Buttermilk Rolls, Wheat Sandwich Baguettes and Wholewheat Burger Buns.","description":"Move beyond basic tin loaves into whole-grain hydration, soft enriched dinner rolls, seeded burger buns and sandwich baguettes. Focuses on dough conditioning, uniform portioning, tension shaping and crust finishes.","fee":220000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Whole-meal Wheat Bread","Soft Buttermilk Rolls","Wheat Sandwich Baguettes","Wholewheat Burger Buns"],"skills":["Hydration adjustments for whole-meal and wheat flours","Dividing, rounding and uniform tension shaping for rolls and buns","Pre-shaping, couching and scoring sandwich baguettes","Egg-wash, seed topping, steam control, presentation and packaging"],"provided":["All whole-grain and bread flours, buttermilk, butter and seeds","Proofer, ovens, benc'
    || 'h scrapers and baking trays","Printed recipe manual and batch costing guide","All loaves, rolls and buns baked in class"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and equipment are provided by the school.","prereq":"Beginner complete, or equivalent comfort with a basic yeast dough.","published":true},{"slug":"bread-advanced","track":"bread","level":3,"level_label":"Advanced","name":"Bread Making · Advanced","summary":"Artisan fermentation, braided and enriched doughs: Sourdough Boule, Classic French Baguette, Braided Challah, Brioche, Cinnamon Swirl, Rosemary Focaccia, New York Bagels and Skillet Naan.","description":"Our flagship bread course covering natural levain management, high-hydration open-crumb doughs, multi-strand braiding, rich butter brioche, boiled bagels and flatbreads. Designed for serious home bakers and bakery founders.","fee":300000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Artisan Sourdough Boule","Classic French Baguette","Braided Challah","Brioche","Cinnamon Swirl Butter Loaf","Rosemary Focaccia","New York Style Bagels","Skillet Naan"],"skills":["Building and maintaining an active sourdough starter and levain","Stretch-and-fold, coil folds and cold retard fermentation","High-butter emulsion for brioche and multi-strand challah braiding","Kettle-boiling bagels, open-hearth steaming, scoring and troubleshooting"],"provided":["All specialty flours, butter, inclusions and active sourdough starter to take home","Bannetons, lame, baking steel/stone and full kitchen equipment","Comprehensive artisan bread workbook and commercial pricing sheet","Every loaf, bagel and flatbread baked during the week"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for fermentation logs","Hair net or head wrap"],"bring_note":"All ingredients, bannetons and tools are provided by the school.","prereq":"Intermediate complete, or confident with enriched, laminated and wheat doughs.","published":true},{"slug":"pastry-beginner","track":"pastry","level":1,"level_label":"Beginner","name":"Pastry & Savoury · Beginner","summary":"Everyday savoury pastries and Ghanaian snacks: Meat Pie, Sausage Roll, Spring Roll, Samosa, Puff-Puff (Bofrot), Rock Buns, Atwemo and Chin Chin.","description":"Master the everyday savoury pastries and traditional Ghanaian snacks that anchor event platters and daily bakery orders. Covers shortcrust rubbing-in, savoury fillings, folding samosas and spring rolls, and frying temperature control.","fee":150000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Meat Pie","Sausage Roll","Spring Roll","Samosa","Puff-Puff (Bofrot)","Ghanaian Rock Buns","Atwemo","Chin Chin"],"skills":["Flaky shortcrust and rough-puff pastry without tough shrinkage","Seasoning and binding moist meat and vegetable fillings","Wrapping, sealing and crimping pies, '
    || 'rolls, spring rolls and samosas","Frying oil temperature control, packaging and costing a snack order"],"provided":["All flour, butter, meats, vegetables, spices, oil and packaging boxes","Ovens, fryers, cutters, rolling pins and workstation tools","Printed recipe booklet and small-chop platter costing guide","All pastries and snack packs made during class"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and packaging are provided by the school.","prereq":"No experience needed. The beginner course assumes you have never baked bread or pastry.","published":true},{"slug":"pastry-intermediate","track":"pastry","level":2,"level_label":"Intermediate","name":"Pastry & Bakery · Intermediate","summary":"Lamination, bakery counter favourites and café bakes: Croissants, Danish, Puff Pastry, Cinnamon Rolls, Doughnuts, Cupcakes, Cookies and Pizza.","description":"Learn butter lock-in and lamination for crisp croissants, Danish and puff pastry alongside commercial-grade milky doughnuts, swirled cinnamon rolls, hand-iced cupcakes, cookies and artisan pizza dough.","fee":220000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Croissants","Danish Pastry","Puff Pastry","Cinnamon Rolls","Doughnuts","Cupcakes","Cookies","Pizza"],"skills":["Butter block preparation, single/double turns and cold lamination","Shaping, proofing and glazing croissants, Danish and cinnamon rolls","Frying and filling pillowy doughnuts with stable glazes","Creaming method for cupcakes and cookies, piping, presentation and costing"],"provided":["Lamination butter, chocolate, glazes, fillings and all ingredients","Chillers, mixers, piping tips, cutters and baking sheets","Step-by-step lamination schedule and recipe manual","Boxes of everything you bake to take home"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and equipment are provided by the school.","prereq":"Beginner complete, or equivalent comfort with basic dough and pastry handling.","published":true},{"slug":"pastry-advanced","track":"pastry","level":3,"level_label":"Advanced","name":"Pâtisserie & Desserts · Advanced","summary":"Fine pâtisserie and plated desserts: Macarons, Éclairs, Fruit and Custard Tarts, Quiche, Cheesecakes and Mousse Cakes.","description":"Precision pastry for dessert tables and boutique orders. Covers macaronage, choux pastry for éclairs, crisp pâte sucrée tart shells, pastry cream, baked and chilled cheesecakes, savoury quiche and mirror-finished mousse cakes.","fee":300000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Macarons","Éclairs","Fruit and Custard Tarts","Quiche","Cheesecakes","Mousse Cakes"],"skills":["Meringue stability and macaronage for smooth, footed macaron shells","Piping and baking hollow choux pastry éclairs with pastry crea'
    || 'm and glaze","Blind-baking crisp sweet and savoury tart shells without shrinkage","Emulsion, setting and finishing for cheesecakes and mousse cakes"],"provided":["Almond flour, chocolate, cream cheese, fresh fruit and all ingredients","Baking mats, tart rings, thermometers, mixers and finishing tools","Advanced pâtisserie manual, troubleshooting and pricing guide","Full dessert boxes of your finished creations"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All specialty ingredients and tools are provided by the school.","prereq":"Intermediate complete, or confident with enriched, laminated and wheat doughs.","published":true}],"options":[{"kind":"size","key":"5","label":"5-inch (serves 6–8)","payload":{"price":15000}},{"kind":"size","key":"6","label":"6-inch (serves 8–12)","payload":{"price":22000}},{"kind":"size","key":"7","label":"7-inch (serves 12–16)","payload":{"price":28000}},{"kind":"size","key":"8","label":"8-inch (serves 16–22)","payload":{"price":35000}},{"kind":"size","key":"10","label":"10-inch (serves 25–32)","payload":{"price":65000}},{"kind":"size","key":"12","label":"12-inch (serves 35–45)","payload":{"price":90000}},{"kind":"decor","key":"basic","label":"Basic single-layer","payload":{"charges":{"5":15000,"6":22000,"7":28000,"8":35000,"10":65000,"12":90000}}},{"kind":"decor","key":"simple","label":"Simple decorated birthday","payload":{"charges":{"5":18000,"6":25000,"7":32000,"8":40000,"10":75000,"12":100000}}},{"kind":"decor","key":"custom","label":"Custom decorated single-layer","payload":{"charges":{"5":22000,"6":30000,"7":38000,"8":50000,"10":95000,"12":130000}}},{"kind":"decor","key":"two-plain","label":"Two-layer, plain finish","payload":{"charges":{"5":22000,"6":30000,"7":40000,"8":50000,"10":80000,"12":110000}}},{"kind":"decor","key":"two-decor","label":"Two-layer, decorated","payload":{"charges":{"5":28000,"6":38000,"7":48000,"8":70000,"10":100000,"12":140000}}},{"kind":"flavour","key":"vanilla","label":"Vanilla","payload":{"extra":0}},{"kind":"flavour","key":"banana","label":"Banana","payload":{"extra":0}},{"kind":"flavour","key":"chocolate","label":"Chocolate","payload":{"extra":2000}},{"kind":"flavour","key":"lemon","label":"Lemon","payload":{"extra":2000}},{"kind":"flavour","key":"marble","label":"Marble","payload":{"extra":3000}},{"kind":"flavour","key":"coconut","label":"Coconut","payload":{"extra":3000}},{"kind":"flavour","key":"carrot","label":"Carrot","payload":{"extra":3000}},{"kind":"flavour","key":"redvelvet","label":"Red velvet","payload":{"extra":4000}},{"kind":"flavour","key":"fruit","label":"Traditional fruit cake","payload":{"extra":5000,"priceMax":10000}},{"kind":"addon","key":"writing","label":"Birthday writing on cake","payload":{"price":1000}},{"kind":"addon","key":"piping","label":"Extra cream piping","payload":{"price":3000}},{"kind":"addon","key":"drip","label":"Chocolate drip","payload":{"price":3000,"priceMax":4000}'
    || '},{"kind":"addon","key":"oreo","label":"Oreo or biscuit topping","payload":{"price":3000,"priceMax":4000}},{"kind":"addon","key":"fruit","label":"Fresh fruit decoration","payload":{"price":5000}},{"kind":"addon","key":"photo","label":"Edible image / photo print","payload":{"price":6000}},{"kind":"addon","key":"topper","label":"Acrylic cake topper","payload":{"price":3000,"priceMax":6000}},{"kind":"addon","key":"fondant-name","label":"Fondant name or age","payload":{"price":5000}},{"kind":"addon","key":"fondant-full","label":"Full fondant covering / theme design","payload":{"price":null,"priceMax":30000}},{"kind":"variety","key":"bento","label":"Bento gift cake (4-inch)","payload":{"price":12000}},{"kind":"variety","key":"birthday","label":"Classic birthday cake","payload":{"price":18000}},{"kind":"variety","key":"heart","label":"Heart-shaped cake (6-inch)","payload":{"price":30000}},{"kind":"variety","key":"drip","label":"Drip cake (6-inch)","payload":{"price":35000}},{"kind":"variety","key":"oreo","label":"Oreo cake (6-inch)","payload":{"price":35000}},{"kind":"variety","key":"chocolate","label":"Chocolate-loaded cake (6-inch)","payload":{"price":40000}},{"kind":"variety","key":"fruit","label":"Fruit-topped cake (6-inch)","payload":{"price":40000}},{"kind":"variety","key":"redvelvet","label":"Red velvet celebration cake (6-inch)","payload":{"price":40000}},{"kind":"variety","key":"photo","label":"Photo cake (6-inch)","payload":{"price":35000}},{"kind":"variety","key":"number","label":"Number milestone cake","payload":{"price":45000}},{"kind":"variety","key":"kids","label":"Kids’ character or theme cake","payload":{"price":60000}},{"kind":"variety","key":"corporate","label":"Luxury custom cake","payload":{"price":100000}},{"kind":"variety","key":"tier2","label":"Two-tier wedding cake","payload":{"price":150000}},{"kind":"variety","key":"tier3","label":"Three-tier grand wedding cake","payload":{"price":250000}},{"kind":"tier","key":"tier2","label":"Two-tier wedding cake (8\" + 6\")","payload":{"price":150000}},{"kind":"tier","key":"tier3","label":"Three-tier grand wedding cake (10\" + 8\" + 6\")","payload":{"price":250000}}]}'
  )::jsonb;

  -- Categories first: products reference them by slug.
  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'categories') LOOP
    INSERT INTO public.categories (slug, name, intro, published, sort_order)
    VALUES (
      rec->>'slug',
      rec->>'name',
      coalesce(rec->>'intro', ''),
      coalesce((rec->>'published')::BOOLEAN, TRUE),
      coalesce((rec->>'sort_order')::INTEGER, 0)
    )
    ON CONFLICT (slug) DO NOTHING;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'products') LOOP
    INSERT INTO public.products (sku, name, category, price, discount_pct, prep_days, meta, description, image, published)
    VALUES (
      rec->>'sku',
      rec->>'name',
      rec->>'category',
      CASE WHEN rec->>'price' IS NULL OR rec->>'price' = 'null' THEN NULL ELSE (rec->>'price')::INTEGER END,
      coalesce((rec->>'discount_pct')::INTEGER, 0),
      coalesce((rec->>'prep_days')::INTEGER, 0),
      coalesce(rec->>'meta', ''),
      coalesce(rec->>'description', ''),
      coalesce(rec->>'image', ''),
      coalesce((rec->>'published')::BOOLEAN, TRUE)
    )
    ON CONFLICT (sku) DO NOTHING;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'classes') LOOP
    INSERT INTO public.classes (
      slug, track, level, level_label, name, summary, description, fee,
      hours, schedule, recipes, skills, provided, bring, bring_note, prereq, published
    )
    VALUES (
      rec->>'slug',
      coalesce(rec->>'track', 'bread'),
      coalesce((rec->>'level')::INTEGER, 1),
      coalesce(rec->>'level_label', 'Beginner'),
      rec->>'name',
      coalesce(rec->>'summary', ''),
      coalesce(rec->>'description', ''),
      coalesce((rec->>'fee')::INTEGER, 0),
      coalesce(rec->>'hours', '1 week'),
      coalesce(rec->>'schedule', ''),
      coalesce(rec->'recipes', '[]'::jsonb),
      coalesce(rec->'skills', '[]'::jsonb),
      coalesce(rec->'provided', '[]'::jsonb),
      coalesce(rec->'bring', '[]'::jsonb),
      coalesce(rec->>'bring_note', ''),
      coalesce(rec->>'prereq', ''),
      coalesce((rec->>'published')::BOOLEAN, TRUE)
    )
    ON CONFLICT (slug) DO NOTHING;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'options') LOOP
    INSERT INTO public.cake_options (kind, key, label, payload)
    VALUES (
      rec->>'kind',
      rec->>'key',
      rec->>'label',
      coalesce(rec->'payload', '{}'::jsonb)
    )
    ON CONFLICT (kind, key) DO NOTHING;
  END LOOP;

  RAISE NOTICE 'Catalogue seed complete. Rows after seed: categories=%, products=%, classes=%, options=%',
    (SELECT count(*) FROM public.categories),
    (SELECT count(*) FROM public.products),
    (SELECT count(*) FROM public.classes),
    (SELECT count(*) FROM public.cake_options);
END $$;

-- [COMMIT removed: the combined script has one outer transaction]


-- =============================================================================
-- ALL SIX FILES APPLIED
-- =============================================================================

COMMIT;

-- Tell PostgREST to reload its schema cache so the new RPCs are callable
-- immediately instead of returning PGRST202 for the next few minutes.
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFICATION — the results of this last query are what you should see
-- =============================================================================
SELECT 'categories'      AS object, count(*) AS rows FROM public.categories
UNION ALL SELECT 'products',        count(*) FROM public.products
UNION ALL SELECT 'classes',         count(*) FROM public.classes
UNION ALL SELECT 'cake_options',    count(*) FROM public.cake_options
UNION ALL SELECT 'settings rows',   count(*) FROM public.settings
UNION ALL SELECT 'admin_users',     count(*) FROM public.admin_users
ORDER BY object;

-- Every RPC the browser calls; all 27 should be listed.
SELECT p.proname AS function_name
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'api\_%'
ORDER BY p.proname;

-- Convenience view of the two things that were broken.
SELECT
  (SELECT count(*) FROM public.classes WHERE published)                AS published_courses,
  (SELECT count(*) FROM public.products WHERE published)               AS published_products,
  (SELECT count(*) FROM public.cake_options)                           AS cake_options,
  (SELECT coalesce(nullif(btrim(business_phone), ''), '(not set)') FROM public.settings WHERE id = 1) AS business_phone,
  (SELECT coalesce(nullif(btrim(whatsapp_contact), ''), '(not set)') FROM public.settings WHERE id = 1) AS whatsapp
;
