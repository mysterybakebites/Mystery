-- =============================================================================
-- Mystery Bakebite — Complete Production Schema, Super Admin Provisioning,
-- User & Role Management (RBAC), Duplicate Payment Prevention, and RLS
-- Target: Supabase PostgreSQL 15+
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Core Catalogue, Orders, Payment Submissions, RBAC & Audit Tables
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
  advance_threshold         INTEGER NOT NULL DEFAULT 15000, -- 150.00 GHS in pesewas
  auto_confirm              BOOLEAN NOT NULL DEFAULT TRUE,
  bundle_two_pct            INTEGER NOT NULL DEFAULT 15 CHECK (bundle_two_pct >= 0 AND bundle_two_pct <= 90),
  bundle_three_pct          INTEGER NOT NULL DEFAULT 25 CHECK (bundle_three_pct >= 0 AND bundle_three_pct <= 90),
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
    (role = 'super_admin' AND lower(email) = 'mysterybakebite@gmail.com' AND is_primary_super_admin = TRUE)
    OR (role <> 'super_admin' AND lower(email) <> 'mysterybakebite@gmail.com' AND is_primary_super_admin = FALSE)
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

-- Orders & Class Bookings
CREATE TABLE IF NOT EXISTS public.orders (
  ref                   TEXT PRIMARY KEY CHECK (ref ~ '^M[BC]-[A-Z0-9]{4,12}$'),
  token                 TEXT NOT NULL CHECK (char_length(token) >= 16),
  idempotency_key       TEXT UNIQUE,
  kind                  TEXT NOT NULL CHECK (kind IN ('product', 'class')),
  customer_name         TEXT NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  phone                 TEXT NOT NULL CHECK (char_length(phone) BETWEEN 7 AND 30),
  email                 TEXT DEFAULT '',
  fulfilment            TEXT NOT NULL DEFAULT 'pickup',
  address               TEXT DEFAULT '',
  event_date            TEXT NOT NULL DEFAULT ''
                        CHECK (kind = 'class' OR event_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  payment_method        TEXT NOT NULL CHECK (payment_method IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery')),
  payment_status        TEXT NOT NULL DEFAULT 'awaiting_payment'
                        CHECK (payment_status IN ('awaiting_payment', 'payment_submitted', 'payment_verified', 'payment_rejected', 'pay_on_collection', 'not_required')),
  order_status          TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (order_status IN ('submitted', 'confirmed', 'in_preparation', 'completed', 'cancelled')),
  subtotal              INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount              INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total                 INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  has_unpriced          BOOLEAN NOT NULL DEFAULT FALSE,
  advance_required      BOOLEAN NOT NULL DEFAULT FALSE,
  items                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes                 TEXT DEFAULT '',
  payment_ref           TEXT DEFAULT '',
  has_proof             BOOLEAN NOT NULL DEFAULT FALSE,
  proof_path            TEXT DEFAULT '',
  proof_note            TEXT DEFAULT '',
  proof_locked          BOOLEAN NOT NULL DEFAULT FALSE,
  proof_submitted_at    TIMESTAMPTZ,
  submission_count      INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  reject_reason         TEXT DEFAULT '',
  verified_at           TIMESTAMPTZ,
  verified_by           TEXT DEFAULT '',
  events                JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payment Proof Submissions (enforces 1 active submission per order + unique transaction references)
CREATE TABLE IF NOT EXISTS public.payment_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref       TEXT NOT NULL REFERENCES public.orders(ref) ON DELETE CASCADE,
  reference       TEXT DEFAULT '',
  image_path      TEXT DEFAULT '',
  note            TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending_verification'
                  CHECK (status IN ('pending_verification', 'verified', 'rejected')),
  reject_reason   TEXT DEFAULT '',
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT DEFAULT '',
  CONSTRAINT chk_submission_has_proof CHECK (
    char_length(trim(coalesce(reference, ''))) >= 4
    OR char_length(trim(coalesce(image_path, ''))) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_submissions_one_active_per_order
  ON public.payment_submissions (order_ref)
  WHERE status IN ('pending_verification', 'verified');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_submissions_unique_ref
  ON public.payment_submissions (upper(trim(reference)))
  WHERE char_length(trim(coalesce(reference, ''))) > 0
    AND status IN ('pending_verification', 'verified');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_submissions_order_ref_tx
  ON public.payment_submissions (order_ref, upper(trim(reference)))
  WHERE char_length(trim(coalesce(reference, ''))) > 0;

-- -----------------------------------------------------------------------------
-- 2. Super Administrator Provisioning & Protection Triggers
-- -----------------------------------------------------------------------------

-- Automatically enroll mysterybakebite@gmail.com as primary Super Administrator
-- when created in Supabase Auth, with mandatory first-login password change.
CREATE OR REPLACE FUNCTION public.trg_auto_provision_super_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF lower(trim(NEW.email)) = 'mysterybakebite@gmail.com' THEN
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
      'mysterybakebite@gmail.com',
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
      'mysterybakebite@gmail.com',
      'mysterybakebite@gmail.com',
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

-- Protect mysterybakebite@gmail.com from accidental deletion, deactivation, or role downgrade
CREATE OR REPLACE FUNCTION public.trg_protect_primary_super_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF lower(OLD.email) = 'mysterybakebite@gmail.com' OR OLD.is_primary_super_admin THEN
      RAISE EXCEPTION 'The primary Super Administrator (mysterybakebite@gmail.com) cannot be removed.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF lower(OLD.email) = 'mysterybakebite@gmail.com' OR OLD.is_primary_super_admin THEN
      IF lower(NEW.email) <> 'mysterybakebite@gmail.com'
         OR NEW.role <> 'super_admin'
         OR NEW.is_primary_super_admin IS DISTINCT FROM TRUE
         OR NEW.active IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'The primary Super Administrator (mysterybakebite@gmail.com) cannot be demoted, deactivated, or reassigned.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF lower(NEW.email) <> 'mysterybakebite@gmail.com' AND (NEW.role = 'super_admin' OR NEW.is_primary_super_admin) THEN
    RAISE EXCEPTION 'The super_admin role is exclusively reserved for mysterybakebite@gmail.com.'
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
      AND lower(a.email) = 'mysterybakebite@gmail.com'
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
    'team', v_admin.role = 'super_admin' AND lower(v_admin.email) = 'mysterybakebite@gmail.com'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'signedIn', TRUE,
    'isAdmin', TRUE,
    'email', v_admin.email,
    'name', v_admin.name,
    'role', v_admin.role,
    'isSuperAdmin', (v_admin.role = 'super_admin' AND lower(v_admin.email) = 'mysterybakebite@gmail.com'),
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

    IF v_caller.role = 'super_admin' AND lower(v_caller.email) = 'mysterybakebite@gmail.com' THEN
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
      'canManageTeam', (v_caller.role = 'super_admin' AND lower(v_caller.email) = 'mysterybakebite@gmail.com'),
      'primarySuperAdminEmail', 'mysterybakebite@gmail.com',
      'auditLog', v_logs
    );
  END IF;

  -- All mutating actions require primary Super Administrator authority
  IF NOT public.is_verified_super_admin() THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'forbidden',
      'error', 'Only the primary Super Administrator (mysterybakebite@gmail.com) is authorized to manage user accounts and roles.'
    );
  END IF;

  v_target_id := NULLIF(trim(coalesce(p_payload->>'userId', '')), '')::UUID;
  SELECT * INTO v_target FROM public.admin_users WHERE user_id = v_target_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Target user account was not found.');
  END IF;

  IF lower(v_target.email) = 'mysterybakebite@gmail.com' OR v_target.is_primary_super_admin THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'super_admin_protected',
      'error', 'The primary Super Administrator (mysterybakebite@gmail.com) is protected and cannot be modified, demoted, deactivated, or removed.'
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
-- 6. Payment State-Machine Trigger & Verification RPCs
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
-- 7. Private Storage Bucket for Payment Screenshots
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

DROP POLICY IF EXISTS "admin_read_proof_objects" ON storage.objects;
CREATE POLICY "admin_read_proof_objects" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'proofs' AND public.is_verified_admin());

GRANT EXECUTE ON FUNCTION public.api_admin_whoami() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_complete_first_login(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_team(JSONB) TO authenticated;

COMMIT;
